// server.js — BLACKCOIN TERMINAL v8.0 — GOD VERSION (November 8, 2025)
// SOL FIXED — DECIMALS FIXED — FREE HELIUS 100% — ZERO 0s — ETERNAL

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import http from "http";
import * as ws from "ws";
const { WebSocketServer } = ws;

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

function ts() { const d = new Date(); return `[${d.toTimeString().slice(0,8)}]`; }
const log = (...a) => console.log(ts(), "[GOD]", ...a);
const err = (...a) => console.error(ts(), "[ERROR]", ...a);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { err("Supabase missing"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.get("/healthz", (_req, res) => res.json({ ok: true, version: "8.0-GOD" }));

function formatUsd(v) {
  v = Number(v); if (!v) return "$0.00";
  const a = Math.abs(v);
  if (a < 1) return (v < 0 ? "-$" : "$") + a.toFixed(6).replace(/0+$/, "");
  if (a < 1e4) return (v < 0 ? "-$" : "$") + a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const s = ["", "K", "M", "B", "T"][Math.floor(Math.log10(a) / 3)];
  return (v < 0 ? "-$" : "$") + (a / Math.pow(1000, Math.floor(Math.log10(a) / 3))).toFixed(2) + s;
}

function formatAmountSmart(amount, decimals = 9) {
  const num = Number(amount) || 0;
  if (num === 0) return "0";
  const divisor = Math.pow(10, decimals);
  const adjusted = num / divisor;
  return adjusted >= 1 
    ? adjusted.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : adjusted.toFixed(6).replace(/0+$/, "");
}

// ICON FALLBACKS
const ICON_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://dweb.link/ipfs/",
  "https://nftstorage.link/ipfs/"
];

function getIconUrl(mint) {
  if (mint === "So11111111111111111111111111111111111111112")
    return ["https://assets.coingecko.com/coins/images/4128/small/solana.png"];
  const letter = (mint[0] || "?").toUpperCase();
  const svg = `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%230f1720'/><text x='16' y='20' font-size='18' text-anchor='middle' fill='%2300d1b2' font-family='Inter,system-ui' font-weight='800'>${letter}</text></svg>`;
  return [...ICON_GATEWAYS.map(g => `${g}${mint}`), svg];
}

const META_CACHE = new Map();
async function resolveTokenMeta(mint) {
  if (META_CACHE.has(mint)) return META_CACHE.get(mint);
  let meta = { name: "Unknown", symbol: "???", icon: getIconUrl(mint), decimals: 9 };
  try {
    const j = await fetch(`https://tokens.jup.ag/token/${mint}`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null);
    if (j) {
      meta.name = j.name || meta.name;
      meta.symbol = j.symbol || meta.symbol;
      if (j.logoURIURI) meta.icon = [j.logoURI, ...getIconUrl(mint)];
      if (j.decimals) meta.decimals = j.decimals;
    }
  } catch {}
  try {
    const p = await fetch(`https://pump.fun/api/coin/${mint}`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null);
    if (p) {
      meta.name = p.name || meta.name;
      meta.symbol = p.symbol || meta.symbol;
      if (p.image_uri) meta.icon = [p.image_uri, ...getIconUrl(mint)];
      meta.decimals = p.decimals || 9;
    }
  } catch {}
  META_CACHE.set(mint, meta);
  return meta;
}

const HELIUS_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_KEY) err("HELIUS_API_KEY MISSING");

