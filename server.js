// server.js — BLACKCOIN OPERATOR HUB BACKEND v11.1 — realtime broadcasts restored
/* Key points:
 * - Keeps all v11 features (chart poller, profiles, avatar upload, balances, refund log/history, /api/rpc).
 * - WebSocket server on /ws.
 * - Realtime subscription for hub_broadcasts now matches your old, working pattern:
 *      • INSERT → { type:"insert", row }
 *      • UPDATE → { type:"update", row }
 *      • DELETE → { type:"delete", id }
 *   so deleting a row in Supabase instantly removes it from Signal Room.
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
app.use(express.static("public")); // serves OperatorHub.html etc.

/* ---------- tiny log helpers ---------- */
function ts() { return `[${new Date().toTimeString().slice(0, 8)}]`; }
const log  = (...a) => console.log(ts(), ...a);
const warn = (...a) => console.warn(ts(), ...a);
const err  = (...a) => console.error(ts(), ...a);

/* ---------- Supabase ---------- */
const SUPABASE_URL = process.env.SUPABASE_URL;
// Accept both names so it works with your existing Render env
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

/* ---------- Chart Poller (DexScreener) ---------- */
const TOKEN_MINT = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";
let FETCH_INTERVAL = 70000;
const BACKOFF_INTERVAL = 180000;
let isBackoff = false,
  fetchInProgress = false,
  pollTimer = null;
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
  log("⏱️  Polling DexScreener...");
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`,
      { headers: { "Cache-Control": "no-cache" } }
    );

    if (res.status === 429) {
      warn("⚠️  429 — entering backoff");
      return "backoff";
    }
    if (!res.ok) {
      warn(`⚠️  Upstream ${res.status} — continuing`);
      return "softfail";
    }

    const json = await res.json();
    const pair = json.pairs?.[0];
    if (!pair) {
      warn("⚠️  No pairs in response");
      return "softfail";
    }

    const point = {
      timestamp: new Date().toISOString(),
      price: +pair.priceUsd,
      change: +(pair.priceChange?.h24),
      volume: +(pair.volume?.h24),
    };

    if (Object.values(point).some((v) => isNaN(v))) {
      warn("⚠️  Invalid numeric fields — skipping insert");
      return "softfail";
    }

    memoryCache.push(point);
    if (memoryCache.length > 10000) memoryCache.shift();
    await insertPoint(point);
    log("✅ Chart data stored");
    return "ok";
  } catch (e) {
    err("fetchOneTick failed:", e);
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
  if (fetchInProgress) {
    warn("⏸️  Previous fetch still running — skipping");
    return scheduleNext(isBackoff ? BACKOFF_INTERVAL : FETCH_INTERVAL);
  }
  const r = await fetchOneTick();
  if (r === "backoff") {
    isBackoff = true;
    return scheduleNext(BACKOFF_INTERVAL);
  }
  if (isBackoff && r === "ok") {
    isBackoff = false;
    log("⏳  Backoff ended — resume normal interval");
  }
  scheduleNext(FETCH_INTERVAL);
}
pollLoop();

/* ---------- Chart API ---------- */
function bucketMs(interval) {
  switch (interval) {
    case "1m":  return 60e3;
    case "5m":  return 300e3;
    case "30m": return 1800e3;
    case "1h":  return 3600e3;
    case "D":   return 86400e3;
    default:    return 60e3;
  }
}
function getWindow(interval) {
  const now = Date.now();
  if (interval === "D")  return new Date(now - 30 * 86400e3).toISOString();
  if (interval === "1h") return new Date(now - 7  * 86400e3).toISOString();
  return new Date(now - 86400e3).toISOString();
}
function floorToBucketUTC(tsISO, interval) {
  const ms = bucketMs(interval);
  const d = new Date(tsISO);
  return new Date(Math.floor(d.getTime() / ms) * ms);
}
function bucketize(rows, interval) {
  const m = new Map();
  for (const r of rows) {
    const key = floorToBucketUTC(r.timestamp, interval).toISOString();
    const price = +r.price, change = +r.change, vol = +r.volume;
    if (!m.has(key)) {
      m.set(key, { timestamp: key, price, change, volume: 0 });
    }
    const b = m.get(key);
    b.price = price;
    b.change = change;
    b.volume += isNaN(vol) ? 0 : vol;
  }
  return Array.from(m.values()).sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );
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

    const raw = data?.length
      ? data
      : memoryCache.filter((p) => new Date(p.timestamp) >= new Date(cutoff));

    const points = bucketize(raw, interval);
    const latest = raw.length ? raw[raw.length - 1] : memoryCache.at(-1);
    const totalCount = count || raw.length;
    const nextPage = offset + limit < totalCount ? page + 1 : null;

    res.json({ points, latest, page, nextPage, hasMore: Boolean(nextPage) });
  } catch (e) {
    err("Error /api/chart:", e);
    res.status(500).json({ error: "Failed to fetch chart data" });
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
    err("Error /api/latest:", e);
    res.status(500).json({ error: "Failed" });
  }
});

/* ---------- Profile + Avatar ---------- */
app.post("/api/profile", async (req, res) => {
  try {
    // Required
    const wallet = String(req.body.wallet || "").trim();
    if (!wallet) return res.status(400).json({ error: "Missing wallet" });

    // Optional fields — treat empty strings and null/undefined as "not provided"
    let handle = req.body.handle;
    if (typeof handle === "string") {
      handle = handle.trim();
      if (handle === "") handle = undefined;
    } else if (handle == null) {
      handle = undefined;
    }

    let avatar_url = req.body.avatar_url;
    if (typeof avatar_url === "string") {
      avatar_url = avatar_url.trim();
      if (avatar_url === "") avatar_url = undefined;
    } else if (avatar_url == null) {
      avatar_url = undefined;
    }

    // If neither field provided, nothing to do
    if (handle === undefined && avatar_url === undefined) {
      return res.status(400).json({ error: "no fields to update" });
    }

    // Fetch existing row (if any)
    const { data: existing, error: selErr } = await supabase
      .from("hub_profiles")
      .select("wallet, handle, avatar_url")
      .eq("wallet", wallet)
      .maybeSingle();

    if (selErr) {
      return res.status(500).json({ error: "select_failed", detail: selErr.message });
    }

    // Build PATCH with only provided keys
    const patch = { updated_at: new Date().toISOString() };
    if (handle !== undefined) patch.handle = handle;
    if (avatar_url !== undefined) patch.avatar_url = avatar_url;

    if (existing) {
      // Update only provided columns
      const { data, error } = await supabase
        .from("hub_profiles")
        .update(patch)
        .eq("wallet", wallet)
        .select()
        .maybeSingle();

      if (error) return res.status(500).json({ error: "update_failed", detail: error.message });
      return res.json({ success: true, profile: data });
    } else {
      // Insert minimal new row with only provided columns
      const insertRow = { wallet, ...patch };
      const { data, error } = await supabase
        .from("hub_profiles")
        .insert(insertRow)
        .select()
        .maybeSingle();

      if (error) return res.status(500).json({ error: "insert_failed", detail: error.message });
      return res.json({ success: true, profile: data });
    }
  } catch (e) {
    err("Profile save error:", e);
    res.status(500).json({ error: String(e.message || e) });
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
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (uploadErr) throw uploadErr;

    const { data: urlData } = supabase
      .storage
      .from("hub_avatars")
      .getPublicUrl(fileName);
    const url = urlData.publicUrl;

    const { error: updErr } = await supabase
      .from("hub_profiles")
      .upsert(
        { wallet, avatar_url: url, updated_at: new Date().toISOString() },
        { onConflict: "wallet" }
      );

    if (updErr) throw updErr;

    res.json({ success: true, url });
  } catch (e) {
    err("Avatar upload error:", e);
    res.status(500).json({ error: e.message });
  }
});

/* ---------- Balances (Helius RPC + DexScreener + Jupiter) ---------- */
const HELIUS_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_KEY) warn("HELIUS_API_KEY missing — /api/balances will 400 if called.");
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

const TOKEN_PROGRAM_ID      = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// Caches
const SOL_CACHE   = { priceUsd: null, ts: 0 };
const META_CACHE  = new Map();  // mint -> { data, ts }
const PRICE_CACHE = new Map();  // mint -> { priceUsd, ts }
const TTL_PRICE   = 15_000;     // 15s prices
const TTL_META    = 6 * 60 * 60 * 1000;
const TTL_SOL     = 25_000;

// ---------- Token meta cache (merged from Helius DAS + Jupiter + Dexscreener + Pump) ----------
const META_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const MEMO_META = new Map();

function memoGetMeta(mint){
  const e = MEMO_META.get(mint);
  if (!e) return null;
  if (Date.now() - e.t > META_TTL_MS) { MEMO_META.delete(mint); return null; }
  return e.v;
}
function memoSetMeta(mint, v){ MEMO_META.set(mint, { v, t: Date.now() }); }

// Helius DAS (via the same HELIUS_RPC): getAsset
async function fetchHeliusDAS(mint){
  try{
    const r = await fetch(HELIUS_RPC, {
      method: "POST",
      headers: {"content-type":"application/json"},
      body: JSON.stringify({ jsonrpc:"2.0", id:1, method:"getAsset", params:{ id: mint } })
    });
    const j = await r.json();
    const a = j?.result;
    if (!a) return null;
    const name   = a?.content?.metadata?.name || a?.token_info?.symbol || null;
    const symbol = a?.token_info?.symbol || a?.content?.metadata?.symbol || null;
    const image  = a?.content?.links?.image || null;
    const desc   = a?.content?.metadata?.description || null;
    const decimals = Number(a?.token_info?.decimals ?? 0);
    const supply   = Number(a?.token_info?.supply ?? 0);
    return { name, symbol, image, description: desc, decimals, supply };
  }catch{ return null; }
}

async function fetchJupiterMetaLoose(mint){
  try{
    const r = await fetch(`https://tokens.jup.ag/token/${mint}`, { cache:"no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    return {
      name: j?.name || null,
      symbol: j?.symbol || null,
      decimals: typeof j?.decimals === "number" ? j.decimals : undefined,
      image: j?.logoURI || null
    };
  }catch{ return null; }
}

