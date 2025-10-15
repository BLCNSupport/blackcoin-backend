// server.js (ES Modules, Render safe)
import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// -------------------------
// Supabase setup
// -------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_URL or SUPABASE_KEY is missing!');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// -------------------------
// Token info
// -------------------------
const TOKEN_MINT = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";
const FETCH_INTERVAL = 5000; // 5 seconds

// -------------------------
// In-memory cache
// -------------------------
let memoryCache = [];

// -------------------------
// Insert with retry (safe)
// -------------------------
async function insertPoint(point, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const { data, error } = await supabase.from('chart_data').insert([point]).select();
    if (!error) {
      console.log(`Supabase insert succeeded: ${point.timestamp}`);
      return true;
    } else {
      console.warn(`Insert failed, attempt ${i + 1}:`, error.message);
      await new Promise(r => setTimeout(r, 500));
    }
  }
  console.error("Insert permanently failed:", point);
  return false;
}

// -------------------------
// Fetch live data
// -------------------------
async function fetchLiveData() {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`);
    const data = await res.json();
    if (!data.pairs || !data.pairs[0]) return;

    const pair = data.pairs[0];
    const price = parseFloat(pair.priceUsd) || 0;
    const change = parseFloat(pair.priceChange?.h24) || 0;
    const volume = parseFloat(pair.volume?.h24) || 0;

    // Unique timestamp to avoid collisions
    const timestamp = new Date().toISOString() + `.${Date.now() % 1000}`;
    const point = { timestamp, price, change, volume };

    // Save in-memory (last 24h)
    memoryCache.push(point);
    memoryCache = memoryCache.filter(
      p => new Date(p.timestamp) >= new Date(Date.now() - 24 * 60 * 60 * 1000)
    );

    console.log("Inserting point:", point);
    await insertPoint(point);

  } catch (err) {
    console.error("Error fetching live data:", err);
  }
}

// -------------------------
// Periodic cleanup of old points (once per hour)
// -------------------------
setInterval(async () => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase.from('chart_data').delete().lt('timestamp', cutoff);
  if (error) console.error("Supabase delete old points error:", error.message);
}, 60 * 60 * 1000); // every hour

// -------------------------
// Start fetching live data
// -------------------------
setInterval(fetchLiveData, FETCH_INTERVAL);
fetchLiveData(); // immediate fetch

// -------------------------
// API endpoint for frontend
// -------------------------
app.get('/api/chart', async (req, res) => {
  const interval = req.query.interval || 'D';
  let timeframeMs = 24 * 60 * 60 * 1000;

  switch(interval){
    case '1m': timeframeMs = 60*1000; break;
    case '5m': timeframeMs = 5*60*1000; break;
    case '30m': timeframeMs = 30*60*1000; break;
    case '1h': timeframeMs = 60*60*1000; break;
    case 'D': timeframeMs = 24*60*60*1000; break;
  }

  const cutoff = new Date(Date.now() - timeframeMs).toISOString();

  try {
    let { data, error } = await supabase
      .from('chart_data')
      .select('*')
      .gte('timestamp', cutoff)
      .order('timestamp', { ascending: true });

    if (error) {
      console.error("Supabase fetch error:", error.message);
      data = memoryCache.filter(p => new Date(p.timestamp) >= new Date(Date.now() - timeframeMs));
    }

    // Downsample max 500 points
    if (data.length > 500) {
      const sampleRate = Math.ceil(data.length / 500);
      data = data.filter((_, i) => i % sampleRate === 0);
    }

    res.json(data);

  } catch (err) {
    console.error("Error fetching chart data:", err);
    res.json(memoryCache.filter(p => new Date(p.timestamp) >= new Date(Date.now() - timeframeMs)));
  }
});

// -------------------------
// Start server
// -------------------------
app.listen(PORT, () => console.log(`BlackCoin backend running on port ${PORT}`));
