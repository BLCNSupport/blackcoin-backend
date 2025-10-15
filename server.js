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

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_URL or SUPABASE_KEY is missing!');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const TOKEN_MINT = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";
const FETCH_INTERVAL = 5000; // 5 seconds

// -------------------------
// In-memory cache for fast access
// -------------------------
let memoryCache = [];

// -------------------------
// Insert new point into Supabase
// -------------------------
async function insertPoint(point, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const { error } = await supabase.from('chart_data').insert([point]);
    if (!error) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// -------------------------
// Fetch live data from DexScreener
// -------------------------
async function fetchLiveData() {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`);
    const json = await res.json();
    if (!json.pairs || !json.pairs[0]) return;

    const pair = json.pairs[0];
    const price = parseFloat(pair.priceUsd) || 0;
    const change = parseFloat(pair.priceChange?.h24) || 0; // 24h %
    const volume = parseFloat(pair.volume?.h24) || 0;       // 24h volume
    const timestamp = new Date().toISOString();

    const point = { timestamp, price, change, volume };

    memoryCache.push(point);
    await insertPoint(point);

    // Keep only last 48h in memory to prevent memory growth
    memoryCache = memoryCache.filter(p => new Date(p.timestamp) >= new Date(Date.now() - 48*60*60*1000));
  } catch (err) {
    console.error("Error fetching live data:", err);
  }
}

// Start fetching live data
fetchLiveData();
setInterval(fetchLiveData, FETCH_INTERVAL);

// -------------------------
// API endpoint for frontend
// -------------------------
app.get('/api/chart', async (req, res) => {
  const interval = req.query.interval || 'D'; // 1m, 5m, 30m, 1h, D
  let cutoff = new Date(Date.now() - 24*60*60*1000); // default last 24h

  switch(interval) {
    case '1m': cutoff = new Date(Date.now() - 60*60*1000); break;       // last 1h
    case '5m': cutoff = new Date(Date.now() - 3*60*60*1000); break;     // last 3h
    case '30m': cutoff = new Date(Date.now() - 12*60*60*1000); break;   // last 12h
    case '1h': cutoff = new Date(Date.now() - 24*60*60*1000); break;    // last 24h
    case 'D': cutoff = new Date(Date.now() - 24*60*60*1000); break;     // last 24h
  }

  try {
    let { data, error } = await supabase
      .from('chart_data')
      .select('*')
      .gte('timestamp', cutoff.toISOString())
      .order('timestamp', { ascending: true });

    if (error || !data || data.length === 0) {
      data = memoryCache.filter(p => new Date(p.timestamp) >= cutoff);
    }

    res.json(data);

  } catch (err) {
    console.error("Error fetching chart data:", err);
    res.json(memoryCache.filter(p => new Date(p.timestamp) >= cutoff));
  }
});

app.listen(PORT, () => console.log(`BlackCoin backend running on port ${PORT}`));