async function fetchDexscreenerMeta(mint){
  try{
    const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${mint}`);
    const j = await r.json();
    const p = j?.pairs?.[0];
    if (!p) return null;
    // Dexscreener sometimes exposes base token fields + liquidity/FDV
    const holders = Number(p?.holders || 0); // often absent; keep as best-effort
    return {
      price_usd: Number(p?.priceUsd) || 0,
      market_cap_usd: Number(p?.fdv || p?.marketCap || 0),
      holders: holders > 0 ? holders : null
    };
  }catch{ return null; }
}

async function fetchPumpFunMeta(mint){
  try{
    const r = await fetch(`https://frontend-api.pump.fun/coins/${mint}`);
    if (!r.ok) return null;
    const j = await r.json();
    return {
      description: j?.description || null,
      image: j?.image_uri || null
    };
  }catch{ return null; }
}

function mergeMetaParts(...parts){
  const out = {};
  for (const p of parts) {
    if (!p) continue;
    for (const [k,v] of Object.entries(p)) {
      if (out[k] == null || out[k] === 0 || out[k] === "") out[k] = v;
    }
  }
  return out;
}

// GET /api/token-meta?mint=...
app.get("/api/token-meta", async (req, res) => {
  try{
    const mint = String(req.query.mint || "").trim();
    if (!mint) return res.status(400).json({ error:"mint required" });

    // in-memory cache
    const memo = memoGetMeta(mint);
    if (memo) return res.json(memo);

    // supabase cache (≤6h)
    const { data: cached } = await supabase
      .from("token_meta")
      .select("*")
      .eq("mint", mint)
      .maybeSingle();

    if (cached && (Date.now() - new Date(cached.updated_at).getTime() < META_TTL_MS)) {
      memoSetMeta(mint, cached);
      return res.json(cached);
    }

    // fan-out to sources in parallel
    const [hel, jup, dskr, pump] = await Promise.all([
      fetchHeliusDAS(mint),
      fetchJupiterMetaLoose(mint),
      fetchDexscreenerMeta(mint),
      fetchPumpFunMeta(mint)
    ]);

    let merged = mergeMetaParts(hel, jup, pump, dskr);

    // compute market cap if missing and we have price + supply
    if ((!merged.market_cap_usd || merged.market_cap_usd === 0) &&
        merged.price_usd && merged.supply) {
      merged.market_cap_usd = merged.price_usd * merged.supply;
    }

    const payload = {
      mint,
      name: merged.name || jup?.name || hel?.name || null,
      symbol: merged.symbol || jup?.symbol || hel?.symbol || null,
      decimals: typeof merged.decimals === "number" ? merged.decimals :
                (typeof jup?.decimals === "number" ? jup.decimals :
                 (typeof hel?.decimals === "number" ? hel.decimals : 0)),
      image: merged.image || jup?.image || hel?.image || null,
      description: merged.description || pump?.description || null,
      supply: Number(merged.supply || 0),
      price_usd: Number(merged.price_usd || 0),
      market_cap_usd: Number(merged.market_cap_usd || 0),
      holders: typeof merged.holders === "number" ? merged.holders : null,
      source: { helius: !!hel, jupiter: !!jup, dexscreener: !!dskr, pump: !!pump },
      updated_at: new Date().toISOString()
    };

    // upsert cache
    await supabase.from("token_meta").upsert(payload, { onConflict: "mint" });

    memoSetMeta(mint, payload);
    res.json(payload);
  }catch(e){
    err("token-meta error:", e);
    res.status(500).json({ error:"meta_failed", detail:String(e?.message || e) });
  }
});


