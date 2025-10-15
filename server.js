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
// Supabase setup (service_role key required for inserts)
// -------------------------
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// -------------------------
// Token info
// -------------------------
const TOKEN_MINT = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";
const FETCH_INTERVAL = 5000; // 5 seconds

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

    // Insert new point
    const { error: insertError } = await supabase
      .from('chart_data')
      .insert([point]);

    if (insertError) {
      console.error("Supabase insert error:", insertError);
      return;
    }

    // Remove points older than 24h
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { error: deleteError } = await supabase
      .from('chart_data')
      .delete()
      .lt('timestamp', cutoff);

    if (deleteError) console.error("Supabase delete old points error:", deleteError);

    console.log(`Inserted point: $${price.toFixed(6)} at ${timestamp}`);

  } catch (e) {
    console.error("Error fetching live data:", e);
  }
}

// -------------------------
// Start fetching live data
// -------------------------
setInterval(fetchLiveData, FETCH_INTERVAL);
fetchLiveData(); // immediate fetch

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
    let { data, error } = await supabase
      .from('chart_data')
      .select('*')
      .gte('timestamp', cutoff)
      .order('timestamp', { ascending: true });

    if (error) {
      console.error("Supabase fetch error:", error);
      return res.status(500).json({ error: error.message });
    }

    // Downsample if too many points
    const maxPoints = 500;
    if (data.length > maxPoints) {
      const sampleRate = Math.ceil(data.length / maxPoints);
      data = data.filter((_, i) => i % sampleRate === 0);
    }

    res.json(data);

  } catch (err) {
    console.error("Error fetching chart data:", err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------
// Start server
// -------------------------
app.listen(PORT, () => console.log(`BlackCoin backend running on port ${PORT}`));
