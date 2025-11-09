// server.js — BLACKCOIN OPERATOR HUB BACKEND v10.0 — FINAL NUCLEAR EDITION (patched+refund-history)
/* Changes:
 * - Realtime: add UPDATE + DELETE handlers so broadcast deletes/edits propagate instantly
 * - Env vars: accept SUPABASE_SERVICE_ROLE_KEY or SUPABASE_KEY (backward compatible)
 * - Clearer missing-env error message
 * - NEW: Refund History endpoints (POST/GET) writing to hub_refund_history with server-side timestamps
 */
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
// Accept both names to match your Render config
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  err("Missing required env vars: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY).");
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

/* ---------- Balances (Helius RPC + DexScreener + Jupiter) ---------- */
const HELIUS_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_KEY) warn("HELIUS_API_KEY missing");
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

const TOKEN_PROGRAM_ID      = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // SPL legacy
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"; // SPL-2022

// Caches
const SOL_CACHE = { priceUsd: null, ts: 0 };
const META_CACHE = new Map();    // mint -> { symbol, name, logo, tags, verified, decimals? }
const PRICE_CACHE = new Map();   // mint -> { priceUsd, ts }
const TTL_PRICE = 30_000;        // 30s for prices
const TTL_META  = 6 * 60 * 60 * 1000; // 6h for token metadata
const TTL_SOL   = 25_000;

