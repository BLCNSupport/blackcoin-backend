// server.js — BLACKCOIN OPERATOR HUB BACKEND v11.3 — Jupiter v3 price + Jupiter v2 tokens + Solscan meta
/* Key points:
 * - Prices: PRIMARY = Jupiter Price API v3 (Lite) at https://lite-api.jup.ag/price/v3
 *            Fallback = Dexscreener search
 * - Token meta: Jupiter Tokens API v2 search preferred, then Solscan/Helius/Pump/Dexscreener merge.
 * - /api/token-meta supports ?nocache=true to bypass memo + stale DB cache for that call.
 * - Keeps all v11.2 features (chart poller, profiles, avatar upload, balances, refund log/history, /api/rpc, WS).
 */

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import multer from "multer";
import { WebSocketServer } from "ws";
import http from "http";

/* === NEW: Solana + SPL Token for staking payouts === */
import * as web3 from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
  TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------- CORS ---------- */
// Use cors() so all routes (/api/balances, /api/token-meta, etc.) are CORS-safe.
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  })
);
// Handle preflight
app.options("*", cors());

// Body parsing + static files
app.use(express.json({ limit: "10mb" }));
app.use(express.static("public")); // serves OperatorHub.html / index.html / Terminal Hub, etc.

/* ---------- tiny log helpers ---------- */
function ts() {
  return `[${new Date().toTimeString().slice(0, 8)}]`;
}
const log = (...a) => console.log(ts(), ...a);
const warn = (...a) => console.warn(ts(), ...a);
const err = (...a) => console.error(ts(), ...a);

