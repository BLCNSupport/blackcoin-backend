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

// --- Supabase setup ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL or SUPABASE_KEY missing');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- Token + cache ---
const TOKEN_MINT = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";
const FETCH_INTERVAL = 5000; // every 5 seconds
let memoryCache = [];

// --- Insert tick into Supabase ---
async function insertPoint(point) {
  try {
    const { error } = await supabase.from('chart_data').insert([point]);
    if (error) console.error('Supabase insert failed:', error.message);
  } catch (err) {
    console.error('Supabase insert exception:', err);
  }
}

// --- Fetch live data from DexScreener ---
async function fetchLiveData() {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`, {
      headers: { 'Cache-Control': 'no-cache' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const pair = json.pairs?.[0];
    if (!pair) return;

    const point = {
      timestamp: new Date().toISOString(),
      price: parseFloat(pair.priceUsd),
      change: parseFloat(pair.priceChange?.h24),
      volume: parseFloat(pair.volume?.h24)
    };

    if ([point.price, point.change, point.volume].some(v => isNaN(v))) return;

    memoryCache.push(point);
    if (memoryCache.length > 10000) memoryCache.shift(); // prevent unbounded growth

    await insertPoint(point);
  } catch (err) {
    console.error('fetchLiveData failed:', err);
  }
}

// --- Start background fetch ---
fetchLiveData();
setInterval(fetchLiveData, FETCH_INTERVAL);

// --- Time window helper ---
function getCutoff(interval) {
  const now = Date.now();
  if (interval === 'D') return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
  if (interval === '1h') return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();  // 7 days
  return new Date(now - 24 * 60 * 60 * 1000).toISOString();                             // 24h
}

// --- Main chart endpoint (paginated + multi-day) ---
app.get('/api/chart', async (req, res) => {
  try {
    const interval = req.query.interval || 'D';
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 10000, 20000);
    const offset = (page - 1) * limit;
    const cutoff = getCutoff(interval);

    const { data, error, count } = await supabase
      .from('chart_data')
      .select('timestamp, price, change, volume', { count: 'exact' })
      .gte('timestamp', cutoff)
      .order('timestamp', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('Supabase fetch error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch data' });
    }

    const points = data?.length
      ? data
      : memoryCache.filter(p => new Date(p.timestamp) >= new Date(cutoff));

    const latest = points.length
      ? points[points.length - 1]
      : memoryCache[memoryCache.length - 1];

    const totalCount = count || points.length;
    const totalPages = Math.ceil(totalCount / limit);
    const nextPage = page < totalPages ? page + 1 : null;

    res.json({
      points,
      latest,
      page,
      totalPages,
      nextPage,
      hasMore: Boolean(nextPage)
    });
  } catch (err) {
    console.error('Error fetching chart data:', err);
    const latest = memoryCache[memoryCache.length - 1];
    res.json({ points: memoryCache, latest, hasMore: false });
  }
});

// --- Full history endpoint (for exports or archives) ---
app.get('/api/chart/full', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('chart_data')
      .select('timestamp, price, change, volume')
      .order('timestamp', { ascending: true })
      .limit(50000); // up to 50k rows

    if (error) console.error('Supabase fetch error:', error.message);

    const points = data?.length ? data : memoryCache;
    const latest = points[points.length - 1] || memoryCache[memoryCache.length - 1];
    res.json({ points, latest });
  } catch (err) {
    console.error('Error fetching full chart data:', err);
    const latest = memoryCache[memoryCache.length - 1];
    res.json({ points: memoryCache, latest });
  }
});

// --- NEW lightweight endpoint for instant price ---
app.get('/api/latest', async (req, res) => {
  try {
    // grab latest from memory first
    let latest = memoryCache[memoryCache.length - 1];

    // fallback to Supabase if cache is empty
    if (!latest) {
      const { data, error } = await supabase
        .from('chart_data')
        .select('timestamp, price, change, volume')
        .order('timestamp', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) console.error('Supabase latest fetch error:', error.message);
      latest = data;
    }

    if (!latest) {
      return res.status(404).json({ error: 'No data available' });
    }

    res.json({
      timestamp: latest.timestamp,
      price: latest.price,
      change: latest.change,
      volume: latest.volume
    });
  } catch (err) {
    console.error('Error fetching latest:', err);
    res.status(500).json({ error: 'Failed to get latest data' });
  }
});

// --- Server start ---
app.listen(PORT, () =>
  console.log(`✅ BlackCoin backend running on port ${PORT}`)
);