// Generic RPC helper
async function rpc(method, params) {
  const r = await fetch(HELIUS_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
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
    const r = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=false"
    );
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

// Token metadata (symbol/name/logo/decimals) via Jupiter
async function getTokenMeta(mint) {
  const now = Date.now();
  const cached = META_CACHE.get(mint);
  if (cached && now - cached.ts < TTL_META) return cached.data;

  // 1) Try backend cache endpoint first (fast path)
  try{
    const r = await fetch(`${process.env.PUBLIC_URL || ""}/api/token-meta?mint=${encodeURIComponent(mint)}`);
    if (r.ok){
      const j = await r.json();
      const meta = {
        symbol: j?.symbol || "",
        name: j?.name || "",
        logo: j?.image || "",
        decimals: typeof j?.decimals === "number" ? j.decimals : undefined,
        // keep your existing flags shape so the rest of code stays untouched
        tags: [],
        isVerified: Boolean(j?.market_cap_usd || j?.price_usd || j?.supply),
      };
      META_CACHE.set(mint, { ts: now, data: meta });
      return meta;
    }
  }catch{}

  // 2) Fallback to your previous Jupiter-only lookup
  try {
    const r = await fetch(`https://tokens.jup.ag/token/${mint}`);
    if (r.ok) {
      const j = await r.json();
      const meta = {
        symbol: j?.symbol || "",
        name: j?.name || "",
        logo: j?.logoURI || "",
        tags: Array.isArray(j?.tags) ? j.tags : [],
        isVerified: Boolean(
          j?.extensions?.coingeckoId ||
          j?.daily_volume ||
          j?.liquidity ||
          j?.verified
        ),
        decimals: typeof j?.decimals === "number" ? j.decimals : undefined,
      };
      META_CACHE.set(mint, { ts: now, data: meta });
      return meta;
    }
  } catch {}

  const meta = {
    symbol: "",
    name: "",
    logo: "",
    tags: [],
    isVerified: false,
    decimals: undefined,
  };
  META_CACHE.set(mint, { ts: now, data: meta });
  return meta;
}

  } catch {}

  const meta = {
    symbol: "",
    name: "",
    logo: "",
    tags: [],
    isVerified: false,
    decimals: undefined,
  };
  META_CACHE.set(mint, { ts: now, data: meta });
  return meta;
}

