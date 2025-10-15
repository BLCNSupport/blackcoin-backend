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

// Validate Supabase env vars
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_URL or SUPABASE_KEY is missing!');
  process.exit(1);
}

// Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Token info
const TOKEN_MINT = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";
const FETCH_INTERVAL = 5000; // 5 seconds
const MAX_POINTS = 2000; // Covers ~2.8 hours at 5s intervals

// In-memory cache for fallback
let memoryCache = [];

// Insert with retry
async function insertPoint(point, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const { data, error } = await supabase.from('chart_data').insert([point]).select();
      if (!error) {
        console.log("Supabase insert succeeded:", data);
        return true;
      } else {
        console.warn(`Insert failed, attempt ${i + 1}:`, error);
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (err) {
      console.warn(`Insert attempt ${i + 1} threw exception:`, err);
    }
  }
  console.error("Insert permanently failed:", point);
  return false;
}

// Fetch live data from DexScreener and save to Supabase
async function fetchLiveData() {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`, {
      headers: { 'Cache-Control': 'no-cache' }
    });
    if (!res.ok) {
      throw new Error(`DexScreener HTTP error! Status: ${res.status}`);
    }
    const data = await res.json();

    if (!data.pairs || !data.pairs[0]) {
      console.warn("No pairs found in DexScreener response:", data);
      return;
    }

    const pair = data.pairs[0];
    const price = parseFloat(pair.priceUsd);
    const change = parseFloat(pair.priceChange?.h24);
    const volume = parseFloat(pair.volume?.h24);

    if (isNaN(price) || isNaN(change) || isNaN(volume)) {
      console.warn("Invalid data from DexScreener:", { price, change, volume });
      return;
    }

    const timestamp = new Date().toISOString();
    const point = { timestamp, price, change, volume };

    memoryCache.push(point);
    memoryCache = memoryCache.filter(
      p => new Date(p.timestamp) >= new Date(Date.now() - 24 * 60 * 60 * 1000)
    );

    console.log("Inserting point:", point);
    await insertPoint(point);

    // Delete data older than 24 hours
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { error: deleteError } = await supabase
      .from('chart_data')
      .delete()
      .lt('timestamp', cutoff);
    if (deleteError) console.error("Supabase delete error:", deleteError);

  } catch (err) {
    console.error("Error fetching live data:", err);
  }
}

// Start fetching live data
setInterval(fetchLiveData, FETCH_INTERVAL);
fetchLiveData();

// API endpoint for frontend chart
app.get('/api/chart', async (req, res) => {
  const interval = req.query.interval || 'D';
  let timeframeMs;

  switch (interval) {
    case '1m': timeframeMs = 60 * 1000; break;
    case '5m': timeframeMs = 5 * 60 * 1000; break;
    case '30m': timeframeMs = 30 * 60 * 1000; break;
    case '1h': timeframeMs = 60 * 60 * 1000; break;
    case 'D': timeframeMs = 24 * 60 * 60 * 1000; break;
    default:
      console.warn("Invalid interval, defaulting to 'D':", interval);
      timeframeMs = 24 * 60 * 60 * 1000;
  }

  const cutoff = new Date(Date.now() - timeframeMs).toISOString();

  try {
    let { data, error } = await supabase
      .from('chart_data')
      .select('timestamp, price, change, volume')
      .gte('timestamp', cutoff)
      .order('timestamp', { ascending: true })
      .limit(MAX_POINTS);

    if (error) {
      console.error("Supabase fetch error:", error);
      data = memoryCache.filter(p => new Date(p.timestamp) >= new Date(cutoff));
    }

    if (!data || !data.length) {
      console.warn("No data found for interval:", interval);
      data = memoryCache.filter(p => new Date(p.timestamp) >= new Date(cutoff));
    }

    // Aggregate for non-D intervals
    let aggregatedData = data;
    if (interval !== 'D') {
      const grouped = {};
      for (const point of data) {
        const date = new Date(point.timestamp);
        let key;
        if (interval === '1m') {
          date.setSeconds(0, 0);
          key = date.toISOString();
        } else if (interval === '5m') {
          date.setSeconds(0, 0);
          date.setMinutes(Math.floor(date.getMinutes() / 5) * 5);
          key = date.toISOString();
        } else if (interval === '30m') {
          date.setSeconds(0, 0);
          date.setMinutes(Math.floor(date.getMinutes() / 30) * 30);
          key = date.toISOString();
        } else if (interval === '1h') {
          date.setSeconds(0, 0);
          date.setMinutes(0, 0);
          key = date.toISOString();
        }

        if (!grouped[key]) {
          grouped[key] = {
            timestamp: key,
            price: point.price,
            volume: point.volume,
            points: [{ price: point.price, timestamp: point.timestamp }]
          };
        } else {
          grouped[key].price = point.price; // Latest price
          grouped[key].volume += point.volume;
          grouped[key].points.push({ price: point.price, timestamp: point.timestamp });
        }
      }

      // Calculate change per bucket
      aggregatedData = Object.values(grouped).map(bucket => ({
        timestamp: bucket.timestamp,
        price: bucket.price,
        volume: bucket.volume,
        change: bucket.points.length >= 2
          ? ((bucket.points[bucket.points.length - 1].price - bucket.points[0].price) / bucket.points[0].price * 100)
          : 0
      })).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    } else {
      // For D, recalculate change over entire timeframe
      if (data.length >= 2) {
        const firstPrice = data[0].price;
        const lastPrice = data[data.length - 1].price;
        const intervalChange = ((lastPrice - firstPrice) / firstPrice * 100) || 0;
        data.forEach(point => point.change = intervalChange);
      } else if (data.length === 1) {
        data[0].change = 0;
      }
    }

    console.log(`Returning ${aggregatedData.length} points for interval ${interval}`);
    res.json(aggregatedData);

  } catch (err) {
    console.error("Error fetching chart data:", err);
    const fallbackData = memoryCache.filter(p => new Date(p.timestamp) >= new Date(cutoff));
    console.log(`Returning ${fallbackData.length} cached points for interval ${interval}`);
    res.json(fallbackData);
  }
});

// Start server
app.listen(PORT, () => console.log(`BlackCoin backend running on port ${PORT}`));