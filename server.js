// server.js — BlackCoin backend (Operator Hub realtime edition)
// ESM + Express + Supabase + WS
// - Chart poller with backoff (UNCHANGED)
// - Profile save/get
// - Avatar upload to Supabase Storage + profile update
// - Broadcasts: insert + list (DESC, 25)
// - Refund: insert + list
// - WebSocket server on /ws broadcasting realtime INSERT/UPDATE/DELETE from hub_broadcasts
// - Weighted-blend pricing (Jupiter + DexScreener) with USD formatter & caching
// - NEW: 10s API caching for price & 24h change + server-side portfolioDeltaPct (with 25% per-asset cap)
// - NEW: BlackCoin overrides (mint symbol/name + price source order) + server-side icon resolution

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import multer from "multer";
import http from "http";
import * as ws from "ws";
const { WebSocketServer } = ws;

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

function ts(){ const d=new Date(); return `[${d.toTimeString().slice(0,8)}]`; }
const log=(...a)=>console.log(ts(),...a);
const warn=(...a)=>console.warn(ts(),...a);
const err=(...a)=>console.error(ts(),...a);

/* ---------- Supabase ---------- */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // service_role
if (!SUPABASE_URL || !SUPABASE_KEY) {
  err("SUPABASE_URL or SUPABASE_KEY missing"); process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ---------- Health ---------- */
app.get("/healthz", (_req,res)=>res.json({ ok:true, time:new Date().toISOString() }));

/* ---------- Chart poller (UNCHANGED) ---------- */
const TOKEN_MINT = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump"; // BlackCoin
let FETCH_INTERVAL = 20000;
const BACKOFF_INTERVAL = 60000;
let isBackoff=false, fetchInProgress=false, pollTimer=null;
let memoryCache=[];

async function insertPoint(point){
  try{ const {error}=await supabase.from("chart_data").insert([point]); if(error) err("Supabase insert failed:",error.message); }
  catch(e){ err("Supabase insert exception:",e); }
}
async function fetchOneTick(){
  fetchInProgress=true; log("⏱️  Polling Dexscreener...");
  try{
    const res=await fetch(`https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`,{headers:{"Cache-Control":"no-cache"}});
    if(res.status===429){ warn("⚠️  429 rate limit hit — entering backoff:",`${BACKOFF_INTERVAL/1000}s`); return "backoff"; }
    if(!res.ok){ warn(`⚠️  Upstream returned ${res.status} — keeping normal cadence`); return "softfail"; }
    const json=await res.json(); const pair=json.pairs?.[0];
    if(!pair){ warn("⚠️  No pairs in response — keeping normal cadence"); return "softfail"; }
    const point={ timestamp:new Date().toISOString(), price:+pair.priceUsd, change:+(pair.priceChange?.h24), volume:+(pair.volume?.h24) };
    if([point.price,point.change,point.volume].some(v=>isNaN(v))){ warn("⚠️  Invalid numeric fields — skipping insert"); return "softfail"; }
    memoryCache.push(point); if(memoryCache.length>10000) memoryCache.shift();
    await insertPoint(point); log("✅ Data stored at",point.timestamp); return "ok";
  }catch(e){ err("fetchLiveData failed:",e); return "softfail"; } finally{ fetchInProgress=false; }
}
function scheduleNext(ms){ if(pollTimer){ clearTimeout(pollTimer); pollTimer=null; } pollTimer=setTimeout(pollLoop,ms); }
async function pollLoop(){
  if(fetchInProgress){ warn("⏸️  Prev fetch still running — skip"); return scheduleNext(isBackoff?BACKOFF_INTERVAL:FETCH_INTERVAL); }
  const r=await fetchOneTick();
  if(r==="backoff"){ if(!isBackoff) isBackoff=true; log("⏸️  Backoff active — delaying"); return scheduleNext(BACKOFF_INTERVAL); }
  if(isBackoff && r==="ok"){ isBackoff=false; log("⏳  Backoff ended — resume"); return scheduleNext(FETCH_INTERVAL); }
  scheduleNext(FETCH_INTERVAL);
}
pollLoop();

/* ---------- Chart API (UNCHANGED) ---------- */
function bucketMs(interval){ switch(interval){case"1m":return 60e3;case"5m":return 300e3;case"30m":return 1800e3;case"1h":return 3600e3;case"D":return 86400e3;default:return 60e3;} }
function getWindow(interval){ const now=Date.now(); if(interval==="D") return new Date(now-30*86400e3).toISOString(); if(interval==="1h") return new Date(now-7*86400e3).toISOString(); return new Date(now-86400e3).toISOString(); }
function floorToBucketUTC(tsISO, interval){ const ms=bucketMs(interval); const d=new Date(tsISO); return new Date(Math.floor(d.getTime()/ms)*ms); }
function bucketize(rows,interval){ const m=new Map(); for(const r of rows){ const key=floorToBucketUTC(r.timestamp,interval).toISOString(); const price=+r.price,change=+r.change,vol=+r.volume; if(!m.has(key)) m.set(key,{timestamp:key,price,change,volume:0}); const b=m.get(key); b.price=price; b.change=change; b.volume+=isNaN(vol)?0:vol; } return Array.from(m.values()).sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp)); }
app.get("/api/chart",async(req,res)=>{
  try{
    const interval=req.query.interval||"D", page=Math.max(parseInt(req.query.page)||1,1), limit=Math.min(parseInt(req.query.limit)||10000,20000);
    const offset=(page-1)*limit, cutoff=getWindow(interval);
    const {data,error,count}=await supabase.from("chart_data").select("timestamp, price, change, volume",{count:"exact"}).gte("timestamp",cutoff).order("timestamp",{ascending:true}).range(offset,offset+limit-1);
    if(error) throw error;
    const raw=data?.length?data:memoryCache.filter(p=>new Date(p.timestamp)>=new Date(cutoff));
    const points=bucketize(raw,interval); const latest=raw.length?raw[raw.length-1]:memoryCache.at(-1);
    const totalCount=count||raw.length; const nextPage=offset+limit<totalCount? page+1:null;
    res.json({points,latest,page,nextPage,hasMore:Boolean(nextPage)});
  }catch(e){ err("Error /api/chart:",e); res.status(500).json({error:"Failed to fetch chart data",message:e.message}); }
});
app.get("/api/latest",async(_req,res)=>{
  try{
    let latest=memoryCache.at(-1);
    if(!latest){ const {data}=await supabase.from("chart_data").select("timestamp, price, change, volume").order("timestamp",{ascending:false}).limit(1).maybeSingle(); latest=data; }
    if(!latest) return res.status(404).json({error:"No data"});
    res.json(latest);
  }catch(e){ err("Error /api/latest:",e); res.status(500).json({error:"Failed"}); }
});

