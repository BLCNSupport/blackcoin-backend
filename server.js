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
// In-memory cache for fast startup
// -------------------------
let memoryCache = [];

// -------------------------
// Insert data point with retry
// -------------------------
async function insertPoint(point, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const { data, error } = await supabase.from('chart_data').insert([point]).select();
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
    const change = parseFloat(pair.priceChange?.h24) || 0;
    const volume = parseFloat(pair.volume?.h24) || 0;
    const timestamp = new Date().toISOString();

    const point = { timestamp, price, change, volume };

    // Save in memory cache
    memoryCache.push(point);
    memoryCache = memoryCache.filter(
      p => new Date(p.timestamp) >= new Date(Date.now() - 24*60*60*1000)
    );

    await insertPoint(point);

    // Optional cleanup older than 24h
    const cutoff = new Date(Date.now() - 24*60*60*1000).toISOString();
    await supabase.from('chart_data').delete().lt('timestamp', cutoff);

  } catch (err) {
    console.error("Error fetching live data:", err);
  }
}

// Start fetching live data
fetchLiveData();
setInterval(fetchLiveData, FETCH_INTERVAL);

// -------------------------
// Aggregate data function
// -------------------------
function aggregateData(data, intervalMs) {
  if (intervalMs <= 0 || data.length <= 1) return data;

  const buckets = {};

  data.forEach(d => {
    const t = new Date(d.timestamp).getTime();
    const bucket = Math.floor(t / intervalMs) * intervalMs;
    if (!buckets[bucket]) buckets[bucket] = [];
    buckets[bucket].push(d);
  });

  return Object.keys(buckets).map(ts => {
    const points = buckets[ts];
    const avgPrice = points.reduce((a,b) => a + b.price, 0) / points.length;
    const avgChange = points.reduce((a,b) => a + b.change, 0) / points.length;
    const sumVolume = points.reduce((a,b) => a + b.volume, 0);
    return {
      timestamp: new Date(Number(ts)).toISOString(),
      price: avgPrice,
      change: avgChange,
      volume: sumVolume
    };
  }).sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
}

// -------------------------
// API endpoint for frontend
// -------------------------
app.get('/api/chart', async (req, res) => {
  const interval = req.query.interval || 'D';
  let timeframeMs = 24*60*60*1000;
  let bucketMs = 60*1000;

  // Set proper timeframes and aggregation buckets
  switch(interval){
    case '1m': timeframeMs = 60*60*1000; bucketMs = 60*1000; break;   // last 1 hour, 1m buckets
    case '5m': timeframeMs = 3*60*60*1000; bucketMs = 5*60*1000; break; // last 3 hours, 5m buckets
    case '30m': timeframeMs = 12*60*60*1000; bucketMs = 30*60*1000; break; // last 12 hours, 30m buckets
    case '1h': timeframeMs = 24*60*60*1000; bucketMs = 60*60*1000; break; // last 24h, 1h buckets
    case 'D': timeframeMs = 24*60*60*1000; bucketMs = 5*60*1000; break;   // downsample daily to 5m
  }

  const cutoff = new Date(Date.now() - timeframeMs).toISOString();

  try {
    let { data, error } = await supabase
      .from('chart_data')
      .select('*')
      .gte('timestamp', cutoff)
      .order('timestamp', { ascending: true });

    if (error || !data || data.length === 0) {
      data = memoryCache.filter(p => new Date(p.timestamp) >= new Date(Date.now() - timeframeMs));
    }

    // Aggregate to interval
    const aggregated = aggregateData(data, bucketMs);

    res.json(aggregated);

  } catch (err) {
    console.error("Error fetching chart data:", err);
    res.json(memoryCache.filter(p => new Date(p.timestamp) >= new Date(Date.now() - timeframeMs)));
  }
});

app.listen(PORT, () => console.log(`BlackCoin backend running on port ${PORT}`));
