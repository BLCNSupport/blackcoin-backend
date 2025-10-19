// server.js — BlackCoin backend (UTC version)
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

// --- Supabase ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // service_role
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL or SUPABASE_KEY missing');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- Constants ---
const TOKEN_MINT = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";
const FETCH_INTERVAL = 5000; // 5 seconds
let memoryCache = [];

// Insert tick into Supabase
async function insertPoint(point) {
  try {
    const { error } = await supabase.from('chart_data').insert([point]);
    if (error) console.error('Supabase insert failed:', error.message);
  } catch (err) {
    console.error('Supabase insert exception:', err);
  }
}

// Poll DexScreener every 5s
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
    if (memoryCache.length > 10000) memoryCache.shift();

    await insertPoint(point);
  } catch (err) {
    console.error('fetchLiveData failed:', err);
  }
}

fetchLiveData();
setInterval(fetchLiveData, FETCH_INTERVAL);

// Helpers
function bucketMs(interval) {
  switch (interval) {
    case '1m':  return 60 * 1000;
    case '5m':  return 5 * 60 * 1000;
    case '30m': return 30 * 60 * 1000;
    case '1h':  return 60 * 60 * 1000;
    case 'D':   return 24 * 60 * 60 * 1000;
    default:    return 60 * 1000;
  }
}

function getWindow(interval) {
  const now = Date.now();
  if (interval === 'D')   return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
  if (interval === '1h')  return new Date(now - 7  * 24 * 60 * 60 * 1000).toISOString(); // 7 days
  return new Date(now - 24 * 60 * 60 * 1000).toISOString(); // 24 hours
}

// --- NEW: UTC bucketing ---
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
  const out = Array.from(byKey.values()).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return out;
}

// --- Paginated chart endpoint ---
app.get('/api/chart', async (req, res) => {
  try {
    const interval = req.query.interval || 'D';
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 10000, 20000);
    const offset = (page - 1) * limit;

    const cutoff = getWindow(interval);

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

    const raw = (data?.length ? data : memoryCache.filter(p => new Date(p.timestamp) >= new Date(cutoff)));
    const points = bucketize(raw, interval);
    const latest = raw.length ? raw[raw.length - 1] : memoryCache[memoryCache.length - 1];
    const totalCount = count || raw.length;
    const nextPage = (offset + limit) < totalCount ? page + 1 : null;

    res.json({ points, latest, page, nextPage, hasMore: Boolean(nextPage) });
  } catch (err) {
    console.error('Error /api/chart:', err);
    const latest = memoryCache[memoryCache.length - 1];
    res.json({ points: bucketize(memoryCache, req.query.interval || 'D'), latest, hasMore: false });
  }
});

// --- Latest tick (fast) ---
app.get('/api/latest', async (req, res) => {
  try {
    let latest = memoryCache[memoryCache.length - 1];
    if (!latest) {
      const { data } = await supabase
        .from('chart_data')
        .select('timestamp, price, change, volume')
        .order('timestamp', { ascending: false })
        .limit(1)
        .maybeSingle();
      latest = data;
    }
    if (!latest) return res.status(404).json({ error: 'No data' });
    res.json(latest);
  } catch (err) {
    console.error('Error /api/latest:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

app.listen(PORT, () => console.log(`✅ BlackCoin backend running in UTC on port ${PORT}`));