/* ---------- Profiles & Avatars ---------- */
app.post("/api/profile", async (req,res)=>{
  try{
    let { wallet, handle, avatar_url } = req.body;
    if(!wallet) return res.status(400).json({error:"Missing wallet"});
    if(typeof handle==="string") handle=handle.trim();
    if(!handle) handle="@Operator";
    const { data, error } = await supabase.from("hub_profiles").upsert(
      { wallet, handle, avatar_url: avatar_url ?? null, updated_at:new Date().toISOString() },
      { onConflict:"wallet" }
    ).select();
    if(error) throw error;
    res.json({ success:true, data });
  }catch(e){ err("Error /api/profile:",e); res.status(500).json({error:e.message}); }
});
app.get("/api/profile", async (req,res)=>{
  try{
    const wallet=req.query.wallet; if(!wallet) return res.status(400).json({error:"Missing wallet"});
    const { data, error } = await supabase.from("hub_profiles").select("*").eq("wallet",wallet).maybeSingle();
    if(error) throw error;
    if(!data) return res.status(404).json({error:"Not found"});
    res.json(data);
  }catch(e){ err("Error /api/profile[GET]:",e); res.status(500).json({error:e.message}); }
});

const upload = multer({ storage: multer.memoryStorage() });
app.post("/api/avatar-upload", upload.single("avatar"), async (req,res)=>{
  try{
    const { wallet } = req.body; const file = req.file;
    if(!wallet || !file) return res.status(400).json({error:"Missing fields"});
    const fileName = `avatars/${wallet}_${Date.now()}.jpg`;
    const { error: uploadErr } = await supabase.storage.from("hub_avatars").upload(fileName, file.buffer, { contentType:file.mimetype, upsert:true });
    if(uploadErr) throw uploadErr;
    const { data: publicURL } = supabase.storage.from("hub_avatars").getPublicUrl(fileName);
    const url = publicURL.publicUrl;
    const { error: updErr } = await supabase.from("hub_profiles").upsert({ wallet, avatar_url:url, updated_at:new Date().toISOString() }, { onConflict:"wallet" });
    if(updErr) throw updErr;
    res.json({ success:true, url });
  }catch(e){ err("Error /api/avatar-upload:",e); res.status(500).json({error:e.message}); }
});

