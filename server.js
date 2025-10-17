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

// Ensure you're using the service_role key here
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // must be service_role key
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_URL or SUPABASE_KEY is missing!');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TOKEN_MINT = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";
const FETCH_INTERVAL = 5000; // 5s
const MAX_POINTS = 2000;

// In-memory fallback cache
let memoryCache = [];

// Robust insert with clear logging
async function insertPoint(point) {
  try {
    const { data, error } = await supabase.from('chart_data').insert([point]).select();
    if (error) {
      console.error('Supabase insert failed:', error, 'Point:', point);
      return false;
    } else {
      console.log('Supabase insert succeeded:', data);
      return true;
    }
  } catch (err) {
    console.error('Supabase insert exception:', err, 'Point:', point);
    return false;
  }
}

// Fetch live data from DexScreener
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

    if ([point.price, point.change, point.volume].some(v => isNaN(v))) {
      console.warn('Invalid data from DexScreener:', point);
      return;
    }

    memoryCache.push(point);
    memoryCache = memoryCache.filter(
      p => new Date(p.timestamp) >= new Date(Date.now() - 24 * 60 * 60 * 1000)
    );

    console.log('Inserting point:', point);
    await insertPoint(point);

    // Cleanup old data in Supabase
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { error: deleteError } = await supabase.from('chart_data').delete().lt('timestamp', cutoff);
    if (deleteError) console.error('Supabase delete error:', deleteError);

  } catch (err) {
    console.error('fetchLiveData failed:', err);
  }
}

// Start fetching
fetchLiveData();
setInterval(fetchLiveData, FETCH_INTERVAL);

// API endpoint for frontend chart
app.get('/api/chart', async (req, res) => {
  const interval = req.query.interval || 'D';
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  try {
    let { data, error } = await supabase
      .from('chart_data')
      .select('timestamp, price, change, volume')
      .gte('timestamp', cutoff)
      .order('timestamp', { ascending: true })
      .limit(MAX_POINTS);

    if (error) {
      console.error('Supabase fetch error:', error);
      data = memoryCache.filter(p => new Date(p.timestamp) >= new Date(cutoff));
    }

    if (!data || !data.length) data = memoryCache.filter(p => new Date(p.timestamp) >= new Date(cutoff));

    res.json(data);
  } catch (err) {
    console.error('Error fetching chart data:', err);
    res.json(memoryCache.filter(p => new Date(p.timestamp) >= new Date(cutoff)));
  }
});

app.listen(PORT, () => console.log(`BlackCoin backend running on port ${PORT}`));