// Price: DexScreener (primary), Jupiter (fallback) + WS tick broadcast
async function getTokenUsd(mint) {
  const now = Date.now();

  // Serve hot cache when fresh
  const cached = PRICE_CACHE.get(mint);
  if (cached && now - cached.ts < TTL_PRICE) return cached.priceUsd;

  // Helper: set cache + broadcast tick if value changed and > 0
  const setAndMaybeBroadcast = (val) => {
    const prev = PRICE_CACHE.get(mint)?.priceUsd;
    PRICE_CACHE.set(mint, { ts: now, priceUsd: val });

    if (typeof wsBroadcastAll === "function" && val > 0 && val !== prev) {
      try {
        wsBroadcastAll({ type: "price", mint, priceUsd: val });
      } catch {}
    }
    return val;
  };

  // ---------- DexScreener primary ----------
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(mint)}`, {
      headers: { "Cache-Control": "no-cache" }
    });

    if (r.ok) {
      const j = await r.json();
      const pairs = Array.isArray(j?.pairs) ? j.pairs : [];

      // Prefer exact baseToken.address==mint on Solana; else fall back to first
      const best =
        pairs.find(p => p?.chainId === "solana" && p?.baseToken?.address === mint) ||
        pairs.find(p => p?.baseToken?.address === mint) ||
        pairs[0];

      const p = Number(best?.priceUsd) || 0;
      if (p > 0) return setAndMaybeBroadcast(p);
    }
  } catch {
    // swallow; try fallback
  }

  // ---------- Jupiter fallback ----------
  try {
    const r2 = await fetch(`https://price.jup.ag/v6/price?ids=${encodeURIComponent(mint)}`, {
      headers: { "Cache-Control": "no-cache" }
    });
    if (r2.ok) {
      const j2 = await r2.json();
      const p2 = Number(j2?.data?.[mint]?.price) || 0;
      if (p2 > 0) return setAndMaybeBroadcast(p2);
    }
  } catch {
    // swallow; will return 0 below
  }

  // No price found — cache zero (no broadcast)
  PRICE_CACHE.set(mint, { ts: now, priceUsd: 0 });
  return 0;
}