/* ---------- Balances (Helius Enhanced + prices) ---------- */
const HELIUS_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_KEY) warn("HELIUS_API_KEY is not set — /api/balances will fail.");

// ===== Number/format utils =====
function abbreviate(n) {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return sign + (abs/1_000_000_000).toFixed(abs % 1_000_000_000 === 0 ? 0 : 2).replace(/\.0+$|(?<=\.\d*[1-9])0+$/g,"") + "B";
  if (abs >= 1_000_000)     return sign + (abs/1_000_000).toFixed(abs % 1_000_000 === 0 ? 0 : 2).replace(/\.0+$|(?<=\.\d*[1-9])0+$/g,"") + "M";
  if (abs >= 10_000)        return sign + (abs/1_000).toFixed(abs % 1_000 === 0 ? 0 : 2).replace(/\.0+$|(?<=\.\d*[1-9])0+$/g,"") + "K";
  return null;
}
function formatUsd(value){
  if (value == null || Number.isNaN(value)) return "$0.00";
  const v = Number(value);
  const abs = Math.abs(v);
  if (abs < 1) {
    const s = abs.toFixed(6).replace(/\.?0+$/,"");
    return (v < 0 ? "-$" : "$") + (v < 0 ? s.slice(1) : s);
  }
  if (abs < 10_000) {
    return (v < 0 ? "-$" : "$") + abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  const abbr = abbreviate(v);
  return "$" + abbr;
}

// ===== Caches =====
const PRICE_TTL_MS = 25_000;
const BLENDED_CACHE = new Map(); // mint -> { priceUsd, ts, source, confidence, raw }
const TEN_S = 10_000;
const DS_SEARCH_CACHE = new Map(); // mint -> { ts, json }
const CG_SOL_CACHE = { ts: 0, priceUsd: 0, changePct: 0 };
const ICON_CACHE = new Map();

// ===== Helper fetch =====
async function fetchJSON(url, headers={}){
  const r = await fetch(url, { headers: { "Cache-Control":"no-cache", ...headers }});
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ===== Price sources =====
async function jupPrice(mint){
  try{
    const j = await fetchJSON(`https://price.jup.ag/v6/price?ids=${encodeURIComponent(mint)}`);
    const p = Number(j?.data?.[mint]?.price) || Number(j?.data?.price) || 0;
    return (p>0)? p : 0;
  }catch{ return 0; }
}
async function dsSearch(mint){
  const now = Date.now();
  const hit = DS_SEARCH_CACHE.get(mint);
  if (hit && (now - hit.ts) < TEN_S) return hit.json;
  try{
    const j = await fetchJSON(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(mint)}`);
    DS_SEARCH_CACHE.set(mint, { ts: now, json: j });
    return j;
  }catch{
    return null;
  }
}
async function dsPriceAndChange(mint){
  const j = await dsSearch(mint);
  const pair = j?.pairs?.[0];
  const price = Number(pair?.priceUsd) || 0;
  const changePct = Number(pair?.priceChange?.h24) || 0;
  return { price, changePct };
}

// ===== Confidence label =====
function pickConfidence(p){
  if (p >= 1) return "high";
  if (p > 0) return "medium";
  return "low";
}

// ===== Blended price (general SPL) =====
const MAJOR_SPL = new Set([
  "So11111111111111111111111111111111111111112", // SOL pseudo mint
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "JUPyiwrYJFskUPiHa7hkrL2Fzf8mFk7LtKXBs3CToyD", // JUP
  "DezXAZ8z7PnrnRJjz3wXBoRgixAeg22u71LtBH5e7UDm", // BONK
  "7W13pQwT5F9nMEW3YQicPZaBFtwZr9QG4bw35vjULK2f", // WIF
  "orcaEKTd74cKAXcFDcCk6N88G9nogjXwLMoMfeJMZgj", // ORCA
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", // mSOL
  "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3"  // PYTH
]);

async function blendedPrice(mint){
  const now = Date.now();
  const cached = BLENDED_CACHE.get(mint);
  if (cached && (now - cached.ts) < PRICE_TTL_MS) return cached;

  const [ {price: dsPrice, changePct}, jPrice ] = await Promise.all([ dsPriceAndChange(mint), jupPrice(mint) ]);

  const isMajor = MAJOR_SPL.has(mint);
  let price = 0, source = [];
  if (isMajor) {
    if (jPrice || dsPrice) { price = (jPrice * 0.7) + (dsPrice * 0.3); source = ["jup","dex"]; }
  } else {
    if (jPrice || dsPrice) { price = (dsPrice * 0.85) + (jPrice * 0.15); source = ["dex","jup"]; }
  }
  if (!price) { price = dsPrice || jPrice || 0; source = dsPrice ? ["dex"] : jPrice ? ["jup"] : []; }

  const out = { priceUsd: price || 0, changePct: changePct || 0, confidence: pickConfidence(price||0), source, ts: now, raw: { jup: jPrice, dex: dsPrice } };
  BLENDED_CACHE.set(mint, out);
  return out;
}

// ===== BlackCoin price (override: Dex → Jup → Pump.fun) =====
async function pumpFunPrice(mint){
  try{
    const p = await fetchJSON(`https://pump.fun/api/coin/${encodeURIComponent(mint)}`);
    // no guaranteed price field; best-effort parse:
    const price = Number(p?.usdPrice || p?.priceUsd || p?.price || 0);
    return price > 0 ? price : 0;
  }catch{ return 0; }
}
async function blackCoinPriceAndChange(mint){
  // Prefer DexScreener price & change, then Jup price, last Pump price (change from DS if available)
  const [{ price: dsP, changePct }, jP, pumpP] = await Promise.all([
    dsPriceAndChange(mint),
    jupPrice(mint),
    pumpFunPrice(mint)
  ]);
  const price = dsP || jP || pumpP || 0;
  return { priceUsd: price, changePct: changePct || 0, source: price === dsP ? ["dex"] : price === jP ? ["jup"] : ["pump"] };
}

// ===== Coingecko SOL (price + 24h change) with 10s cache =====
async function getSolUsdAndChange() {
  const now = Date.now();
  if ((now - CG_SOL_CACHE.ts) < TEN_S && CG_SOL_CACHE.priceUsd) {
    return { priceUsd: CG_SOL_CACHE.priceUsd, changePct: CG_SOL_CACHE.changePct };
  }
  try {
    const j = await fetchJSON("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true");
    const priceUsd = Number(j?.solana?.usd) || 0;
    const changePct = Number(j?.solana?.usd_24h_change) || 0;
    if (priceUsd > 0) {
      CG_SOL_CACHE.ts = now;
      CG_SOL_CACHE.priceUsd = priceUsd;
      CG_SOL_CACHE.changePct = changePct;
    }
    return { priceUsd, changePct };
  } catch {
    return { priceUsd: CG_SOL_CACHE.priceUsd || 0, changePct: CG_SOL_CACHE.changePct || 0 };
  }
}

// ===== Icon resolver (Jupiter → Solscan → Pump → GH fallback) =====
async function resolveTokenIcon(mint){
  if (!mint) return null;
  if (ICON_CACHE.has(mint)) return ICON_CACHE.get(mint);

  try {
    const j = await fetchJSON(`https://tokens.jup.ag/token/${encodeURIComponent(mint)}`);
    if (j?.logoURI) { ICON_CACHE.set(mint, j.logoURI); return j.logoURI; }
  } catch {}

  try {
    const s = await fetchJSON(`https://public-api.solscan.io/token/meta?tokenAddress=${encodeURIComponent(mint)}`);
    const img = s?.icon || s?.image || s?.metadata?.image;
    if (img) { ICON_CACHE.set(mint, img); return img; }
  } catch {}

  try {
    const p = await fetchJSON(`https://pump.fun/api/coin/${encodeURIComponent(mint)}`);
    const img = p?.image_uri || p?.image || p?.metadata?.image;
    if (img) { ICON_CACHE.set(mint, img); return img; }
  } catch {}

  const gh = `https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/${mint}/logo.png`;
  ICON_CACHE.set(mint, gh);
  return gh;
}

/**
 * POST /api/balances
 * body: { wallet: string }
 * returns: {
 *   sol: number,
 *   solUsd: number,
 *   solChangePct: number,
 *   tokens: [{ mint, amount, decimals, symbol, name, logo, priceUsd, usd, changePct }],
 *   portfolioDeltaPct: number
 * }
 */
app.post("/api/balances", async (req, res) => {
  try {
    const wallet = (req.body?.wallet || "").trim();
    if (!wallet) return res.status(400).json({ error: "Missing wallet" });
    if (!HELIUS_KEY) return res.status(500).json({ error: "Backend missing HELIUS_API_KEY" });

    const url = `https://api.helius.xyz/v0/addresses/${wallet}/balances?api-key=${HELIUS_KEY}&includeNative=true`;
    const r = await fetch(url, { headers: { "Cache-Control": "no-cache" }});
    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: `Helius ${r.status}`, body: t });
    }
    const data = await r.json();

    const lamports =
      Number(data?.nativeBalance?.lamports) ||
      Number(data?.native?.lamports) ||
      0;
    const sol = lamports / 1e9;

    const rawTokens =
      Array.isArray(data?.tokens) ? data.tokens :
      Array.isArray(data?.tokenBalances) ? data.tokenBalances :
      [];

    // Normalize token fields
    const tokensBase = rawTokens
      .map(t => ({
        mint: t.mint || t.tokenMint || "",
        amount: Number(t.amount ?? t.uiAmount ?? t.tokenAmount?.uiAmount ?? 0),
        decimals: Number(t.decimals ?? t.tokenAmount?.decimals ?? 0),
        symbol: t.symbol || t.tokenSymbol || t.info?.symbol || "",
        name: t.name || t.tokenName || t.info?.name || "",
        logo: t.logo || t.image || t.info?.image || ""
      }))
      .filter(t => t.mint && t.amount > 0);

    // SOL price + change
    const { priceUsd: solUsd, changePct: solChangePct } = await getSolUsdAndChange();
    const totalUsdFromSol = sol * solUsd;

    // Price tokens (BlackCoin override)
    const priced = await Promise.all(tokensBase.map(async t => {
      const isBlack = t.mint === TOKEN_MINT;
      // BlackCoin: force symbol/name regardless of Helius metadata
      const symbol = isBlack ? "BLCN" : (t.symbol || "");
      const name   = isBlack ? "BlackCoin" : (t.name || "");

      const icon   = await resolveTokenIcon(t.mint);

      if (isBlack) {
        const bc = await blackCoinPriceAndChange(t.mint);
        const priceUsd = Number(bc.priceUsd) || 0;
        const usd = priceUsd * t.amount;
        return { ...t, symbol, name, logo: icon, priceUsd, usd, changePct: bc.changePct };
      } else {
        const blend = await blendedPrice(t.mint);
        const priceUsd = Number(blend.priceUsd) || 0;
        const usd = priceUsd * t.amount;
        return { ...t, symbol, name, logo: icon, priceUsd, usd, changePct: Number(blend.changePct) || 0 };
      }
    }));

    const tokens = priced.sort((a, b) => (b.usd || 0) - (a.usd || 0));

    // ---- Weighted portfolio Δ with 25% per-asset influence cap ----
    // Build value parts (include SOL as a "token-like" part)
    const parts = [];
    let totalUSD = totalUsdFromSol;
    if (totalUsdFromSol > 0) parts.push({ val: totalUsdFromSol, pct: solChangePct, label: "SOL" });
    for (const t of tokens) {
      const val = Number(t.usd) || 0;
      if (val > 0) {
        parts.push({ val, pct: Number.isFinite(t.changePct) ? t.changePct : 0, label: t.symbol || t.name || t.mint });
        totalUSD += val;
      }
    }

    let portfolioDeltaPct = 0;
    if (totalUSD > 0 && parts.length) {
      // Cap each asset's contribution to 25% of total, then re-average
      const cap = 0.25 * totalUSD;
      const effVals = parts.map(p => Math.min(p.val, cap));
      const denom = effVals.reduce((s,v)=>s+v,0) || 1;
      const num = parts.reduce((s,p,i)=> s + effVals[i]*(p.pct/100), 0);
      portfolioDeltaPct = (num / denom) * 100;
    }

    res.json({
      sol,
      solUsd,
      solChangePct,
      tokens,
      portfolioDeltaPct
    });
  } catch (e) {
    err("Error /api/balances:", e);
    res.status(500).json({ error: e.message || "Failed to load balances" });
  }
});

