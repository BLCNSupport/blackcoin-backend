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
// Validate Supabase env vars
// -------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_URL or SUPABASE_KEY is missing!');
  process.exit(1);
}

// -------------------------
// Supabase client
// -------------------------
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// -------------------------
// Token info
// -------------------------
const TOKEN_MINT = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";
const FETCH_INTERVAL = 5000; // 5 seconds

// -------------------------
// In-memory cache for fallback
// -------------------------
let memoryCache = [];

// -------------------------
// Insert with retry
// -------------------------
async function insertPoint(point, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const { data, error } = await supabase.from('chart_data').insert([point]).select();
    if (!error) {
      console.log("Supabase insert succeeded:", data);
      return true;
    } else {
      console.warn(`Insert failed, attempt ${i + 1}:`, error);
      await new Promise(r => setTimeout(r, 500)); // wait 500ms before retry
    }
  }
  console.error("Insert permanently failed:", point);
  return false;
}

// -------------------------
// Fetch live data from DexScreener and save to Supabase
// -------------------------
async function fetchLiveData() {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`);
    const data = await res.json();
    if (!data.pairs || !data.pairs[0]) return;

    const pair = data.pairs[0];

    // Ensure all numeric values
    const price = parseFloat(pair.priceUsd) || 0;
    const change = parseFloat(pair.priceChange?.h24) || 0;
    const volume = parseFloat(pair.volume?.h24) || 0;

    // Use a valid ISO string for timestamp
    const timestamp = new Date().toISOString();

    const point = { timestamp, price, change, volume };

    // Save in-memory (last 24h)
    memoryCache.push(point);
    memoryCache = memoryCache.filter(
      p => new Date(p.timestamp) >= new Date(Date.now() - 24 * 60 * 60 * 1000)
    );

    console.log("Inserting point:", point);
    await insertPoint(point);

    // Optional: delete old points (>24h) from Supabase
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { error: deleteError } = await supabase.from('chart_data').delete().lt('timestamp', cutoff);
    if (deleteError) console.error("Supabase delete old points error:", deleteError);

  } catch (err) {
    console.error("Error fetching live data:", err);
  }
}

// -------------------------
// Start fetching live data
// -------------------------
setInterval(fetchLiveData, FETCH_INTERVAL);
fetchLiveData(); // immediate fetch

// -------------------------
// API endpoint for frontend chart
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
      console.error("Supabase fetch error:", error);
      data = memoryCache.filter(p => new Date(p.timestamp) >= new Date(Date.now() - timeframeMs));
    }

    // Downsample to max 500 points
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
