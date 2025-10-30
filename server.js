// server.js — BlackCoin backend (UTC version + Operator Hub extensions)
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import multer from "multer";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// === Supabase ===
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // service_role
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("SUPABASE_URL or SUPABASE_KEY missing");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// === Chart data poller (unchanged) ===
const TOKEN_MINT = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";
const FETCH_INTERVAL = 5000;
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
    const res = await fetch(
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

    if ([point.price, point.change, point.volume].some((v) => isNaN(v))) return;
    memoryCache.push(point);
    if (memoryCache.length > 10000) memoryCache.shift();

    await insertPoint(point);
  } catch (err) {
    console.error("fetchLiveData failed:", err);
  }
}

fetchLiveData();
setInterval(fetchLiveData, FETCH_INTERVAL);

// === Chart endpoints (unchanged) ===
function bucketMs(interval) {
  switch (interval) {
    case "1m":
      return 60 * 1000;
    case "5m":
      return 5 * 60 * 1000;
    case "30m":
      return 30 * 60 * 1000;
    case "1h":
      return 60 * 60 * 1000;
    case "D":
      return 24 * 60 * 60 * 1000;
    default:
      return 60 * 1000;
  }
}
function getWindow(interval) {
  const now = Date.now();
  if (interval === "D")
    return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  if (interval === "1h")
    return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  return new Date(now - 24 * 60 * 60 * 1000).toISOString();
}
function floorToBucketUTC(tsISO, interval) {
  const ms = bucketMs(interval);
  const d = new Date(tsISO);
  const floored = new Date(Math.floor(d.getTime() / ms) * ms);
  return floored;
}
function bucketize(rows, interval) {
  const byKey = new Map();
  for (const r of rows) {
    const keyDate = floorToBucketUTC(r.timestamp, interval);
    const key = keyDate.toISOString();
    const price = +r.price;
    const change = +r.change;
    const vol = +r.volume;

    if (!byKey.has(key)) {
      byKey.set(key, { timestamp: key, price, change, volume: 0 });
    }
    const b = byKey.get(key);
    b.price = price;
    b.change = change;
    b.volume += isNaN(vol) ? 0 : vol;
  }
  return Array.from(byKey.values()).sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );
}

// Paginated chart
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

    const raw =
      data?.length > 0
        ? data
        : memoryCache.filter((p) => new Date(p.timestamp) >= new Date(cutoff));

    const points = bucketize(raw, interval);
    const latest =
      raw.length > 0 ? raw[raw.length - 1] : memoryCache[memoryCache.length - 1];
    const totalCount = count || raw.length;
    const nextPage = offset + limit < totalCount ? page + 1 : null;

    res.json({ points, latest, page, nextPage, hasMore: Boolean(nextPage) });
  } catch (err) {
    console.error("Error /api/chart:", err);
    res
      .status(500)
      .json({ error: "Failed to fetch chart data", message: err.message });
  }
});

// Latest tick
app.get("/api/latest", async (req, res) => {
  try {
    let latest = memoryCache[memoryCache.length - 1];
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
    console.error("Error /api/latest:", err);
    res.status(500).json({ error: "Failed" });
  }
});

/* ======================================================
   === Operator Hub / Terminal API Extensions ===
   ====================================================== */

// === 1. Save or update user profile ===
app.post("/api/profile", async (req, res) => {
  try {
    const { wallet, handle, avatar_url } = req.body;
    if (!wallet) return res.status(400).json({ error: "Missing wallet" });

    const { data, error } = await supabase
      .from("hub_profiles")
      .upsert(
        {
          wallet,
          handle: handle || "@Operator",
          avatar_url: avatar_url || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "wallet" }
      )
      .select();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error("Error /api/profile:", err);
    res.status(500).json({ error: err.message });
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
      .upload(fileName, file.buffer, { contentType: file.mimetype, upsert: true });
    if (uploadErr) throw uploadErr;

    const { data: publicURL } = supabase.storage
      .from("hub_avatars")
      .getPublicUrl(fileName);

    await supabase
      .from("hub_profiles")
      .update({ avatar_url: publicURL.publicUrl })
      .eq("wallet", wallet);

    res.json({ success: true, url: publicURL.publicUrl });
  } catch (err) {
    console.error("Error /api/avatar-upload:", err);
    res.status(500).json({ error: err.message });
  }
});

// === 3. Post new broadcast ===
app.post("/api/broadcast", async (req, res) => {
  try {
    const { wallet, message } = req.body;
    if (!wallet || !message) return res.status(400).json({ error: "Missing fields" });

    const entry = {
      wallet,
      message,
      time: new Date().toISOString(),
    };
    const { error } = await supabase.from("hub_broadcasts").insert([entry]);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error("Error /api/broadcast:", err);
    res.status(500).json({ error: err.message });
  }
});

// === 4. Fetch broadcasts (latest 50) ===
app.get("/api/broadcasts", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("hub_broadcasts")
      .select("*")
      .order("time", { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("Error /api/broadcasts:", err);
    res.status(500).json({ error: err.message });
  }
});

// === 5. Log refund transaction ===
app.post("/api/refund", async (req, res) => {
  try {
    const { wallet, token, rent, tx, status } = req.body;
    if (!wallet || !tx) return res.status(400).json({ error: "Missing fields" });

    const record = {
      wallet,
      token,
      rent,
      tx,
      status: status || "Success",
      created_at: new Date().toISOString(),
    };
    const { error } = await supabase.from("hub_refund_history").insert([record]);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error("Error /api/refund:", err);
    res.status(500).json({ error: err.message });
  }
});

// === 6. Fetch wallet summary (optional placeholder) ===
app.get("/api/wallet", async (req, res) => {
  try {
    const addr = req.query.addr;
    if (!addr) return res.status(400).json({ error: "Missing addr" });
    // Placeholder: real integration can call Solana RPC later
    res.json({
      address: addr,
      balances: [
        { name: "SOL", amount: 12.34, value: 12.34 * 305 },
        { name: "BlackCoin", amount: 1000000, value: 187.5 },
      ],
    });
  } catch (err) {
    console.error("Error /api/wallet:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ====================================================== */

app.listen(PORT, () =>
  console.log(`✅ BlackCoin backend running (UTC) on port ${PORT}`)
);