/* ---------- Supabase ---------- */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  err(
    "Missing required env vars: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY)."
  );
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ---------- Health ---------- */
app.get("/healthz", (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

/* ---------- Chart Poller (DexScreener) ---------- */
const TOKEN_MINT = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";

// Homepage “vaults” (same as in your HTML)
const CTO_WALLET = "6ssbYRD3yWy11XNSQXNgTzvmyoUPZcLMyTFMj8mcyC3";
const UTILITY_WALLET = "8XuN2RbJHKHkj4tRDxc2seG1YnCgEYnkxYXAq3FzXzf1";

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
    const pair = json?.pairs?.[0];
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

    if (Object.values(point).some((v) => Number.isNaN(v))) {
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
    case "1m":
      return 60e3;
    case "5m":
      return 300e3;
    case "30m":
      return 1800e3;
    case "1h":
      return 3600e3;
    case "D":
      return 86400e3;
    default:
      return 60e3;
  }
}
function getWindow(interval) {
  const now = Date.now();
  if (interval === "D")
    return new Date(now - 30 * 86400e3).toISOString();
  if (interval === "1h")
    return new Date(now - 7 * 86400e3).toISOString();
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
    const price = +r.price,
      change = +r.change,
      vol = +r.volume;
    if (!m.has(key)) {
      m.set(key, { timestamp: key, price, change, volume: 0 });
    }
    const b = m.get(key);
    b.price = price;
    b.change = change;
    b.volume += Number.isNaN(vol) ? 0 : vol;
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
      : memoryCache.filter(
          (p) => new Date(p.timestamp) >= new Date(cutoff)
        );

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
app.get("/api/profile", async (req, res) => {
  try {
    const wallet = String(req.query.wallet || "").trim();
    if (!wallet) return res.status(400).json({ error: "wallet required" });

    const { data, error } = await supabase
      .from("hub_profiles")
      .select("wallet, handle, avatar_url")
      .eq("wallet", wallet)
      .maybeSingle();

    if (error) {
      warn("[/api/profile] select error:", error.message);
      return res.status(500).json({ error: "db error" });
    }
    return res.status(200).json(data || {});
  } catch (e) {
    err("[/api/profile] fatal:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

app.post("/api/profile", async (req, res) => {
  try {
    const wallet = String(req.body.wallet || "").trim();
    if (!wallet) return res.status(400).json({ error: "Missing wallet" });

    let handle = req.body.handle;
    if (typeof handle === "string") {
      handle = handle.trim();
      if (handle === "") handle = undefined;
    } else if (handle == null) handle = undefined;

    let avatar_url = req.body.avatar_url;
    if (typeof avatar_url === "string") {
      avatar_url = avatar_url.trim();
      if (avatar_url === "") avatar_url = undefined;
    } else if (avatar_url == null) avatar_url = undefined;

    if (handle === undefined && avatar_url === undefined) {
      return res.status(400).json({ error: "no fields to update" });
    }

    const { data: existing, error: selErr } = await supabase
      .from("hub_profiles")
      .select("wallet, handle, avatar_url")
      .eq("wallet", wallet)
      .maybeSingle();

    if (selErr) {
      return res
        .status(500)
        .json({ error: "select_failed", detail: selErr.message });
    }

    const patch = { updated_at: new Date().toISOString() };
    if (handle !== undefined) patch.handle = handle;
    if (avatar_url !== undefined) patch.avatar_url = avatar_url;

    if (existing) {
      const { data, error } = await supabase
        .from("hub_profiles")
        .update(patch)
        .eq("wallet", wallet)
        .select()
        .maybeSingle();

      if (error)
        return res
          .status(500)
          .json({ error: "update_failed", detail: error.message });
      return res.json({ success: true, profile: data });
    } else {
      const insertRow = { wallet, ...patch };
      const { data, error } = await supabase
        .from("hub_profiles")
        .insert(insertRow)
        .select()
        .maybeSingle();

      if (error)
        return res
          .status(500)
          .json({ error: "insert_failed", detail: error.message });
      return res.json({ success: true, profile: data });
    }
  } catch (e) {
    err("Profile save error:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

const upload = multer({ storage: multer.memoryStorage() });
app.post(
  "/api/avatar-upload",
  upload.single("avatar"),
  async (req, res) => {
    try {
      const { wallet } = req.body;
      const file = req.file;
      if (!wallet || !file)
        return res.status(400).json({ error: "Missing" });

      const fileName = `avatars/${wallet}_${Date.now()}.jpg`;
      const { error: uploadErr } = await supabase.storage
        .from("hub_avatars")
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
          upsert: true,
        });

      if (uploadErr) throw uploadErr;

      const { data: urlData } = supabase.storage
        .from("hub_avatars")
        .getPublicUrl(fileName);
      const url = urlData?.publicUrl || null;

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
  }
);

/* ---------- Balances (Helius RPC + Jupiter v3 price + DexScreener fallback) ---------- */
const HELIUS_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_KEY)
  warn(
    "HELIUS_API_KEY missing — /api/balances and /api/wallets will 400 if called."
  );
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

const TOKEN_PROGRAM_ID =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
// ✅ correct SPL Token-2022 program id
const TOKEN_2022_PROGRAM_ID =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/* ---------- Solscan ---------- */
const SOLSCAN_KEY = process.env.SOLSCAN_KEY || "";
if (!SOLSCAN_KEY)
  warn("SOLSCAN_KEY not set — Solscan metadata will be skipped.");

/* ---------- Caches ---------- */
const SOL_CACHE = { priceUsd: null, ts: 0 };
const META_CACHE = new Map(); // mint -> { data, ts }
const PRICE_CACHE = new Map(); // mint -> { priceUsd, ts }
const JUP_V2_CACHE = new Map(); // query -> { data, ts }
const TTL_PRICE = 15_000; // 15s prices
const TTL_META = 6 * 60 * 60 * 1000;
const TTL_SOL = 25_000;
const TTL_JUP_V2 = 15 * 60 * 1000; // 15m for token search

const CACHE_LIMIT = 500;
function setWithLimit(map, key, value) {
  if (map.size >= CACHE_LIMIT) {
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) map.delete(firstKey);
  }
  map.set(key, value);
}

/* ---------- Token Meta Resolver (shared) ---------- */
const META_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const MEMO_META = new Map();
function memoGetMeta(mint) {
  const e = MEMO_META.get(mint);
  if (!e) return null;
  if (Date.now() - e.t > META_TTL_MS) {
    MEMO_META.delete(mint);
    return null;
  }
  return e.v;
}
function memoSetMeta(mint, v) {
  setWithLimit(MEMO_META, mint, { v, t: Date.now() });
}

/* ------- Jupiter Tokens API v2 helpers ------- */
async function jupV2Search(query) {
  const key = `q:${query}`;
  const now = Date.now();
  const cached = JUP_V2_CACHE.get(key);
  if (cached && now - cached.ts < TTL_JUP_V2) return cached.data;
  const url = `https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(
    query
  )}`;
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`Jupiter v2 search HTTP ${r.status}`);
  const data = await r.json();
  setWithLimit(JUP_V2_CACHE, key, { data, ts: now });
  return data;
}

async function fetchJupiterV2ByMint(mint) {
  try {
    const list = await jupV2Search(mint);
    if (!Array.isArray(list) || !list.length) return null;
    const hit =
      list.find(
        (t) => (t.mint || "").toLowerCase() === mint.toLowerCase()
      ) || list[0];
    return {
      name: hit?.name || null,
      symbol: hit?.symbol || null,
      decimals:
        typeof hit?.decimals === "number" ? hit.decimals : undefined,
      image: hit?.logoURI || null,
      tags: Array.isArray(hit?.tags) ? hit.tags : undefined,
    };
  } catch {
    return null;
  }
}

/* ------- Other sources ------- */
async function fetchHeliusDAS(mint) {
  try {
    const r = await fetch(HELIUS_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAsset",
        params: { id: mint },
      }),
    });
    const j = await r.json();
    const a = j?.result;
    if (!a) return null;
    const name =
      a?.content?.metadata?.name || a?.token_info?.symbol || null;
    const symbol =
      a?.token_info?.symbol || a?.content?.metadata?.symbol || null;
    const image = a?.content?.links?.image || null;
    const desc = a?.content?.metadata?.description || null;
    const decimals = Number(a?.token_info?.decimals ?? 0);
    const supply = Number(a?.token_info?.supply ?? 0);
    return { name, symbol, image, description: desc, decimals, supply };
  } catch {
    return null;
  }
}
async function fetchDexscreenerMeta(mint) {
  try {
    const r = await fetch(
      `https://api.dexscreener.com/latest/dex/search?q=${mint}`
    );
    const j = await r.json();
    const p = j?.pairs?.[0];
    if (!p) return null;
    const holders = Number(p?.holders || 0);
    return {
      price_usd: Number(p?.priceUsd) || 0,
      market_cap_usd:
        Number(p?.fdv || p?.marketCap || 0),
      holders: holders > 0 ? holders : null,
    };
  } catch {
    return null;
  }
}
async function fetchPumpFunMeta(mint) {
  try {
    const r = await fetch(
      `https://frontend-api.pump.fun/coins/${mint}`
    );
    if (!r.ok) return null;
    const j = await r.json();
    return {
      description: j?.description || null,
      image: j?.image_uri || null,
    };
  } catch {
    return null;
  }
}

/* NEW: Solscan Pro token meta */
async function fetchSolscanMeta(mint) {
  if (!SOLSCAN_KEY) return null;
  const headers = { accept: "application/json", token: SOLSCAN_KEY };

  // Try v1.1 first
  try {
    const r = await fetch(
      `https://pro-api.solscan.io/v1.1/token/meta?tokenAddress=${mint}`,
      { headers }
    );
    if (r.ok) {
      const j = await r.json();
      const d = j?.data || j;
      if (d) {
        const price = Number(
          d?.priceUsdt ?? d?.price_usd ?? 0
        );
        const mc = Number(
          d?.marketCap ?? d?.market_cap ?? 0
        );
        const holders = Number(d?.holder ?? d?.holders ?? 0);
        return {
          name: d?.name || null,
          symbol: d?.symbol || null,
          image: d?.icon || d?.image || null,
          price_usd: price > 0 ? price : undefined,
          market_cap_usd: mc > 0 ? mc : undefined,
          holders: holders > 0 ? holders : undefined,
        };
      }
    }
  } catch {}

  // Fallback: v1
  try {
    const r = await fetch(
      `https://pro-api.solscan.io/v1/token/meta?tokenAddress=${mint}`,
      { headers }
    );
    if (r.ok) {
      const j = await r.json();
      const d = j?.data || j;
      if (d) {
        const price = Number(
          d?.priceUsdt ?? d?.price_usd ?? 0
        );
        const mc = Number(
          d?.marketCap ?? d?.market_cap ?? 0
        );
        const holders = Number(d?.holder ?? d?.holders ?? 0);
        return {
          name: d?.name || null,
          symbol: d?.symbol || null,
          image: d?.icon || d?.image || null,
          price_usd: price > 0 ? price : undefined,
          market_cap_usd: mc > 0 ? mc : undefined,
          holders: holders > 0 ? holders : undefined,
        };
      }
    }
  } catch {}

  return null;
}

function mergeMetaParts(...parts) {
  const out = {};
  for (const p of parts) {
    if (!p) continue;
    for (const [k, v] of Object.entries(p)) {
      if (v == null || v === "" || v === 0) continue;
      if (out[k] == null || out[k] === "" || out[k] === 0) out[k] = v;
    }
  }
  return out;
}

// shared implementation
async function resolveTokenMetaCombined(
  mint,
  { nocache = false } = {}
) {
  // in-memory memo
  if (!nocache) {
    const memo = memoGetMeta(mint);
    if (memo) return memo;
  }

  // supabase cache (≤6h)
  if (!nocache) {
    const { data: cached } = await supabase
      .from("token_meta")
      .select("*")
      .eq("mint", mint)
      .maybeSingle();

    if (
      cached &&
      Date.now() - new Date(cached.updated_at).getTime() <
        META_TTL_MS
    ) {
      memoSetMeta(mint, cached);
      return cached;
    }
  }

  // fan-out (Jupiter v2 preferred)
  const [jupV2, hel, dskr, pump, solscan] = await Promise.all([
    fetchJupiterV2ByMint(mint),
    fetchHeliusDAS(mint),
    fetchDexscreenerMeta(mint),
    fetchPumpFunMeta(mint),
    fetchSolscanMeta(mint),
  ]);

  let merged = mergeMetaParts(solscan, jupV2, hel, pump, dskr);

  // NOTE: no heavy Helius holder scan here; we rely on Solscan/Dexscreener snapshot
  // to avoid massive getProgramAccounts over the full token set.

  // compute market cap if missing but price & supply are present
  if (
    (!merged.market_cap_usd || merged.market_cap_usd === 0) &&
    merged.price_usd &&
    merged.supply
  ) {
    merged.market_cap_usd = merged.price_usd * merged.supply;
  }

  const payload = {
    mint,
    name: merged.name || jupV2?.name || hel?.name || null,
    symbol: merged.symbol || jupV2?.symbol || hel?.symbol || null,
    decimals:
      typeof merged.decimals === "number"
        ? merged.decimals
        : typeof jupV2?.decimals === "number"
        ? jupV2.decimals
        : typeof hel?.decimals === "number"
        ? hel.decimals
        : 0,
    image: merged.image || jupV2?.image || hel?.image || null,
    description: merged.description || pump?.description || null,
    supply: Number(merged.supply || 0),
    price_usd: Number(merged.price_usd || 0),
    market_cap_usd: Number(merged.market_cap_usd || 0),
    holders:
      typeof merged.holders === "number" ? merged.holders : null,
    source: {
      jupiter_v2: !!jupV2,
      helius: !!hel,
      dexscreener: !!dskr,
      pump: !!pump,
      solscan: !!solscan,
    },
    updated_at: new Date().toISOString(),
  };

  // upsert cache unless nocache requested
  try {
    await supabase
      .from("token_meta")
      .upsert(payload, { onConflict: "mint" });
  } catch (e) {
    warn("token_meta upsert failed (non-fatal):", e?.message || e);
  }

  memoSetMeta(mint, payload);
  return payload;
}

/* ---------- /api/token-meta HTTP ---------- */
app.get("/api/token-meta", async (req, res) => {
  try {
    const mint = String(req.query.mint || "").trim();
    if (!mint) return res.status(400).json({ error: "mint required" });
    const nocache =
      String(req.query.nocache || "").toLowerCase() === "true";
    const payload = await resolveTokenMetaCombined(mint, { nocache });
    res.json(payload);
  } catch (e) {
    err("token-meta error:", e);
    res
      .status(500)
      .json({ error: "meta_failed", detail: String(e?.message || e) });
  }
});

/* ---------- Jupiter v2 proxy (for UI search/autocomplete, optional) ---------- */
app.get("/api/jup/tokens/search", async (req, res) => {
  try {
    const query = (req.query.query || "").trim();
    if (!query)
      return res.status(400).json({ error: "missing_query" });
    const data = await jupV2Search(query);
    res.json(data);
  } catch (e) {
    warn("Jupiter v2 proxy error:", e?.message || e);
    res.status(502).json({ error: "jupiter_v2_failed" });
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
  if (j.error)
    throw new Error(
      `RPC ${method} error: ${j.error.message || "unknown"}`
    );
  return j.result;
}

async function getSolUsd() {
  const now = Date.now();
  if (SOL_CACHE.priceUsd && now - SOL_CACHE.ts < TTL_SOL)
    return SOL_CACHE.priceUsd;
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

/* ---------- Server-side getTokenMeta uses local resolver (no HTTP) ---------- */
async function getTokenMeta(mint) {
  const now = Date.now();
  const cached = META_CACHE.get(mint);
  if (cached && now - cached.ts < TTL_META) return cached.data;

  try {
    const j = await resolveTokenMetaCombined(mint);
    const meta = {
      symbol: j?.symbol || "",
      name: j?.name || "",
      logo: j?.image || "",
      decimals:
        typeof j?.decimals === "number" ? j.decimals : undefined,
      tags: [],
      isVerified: Boolean(
        j?.market_cap_usd || j?.price_usd || j?.supply
      ),

      // keep these so balances can use them
      market_cap_usd:
        typeof j?.market_cap_usd === "number"
          ? j.market_cap_usd
          : undefined,
      holders:
        typeof j?.holders === "number" ? j.holders : undefined,
      supply:
        typeof j?.supply === "number" ? j.supply : undefined,
    };
    setWithLimit(META_CACHE, mint, { ts: now, data: meta });
    return meta;
  } catch {
    // fallback: Jupiter v2 direct
    try {
      const v2 = await fetchJupiterV2ByMint(mint);
      const meta = {
        symbol: v2?.symbol || "",
        name: v2?.name || "",
        logo: v2?.image || "",
        tags: Array.isArray(v2?.tags) ? v2.tags : [],
        isVerified: Boolean(v2?.symbol && v2?.name),
        decimals:
          typeof v2?.decimals === "number"
            ? v2.decimals
            : undefined,
      };
      setWithLimit(META_CACHE, mint, { ts: now, data: meta });
      return meta;
    } catch {}
    const meta = {
      symbol: "",
      name: "",
      logo: "",
      tags: [],
      isVerified: false,
      decimals: undefined,
    };
    setWithLimit(META_CACHE, mint, { ts: now, data: meta });
    return meta;
  }
}

/* ---------- Price (Jupiter v3 primary, Dexscreener fallback) + WS tick ---------- */
async function getTokenUsd(mint, { nocache = false } = {}) {
  const now = Date.now();
  if (!nocache) {
    const cached = PRICE_CACHE.get(mint);
    if (cached && now - cached.ts < TTL_PRICE) return cached.priceUsd;
  }

  const setAndMaybeBroadcast = (val) => {
    const prev = PRICE_CACHE.get(mint)?.priceUsd;
    setWithLimit(PRICE_CACHE, mint, { ts: now, priceUsd: val });
    if (
      typeof wsBroadcastAll === "function" &&
      val > 0 &&
      val !== prev
    ) {
      try {
        wsBroadcastAll({ type: "price", mint, priceUsd: val });
      } catch {}
    }
    return val;
  };

  // 1) Jupiter Price API v3 (Lite)
  try {
    const url = `https://lite-api.jup.ag/price/v3?ids=${encodeURIComponent(
      mint
    )}`;
    const r = await fetch(url, {
      headers: {
        accept: "application/json",
        "Cache-Control": "no-cache",
      },
    });
    if (r.ok) {
      const j = await r.json();
      const p = Number(j?.data?.[mint]?.price) || 0;
      if (p > 0) return setAndMaybeBroadcast(p);
    }
  } catch {}

  // 2) Fallback: Dexscreener search
  try {
    const r2 = await fetch(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(
        mint
      )}`,
      {
        headers: { "Cache-Control": "no-cache" },
      }
    );
    if (r2.ok) {
      const j2 = await r2.json();
      const pairs = Array.isArray(j2?.pairs) ? j2.pairs : [];
      const best =
        pairs.find(
          (p) =>
            p?.chainId === "solana" &&
            p?.baseToken?.address === mint
        ) ||
        pairs.find((p) => p?.baseToken?.address === mint) ||
        pairs[0];
      const p2 = Number(best?.priceUsd) || 0;
      if (p2 > 0) return setAndMaybeBroadcast(p2);
    }
  } catch {}

  setWithLimit(PRICE_CACHE, mint, { ts: now, priceUsd: 0 });
  return 0;
}

/* ---------- Balance helpers ---------- */
function parseParsedAccount(acc) {
  const info = acc?.account?.data?.parsed?.info;
  const amt =
    info?.tokenAmount ||
    info?.parsed?.info?.tokenAmount ||
    info?.uiTokenAmount ||
    {};
  const decimals = Number(amt?.decimals ?? info?.decimals ?? 0);
  const raw = amt?.amount != null ? String(amt.amount) : null;

  const uiAmount =
    raw && decimals >= 0
      ? Number(raw) / Math.pow(10, decimals)
      : Number(amt?.uiAmount ?? 0);

  return {
    mint: info?.mint || info?.parsed?.info?.mint || "",
    amount: uiAmount || 0,
    decimals,
  };
}

// Token-2022 lookup is non-fatal (best-effort)
async function getAllSplTokenAccounts(owner, commitment = "confirmed") {
  // Always fetch legacy SPL token accounts
  const legacy = await rpc("getTokenAccountsByOwner", [
    owner,
    { programId: TOKEN_PROGRAM_ID },
    { encoding: "jsonParsed", commitment },
  ]);

  // Token-2022 is best-effort only
  let t22 = { value: [] };
  try {
    t22 = await rpc("getTokenAccountsByOwner", [
      owner,
      { programId: TOKEN_2022_PROGRAM_ID },
      { encoding: "jsonParsed", commitment },
    ]);
  } catch (e) {
    warn(
      "getAllSplTokenAccounts: token-2022 lookup failed (non-fatal):",
      e?.message || e
    );
  }

  const list = []
    .concat(legacy?.value || [], t22?.value || [])
    .map(parseParsedAccount)
    .filter((t) => t.mint && t.amount > 0);

  const byMint = new Map();
  for (const t of list) {
    const prev = byMint.get(t.mint);
    if (prev) {
      prev.amount += t.amount;
      if (
        typeof prev.decimals !== "number" &&
        typeof t.decimals === "number"
      ) {
        prev.decimals = t.decimals;
      }
    } else {
      byMint.set(t.mint, { ...t });
    }
  }
  return Array.from(byMint.values());
}

/* === Small helper for homepage CTO / Utility wallets === */
async function getWalletSnapshot(
  owner,
  mint,
  commitment = "confirmed"
) {
  const [bal, tokens] = await Promise.all([
    rpc("getBalance", [owner, { commitment }]),
    getAllSplTokenAccounts(owner, commitment),
  ]);

  const sol = Number(bal?.value || 0) / 1e9;
  const tok = (tokens || []).find((t) => t.mint === mint);
  const tokenAmount = tok ? tok.amount : 0;
  return { sol, token: tokenAmount };
}

/* Simple JSON for homepage vault cards:
 * {
 *   cto:      { sol, token },
 *   utility:  { sol, token }
 * }
 */
app.get("/api/wallets", async (_req, res) => {
  try {
    if (!HELIUS_KEY) {
      return res
        .status(400)
        .json({ error: "HELIUS_API_KEY not configured on backend" });
    }

    const [cto, utility] = await Promise.all([
      getWalletSnapshot(CTO_WALLET, TOKEN_MINT),
      getWalletSnapshot(UTILITY_WALLET, TOKEN_MINT),
    ]);

    res.json({ cto, utility });
  } catch (e) {
    err("/api/wallets error:", e);
    res
      .status(500)
      .json({ error: "Failed to fetch wallet snapshots" });
  }
});

/* ---------- Home dashboard summary (for Terminal Hub hero card) ---------- */
/* Returns:
 * {
 *   mint,
 *   priceUsd,
 *   marketCapUsd,
 *   holders,
 *   supply,
 *   changePct24h,
 *   volume24h
 * }
 */
app.get("/api/home", async (_req, res) => {
  try {
    const [meta, latest] = await Promise.all([
      resolveTokenMetaCombined(TOKEN_MINT, { nocache: false }),
      (async () => {
        let l = memoryCache.at(-1);
        if (!l) {
          const { data } = await supabase
            .from("chart_data")
            .select("timestamp, price, change, volume")
            .order("timestamp", { ascending: false })
            .limit(1)
            .maybeSingle();
          l = data;
        }
        return l || null;
      })(),
    ]);

    const priceUsd = Number(meta?.price_usd || latest?.price || 0);
    const marketCapUsd = Number(meta?.market_cap_usd || 0);
    const holders =
      meta?.holders != null ? Number(meta.holders) : 0;
    const supply =
      meta?.supply != null ? Number(meta.supply) : 0;
    const changePct24h =
      latest?.change != null ? Number(latest.change) : 0;
    const volume24h =
      latest?.volume != null ? Number(latest.volume) : 0;

    res.json({
      mint: TOKEN_MINT,
      priceUsd,
      marketCapUsd,
      holders,
      supply,
      changePct24h,
      volume24h,
    });
  } catch (e) {
    err("/api/home error:", e);
    res
      .status(500)
      .json({ error: "Failed to build home summary" });
  }
});

/* ---------- Balances endpoint ---------- */
app.post("/api/balances", async (req, res) => {
  try {
    const wallet = req.body?.wallet?.trim();
    const commitment = ["processed", "confirmed", "finalized"].includes(
      req.body?.commitment
    )
      ? req.body.commitment
      : "confirmed";
    const nocache = Boolean(req.body?.nocache);

    if (!wallet || !HELIUS_KEY) {
      return res.status(400).json({ error: "Bad request" });
    }

    // Optional: bypass caches when client asks for fresh pull
    if (nocache) {
      SOL_CACHE.ts = 0;
    }

    const solBal = await rpc("getBalance", [wallet, { commitment }]);
    const sol = Number(solBal?.value || 0) / 1e9;
    const solUsd = await getSolUsd();

    const tokenAccounts = await getAllSplTokenAccounts(
      wallet,
      commitment
    );

    const enriched = await Promise.all(
      tokenAccounts.map(async (t) => {
        const meta = await getTokenMeta(t.mint);
        const decimals =
          typeof meta.decimals === "number"
            ? meta.decimals
            : t.decimals;
        const priceUsd = await getTokenUsd(t.mint, { nocache });
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

          // meta extras for wallet popup
          marketCapUsd:
            typeof meta.market_cap_usd === "number"
              ? meta.market_cap_usd
              : null,
          holders:
            typeof meta.holders === "number" ? meta.holders : null,
          supply:
            typeof meta.supply === "number" ? meta.supply : null,
        };
      })
    );

    enriched.sort((a, b) => (b.usd || 0) - (a.usd || 0));

    res.json({ sol, solUsd, tokens: enriched, commitment, nocache });
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
    const { wallet, token, tx, date, status, rent_reclaimed } =
      req.body || {};
    if (!wallet || !token || !tx) {
      return res.status(400).json({
        error: "Missing required fields (wallet, token, tx)",
      });
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
    if (!wallet)
      return res.status(400).json({ error: "Missing wallet" });

    const { data, error } = await supabase
      .from("hub_refund_history")
      .select(
        "id, wallet, token, tx, date, status, created_at, rent_reclaimed"
      )
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
app.post("/api/rpc", async (req, res) => {
  try {
    const { method, params } = req.body || {};
    if (!HELIUS_KEY) {
      return res.status(400).json({
        error: "HELIUS_API_KEY not configured on backend",
      });
    }
    if (!method)
      return res.status(400).json({ error: "Missing method" });

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
    return res
      .status(400)
      .json({ error: "HELIUS_API_KEY not configured" });
  }
  return res.json({ rpc: HELIUS_RPC });
});

/* ======================================================================== */
/* =======================  STAKING TERMINAL BACKEND  ===================== */
/* ======================================================================== */

/* ---- Staking + reward pool config ---- */

const STAKE_REWARD_RATES = { 30: 0.05, 60: 0.125, 90: 0.25 }; // matches UI
const STAKE_CAP_PER_WALLET = 100000;
const STAKE_GLOBAL_CAP = Number(process.env.STAKE_GLOBAL_CAP || "0");

const REWARD_POOL_PUBKEY = process.env.REWARD_POOL_PUBKEY || "";
const REWARD_POOL_SECRET = process.env.REWARD_POOL_SECRET || "";
const FART_MINT_STR =
  process.env.FART_MINT || "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
const FART_DECIMALS = Number(process.env.FART_DECIMALS || "6");
const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

if (!REWARD_POOL_PUBKEY) {
  warn("[staking] REWARD_POOL_PUBKEY not set — /api/staking/claim will fail");
}
if (!REWARD_POOL_SECRET) {
  warn("[staking] REWARD_POOL_SECRET not set — /api/staking/claim will fail");
}

const stakingConnection = new web3.Connection(SOLANA_RPC_URL, "confirmed");

/* ---- Staking helpers ---- */

function getRewardRate(durationDays) {
  return STAKE_REWARD_RATES[durationDays] ?? 0;
}

function calcEndsAt(startedAt, durationDays) {
  const ms = durationDays * 24 * 60 * 60 * 1000;
  return new Date(startedAt.getTime() + ms);
}

// "all at the end" reward: 0 until matured, full reward when finished
function computeStakeAccrual(stakeRow, now = new Date()) {
  const {
    amount,
    duration_days,
    started_at,
    ends_at,
    claimed_total = 0,
    reward_rate,
  } = stakeRow;

  const amt = Number(amount || 0);
  const durationDays = Number(duration_days || 0);
  const rate =
    reward_rate != null ? Number(reward_rate) : getRewardRate(durationDays);
  const maxReward = +(amt * rate).toFixed(6);

  if (!amt || !durationDays || !rate) {
    return { maxReward: 0, accrued: 0, unclaimed: 0, matured: false };
  }

  const start = new Date(started_at);
  const end = ends_at ? new Date(ends_at) : calcEndsAt(start, durationDays);
  const matured = now.getTime() >= end.getTime();

  if (!matured) {
    return { maxReward, accrued: 0, unclaimed: 0, matured: false };
  }

  const accrued = maxReward;
  const unclaimed = Math.max(
    0,
    +(accrued - Number(claimed_total || 0)).toFixed(6)
  );

  return { maxReward, accrued, unclaimed, matured: true };
}

function loadPoolKeypair() {
  if (!REWARD_POOL_SECRET) throw new Error("REWARD_POOL_SECRET not set");
  try {
    // JSON array case
    const arr = JSON.parse(REWARD_POOL_SECRET);
    return web3.Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch {
    // base58 case (Phantom style)
    const secret = bs58.decode(REWARD_POOL_SECRET);
    return web3.Keypair.fromSecretKey(secret);
  }
}

/**
 * Send FART from pool wallet to `toWallet`.
 * amountFart is in human units, e.g. 123.45
 */
async function sendFartFromPool(toWallet, amountFart) {
  const poolKp = loadPoolKeypair();
  const poolPubkey = poolKp.publicKey;
  const userPubkey = new web3.PublicKey(toWallet);
  const mint = new web3.PublicKey(FART_MINT_STR);

  // convert to smallest units
  const raw = Math.round(amountFart * Math.pow(10, FART_DECIMALS));
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error(`Invalid FART amount: ${amountFart}`);
  }

  const amountRaw = BigInt(raw);

  const poolAta = await getOrCreateAssociatedTokenAccount(
    stakingConnection,
    poolKp,
    mint,
    poolPubkey
  );

  const userAta = await getOrCreateAssociatedTokenAccount(
    stakingConnection,
    poolKp,
    mint,
    userPubkey
  );

  const ix = createTransferInstruction(
    poolAta.address,
    userAta.address,
    poolPubkey,
    Number(amountRaw),
    [],
    SPL_TOKEN_PROGRAM_ID
  );

  const tx = new web3.Transaction().add(ix);
  tx.feePayer = poolPubkey;
  const { blockhash } = await stakingConnection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;

  const sig = await web3.sendAndConfirmTransaction(
    stakingConnection,
    tx,
    [poolKp],
    { commitment: "confirmed" }
  );

  log("[staking] FART sent from pool →", toWallet, "amount=", amountFart);
  return sig;
}

/* ---- /api/staking/state ---- */
/*
GET /api/staking/state?wallet=<pubkey>
  -> {
       wallet,
       black: { available, staked_total },
       fart:  { claimable },
       stakes: [
         { id, amount, duration_days, start_ts, end_ts, status, reward_est, tx? }
       ]
     }
*/
app.get("/api/staking/state", async (req, res) => {
  const wallet = String(req.query.wallet || "").trim();
  if (!wallet) {
    return res.status(400).json({ error: "wallet is required" });
  }

  try {
    const { data: stakeRows, error } = await supabase
      .from("hub_stakes")
      .select("*")
      .eq("wallet", wallet)
      .order("started_at", { ascending: false });

    if (error) {
      err("[staking/state] select error:", error.message);
      return res.status(500).json({ error: "Failed to load stakes" });
    }

    let walletStakedTotal = 0;
    let walletClaimableTotal = 0;
    const now = new Date();

    const stakes = (stakeRows || []).map((row) => {
      const { maxReward, unclaimed, matured } = computeStakeAccrual(row, now);

      if (row.status === "active") {
        walletStakedTotal += Number(row.amount || 0);
      }

      if (matured && unclaimed > 0 && (row.status === "active" || row.status === "settled")) {
        walletClaimableTotal += unclaimed;
      }

      return {
        id: row.id,
        wallet: row.wallet,
        amount: Number(row.amount || 0),
        duration_days: Number(row.duration_days || 0),
        reward_rate: Number(
          row.reward_rate != null
            ? row.reward_rate
            : getRewardRate(row.duration_days)
        ),
        max_reward: maxReward,
        start_ts: row.started_at,
        end_ts: row.ends_at,
        status: row.status,
        claimed_total: Number(row.claimed_total || 0),
        reward_est: maxReward,
        tx: row.tx || null,
      };
    });

    // For now, "available" = remaining room under per-wallet cap
    // so UI can stake up to the cap without on-chain BAL yet.
    const blackAvailable = Math.max(
      0,
      STAKE_CAP_PER_WALLET - walletStakedTotal
    );

    return res.json({
      wallet,
      BlackCoin: {
        available: blackAvailable,
        staked_total: walletStakedTotal,
      },
      fart: {
        claimable: walletClaimableTotal,
      },
      stakes,
    });
  } catch (e) {
    err("[staking/state] exception:", e);
    return res.status(500).json({ error: "Internal error" });
  }
});

/* ---- /api/staking/stake ---- */
/*
POST /api/staking/stake
  { wallet, amount, duration_days }
*/
app.post("/api/staking/stake", async (req, res) => {
  const { wallet, amount, duration_days } = req.body || {};
  const w = String(wallet || "").trim();
  const amt = Number(amount || 0);
  const dur = Number(duration_days || 0);

  if (!w || !amt || !dur) {
    return res
      .status(400)
      .json({ error: "wallet, amount, duration_days required" });
  }
  if (!STAKE_REWARD_RATES[dur]) {
    return res.status(400).json({ error: "Invalid duration" });
  }
  if (amt <= 0) {
    return res.status(400).json({ error: "Amount must be > 0" });
  }

  try {
    // Per-wallet cap
    const { data: activeRows, error: actErr } = await supabase
      .from("hub_stakes")
      .select("amount")
      .eq("wallet", w)
      .eq("status", "active");

    if (actErr) {
      err("[staking/stake] walletActive error:", actErr.message);
      return res
        .status(500)
        .json({ error: "Failed to check wallet cap" });
    }

    const currentActive = (activeRows || []).reduce(
      (sum, r) => sum + Number(r.amount || 0),
      0
    );
    if (currentActive + amt > STAKE_CAP_PER_WALLET) {
      return res.status(400).json({
        error: `Per-wallet cap exceeded (${STAKE_CAP_PER_WALLET.toLocaleString()} BLACK)`,
      });
    }

    // Optional global cap
    if (STAKE_GLOBAL_CAP > 0) {
      const { data: allActive, error: gErr } = await supabase
        .from("hub_stakes")
        .select("amount")
        .eq("status", "active");

      if (gErr) {
        err("[staking/stake] globalActive error:", gErr.message);
        return res
          .status(500)
          .json({ error: "Failed to check global cap" });
      }

      const globalActive = (allActive || []).reduce(
        (sum, r) => sum + Number(r.amount || 0),
        0
      );
      if (globalActive + amt > STAKE_GLOBAL_CAP) {
        return res
          .status(400)
          .json({ error: "Global staking cap reached." });
      }
    }

    const now = new Date();
    const rewardRate = getRewardRate(dur);
    const maxReward = +(amt * rewardRate).toFixed(6);
    const endsAt = calcEndsAt(now, dur);

    const { data: inserted, error: insErr } = await supabase
      .from("hub_stakes")
      .insert({
        wallet: w,
        amount: amt,
        duration_days: dur,
        reward_rate: rewardRate,
        max_reward: maxReward,
        status: "active",
        started_at: now.toISOString(),
        ends_at: endsAt.toISOString(),
        last_claim_at: now.toISOString(),
        claimed_total: 0,
      })
      .select()
      .maybeSingle();

    if (insErr) {
      err("[staking/stake] insert error:", insErr.message);
      return res.status(500).json({ error: "Failed to create stake" });
    }

    return res.json({ ok: true, stake: inserted });
  } catch (e) {
    err("[staking/stake] exception:", e);
    return res.status(500).json({ error: "Internal error" });
  }
});

/* ---- /api/staking/claim ---- */
/*
POST /api/staking/claim
  { wallet }
*/
app.post("/api/staking/claim", async (req, res) => {
  const { wallet } = req.body || {};
  const w = String(wallet || "").trim();
  if (!w) return res.status(400).json({ error: "wallet is required" });

  try {
    const { data: stakeRows, error } = await supabase
      .from("hub_stakes")
      .select("*")
      .eq("wallet", w)
      .in("status", ["active", "settled"]);

    if (error) {
      err("[staking/claim] select error:", error.message);
      return res.status(500).json({ error: "Failed to load stakes" });
    }

    const now = new Date();
    let totalClaimed = 0;
    const updates = [];
    const claimRows = [];

    for (const row of stakeRows || []) {
      const { maxReward, unclaimed, matured } = computeStakeAccrual(
        row,
        now
      );
      if (!matured || unclaimed <= 0) continue;

      totalClaimed += unclaimed;

      const newClaimedTotal = +(
        Number(row.claimed_total || 0) + unclaimed
      ).toFixed(6);

      const update = {
        id: row.id,
        claimed_total: newClaimedTotal,
        last_claim_at: now.toISOString(),
      };

      if (newClaimedTotal >= maxReward && row.status === "active") {
        update.status = "settled";
        update.ends_at = row.ends_at || now.toISOString();
      }

      updates.push(update);
      claimRows.push({
        wallet: w,
        stake_id: row.id,
        amount: unclaimed,
        claimed_at: now.toISOString(),
        tx: null,
      });
    }

    if (totalClaimed <= 0) {
      return res.json({ ok: true, amount_claimed: 0 });
    }

    // Send FART from pool → user
    let txSig;
    try {
      txSig = await sendFartFromPool(w, totalClaimed);
    } catch (sendErr) {
      err("[staking/claim] sendFartFromPool error:", sendErr);
      return res
        .status(500)
        .json({ error: "Reward transfer failed" });
    }

    const claimRowsWithTx = claimRows.map((c) => ({
      ...c,
      tx: txSig,
    }));

    // Apply updates
    for (const u of updates) {
      const { error: updErr } = await supabase
        .from("hub_stakes")
        .update({
          claimed_total: u.claimed_total,
          last_claim_at: u.last_claim_at,
          ...(u.status ? { status: u.status, ends_at: u.ends_at } : {}),
        })
        .eq("id", u.id);
      if (updErr) {
        err(
          "[staking/claim] update stake error:",
          updErr.message || updErr
        );
      }
    }

    const { error: insErr } = await supabase
      .from("hub_stake_claims")
      .insert(claimRowsWithTx);
    if (insErr) {
      err("[staking/claim] insert history error:", insErr.message);
    }

    return res.json({ ok: true, amount_claimed: totalClaimed, tx: txSig });
  } catch (e) {
    err("[staking/claim] exception:", e);
    return res.status(500).json({ error: "Internal error" });
  }
});

/* ---- /api/staking/unstake ---- */
/*
POST /api/staking/unstake
  { wallet, stake_id }
*/
app.post("/api/staking/unstake", async (req, res) => {
  const { wallet, stake_id } = req.body || {};
  const w = String(wallet || "").trim();

  if (!w || !stake_id) {
    return res
      .status(400)
      .json({ error: "wallet and stake_id required" });
  }

  try {
    const { data: row, error } = await supabase
      .from("hub_stakes")
      .select("*")
      .eq("id", stake_id)
      .eq("wallet", w)
      .maybeSingle();

    if (error || !row) {
      err("[staking/unstake] select error:", error?.message || error);
      return res.status(404).json({ error: "Stake not found" });
    }
    if (row.status !== "active") {
      return res.status(400).json({ error: "Stake not active" });
    }

    const now = new Date();
    const end = row.ends_at
      ? new Date(row.ends_at)
      : calcEndsAt(new Date(row.started_at), row.duration_days);
    const matured = now.getTime() >= end.getTime();

    const newStatus = matured ? "settled" : "unstaked";

    const { error: updErr } = await supabase
      .from("hub_stakes")
      .update({
        status: newStatus,
        ends_at: matured
          ? row.ends_at || now.toISOString()
          : now.toISOString(),
      })
      .eq("id", stake_id);

    if (updErr) {
      err("[staking/unstake] update error:", updErr.message);
      return res.status(500).json({ error: "Failed to update stake" });
    }

    return res.json({ ok: true, status: newStatus });
  } catch (e) {
    err("[staking/unstake] exception:", e);
    return res.status(500).json({ error: "Internal error" });
  }
});

/* ---- /api/fartcoin/pool-balance ---- */
/*
GET /api/fartcoin/pool-balance?wallet=<POOL_WALLET>
  -> { wallet, fart_balance, updated_at }
*/
app.get("/api/fartcoin/pool-balance", async (req, res) => {
  const wallet =
    String(req.query.wallet || REWARD_POOL_PUBKEY || "").trim();
  if (!wallet) {
    return res.status(400).json({ error: "wallet required" });
  }

  try {
    const { data, error } = await supabase
      .from("hub_stake_pool")
      .select("wallet, fart_balance, updated_at")
      .eq("wallet", wallet)
      .maybeSingle();

    if (error) {
      err("[pool-balance] select error:", error.message);
      return res
        .status(500)
        .json({ error: "Failed to load pool balance" });
    }

    if (!data) {
      return res.json({
        wallet,
        fart_balance: 0,
        updated_at: null,
      });
    }

    return res.json({
      wallet: data.wallet,
      fart_balance: Number(data.fart_balance || 0),
      updated_at: data.updated_at,
    });
  } catch (e) {
    err("[pool-balance] exception:", e);
    return res.status(500).json({ error: "Internal error" });
  }
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

/* ---------- Supabase Realtime: broadcasts ---------- */
let rtChannel = null;
function subscribeToBroadcasts() {
  try {
    if (rtChannel) {
      try {
        supabase.removeChannel(rtChannel);
      } catch {}
      rtChannel = null;
    }

    rtChannel = supabase
      .channel("rt:hub_broadcasts", {
        config: { broadcast: { ack: true }, presence: { key: "server" } },
      })
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "hub_broadcasts",
        },
        (payload) => {
          const row = normRow(payload?.new || payload?.record);
          log("🔔 INSERT hub_broadcasts id=", row?.id);
          if (row) wsBroadcastAll({ type: "insert", row });
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "hub_broadcasts",
        },
        (payload) => {
          const row = normRow(payload?.new || payload?.record);
          log("🔧 UPDATE hub_broadcasts id=", row?.id);
          if (row) wsBroadcastAll({ type: "update", row });
        }
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "hub_broadcasts",
        },
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

// Periodic memory usage log to observe heap in production
setInterval(() => {
  try {
    const { rss, heapUsed, heapTotal } = process.memoryUsage();
    const mb = (n) => (n / 1024 / 1024).toFixed(1);
    log(
      `[MEM] rss=${mb(rss)}MB heapUsed=${mb(
        heapUsed
      )}MB heapTotal=${mb(heapTotal)}MB`
    );
  } catch (e) {
    // ignore
  }
}, 60_000);

server.listen(PORT, () => {
  log(`BLACKCOIN OPERATOR HUB BACKEND v11.3 — LIVE ON PORT ${PORT}`);
  log(`WebSocket: ws://localhost:${PORT}/ws`);
  log(`Frontend:  http://localhost:${PORT}/`);
});
