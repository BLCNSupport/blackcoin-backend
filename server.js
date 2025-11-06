/**
 * server.js — BlackCoin Shared Backend (Final Rules • Multi‑page)
 * - Pages supported: Operator Hub, Staking Terminal, Main Site
 * - Broadcasts: DEV/MOD can post (hardcoded lists); users read-only
 * - No delete endpoint; deletions are manual in Supabase and streamed via SSE
 * - SSE: /api/realtime streams INSERT + DELETE of hub_broadcasts
 * - Profiles: avatar + handle saved; avatar uploaded to storage bucket hub_avatars
 * - Wallet helpers: SOL + SPL balances; refund scan/claim placeholder
 * - Charts: /api/chart, /api/latest with background poller
 * - Hybrid unlock support: /api/can-post
 *
 * Tables:
 *   public.hub_profiles (wallet TEXT PK, handle TEXT, avatar_url TEXT, updated_at TIMESTAMPTZ)
 *   public.hub_broadcasts (id BIGINT IDENTITY PK, wallet TEXT, message TEXT, time TIMESTAMPTZ)
 *   public.hub_refund_history (id BIGINT IDENTITY PK, wallet TEXT, token TEXT, rent_reclaimed NUMERIC, tx TEXT, status TEXT, created_at TIMESTAMPTZ)
 *
 * Storage:
 *   hub_avatars  (public read)
 */

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import fetchOrig from "node-fetch";
import { createClient } from "@supabase/supabase-js";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

/* ------------------------ Middleware ------------------------ */
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const upload = multer({ storage: multer.memoryStorage() });

/* ------------------------ Supabase ------------------------- */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY; // service role

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false },
  global: { fetch: fetchOrig },
});

/* ------------------- Names / Constants --------------------- */
const T_PROFILES = "hub_profiles";
const T_BROADCASTS = "hub_broadcasts";
const T_REFUNDS = "hub_refund_history";
const AVATAR_BUCKET = "hub_avatars";

/* ------------------------ Roles ---------------------------- */
const DEV_WALLET =
  process.env.DEV_WALLET || "94BkuiUMv7jMGKBEhQ87gJVqk9kyQiFus5HbR3hGzhru";
const MOD_WALLETS = (process.env.MOD_WALLETS ||
  "ModWallet1111111111111111111111111111111111111111,ModWallet2222222222222222222222222222222222222222,ModWallet3333333333333333333333333333333333333333").split(",");

function roleOf(wallet) {
  if (!wallet) return "USER";
  if (wallet === DEV_WALLET) return "DEV";
  if (MOD_WALLETS.includes(wallet)) return "MOD";
  return "USER";
}
function ensureCanPost(wallet) {
  const r = roleOf(wallet);
  if (r === "DEV" || r === "MOD") return r;
  const e = new Error("Forbidden: read-only");
  e.status = 403;
  throw e;
}

/* ------------------- Health / Basics ----------------------- */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/* ------------------ Hybrid Unlock Helper ------------------- */
app.get("/api/can-post", (req, res) => {
  const wallet = (req.query.wallet || "").trim();
  const role = roleOf(wallet);
  res.json({ canPost: role === "DEV" || role === "MOD", role });
});