// Unified price endpoint (uses BlackCoin override when mint matches)
app.get("/api/price", async (req, res) => {
  try{
    const mint = String(req.query.mint || "").trim();
    if (!mint) return res.status(400).json({ error: "Missing mint" });

    if (mint === TOKEN_MINT) {
      const out = await blackCoinPriceAndChange(mint);
      return res.json({
        mint,
        priceUsd: out.priceUsd,
        formatted: formatUsd(out.priceUsd),
        confidence: pickConfidence(out.priceUsd || 0),
        source: out.source,
        raw: { dex: out.source.includes("dex") ? out.priceUsd : null }
      });
    }

    const out = await blendedPrice(mint);
    res.json({
      mint,
      priceUsd: out.priceUsd,
      formatted: formatUsd(out.priceUsd),
      confidence: out.confidence,
      source: out.source,
      raw: out.raw
    });
  }catch(e){
    err("Error /api/price:", e);
    res.status(500).json({ error: e.message || "Failed" });
  }
});

/* ---------- Broadcasts ---------- */
const hhmm = (iso)=>{ try{ const d=new Date(iso); return d.toTimeString().slice(0,5);}catch{return "";} };
function normRow(r){
  if(!r) return null;
  return { id: r.id, wallet: r.wallet, message: r.message, created_at: r.created_at, display_time: hhmm(r.created_at) };
}
app.post("/api/broadcast", async (req,res)=>{
  try{
    const { wallet, message } = req.body;
    if(!wallet || !message) return res.status(400).json({error:"Missing fields"});
    const { data, error } = await supabase.from("hub_broadcasts").insert([{ wallet, message }]).select().maybeSingle();
    if(error) throw error;
    const row = normRow(data);
    wsBroadcast({ type:"insert", row });
    res.json({ success:true, data: row });
  }catch(e){ err("Error /api/broadcast:",e); res.status(500).json({error:e.message}); }
});
app.get("/api/broadcasts", async (_req,res)=>{
  try{
    const { data, error } = await supabase
      .from("hub_broadcasts")
      .select("id, wallet, message, created_at")
      .order("created_at",{ascending:false})
      .limit(25);
    if(error) throw error;
    const rows = (data||[]).map(normRow);
    res.json(rows);
  }catch(e){ err("Error /api/broadcasts:",e); res.status(500).json({error:e.message}); }
});