// Normalize parsed token account
function parseParsedAccount(acc) {
  const info = acc?.account?.data?.parsed?.info;
  const amt = info?.tokenAmount || info?.parsed?.info?.tokenAmount || info?.uiTokenAmount || {};
  const decimals = Number(amt?.decimals ?? info?.decimals ?? 0);
  const raw = amt?.amount != null ? String(amt.amount) : null;

  const uiAmount = raw && decimals >= 0
    ? Number(raw) / Math.pow(10, decimals)
    : Number(amt?.uiAmount ?? 0);

  return {
    mint: info?.mint || info?.parsed?.info?.mint || "",
    amount: uiAmount || 0,
    decimals,
  };
}

async function getAllSplTokenAccounts(owner) {
  const legacy = await rpc("getTokenAccountsByOwner", [
    owner,
    { programId: TOKEN_PROGRAM_ID },
    { encoding: "jsonParsed" },
  ]);
  const t22 = await rpc("getTokenAccountsByOwner", [
    owner,
    { programId: TOKEN_2022_PROGRAM_ID },
    { encoding: "jsonParsed" },
  ]);

  const list = []
    .concat(legacy?.value || [], t22?.value || [])
    .map(parseParsedAccount)
    .filter((t) => t.mint && t.amount > 0);

  const byMint = new Map();
  for (const t of list) {
    const prev = byMint.get(t.mint);
    if (prev) {
      prev.amount += t.amount;
      if (typeof prev.decimals !== "number" && typeof t.decimals === "number") {
        prev.decimals = t.decimals;
      }
    } else {
      byMint.set(t.mint, { ...t });
    }
  }
  return Array.from(byMint.values());
}