/* ====================== Broadcasts ========================= */
/* GET — oldest→newest, joined with profile for avatar_url/handle, enriched with role + type */
app.get("/api/broadcasts", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from(T_BROADCASTS)
      .select("*")
      .order("time", { ascending: true })
      .limit(500);
    if (error) throw error;

    const wallets = Array.from(new Set((data || []).map(r => r.wallet).filter(Boolean)));
    let profiles = [];
    if (wallets.length) {
      const { data: profs, error: pErr } = await supabase
        .from(T_PROFILES)
        .select("wallet, handle, avatar_url")
        .in("wallet", wallets);
      if (pErr) throw pErr;
      profiles = profs || [];
    }
    const byWallet = new Map(profiles.map(p => [p.wallet, p]));
    const enriched = (data || []).map(row => ({
      ...row,
      handle: byWallet.get(row.wallet)?.handle || row.handle || "@Operator",
      avatar_url: byWallet.get(row.wallet)?.avatar_url || row.avatar_url || null,
      role: roleOf(row.wallet),
      type: "broadcast",
    }));
    res.json(enriched);
  } catch (err) {
    console.error("GET /api/broadcasts error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* POST — DEV/MOD only, with basic anti-spam validation */
function isLowQuality(msg) {
  if (!msg) return true;
  const s = msg.replace(/\s+/g, " ").trim();
  if (!s) return true;
  if (s.length > 500) return true;
  // only punctuation/emojis/repeated chars (very naive filter)
  if (/^([!?.\-\*_~🔥💥🚀🌪️🌊⚡❤️]+|\.){1,}$/.test(s)) return true;
  if (/^(.)\1{8,}$/.test(s)) return true; // same char repeated 9+
  return false;
}

app.post("/api/broadcasts", async (req, res) => {
  try {
    const { wallet, message } = req.body || {};
    if (!wallet || typeof message !== "string") {
      return res.status(400).json({ error: "Missing wallet or message" });
    }

    ensureCanPost(wallet);

    if (isLowQuality(message)) {
      return res.status(400).json({ error: "Message too short or low quality." });
    }

    const entry = { wallet, message, time: new Date().toISOString() };
    const { error } = await supabase.from(T_BROADCASTS).insert([entry]);
    if (error) throw error;

    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/broadcasts error:", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* Legacy alias */
app.post("/api/broadcast", async (req, res) => {
  try {
    const { wallet, message } = req.body || {};
    if (!wallet || typeof message !== "string") {
      return res.status(400).json({ error: "Missing wallet or message" });
    }
    ensureCanPost(wallet);
    if (isLowQuality(message)) {
      return res.status(400).json({ error: "Message too short or low quality." });
    }
    const entry = { wallet, message, time: new Date().toISOString() };
    const { error } = await supabase.from(T_BROADCASTS).insert([entry]);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/broadcast error:", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* ====================== Profiles =========================== */
app.post("/api/profile", async (req, res) => {
  try {
    const { wallet, handle, avatar_url } = req.body || {};
    if (!wallet) return res.status(400).json({ error: "Missing wallet" });

    const up = {
      wallet,
      handle: handle ?? null,
      avatar_url: avatar_url ?? null,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from(T_PROFILES)
      .upsert(up, { onConflict: "wallet" });
    if (error) throw error;

    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/profile error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/avatar-upload", upload.single("avatar"), async (req, res) => {
  try {
    const file = req.file;
    const wallet = req.body?.wallet;
    if (!file || !wallet) {
      return res.status(400).json({ error: "Missing avatar or wallet" });
    }

    const ext = (file.originalname.split(".").pop() || "jpg").toLowerCase();
    const filePath = `${wallet}/${Date.now()}.${ext}`;

    const { error: upErr } = await supabase.storage
      .from(AVATAR_BUCKET)
      .upload(filePath, file.buffer, {
        upsert: true,
        contentType: file.mimetype,
      });
    if (upErr) throw upErr;

    const { data: pub } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(filePath);

    await supabase
      .from(T_PROFILES)
      .upsert({ wallet, avatar_url: pub.publicUrl, updated_at: new Date().toISOString() }, { onConflict: "wallet" });

    res.json({ ok: true, url: pub.publicUrl });
  } catch (err) {
    console.error("POST /api/avatar-upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ========================= SSE ============================ */
const sseClients = new Set();

app.get("/api/realtime", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

const realtimeChannel = supabase
  .channel("realtime-broadcasts")
  .on("postgres_changes", { event: "INSERT", schema: "public", table: T_BROADCASTS }, (payload) => {
    const out = JSON.stringify({
      type: "INSERT",
      new: { ...payload.new, role: roleOf(payload.new.wallet), type: "broadcast" },
    });
    for (const c of sseClients) c.write(`data: ${out}\n\n`);
  })
  .on("postgres_changes", { event: "DELETE", schema: "public", table: T_BROADCASTS }, (payload) => {
    const out = JSON.stringify({ type: "DELETE", old: payload.old });
    for (const c of sseClients) c.write(`data: ${out}\n\n`);
  })
  .subscribe((status) => console.log("Realtime status:", status));

/* ===================== Wallet / Refund ===================== */
const HELIUS_KEY = process.env.HELIUS_KEY || "";
const RPC_URL =
  process.env.RPC_URL || (HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : "");

app.get("/api/wallet/:addr/balances", async (req, res) => {
  const addr = req.params.addr;
  if (!addr || !RPC_URL) return res.status(400).json({ error: "Missing addr or RPC_URL" });
  try {
    const bal = await fetchOrig(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [addr] }),
    }).then((r) => r.json());
    const lamports = bal?.result?.value ?? 0;
    const sol = (lamports / 1_000_000_000).toFixed(4);

    const tok = await fetchOrig(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "getTokenAccountsByOwner",
        params: [addr, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "jsonParsed" }],
      }),
    }).then((r) => r.json());

    const spl_tokens = (tok?.result?.value || []).map((v) => {
      const info = v?.account?.data?.parsed?.info;
      const mint = info?.mint;
      const ata = v?.pubkey;
      const amount = info?.tokenAmount?.uiAmount || 0;
      return { mint, ata, amount };
    });

    res.json({ sol, spl_tokens });
  } catch (e) {
    res.status(500).json({ error: e.message || "RPC failed" });
  }
});

app.post("/api/refund/scan", async (req, res) => {
  const { wallet } = req.body || {};
  if (!wallet || !RPC_URL) return res.status(400).json({ error: "Missing wallet or RPC_URL" });
  try {
    const tok = await fetchOrig(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "getTokenAccountsByOwner",
        params: [wallet, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "jsonParsed" }],
      }),
    }).then((r) => r.json());

    const accounts = [];
    for (const v of tok?.result?.value || []) {
      const info = v?.account?.data?.parsed?.info;
      const amount = info?.tokenAmount?.uiAmount || 0;
      if (amount === 0) {
        const rentLamports = 2039280; // typical ATA rent; may vary by cluster
        accounts.push({
          mint: info?.mint,
          ata: v?.pubkey,
          balance: 0,
          rent_sol: (rentLamports / 1_000_000_000).toFixed(6),
        });
      }
    }
    res.json({ accounts });
  } catch (e) {
    res.status(500).json({ error: e.message || "scan failed" });
  }
});

app.post("/api/refund/claim", async (req, res) => {
  const { wallet, atas } = req.body || {};
  if (!wallet || !Array.isArray(atas))
    return res.status(400).json({ error: "wallet and atas[] required" });
  // Placeholder: client constructs and signs closeAccount transactions.
  res.json({ ok: true, message: "Construct and sign closeAccount transactions client-side." });
});

app.post("/api/refund", async (req, res) => {
  try {
    const { wallet, token, rent, tx, status } = req.body || {};
    if (!wallet || !tx) return res.status(400).json({ error: "Missing wallet or tx" });

    const record = {
      wallet,
      token: token || "UNKNOWN",
      rent_reclaimed: rent ?? 0,
      tx,
      status: status || "Success",
      created_at: new Date().toISOString(),
    };

    const { data, error } = await supabase.from(T_REFUNDS).insert([record]).select();
    if (error) throw error;
    res.json({ success: true, inserted: data });
  } catch (err) {
    console.error("POST /api/refund error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ========================= Charts ========================= */
const TOKEN_MINT =
  process.env.TOKEN_MINT || "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";
const FETCH_INTERVAL = parseInt(process.env.FETCH_INTERVAL || "5000", 10);
let memoryCache = [];

async function insertPoint(point) {
  try {
    const { error } = await supabase.from("chart_data").insert([point]);
    if (error) console.error("Supabase insert failed:", error.message);
  } catch (err) {
    console.error("Supabase insert exception:", err);
  }
}
async function fetchLiveData() {
  try {
    const res = await fetchOrig(
      `https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`,
      { headers: { "Cache-Control": "no-cache" } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const pair = json.pairs?.[0];
    if (!pair) return;

    const point = {
      timestamp: new Date().toISOString(),
      price: parseFloat(pair.priceUsd),
      change: parseFloat(pair.priceChange?.h24),
      volume: parseFloat(pair.volume?.h24),
    };
    if ([point.price, point.change, point.volume].some(v => isNaN(v))) return;

    memoryCache.push(point);
    if (memoryCache.length > 10000) memoryCache.shift();
    await insertPoint(point);
  } catch (err) {
    console.error("fetchLiveData failed:", err);
  }
}
fetchLiveData();
setInterval(fetchLiveData, FETCH_INTERVAL);

function bucketMs(interval) {
  switch (interval) {
    case "1m": return 60_000;
    case "5m": return 300_000;
    case "30m": return 1_800_000;
    case "1h": return 3_600_000;
    case "D": return 86_400_000;
    default: return 60_000;
  }
}
function getWindow(interval) {
  const now = Date.now();
  if (interval === "D") return new Date(now - 30 * 86_400_000).toISOString();
  if (interval === "1h") return new Date(now - 7 * 86_400_000).toISOString();
  return new Date(now - 86_400_000).toISOString();
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
  return Array.from(byKey.values()).sort((a,b)=> new Date(a.timestamp) - new Date(b.timestamp));
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

    const raw = data?.length ? data :
      memoryCache.filter(p => new Date(p.timestamp) >= new Date(cutoff));

    const points = bucketize(raw, interval);
    const latest = raw.length ? raw[raw.length - 1] : memoryCache.at(-1);
    const totalCount = count || raw.length;
    const nextPage = offset + limit < totalCount ? page + 1 : null;

    res.json({ points, latest, page, nextPage, hasMore: Boolean(nextPage) });
  } catch (err) {
    console.error("GET /api/chart error:", err);
    res.status(500).json({ error: "Failed to fetch chart data", message: err.message });
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
  } catch (err) {
    console.error("GET /api/latest error:", err);
    res.status(500).json({ error: "Failed" });
  }
});

/* -------------------------- Start -------------------------- */
app.listen(PORT, () => {
  console.log(`✅ BlackCoin Server running on :${PORT}`);
});
