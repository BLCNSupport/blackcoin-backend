// server.js — BlackCoin backend (UTC version + Operator Hub extensions)
// Smart Backoff polling (20s → 60s on 429), no-overlap protection, timestamped logs
// Realtime WebSocket relay for hub_broadcasts at /ws — ESM-safe + heartbeat
// Broadcast timestamps use Supabase `created_at` and include `display_time` as "HH:MM" (server-local)

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import multer from "multer";
import http from "http";
import * as ws from "ws";         // ESM-safe: namespace import from CJS
const { WebSocketServer } = ws;    // server class only; NO client usage

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

/* ============ Logging Helpers (Normal) ============ */
function ts() {
  const d = new Date();
  return `[${d.toTimeString().slice(0, 8)}]`;
}
function log(...args) { console.log(ts(), ...args); }
function warn(...args) { console.warn(ts(), ...args); }
function err(...args) { console.error(ts(), ...args); }

/* ============ Supabase ============ */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // service_role
if (!SUPABASE_URL || !SUPABASE_KEY) {
  err("SUPABASE_URL or SUPABASE_KEY missing");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ============ Chart poller ============ */
const TOKEN_MINT = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";

let FETCH_INTERVAL = 20000;            // 20s normal
const BACKOFF_INTERVAL = 60000;        // 60s after 429
let isBackoff = false;
let fetchInProgress = false;
let pollTimer = null;

let memoryCache = [];

async function insertPoint(point) {
  try {
    const { error } = await supabase.from("chart_data").insert([point]);
    if (error) err("Supabase insert failed:", error.message);
  } catch (e) {
    err("Supabase insert exception:", e);
  }
}

async function fetchOneTick() {
  fetchInProgress = true;
  log("⏱️  Polling Dexscreener...");
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`,
      { headers: { "Cache-Control": "no-cache" } }
    );
    if (res.status === 429) {
      warn("⚠️  429 rate limit hit — entering backoff:", `${BACKOFF_INTERVAL / 1000}s`);
      return "backoff";
    }
    if (!res.ok) {
      warn(`⚠️  Upstream returned ${res.status} — keeping normal cadence`);
      return "softfail";
    }
    const json = await res.json();
    const pair = json.pairs?.[0];
    if (!pair) {
      warn("⚠️  No pairs in response — keeping normal cadence");
      return "softfail";
    }
    const point = {
      timestamp: new Date().toISOString(),
      price: parseFloat(pair.priceUsd),
      change: parseFloat(pair.priceChange?.h24),
      volume: parseFloat(pair.volume?.h24),
    };
    if ([point.price, point.change, point.volume].some((v) => isNaN(v))) {
      warn("⚠️  Invalid numeric fields in response — skipping insert");
      return "softfail";
    }
    memoryCache.push(point);
    if (memoryCache.length > 10000) memoryCache.shift();
    await insertPoint(point);
    log("✅ Data stored at", point.timestamp);
    return "ok";
  } catch (e) {
    err("fetchLiveData failed:", e);
    return "softfail";
  } finally {
    fetchInProgress = false;
  }
}

function scheduleNext(ms) {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  pollTimer = setTimeout(pollLoop, ms);
}

async function pollLoop() {
  if (fetchInProgress) {
    warn("⏸️  Previous fetch still running — skipping this cycle");
    return scheduleNext(isBackoff ? BACKOFF_INTERVAL : FETCH_INTERVAL);
  }
  const result = await fetchOneTick();
  if (result === "backoff") {
    if (!isBackoff) isBackoff = true;
    log("⏸️  Backoff active — delaying next fetch...");
    return scheduleNext(BACKOFF_INTERVAL);
  }
  if (isBackoff && result === "ok") {
    isBackoff = false;
    log("⏳  Backoff ended — resuming normal polling");
    return scheduleNext(FETCH_INTERVAL);
  }
  scheduleNext(FETCH_INTERVAL);
}

// Kick off polling
pollLoop();

/* ============ Chart endpoints ============ */
function bucketMs(interval) {
  switch (interval) {
    case "1m": return 60 * 1000;
    case "5m": return 5 * 60 * 1000;
    case "30m": return 30 * 60 * 1000;
    case "1h": return 60 * 60 * 1000;
    case "D": return 24 * 60 * 60 * 1000;
    default: return 60 * 1000;
  }
}
function getWindow(interval) {
  const now = Date.now();
  if (interval === "D") return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  if (interval === "1h") return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  return new Date(now - 24 * 60 * 60 * 1000).toISOString();
}
function floorToBucketUTC(tsISO, interval) {
  const ms = bucketMs(interval);
  const d = new Date(tsISO);
  return new Date(Math.floor(d.getTime() / ms) * ms);
}
function bucketize(rows, interval) {
  const byKey = new Map();
  for (const r of rows) {
    const key = floorToBucketUTC(r.timestamp, interval).toISOString();
    const price = +r.price, change = +r.change, vol = +r.volume;
    if (!byKey.has(key)) byKey.set(key, { timestamp: key, price, change, volume: 0 });
    const b = byKey.get(key);
    b.price = price; b.change = change; b.volume += isNaN(vol) ? 0 : vol;
  }
  return Array.from(byKey.values()).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

app.get("/api/chart", async (req, res) => {
  try {
    const interval = req.query.interval || "D";
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 10000, 20000);
    const offset = (page - 1) * limit;
    const cutoff = getWindow(interval);

    const { data, error, count } = await supabase
      .from("chart_data")
      .select("timestamp, price, change, volume", { count: "exact" })
      .gte("timestamp", cutoff)
      .order("timestamp", { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    const raw = data?.length ? data : memoryCache.filter((p) => new Date(p.timestamp) >= new Date(cutoff));
    const points = bucketize(raw, interval);
    const latest = raw.length ? raw[raw.length - 1] : memoryCache.at(-1);
    const totalCount = count || raw.length;
    const nextPage = offset + limit < totalCount ? page + 1 : null;

    res.json({ points, latest, page, nextPage, hasMore: Boolean(nextPage) });
  } catch (e) {
    err("Error /api/chart:", e);
    res.status(500).json({ error: "Failed to fetch chart data", message: e.message });
  }
});

app.get("/api/latest", async (req, res) => {
  try {
    let latest = memoryCache.at(-1);
    if (!latest) {
      const { data } = await supabase
        .from("chart_data")
        .select("timestamp, price, change, volume")
        .order("timestamp", { ascending: false })
        .limit(1)
        .maybeSingle();
      latest = data;
    }
    if (!latest) return res.status(404).json({ error: "No data" });
    res.json(latest);
  } catch (e) {
    err("Error /api/latest:", e);
    res.status(500).json({ error: "Failed" });
  }
});

/* ======================================================
   === Operator Hub / Terminal API Extensions ===
   ====================================================== */

// === 1. Save or update user profile (overwrite if fields provided) ===
app.post("/api/profile", async (req, res) => {
  try {
    let { wallet, handle, avatar_url } = req.body;
    if (!wallet) return res.status(400).json({ error: "Missing wallet" });
    if (typeof handle === "string") handle = handle.trim();
    if (!handle || handle === "") handle = "@Operator";

    const { data, error } = await supabase
      .from("hub_profiles")
      .upsert(
        {
          wallet,
          handle,
          avatar_url: avatar_url ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "wallet" }
      )
      .select();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) {
    err("Error /api/profile:", e);
    res.status(500).json({ error: e.message });
  }
});

// === 1b. Get user profile by wallet ===
app.get("/api/profile", async (req, res) => {
  try {
    const wallet = req.query.wallet;
    if (!wallet) return res.status(400).json({ error: "Missing wallet" });
    const { data, error } = await supabase
      .from("hub_profiles")
      .select("*")
      .eq("wallet", wallet)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Not found" });
    res.json(data);
  } catch (e) {
    err("Error /api/profile [GET]:", e);
    res.status(500).json({ error: e.message });
  }
});

// === 2. Avatar upload ===
const upload = multer({ storage: multer.memoryStorage() });
app.post("/api/avatar-upload", upload.single("avatar"), async (req, res) => {
  try {
    const { wallet } = req.body;
    const file = req.file;
    if (!wallet || !file) return res.status(400).json({ error: "Missing fields" });

    const fileName = `avatars/${wallet}_${Date.now()}.jpg`;
    const { error: uploadErr } = await supabase.storage
      .from("hub_avatars")
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });
    if (uploadErr) throw uploadErr;

    const { data: publicURL } = supabase.storage
      .from("hub_avatars")
      .getPublicUrl(fileName);

    await supabase
      .from("hub_profiles")
      .update({ avatar_url: publicURL.publicUrl })
      .eq("wallet", wallet);

    res.json({ success: true, url: publicURL.publicUrl });
  } catch (e) {
    err("Error /api/avatar-upload:", e);
    res.status(500).json({ error: e.message });
  }
});

// Helper: format "HH:MM" local from ISO string
function hhmm(iso) {
  try {
    const d = new Date(iso);
    return d.toTimeString().slice(0,5);
  } catch {
    return "";
  }
}

// === 3. Post new broadcast (created_at by Supabase) ===
app.post("/api/broadcast", async (req, res) => {
  try {
    const { wallet, message } = req.body;
    if (!wallet || !message) return res.status(400).json({ error: "Missing fields" });

    const { data, error } = await supabase
      .from("hub_broadcasts")
      .insert([{ wallet, message }])
      .select()
      .maybeSingle();
    if (error) throw error;

    // Attach display_time for convenience
    const row = data ? { ...data, display_time: hhmm(data.created_at) } : null;

    res.json({ success: true, data: row });
  } catch (e) {
    err("Error /api/broadcast:", e);
    res.status(500).json({ error: e.message });
  }
});

// === 4. Fetch broadcasts (latest 25, DESC by created_at) ===
app.get("/api/broadcasts", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("hub_broadcasts")
      .select("id, wallet, message, created_at")
      .order("created_at", { ascending: false })
      .limit(25);
    if (error) throw error;
    const rows = (data || []).map(r => ({ ...r, display_time: hhmm(r.created_at) }));
    res.json(rows);
  } catch (e) {
    err("Error /api/broadcasts:", e);
    res.status(500).json({ error: e.message });
  }
});

// === 5. Log refund transaction ===
app.post("/api/refund", async (req, res) => {
  try {
    const { wallet, token, rent, tx, status } = req.body;
    if (!wallet || !tx) return res.status(400).json({ error: "Missing required fields" });

    const record = {
      wallet,
      token: token || "UNKNOWN",
      rent_reclaimed: rent ?? 0,
      tx,
      status: status || "Success",
      // created_at is Supabase-managed default
    };

    const { data, error } = await supabase
      .from("hub_refund_history")
      .insert([record])
      .select();
    if (error) throw error;

    log(`✅ Logged refund for ${wallet} — ${token} ${rent} SOL`);
    await new Promise((r) => setTimeout(r, 1200));
    res.json({ success: true, inserted: data });
  } catch (e) {
    err("❌ Error inserting refund:", e);
    res.status(500).json({ error: e.message });
  }
});

// === 5b. Fetch refund history for a wallet ===
app.get("/api/refund-history", async (req, res) => {
  try {
    const { wallet } = req.query;
    if (!wallet) return res.status(400).json({ error: "Missing wallet" });

    res.set("Cache-Control", "no-store");

    const { data, error } = await supabase
      .from("hub_refund_history")
      .select("*")
      .eq("wallet", wallet)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    err("Error /api/refund-history:", e);
    res.status(500).json({ error: e.message });
  }
});

// === 6. Fetch wallet summary (placeholder) ===
app.get("/api/wallet", async (req, res) => {
  try {
    const addr = req.query.addr;
    if (!addr) return res.status(400).json({ error: "Missing addr" });
    res.json({
      address: addr,
      balances: [
        { name: "SOL", amount: 12.34, value: 12.34 * 305 },
        { name: "BlackCoin", amount: 1000000, value: 187.5 },
      ],
    });
  } catch (e) {
    err("Error /api/wallet:", e);
    res.status(500).json({ error: e.message });
  }
});

/* ======================================================
   === Realtime WebSocket Relay for hub_broadcasts =======
   ====================================================== */

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Set();

// Heartbeat (keep connections alive behind proxies)
function heartbeat() { this.isAlive = true; }
const PING_MS = 30000; // 30s
const pingInterval = setInterval(() => {
  for (const s of clients) {
    if (s.isAlive === false) { s.terminate(); continue; }
    s.isAlive = false;
    try { s.ping(); } catch (e) { /* ignore */ }
  }
}, PING_MS);

wss.on("connection", async (socket) => {
  socket.isAlive = true;
  socket.on("pong", heartbeat);

  clients.add(socket);
  log("WS connect — clients:", clients.size);

  socket.on("close", () => {
    clients.delete(socket);
    log("WS close — clients:", clients.size);
  });

  socket.on("error", (e) => err("WS error:", e?.message || e));

  // Send last 25 on connect (DESC by created_at) with display_time
  try {
    const { data, error } = await supabase
      .from("hub_broadcasts")
      .select("id, wallet, message, created_at")
      .order("created_at", { ascending: false })
      .limit(25);
    if (!error && data) {
      const rows = data.map(r => ({ ...r, display_time: hhmm(r.created_at) }));
      socket.send(JSON.stringify({ type: "hello", rows }));
    }
  } catch (e) {
    err("WS hello failed:", e?.message || e);
  }
});

function wsBroadcast(payloadObj) {
  const msg = JSON.stringify(payloadObj);
  for (const s of clients) {
    if (s.readyState === s.OPEN) {
      s.send(msg);
    }
  }
}

// Supabase realtime: INSERT + DELETE on hub_broadcasts
const channel = supabase
  .channel("realtime:hub_broadcasts")
  .on(
    "postgres_changes",
    { event: "INSERT", schema: "public", table: "hub_broadcasts" },
    (payload) => {
      const row = payload?.new || payload?.record || null;
      if (!row) return;
      wsBroadcast({ type: "insert", row: { ...row, display_time: hhmm(row.created_at) } });
    }
  )
  .on(
    "postgres_changes",
    { event: "DELETE", schema: "public", table: "hub_broadcasts" },
    (payload) => {
      const old = payload?.old || payload?.record || null;
      const id = old?.id || null;
      if (id) wsBroadcast({ type: "delete", id });
      else wsBroadcast({ type: "delete", id: null, match: { wallet: old?.wallet, message: old?.message, created_at: old?.created_at } });
    }
  )
  .subscribe((status) => {
    if (status === "SUBSCRIBED") log("WS realtime: subscribed to hub_broadcasts");
    else if (status === "CLOSED") warn("WS realtime: closed");
    else if (status === "CHANNEL_ERROR") err("WS realtime: channel error");
  });

process.on("SIGTERM", () => {
  clearInterval(pingInterval);
});

server.listen(PORT, () => log(`✅ BlackCoin backend running (UTC) on port ${PORT}`));
