// server.js — BLACKCOIN OPERATOR HUB BACKEND v10.0 — FINAL NUCLEAR EDITION
// 429-PROOF + FULL PROFILE + AVATAR + BROADCAST + REFUND + REALTIME + RENDER-READY
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import multer from "multer";
import { WebSocketServer } from "ws";
import http from "http";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static("public")); // ← Serves OperatorHub.html

function ts() {
  return `[${new Date().toTimeString().slice(0, 8)}]`;
}
const log = (...a) => console.log(ts(), ...a);
const warn = (...a) => console.warn(ts(), ...a);
const err = (...a) => console.error(ts(), ...a);

/* ---------- Supabase ---------- */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  err("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ---------- Health ---------- */
app.get("/healthz", (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

/* ---------- Chart Poller — 429 IMMUNE ---------- */
const TOKEN_MINT = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";
let FETCH_INTERVAL = 70000;
const BACKOFF_INTERVAL = 180000;
let isBackoff = false,
  fetchInProgress = false,
  pollTimer = null;
let memoryCache = [];

async function insertPoint(point) {
  try {
    const { error } = await supabase
      .from("chart_data")
      .insert([point]);
    if (error) err("Supabase insert failed:", error.message);
  } catch (e) {
    err("Supabase insert exception:", e);
  }
}

async function fetchOneTick() {
  fetchInProgress = true;
  log("Polling DexScreener...");
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`,
      { headers: { "Cache-Control": "no-cache" } }
    );

    if (res.status === 429) {
      warn("429 — entering 3min backoff");
      return "backoff";
    }
    if (!res.ok) {
      warn(`Upstream ${res.status} — continuing`);
      return "softfail";
    }

    const json = await res.json();
    const pair = json.pairs?.[0];
    if (!pair) return "softfail";

    const point = {
      timestamp: new Date().toISOString(),
      price: +pair.priceUsd,
      change: +(pair.priceChange?.h24),
      volume: +(pair.volume?.h24),
    };

    if (Object.values(point).some(v => isNaN(v))) return "softfail";

    memoryCache.push(point);
    if (memoryCache.length > 10000) memoryCache.shift();
    await insertPoint(point);
    log("Data stored");
    return "ok";
  } catch (e) {
    err("fetch failed:", e);
    return "softfail";
  } finally {
    fetchInProgress = false;
  }
}

function scheduleNext(ms) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(pollLoop, ms);
}

async function pollLoop() {
  if (fetchInProgress) return scheduleNext(isBackoff ? BACKOFF_INTERVAL : FETCH_INTERVAL);
  const r = await fetchOneTick();
  if (r === "backoff") {
    if (!isBackoff) isBackoff = true;
    return scheduleNext(BACKOFF_INTERVAL);
  }
  if (isBackoff && r === "ok") {
    isBackoff = false;
    log("Backoff ended");
  }
  scheduleNext(FETCH_INTERVAL);
}
pollLoop();

/* ---------- Chart API ---------- */
function bucketMs(i) {
  switch (i) {
    case "1m": return 60e3;
    case "5m": return 300e3;
    case "30m": return 1800e3;
    case "1h": return 3600e3;
    case "D": return 86400e3;
    default: return 60e3;
  }
}
function getWindow(i) {
  const now = Date.now();
  return new Date(now - (i === "D" ? 30 : i === "1h" ? 7 : 1) * 86400e3).toISOString();
}
function floorToBucketUTC(tsISO, i) {
  const ms = bucketMs(i);
  return new Date(Math.floor(new Date(tsISO).getTime() / ms) * ms);
}
function bucketize(rows, i) {
  const m = new Map();
  for (const r of rows) {
    const key = floorToBucketUTC(r.timestamp, i).toISOString();
    const price = +r.price, change = +r.change, vol = +r.volume;
    if (!m.has(key)) m.set(key, { timestamp: key, price, change, volume: 0 });
    const b = m.get(key);
    b.price = price;
    b.change = change;
    b.volume += isNaN(vol) ? 0 : vol;
  }
  return Array.from(m.values()).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
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
    const raw = data?.length ? data : memoryCache.filter(p => new Date(p.timestamp) >= new Date(cutoff));
    const points = bucketize(raw, interval);
    const latest = raw.length ? raw[raw.length - 1] : memoryCache.at(-1);
    const totalCount = count || raw.length;
    const nextPage = offset + limit < totalCount ? page + 1 : null;

    res.json({ points, latest, page, nextPage, hasMore: Boolean(nextPage) });
  } catch (e) {
    err("Chart error:", e);
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/api/latest", async (_req, res) => {
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
    err("Latest error:", e);
    res.status(500).json({ error: "Failed" });
  }
});

/* ---------- Profile + Avatar ---------- */
app.post("/api/profile", async (req, res) => {
  try {
    let { wallet, handle, avatar_url } = req.body;
    if (!wallet) return res.status(400).json({ error: "Missing wallet" });
    handle = (handle || "@Operator").trim();
    const { data, error } = await supabase
      .from("hub_profiles")
      .upsert(
        { wallet, handle, avatar_url: avatar_url || null, updated_at: new Date().toISOString() },
        { onConflict: "wallet" }
      )
      .select();
    if (error) throw error;
    res.json({ success: true, profile: data[0] });
  } catch (e) {
    err("Profile save error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/profile", async (req, res) => {
  try {
    const { wallet } = req.query;
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
    err("Profile get error:", e);
    res.status(500).json({ error: e.message });
  }
});

const upload = multer({ storage: multer.memoryStorage() });
app.post("/api/avatar-upload", upload.single("avatar"), async (req, res) => {
  try {
    const { wallet } = req.body;
    const file = req.file;
    if (!wallet || !file) return res.status(400).json({ error: "Missing" });

    const fileName = `avatars/${wallet}_${Date.now()}.jpg`;
    const { error: uploadErr } = await supabase.storage
      .from("hub_avatars")
      .upload(fileName, file.buffer, { contentType: file.mimetype, upsert: true });

    if (uploadErr) throw uploadErr;

    const { data: urlData } = supabase.storage.from("hub_avatars").getPublicUrl(fileName);
    const url = urlData.publicUrl;

    const { error: updErr } = await supabase
      .from("hub_profiles")
      .upsert({ wallet, avatar_url: url, updated_at: new Date().toISOString() }, { onConflict: "wallet" });

    if (updErr) throw updErr;

    res.json({ success: true, url });
  } catch (e) {
    err("Avatar upload error:", e);
    res.status(500).json({ error: e.message });
  }
});

/* ---------- Balances (Helius + Prices) ---------- */
const HELIUS_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_KEY) warn("HELIUS_API_KEY missing");

const PRICE_CACHE = new Map();
const SOL_CACHE = { priceUsd: null, ts: 0 };
const TTL = 25000;

async function getSolUsd() {
  const now = Date.now();
  if (SOL_CACHE.priceUsd && now - SOL_CACHE.ts < TTL) return SOL_CACHE.priceUsd;
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const j = await r.json();
    const p = Number(j?.solana?.usd) || 0;
    if (p > 0) {
      SOL_CACHE.priceUsd = p;
      SOL_CACHE.ts = now;
      return p;
    }
  } catch {}
  return SOL_CACHE.priceUsd ?? 0;
}

async function getTokenUsd(mint) {
  const now = Date.now();
  const cached = PRICE_CACHE.get(mint);
  if (cached && now - cached.ts < TTL) return cached.priceUsd;

  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${mint}`);
    const j = await r.json();
    const price = Number(j?.pairs?.[0]?.priceUsd) || 0;
    if (price > 0) {
      PRICE_CACHE.set(mint, { priceUsd: price, ts: now });
      return price;
    }
  } catch {}
  return 0;
}

app.post("/api/balances", async (req, res) => {
  try {
    const wallet = req.body?.wallet?.trim();
    if (!wallet || !HELIUS_KEY) return res.status(400).json({ error: "Bad request" });

    const url = `https://api.helius.xyz/v0/addresses/${wallet}/balances?api-key=${HELIUS_KEY}&includeNative=true`;
    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ error: "Helius failed" });

    const data = await r.json();
    const sol = (data?.nativeBalance?.lamports || 0) / 1e9;
    const solUsd = await getSolUsd();

    const tokens = (data?.tokens || [])
      .map(t => ({
        mint: t.mint,
        amount: Number(t.uiAmount || 0),
        decimals: t.decimals,
        symbol: t.symbol || "",
        name: t.name || "",
        logo: t.logo || ""
      }))
      .filter(t => t.amount > 0);

    const priced = await Promise.all(tokens.map(async t => {
      const priceUsd = await getTokenUsd(t.mint);
      return { ...t, priceUsd, usd: priceUsd * t.amount };
    }));

    res.json({
      sol,
      solUsd,
      tokens: priced.sort((a, b) => (b.usd || 0) - (a.usd || 0))
    });
  } catch (e) {
    err("Balances error:", e);
    res.status(500).json({ error: "Failed" });
  }
});

