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

// In-memory cache for fast startup
let memoryCache = [];

// Insert data point with retry
async function insertPoint(point, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const { data, error } = await supabase.from('chart_data').insert([point]).select();
    if (!error) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// Fetch live data from DexScreener
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

    memoryCache.push(point);
    memoryCache = memoryCache.filter(p => new Date(p.timestamp) >= new Date(Date.now() - 24*60*60*1000));

    await insertPoint(point);

    // Optional cleanup older than 24h
    const cutoff = new Date(Date.now() - 24*60*60*1000).toISOString();
    await supabase.from('chart_data').delete().lt('timestamp', cutoff);

  } catch (err) {
    console.error("Error fetching live data:", err);
  }
}

// Start live fetching
fetchLiveData();
setInterval(fetchLiveData, FETCH_INTERVAL);

// Utility: aggregate data by interval in ms
function aggregateData(data, intervalMs) {
  if (intervalMs <= 0 || data.length <= 1) return data;

  const buckets = {};
  data.forEach(d => {
    const t = new Date(d.timestamp).getTime();
    const bucket = Math.floor(t / intervalMs) * intervalMs;
    if (!buckets[bucket]) buckets[bucket] = [];
    buckets[bucket].push(d.price);
  });

  return Object.keys(buckets).map(ts => {
    const prices = buckets[ts];
    const avgPrice = prices.reduce((a,b)=>a+b,0)/prices.length;
    return { timestamp: new Date(Number(ts)).toISOString(), price: avgPrice };
  }).sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
}

// API endpoint
app.get('/api/chart', async (req, res) => {
  const interval = req.query.interval || 'D';
  let timeframeMs = 24*60*60*1000;
  let bucketMs = 60000; // default 1-minute aggregation

  switch(interval){
    case '1m': timeframeMs = 24*60*60*1000; bucketMs = 60000; break;  // 1m buckets
    case '5m': timeframeMs = 24*60*60*1000; bucketMs = 5*60*1000; break;
    case '30m': timeframeMs = 24*60*60*1000; bucketMs = 30*60*1000; break;
    case '1h': timeframeMs = 24*60*60*1000; bucketMs = 60*60*1000; break;
    case 'D': timeframeMs = 24*60*60*1000; bucketMs = 5*60*1000; break; // downsample to 5m for daily
  }

  const cutoff = new Date(Date.now() - timeframeMs).toISOString();

  try {
    let { data, error } = await supabase
      .from('chart_data')
      .select('*')
      .gte('timestamp', cutoff)
      .order('timestamp', { ascending: true });

    if (error || !data) data = memoryCache.filter(p => new Date(p.timestamp) >= new Date(Date.now() - timeframeMs));

    // Aggregate data by interval
    data = aggregateData(data, bucketMs);

    res.json(data);

  } catch (err) {
    console.error("Error fetching chart data:", err);
    res.json(memoryCache.filter(p => new Date(p.timestamp) >= new Date(Date.now() - timeframeMs)));
  }
});

app.listen(PORT, () => console.log(`BlackCoin backend running on port ${PORT}`));