// Small helpers
async function rpc(method, params) {
  const r = await fetch(HELIUS_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  if (!r.ok) throw new Error(`RPC ${method} HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${method} error: ${j.error.message || "unknown"}`);
  return j.result;
}

async function getSolUsd() {
  const now = Date.now();
  if (SOL_CACHE.priceUsd && now - SOL_CACHE.ts < TTL_SOL) return SOL_CACHE.priceUsd;
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=false");
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

// ---- Token metadata (symbol/name/logo/verified/tags) via Jupiter first ----
async function getTokenMeta(mint) {
  const now = Date.now();
  const cached = META_CACHE.get(mint);
  if (cached && now - cached.ts < TTL_META) return cached.data;

  // Jupiter token endpoint returns rich metadata
  try {
    const r = await fetch(`https://tokens.jup.ag/token/${mint}`);
    if (r.ok) {
      const j = await r.json();
      const meta = {
        symbol: j?.symbol || "",
        name: j?.name || "",
        logo: j?.logoURI || "",
        tags: Array.isArray(j?.tags) ? j.tags : [],
        isVerified: Boolean(j?.extensions?.coingeckoId || j?.daily_volume || j?.liquidity || j?.verified),
        decimals: typeof j?.decimals === "number" ? j.decimals : undefined
      };
      META_CACHE.set(mint, { ts: now, data: meta });
      return meta;
    }
  } catch {}

  // Fallback: lean meta (nothing fancy)
  const meta = { symbol: "", name: "", logo: "", tags: [], isVerified: false, decimals: undefined };
  META_CACHE.set(mint, { ts: now, data: meta });
  return meta;
}

// ---- Price: DexScreener primary, Jupiter fallback
async function getTokenUsd(mint) {
  const now = Date.now();
  const c = PRICE_CACHE.get(mint);
  if (c && now - c.ts < TTL_PRICE) return c.priceUsd;

  // 1) DexScreener
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${mint}`);
    if (r.ok) {
      const j = await r.json();
      const p = Number(j?.pairs?.[0]?.priceUsd) || 0;
      if (p > 0) {
        PRICE_CACHE.set(mint, { ts: now, priceUsd: p });
        return p;
      }
    }
  } catch {}

  // 2) Jupiter price fallback
  try {
    const r2 = await fetch(`https://price.jup.ag/v6/price?ids=${encodeURIComponent(mint)}`);
    if (r2.ok) {
      const j2 = await r2.json();
      const p2 = Number(j2?.data?.[mint]?.price) || 0;
      if (p2 > 0) {
        PRICE_CACHE.set(mint, { ts: now, priceUsd: p2 });
        return p2;
      }
    }
  } catch {}

  PRICE_CACHE.set(mint, { ts: now, priceUsd: 0 });
  return 0;
}

// Normalize one parsed token account from RPC
function parseParsedAccount(acc) {
  // rpc result item: { pubkey, account: { data: { parsed: {...} } } }
  const info = acc?.account?.data?.parsed?.info;
  const amt  = info?.tokenAmount || info?.parsed?.info?.tokenAmount || info?.uiTokenAmount || {};
  const decimals = Number(amt?.decimals ?? info?.decimals ?? 0);
  const raw = amt?.amount != null ? String(amt.amount) : null;

  const uiAmount = (raw && decimals >= 0)
    ? Number(raw) / Math.pow(10, decimals)
    : Number(amt?.uiAmount ?? 0);

  return {
    mint: info?.mint || info?.parsed?.info?.mint || "",
    amount: uiAmount || 0,
    decimals
  };
}

async function getAllSplTokenAccounts(owner) {
  // Legacy program
  const legacy = await rpc("getTokenAccountsByOwner", [
    owner,
    { programId: TOKEN_PROGRAM_ID },
    { encoding: "jsonParsed" }
  ]);
  // Token-2022 program
  const t22 = await rpc("getTokenAccountsByOwner", [
    owner,
    { programId: TOKEN_2022_PROGRAM_ID },
    { encoding: "jsonParsed" }
  ]);

  const list = []
    .concat(legacy?.value || [], t22?.value || [])
    .map(parseParsedAccount)
    // Hide zero-balance tokens (your Q3 = No)
    .filter(t => t.mint && t.amount > 0);

  // Combine duplicates (same mint across multiple ATAs)
  const byMint = new Map();
  for (const t of list) {
    const prev = byMint.get(t.mint);
    if (prev) {
      prev.amount += t.amount;
      // prefer a defined decimals
      if (typeof prev.decimals !== "number" && typeof t.decimals === "number") prev.decimals = t.decimals;
    } else {
      byMint.set(t.mint, { ...t });
    }
  }
  return Array.from(byMint.values());
}

app.post("/api/balances", async (req, res) => {
  try {
    const wallet = req.body?.wallet?.trim();
    if (!wallet || !HELIUS_KEY) return res.status(400).json({ error: "Bad request" });

    // 1) SOL balance
    const solBal = await rpc("getBalance", [wallet, { commitment: "confirmed" }]);
    const sol = Number(solBal?.value || 0) / 1e9;
    const solUsd = await getSolUsd();

    // 2) SPL token accounts (legacy + 2022)
    const tokenAccounts = await getAllSplTokenAccounts(wallet);

    // 3) Enrich with metadata + pricing (rich object)
    const enriched = await Promise.all(tokenAccounts.map(async t => {
      const meta = await getTokenMeta(t.mint);
      // if decimals missing from meta, keep RPC decimals
      const decimals = typeof meta.decimals === "number" ? meta.decimals : t.decimals;
      const priceUsd = await getTokenUsd(t.mint);
      const usd = priceUsd * t.amount;

      return {
        mint: t.mint,
        amount: t.amount,
        decimals,
        symbol: meta.symbol || "",
        name: meta.name || "",
        logo: meta.logo || "",
        tags: meta.tags || [],
        isVerified: Boolean(meta.isVerified),
        priceUsd,
        usd
      };
    }));

    // 4) Sort by USD desc
    enriched.sort((a, b) => (b.usd || 0) - (a.usd || 0));

    return res.json({
      sol,
      solUsd,
      tokens: enriched
    });
  } catch (e) {
    err("Balances error:", e);
    res.status(500).json({ error: "Failed" });
  }
});

/* ---------- Refund History (hub_refund_history) ---------- */
/* Fields: wallet, token, mint (nullable for MULTI), rent_reclaimed (number SOL), tx, status ("Success"), created_at (server) */
app.post("/api/refund-history", async (req, res) => {
  try {
    const { wallet, token, mint, rent_reclaimed, tx, status } = req.body || {};
    if (!wallet || !token || !tx) {
      return res.status(400).json({ error: "Missing required fields (wallet, token, tx)" });
    }
    const amount = Number(rent_reclaimed ?? 0);
    const row = {
      wallet: String(wallet).trim(),
      token: String(token).trim(),
      mint: mint ? String(mint).trim() : null,
      rent_reclaimed: isNaN(amount) ? 0 : amount,
      tx: String(tx).trim(),
      status: status ? String(status).trim() : "Success",
      created_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from("hub_refund_history")
      .insert([row])
      .select()
      .maybeSingle();

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (e) {
    err("Refund history insert error:", e);
    return res.status(500).json({ error: "Failed" });
  }
});

app.get("/api/refund-history", async (req, res) => {
  try {
    const wallet = (req.query?.wallet || "").trim();
    if (!wallet) return res.status(400).json({ error: "Missing wallet" });

    const { data, error } = await supabase
      .from("hub_refund_history")
      .select("wallet, token, mint, rent_reclaimed, tx, status, created_at")
      .eq("wallet", wallet)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) throw error;
    return res.json(data || []);
  } catch (e) {
    err("Refund history fetch error:", e);
    return res.status(500).json({ error: "Failed" });
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
    if (!s.isAlive) { try { s.terminate(); } catch {} continue; }
    s.isAlive = false;
    try { s.ping(); } catch {}
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
      // INSERTS
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "hub_broadcasts" }, (p) => {
        const row = normRow(p.new || p.record);
        if (row) {
          log("Realtime INSERT hub_broadcasts id=", row.id);
          wsBroadcast({ type: "insert", row });
        }
      })
      // UPDATES
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "hub_broadcasts" }, (p) => {
        const row = normRow(p.new || p.record);
        if (row) {
          log("Realtime UPDATE hub_broadcasts id=", row.id);
          wsBroadcast({ type: "update", row });
        }
      })
      // DELETES
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "hub_broadcasts" }, (p) => {
        const old = p.old || p.record || null;
        const id = old?.id;
        log("Realtime DELETE hub_broadcasts id=", id);
        if (id) wsBroadcast({ type: "delete", id });
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