/* ---------- Broadcasts ---------- */
const hhmm = (iso) => {
  try { return new Date(iso).toTimeString().slice(0, 5); } catch { return ""; }
};

function normRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    wallet: r.wallet,
    message: r.message,
    created_at: r.created_at,
    display_time: hhmm(r.created_at)
  };
}

app.post("/api/broadcast", async (req, res) => {
  try {
    const { wallet, message } = req.body;
    if (!wallet || !message) return res.status(400).json({ error: "Missing" });

    const { data, error } = await supabase
      .from("hub_broadcasts")
      .insert([{ wallet, message }])
      .select()
      .maybeSingle();

    if (error) throw error;
    const row = normRow(data);
    wsBroadcast({ type: "insert", row });
    res.json({ success: true, data: row });
  } catch (e) {
    err("Broadcast error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/broadcasts", async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("hub_broadcasts")
      .select("id, wallet, message, created_at")
      .order("created_at", { ascending: false })
      .limit(25);
    if (error) throw error;
    res.json((data || []).map(normRow));
  } catch (e) {
    err("Broadcasts GET error:", e);
    res.status(500).json({ error: e.message });
  }
});

/* ---------- Refunds ---------- */
app.post("/api/refund", async (req, res) => {
  try {
    const { wallet, token, rent, tx, status } = req.body;
    if (!wallet || !tx) return res.status(400).json({ error: "Missing" });
    const { data, error } = await supabase
      .from("hub_refund_history")
      .insert([{ wallet, token: token || "UNKNOWN", rent_reclaimed: rent ?? 0, tx, status: status || "Success" }])
      .select();
    if (error) throw error;
    res.json({ success: true, inserted: data });
  } catch (e) {
    err("Refund insert error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/refund-history", async (req, res) => {
  try {
    const { wallet } = req.query;
    if (!wallet) return res.status(400).json({ error: "Missing wallet" });
    const { data, error } = await supabase
      .from("hub_refund_history")
      .select("*")
      .eq("wallet", wallet)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    err("Refund history error:", e);
    res.status(500).json({ error: e.message });
  }
});

/* ---------- WebSocket + Realtime ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Set();

wss.on("connection", async (socket) => {
  socket.isAlive = true;
  clients.add(socket);
  socket.on("pong", () => { socket.isAlive = true; });
  socket.on("close", () => clients.delete(socket));

  try {
    const { data } = await supabase
      .from("hub_broadcasts")
      .select("id, wallet, message, created_at")
      .order("created_at", { ascending: false })
      .limit(25);
    socket.send(JSON.stringify({ type: "hello", rows: (data || []).map(normRow) }));
  } catch (e) {
    err("WS hello failed:", e);
  }
});

setInterval(() => {
  for (const s of clients) {
    if (!s.isAlive) return s.terminate();
    s.isAlive = false;
    s.ping();
  }
}, 30000);

function wsBroadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const s of clients) {
    if (s.readyState === s.OPEN) s.send(msg);
  }
}

let rtChannel = null;
function subscribe() {
  try {
    if (rtChannel) supabase.removeChannel(rtChannel);
    rtChannel = supabase
      .channel("rt:hub_broadcasts")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "hub_broadcasts" }, (p) => {
        const row = normRow(p.new);
        if (row) {
          log("New broadcast");
          wsBroadcast({ type: "insert", row });
        }
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") log("Realtime: LIVE");
        else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
          warn(`Realtime ${status} — reconnecting...`);
          setTimeout(subscribe, 2000);
        }
      });
  } catch (e) {
    err("Subscribe failed:", e);
    setTimeout(subscribe, 2000);
  }
}
subscribe();

/* ---------- Start ---------- */
server.listen(PORT, () => {
  log(`BLACKCOIN OPERATOR HUB BACKEND v10.0 — LIVE ON PORT ${PORT}`);
  log(`WebSocket: ws://localhost:${PORT}/ws`);
  log(`Frontend: http://localhost:${PORT}/OperatorHub.html`);
});