import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// -------------------------
// Supabase setup
// -------------------------
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_KEY must be set as environment variables!");
  process.exit(1);
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// -------------------------
// Token info
// -------------------------
const TOKEN_MINT = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";
const FETCH_INTERVAL = 5000; // 5 seconds

// -------------------------
// In-memory cache for fast frontend response
// -------------------------
let memoryCache = [];

// -------------------------
// Fetch live data from DexScreener and save to Supabase
// -------------------------
async function fetchLiveData() {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`);
    const data = await res.json();
    if (!data.pairs || !data.pairs[0]) return;

    const pair = data.pairs[0];
    const price = parseFloat(pair.priceUsd || 0);
    const change = parseFloat(pair.priceChange?.h24 || 0);
    const volume = parseFloat(pair.volume?.h24 || 0);
    const timestamp = new Date().toISOString();

    const point = { timestamp, price, change, volume };

    // Save to memory
    memoryCache.push(point);

    // Trim memoryCache to last 24h
    const cutoffMem = new Date(Date.now() - 24 * 60 * 60 * 1000);
    memoryCache = memoryCache.filter(p => new Date(p.timestamp) >= cutoffMem);

    // Insert into Supabase
    const { error: insertError } = await supabase.from('chart_data').insert([point]);
    if (insertError) console.error("Supabase insert error:", insertError);
    else console.log(`Inserted point: $${price.toFixed(6)} at ${timestamp}`);

    // Remove points older than 24h
    const { error: deleteError } = await supabase
      .from('chart_data')
      .delete()
      .lt('timestamp', cutoffMem.toISOString());
    if (deleteError) console.error("Supabase delete error:", deleteError);

  } catch (e) {
    console.error("Error fetching live data:", e);
  }
}

// -------------------------
// Start fetching live data
// -------------------------
setInterval(fetchLiveData, FETCH_INTERVAL);
fetchLiveData(); // fetch immediately

// -------------------------
// API endpoint for frontend
// -------------------------
app.get('/api/chart', async (req, res) => {
  const interval = req.query.interval || 'D';
  let timeframeMs = 24 * 60 * 60 * 1000; // default 24h

  switch(interval){
    case '1m': timeframeMs = 60 * 1000; break;
    case '5m': timeframeMs = 5 * 60 * 1000; break;
    case '30m': timeframeMs = 30 * 60 * 1000; break;
    case '1h': timeframeMs = 60 * 60 * 1000; break;
    case 'D': timeframeMs = 24 * 60 * 60 * 1000; break;
  }

  const cutoff = new Date(Date.now() - timeframeMs).toISOString();

  try {
    const { data, error } = await supabase
      .from('chart_data')
      .select('*')
      .gte('timestamp', cutoff)
      .order('timestamp', { ascending: true });

    if (error) {
      console.error("Supabase fetch error:", error);
      // fallback to memory cache
      const fallback = memoryCache.filter(p => new Date(p.timestamp) >= new Date(Date.now() - timeframeMs));
      return res.json(fallback);
    }

    // Downsample if too many points
    let result = data;
    const maxPoints = 500;
    if (result.length > maxPoints) {
      const sampleRate = Math.ceil(result.length / maxPoints);
      result = result.filter((_, i) => i % sampleRate === 0);
    }

    res.json(result);

  } catch (err) {
    console.error("Error fetching chart data:", err);
    // fallback to memory cache
    const fallback = memoryCache.filter(p => new Date(p.timestamp) >= new Date(Date.now() - timeframeMs));
    res.json(fallback);
  }
});

// -------------------------
// Start server
// -------------------------
app.listen(PORT, () => console.log(`BlackCoin backend running on port ${PORT}`));