app.post("/api/balances", async (req, res) => {
  try {
    const wallet = req.body?.wallet?.trim();
    if (!wallet || !HELIUS_KEY) {
      return res.status(400).json({ error: "Bad request" });
    }

    const solBal = await rpc("getBalance", [wallet, { commitment: "confirmed" }]);
    const sol = Number(solBal?.value || 0) / 1e9;
    const solUsd = await getSolUsd();

    const tokenAccounts = await getAllSplTokenAccounts(wallet);

    const enriched = await Promise.all(
      tokenAccounts.map(async (t) => {
        const meta = await getTokenMeta(t.mint);
        const decimals =
          typeof meta.decimals === "number" ? meta.decimals : t.decimals;
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
          usd,
        };
      })
    );

    enriched.sort((a, b) => (b.usd || 0) - (a.usd || 0));

    res.json({ sol, solUsd, tokens: enriched });
  } catch (e) {
    err("Balances error:", e);
    res.status(500).json({ error: "Failed" });
  }
});

/* ---------- Broadcasts (HTTP) ---------- */
const hhmm = (iso) => {
  try {
    return new Date(iso).toTimeString().slice(0, 5);
  } catch {
    return "";
  }
};

function normRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    wallet: r.wallet,
    message: r.message,
    created_at: r.created_at,
    display_time: hhmm(r.created_at),
  };
}

