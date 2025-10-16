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
  console.error('Supabase env vars missing!');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TOKEN_MINT = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";
const FETCH_INTERVAL = 5000; // 5 seconds
const MAX_POINTS = 20000; // ~24h at 5s intervals
let memoryCache = [];

// Insert with fallback
async function insertPoint(point) {
  try {
    await supabase.from('chart_data').insert([point]);
  } catch (err) {
    console.warn('Supabase insert failed, storing in memory cache:', err);
    memoryCache.push(point);
  }
}

async function fetchLiveData() {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`, {
      headers: { 'Cache-Control': 'no-cache' }
    });
    const data = await res.json();
    const pair = data.pairs?.[0];
    if (!pair) return;

    const price = parseFloat(pair.priceUsd);
    const change = parseFloat(pair.priceChange?.h24);
    const volume = parseFloat(pair.volume?.h24);
    if ([price, change, volume].some(v => isNaN(v))) return;

    const timestamp = Date.now(); // numeric ms
    const point = { timestamp, price, change, volume };

    // Save to Supabase
    await insertPoint(point);

    // Keep in-memory cache for fallback
    memoryCache.push(point);
    memoryCache = memoryCache.filter(p => p.timestamp >= Date.now() - 24*60*60*1000);

    // Remove old data from Supabase
    const cutoff = new Date(Date.now() - 24*60*60*1000).toISOString();
    await supabase.from('chart_data').delete().lt('timestamp', cutoff);

  } catch (err) {
    console.error("fetchLiveData error:", err);
  }
}

// Start interval fetch
setInterval(fetchLiveData, FETCH_INTERVAL);
fetchLiveData();

// API endpoint
app.get('/api/chart', async (req, res) => {
  const cutoff = Date.now() - 24*60*60*1000;
  try {
    let { data, error } = await supabase
      .from('chart_data')
      .select('timestamp, price, change, volume')
      .gte('timestamp', new Date(cutoff).toISOString())
      .order('timestamp', { ascending: true })
      .limit(MAX_POINTS);

    // Convert ISO to numeric ms if Supabase stores ISO
    if (data?.length) {
      data = data.map(p => ({
        timestamp: typeof p.timestamp === 'string' ? new Date(p.timestamp).getTime() : p.timestamp,
        price: p.price,
        change: p.change,
        volume: p.volume
      }));
    } else {
      data = memoryCache;
    }

    res.json(data);

  } catch (err) {
    console.error("API fetch error:", err);
    res.json(memoryCache);
  }
});

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