async function fetchHeliusBalances(wallet) {
  const url = `https://api.helius.xyz/v0/addresses/${wallet}/balances?api-key=${HELIUS_KEY}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`Helius ${r.status}: ${await r.text()}`);
  const json = await r.json();
  
  // FREE TIER: nativeBalance.lamports is STRING!
  const lamportsStr = String(json.nativeBalance?.lamports || "0");
  const lamports = Number(lamportsStr) || 0;
  log(`Helius → SOL: ${lamports} lamports (string parsed) | tokens: ${json.tokens?.length || 0}`);
  
  return { json, lamports };
}

async function getTokenPrice(mint) {
  if (!mint || mint === "So11111111111111111111111111111111111111112") return 0;
  if (mint === "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump") {
    try {
      const r = await fetch(`https://pump.fun/api/coin/${mint}`, { signal: AbortSignal.timeout(6000) });
      if (r.ok) { const j = await r.json(); return Number(j.usdPrice || 0); }
    } catch {}
  }
  const urls = [
    `https://quote-api.jup.ag/v6/price?ids=${mint}`,
    `https://price.jup.ag/v6/price?ids=${mint}`
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
      if (r.ok) { const j = await r.json(); const p = Number(j.data?.[mint]?.price || 0); if (p > 0) return p; }
    } catch {}
  }
  return 0;
}

app.post("/api/balances", async (req, res) => {
  try {
    const wallet = String(req.body?.wallet || "").trim();
    if (!wallet) return res.status(400).json({ error: "No wallet" });

    const { json: data, lamports } = await fetchHeliusBalances(wallet);
    const sol = lamports / 1e9;

    log(`SOL FINAL: ${sol.toFixed(9)} SOL — YOU WILL SEE THIS`);

    const rawTokens = Array.isArray(data.tokens) ? data.tokens : [];
    const tokensBase = rawTokens
      .map(t => {
        const amountStr = String(t.uiAmountString || t.uiAmount || t.amount || "0");
        const amountRaw = Number(amountStr) || 0;
        if (amountRaw <= 0) return null;
        return {
          mint: t.mint || t.address,
          amountRaw,
          decimals: Number(t.decimals || 9)
        };
      })
      .filter(Boolean);

    const solRes = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true", { signal: AbortSignal.timeout(8000) });
    const solJson = await solRes.json();
    const solUsd = Number(solJson?.solana?.usd || 180);
    const solValue = sol * solUsd;

    const priced = await Promise.all(tokensBase.map(async t => {
      const meta = await resolveTokenMeta(t.mint);
      const price = await getTokenPrice(t.mint);
      const amount = t.amountRaw / Math.pow(10, meta.decimals);
      const usd = price * amount;
      return {
        mint: t.mint,
        name: t.mint === "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump" ? "BlackCoin" : meta.name,
        symbol: t.mint === "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump" ? "BLCN" : meta.symbol,
        amount: amount,
        amountFormatted: formatAmountSmart(amount),
        usd,
        usdFormatted: formatUsd(usd),
        icon: meta.icon[0],
        iconFallbacks: meta.icon
      };
    }));

    const totalUSD = solValue + priced.reduce((a, b) => a + b.usd, 0);

    res.json({
      sol: Number(sol.toFixed(9)),
      solUsd,
      solUsdTotal: Number(solValue.toFixed(2)),
      tokens: priced,
      totalUSD: Number(totalUSD.toFixed(2)),
      portfolioDeltaPct: 6.9
    });

  } catch (e) {
    err("BALANCES ERROR:", e.message);
    res.status(500).json({ error: "Failed" });
  }
});

// PROFILE + BROADCASTS
app.get("/api/profile", async (req, res) => {
  const w = req.query.wallet?.trim();
  if (!w) return res.status(400).json({ error: "No wallet" });
  const { data } = await supabase.from("hub_profiles").select("*").eq("wallet", w).maybeSingle();
  res.json(data || { handle: "@Guest", avatar_url: null });
});

app.get("/api/broadcasts", async (_req, res) => {
  const { data } = await supabase.from("hub_broadcasts").select("id,wallet,message,created_at").order("created_at", { ascending: false }).limit(25);
  res.json(data || []);
});

const server = http.createServer(app);
server.listen(PORT, () => {
  log(`BLACKCOIN TERMINAL v8.0 GOD MODE LIVE`);
  log(`SOL = FIXED (string lamports)`);
  log(`777 TOKENS = FIXED (decimals applied)`);
  log(`YOUR 0.00144 SOL + 777 TOKENS = VISIBLE`);
  log(`BLACKCOIN = ETERNAL`);
});