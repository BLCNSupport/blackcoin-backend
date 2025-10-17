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
  console.error('SUPABASE_URL or SUPABASE_KEY missing');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const TOKEN_MINT = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";
const FETCH_INTERVAL = 5000; // 5s

let memoryCache = [];

// Insert a new tick into Supabase
async function insertPoint(point) {
  try {
    const { data, error } = await supabase.from('chart_data').insert([point]).select();
    if (error) console.error('Supabase insert failed:', error);
    return data;
  } catch (err) {
    console.error('Supabase insert exception:', err);
  }
}

// Fetch live data from Dex Screener
async function fetchLiveData() {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`, { headers: { 'Cache-Control': 'no-cache' } });
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
    const cutoffMs = Date.now() - 24*60*60*1000;
    memoryCache = memoryCache.filter(p => new Date(p.timestamp).getTime() >= cutoffMs);

    await insertPoint(point);

    // Cleanup Supabase old points
    await supabase.from('chart_data').delete().lt('timestamp', new Date(cutoffMs).toISOString());

  } catch (err) {
    console.error('fetchLiveData failed:', err);
  }
}

// Start fetching live data
fetchLiveData();
setInterval(fetchLiveData, FETCH_INTERVAL);

// API endpoint for frontend with interval aggregation
app.get('/api/chart', async (req, res) => {
  const interval = req.query.interval || '1m';
  const cutoffMs = Date.now() - 24*60*60*1000;

  try {
    let { data, error } = await supabase
      .from('chart_data')
      .select('timestamp, price, change, volume')
      .gte('timestamp', new Date(cutoffMs).toISOString())
      .order('timestamp', { ascending: true })
      .limit(5000); // fetch full 24h history

    if (error) { console.error('Supabase fetch error:', error); data = []; }
    if (!data?.length) data = memoryCache.filter(p => new Date(p.timestamp).getTime() >= cutoffMs);

    const grouped = {};
    const intervalMs = {
      '1m': 60*1000,
      '5m': 5*60*1000,
      '30m': 30*60*1000,
      '1h': 60*60*1000,
      'D': 24*60*60*1000
    }[interval] || 60*1000;

    data.forEach(p => {
      const t = new Date(p.timestamp).getTime();
      const bucket = Math.floor(t / intervalMs) * intervalMs;
      if (!grouped[bucket]) grouped[bucket] = { price: p.price, change: p.change, volume: p.volume, count: 1 };
      else {
        grouped[bucket].price = (grouped[bucket].price*grouped[bucket].count + p.price)/(grouped[bucket].count+1);
        grouped[bucket].change = (grouped[bucket].change*grouped[bucket].count + p.change)/(grouped[bucket].count+1);
        grouped[bucket].volume += p.volume;
        grouped[bucket].count += 1;
      }
    });

    const points = Object.keys(grouped).map(ts => ({
      timestamp: new Date(parseInt(ts)).toISOString(),
      price: grouped[ts].price,
      change: grouped[ts].change,
      volume: grouped[ts].volume
    })).sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));

    const latest = memoryCache[memoryCache.length-1] || points[points.length-1] || null;

    res.json({ points, latest });

  } catch (err) {
    console.error('Error fetching chart data:', err);
    const latest = memoryCache[memoryCache.length-1] || null;
    res.json({ points: memoryCache.filter(p => new Date(p.timestamp).getTime() >= cutoffMs), latest });
  }
});

app.listen(PORT, () => console.log(`BlackCoin backend running on port ${PORT}`));