app.post("/api/broadcast", async (req, res) => {
  try {
    const { wallet, message } = req.body;
    if (!wallet || !message) {
      return res.status(400).json({ error: "Missing" });
    }

    const { data, error } = await supabase
      .from("hub_broadcasts")
      .insert([{ wallet, message }])
      .select()
      .maybeSingle();

    if (error) throw error;
    const row = normRow(data);

    // instant echo so DEV sees their own post immediately
    wsBroadcastAll({ type: "insert", row });

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

/* ---------- Refund History (HTTP) ---------- */
function normRefundRow(r) {
  if (!r) return null;
  const tx = r.tx || "";
  const solscan_url = tx ? `https://solscan.io/tx/${tx}` : null;
  return {
    id: r.id,
    wallet: r.wallet,
    token: r.token,
    tx,
    solscan_url,
    date: r.date,
    status: r.status,
    created_at: r.created_at,
    rent_reclaimed:
      typeof r.rent_reclaimed === "number"
        ? r.rent_reclaimed
        : Number(r.rent_reclaimed || 0),
  };
}

app.post("/api/refund-log", async (req, res) => {
  try {
    const { wallet, token, tx, date, status, rent_reclaimed } = req.body || {};
    if (!wallet || !token || !tx) {
      return res
        .status(400)
        .json({ error: "Missing required fields (wallet, token, tx)" });
    }
    const payload = {
      wallet,
      token,
      tx,
      date: date || new Date().toISOString(),
      status: status || "success",
      rent_reclaimed:
        typeof rent_reclaimed === "number"
          ? rent_reclaimed
          : Number(rent_reclaimed || 0),
    };

    const { data, error } = await supabase
      .from("hub_refund_history")
      .insert([payload])
      .select()
      .maybeSingle();

    if (error) throw error;
    const row = normRefundRow(data);
    // optional: could also wsBroadcastToWallet(wallet, { type:"refund_insert", row });
    res.json({ success: true, data: row });
  } catch (e) {
    err("Refund-log error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/refund-history", async (req, res) => {
  try {
    const wallet = (req.query.wallet || "").trim();
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    if (!wallet) return res.status(400).json({ error: "Missing wallet" });

    const { data, error } = await supabase
      .from("hub_refund_history")
      .select("id, wallet, token, tx, date, status, created_at, rent_reclaimed")
      .eq("wallet", wallet)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json((data || []).map(normRefundRow));
  } catch (e) {
    err("Refund-history GET error:", e);
    res.status(500).json({ error: e.message });
  }
});

/* ---------- Optional RPC Proxy (Helius) ---------- */
// Frontend calls POST /api/rpc with { method, params }.
// If you ever want GET style, you can add it later.
app.post("/api/rpc", async (req, res) => {
  try {
    const { method, params } = req.body || {};
    if (!HELIUS_KEY) {
      return res
        .status(400)
        .json({ error: "HELIUS_API_KEY not configured on backend" });
    }
    if (!method) return res.status(400).json({ error: "Missing method" });

    const r = await fetch(HELIUS_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: params || [],
      }),
    });
    const j = await r.json();
    res.status(r.ok ? 200 : 502).json(j);
  } catch (e) {
    err("RPC proxy error:", e);
    res.status(500).json({ error: "RPC proxy failed" });
  }
});

// Simple GET so the frontend can auto-detect the RPC URL
app.get("/api/rpc", (_req, res) => {
  if (!HELIUS_KEY) {
    return res.status(400).json({ error: "HELIUS_API_KEY not configured" });
  }
  // Frontend expects one of: rpc / helius / rpc_url / rpcUrl
  return res.json({ rpc: HELIUS_RPC });
});



/* ---------- WebSocket + Realtime ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Set();

wss.on("connection", async (socket) => {
  socket.isAlive = true;
  clients.add(socket);

  socket.on("pong", () => {
    socket.isAlive = true;
  });

  socket.on("close", () => {
    clients.delete(socket);
  });

  socket.on("error", (e) => {
    err("WS error:", e?.message || e);
  });

  // initial hello → last 25 broadcasts
  try {
    const { data, error } = await supabase
      .from("hub_broadcasts")
      .select("id, wallet, message, created_at")
      .order("created_at", { ascending: false })
      .limit(25);
    if (!error && data) {
      const rows = (data || []).map(normRow);
      socket.send(JSON.stringify({ type: "hello", rows }));
    }
  } catch (e) {
    err("WS hello failed:", e?.message || e);
  }
});

setInterval(() => {
  for (const s of clients) {
    if (s.isAlive === false) {
      try {
        s.terminate();
      } catch {}
      continue;
    }
    s.isAlive = false;
    try {
      s.ping();
    } catch {}
  }
}, 30000);

function wsBroadcastAll(obj) {
  const msg = JSON.stringify(obj);
  for (const s of clients) {
    if (s.readyState === s.OPEN) s.send(msg);
  }
}

/* ---------- Supabase Realtime: broadcasts only (matches your old working code) ---------- */
let rtChannel = null;
function subscribeToBroadcasts() {
  try {
    if (rtChannel) {
      try { supabase.removeChannel(rtChannel); } catch {}
      rtChannel = null;
    }

    rtChannel = supabase
      .channel("rt:hub_broadcasts", {
        config: { broadcast: { ack: true }, presence: { key: "server" } },
      })
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "hub_broadcasts" },
        (payload) => {
          const row = normRow(payload?.new || payload?.record);
          log("🔔 INSERT hub_broadcasts id=", row?.id);
          if (row) wsBroadcastAll({ type: "insert", row });
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "hub_broadcasts" },
        (payload) => {
          const row = normRow(payload?.new || payload?.record);
          log("🔧 UPDATE hub_broadcasts id=", row?.id);
          if (row) wsBroadcastAll({ type: "update", row });
        }
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "hub_broadcasts" },
        (payload) => {
          const old = payload?.old || payload?.record || null;
          const id = old?.id;
          log("🗑️  DELETE hub_broadcasts id=", id);
          if (id) wsBroadcastAll({ type: "delete", id });
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          log("✅ Realtime subscribed: hub_broadcasts");
        } else if (status === "CHANNEL_ERROR") {
          err("❌ Realtime CHANNEL_ERROR — retrying in 2s");
          setTimeout(subscribeToBroadcasts, 2000);
        } else if (status === "TIMED_OUT") {
          warn("⚠️ Realtime TIMED_OUT — retrying in 2s");
          setTimeout(subscribeToBroadcasts, 2000);
        } else if (status === "CLOSED") {
          warn("⚠️ Realtime CLOSED — retrying in 2s");
          setTimeout(subscribeToBroadcasts, 2000);
        }
      });
  } catch (e) {
    err("Realtime subscribe failed:", e?.message || e);
    setTimeout(subscribeToBroadcasts, 2000);
  }
}
subscribeToBroadcasts();

/* ---------- Start ---------- */
server.listen(PORT, () => {
  log(`BLACKCOIN OPERATOR HUB BACKEND v11.1 — LIVE ON PORT ${PORT}`);
  log(`WebSocket: ws://localhost:${PORT}/ws`);
  log(`Frontend:  http://localhost:${PORT}/OperatorHub.html`);
});