/* ---------- Refunds ---------- */
app.post("/api/refund", async (req,res)=>{
  try{
    const { wallet, token, rent, tx, status } = req.body;
    if(!wallet || !tx) return res.status(400).json({error:"Missing required fields"});
    const record = { wallet, token:token||"UNKNOWN", rent_reclaimed: rent ?? 0, tx, status: status || "Success" };
    const { data, error } = await supabase.from("hub_refund_history").insert([record]).select();
    if(error) throw error;
    res.json({ success:true, inserted:data });
  }catch(e){ err("❌ Error inserting refund:",e); res.status(500).json({error:e.message}); }
});
app.get("/api/refund-history", async (req,res)=>{
  try{
    const { wallet } = req.query;
    if(!wallet) return res.status(400).json({error:"Missing wallet"});
    res.set("Cache-Control","no-store");
    const { data, error } = await supabase
      .from("hub_refund_history")
      .select("*")
      .eq("wallet",wallet)
      .order("created_at",{ascending:false})
      .limit(50);
    if(error) throw error;
    res.json(data||[]);
  }catch(e){ err("Error /api/refund-history:",e); res.status(500).json({error:e.message}); }
});

/* ---------- WebSocket + realtime bridge ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path:"/ws" });
const clients = new Set();

wss.on("connection", async (socket)=>{
  socket.isAlive = true;
  clients.add(socket);
  socket.on("pong", ()=> socket.isAlive=true);
  socket.on("close", ()=> clients.delete(socket));
  socket.on("error", (e)=> err("WS error:", e?.message||e));

  // send last 25 on connect
  try{
    const { data, error } = await supabase
      .from("hub_broadcasts")
      .select("id, wallet, message, created_at")
      .order("created_at",{ascending:false})
      .limit(25);
    if(!error && data){
      const rows = (data||[]).map(normRow);
      socket.send(JSON.stringify({ type:"hello", rows }));
    }
  }catch(e){ err("WS hello failed:", e?.message||e); }
});
setInterval(()=>{
  for(const s of clients){
    if(s.isAlive===false) { try{s.terminate();}catch{}; continue; }
    s.isAlive=false; try{s.ping();}catch{}
  }
}, 30000);
function wsBroadcast(o){
  const msg = JSON.stringify(o);
  for(const s of clients){ if(s.readyState===s.OPEN) s.send(msg); }
}

/* ---------- Supabase Realtime: resilient subscription ---------- */
let rtChannel = null;
function subscribeToBroadcasts() {
  try {
    if (rtChannel) {
      try { supabase.removeChannel(rtChannel); } catch {}
      rtChannel = null;
    }
    rtChannel = supabase
      .channel("rt:hub_broadcasts", {
        config: { broadcast: { ack: true }, presence: { key: "server" } }
      })
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "hub_broadcasts" },
        (payload) => { const row = normRow(payload?.new || payload?.record); log("🔔 INSERT hub_broadcasts id=", row?.id); if (row) wsBroadcast({ type:"insert", row }); }
      )
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "hub_broadcasts" },
        (payload) => { const row = normRow(payload?.new || payload?.record); log("🔧 UPDATE hub_broadcasts id=", row?.id); if (row) wsBroadcast({ type:"update", row }); }
      )
      .on("postgres_changes",
        { event: "DELETE", schema: "public", table: "hub_broadcasts" },
        (payload) => { const old = payload?.old || payload?.record || null; const id = old?.id; log("🗑️  DELETE hub_broadcasts id=", id); if (id) wsBroadcast({ type:"delete", id }); }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") log("✅ Realtime subscribed: hub_broadcasts");
        else if (status === "CHANNEL_ERROR") { err("❌ Realtime CHANNEL_ERROR — retrying in 2s"); setTimeout(subscribeToBroadcasts, 2000); }
        else if (status === "TIMED_OUT") { warn("⚠️ Realtime TIMED_OUT — retrying in 2s"); setTimeout(subscribeToBroadcasts, 2000); }
        else if (status === "CLOSED") { warn("⚠️ Realtime CLOSED — retrying in 2s"); setTimeout(subscribeToBroadcasts, 2000); }
      });
  } catch (e) {
    err("Realtime subscribe failed:", e?.message || e);
    setTimeout(subscribeToBroadcasts, 2000);
  }
}
subscribeToBroadcasts();

server.listen(PORT, ()=> log(`✅ BlackCoin backend running on port ${PORT}`));
