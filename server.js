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

// Fetch live data from DexScreener with retry
async function fetchLiveData(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`, {
        headers: { 'Cache-Control': 'no-cache' }
      });
      if (!res.ok) throw new Error(`DexScreener HTTP error! Status: ${res.status}`);

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

      return; // Success

    } catch (err) {
      console.error(`fetchLiveData attempt ${i + 1} failed:`, err);
      if (i < retries - 1) await new Promise(r => setTimeout(r, 1000));
    }
  }
  console.error("fetchLiveData permanently failed after retries");
}

// Start fetching live data
setInterval(fetchLiveData, FETCH_INTERVAL);
fetchLiveData();

// ===============================
//     API ENDPOINT FOR FRONTEND
// ===============================
app.get('/api/chart', async (req, res) => {
  // 🔒 Prevent all caching (Render, CDN, browser)
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');

  const interval = req.query.interval || 'D';
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // 24h rolling window

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

    // ---- Interval Aggregation ----
    let aggregatedData = data;
    if (interval !== 'D') {
      const buckets = {};
      const intervalMs = {
        '1m': 60 * 1000,
        '5m': 5 * 60 * 1000,
        '30m': 30 * 60 * 1000,
        '1h': 60 * 60 * 1000
      }[interval];

      const startTime = new Date(cutoff);
      for (let time = startTime; time <= new Date(); time.setTime(time.getTime() + intervalMs)) {
        const bucketTime = new Date(time);
        if (interval === '1m') bucketTime.setSeconds(0, 0);
        else if (interval === '5m') {
          bucketTime.setSeconds(0, 0);
          bucketTime.setMinutes(Math.floor(bucketTime.getMinutes() / 5) * 5); // ✅ fixed
        } else if (interval === '30m') {
          bucketTime.setSeconds(0, 0);
          bucketTime.setMinutes(Math.floor(bucketTime.getMinutes() / 30) * 30);
        } else if (interval === '1h') {
          bucketTime.setSeconds(0, 0);
          bucketTime.setMinutes(0, 0);
        }
        const key = bucketTime.toISOString();
        buckets[key] = { timestamp: key, price: null, volume: 0, points: [] };
      }

      for (const point of data) {
        const date = new Date(point.timestamp);
        let key;
        if (interval === '1m') {
          date.setSeconds(0, 0);
          key = date.toISOString();
        } else if (interval === '5m') {
          date.setSeconds(0, 0);
          date.setMinutes(Math.floor(date.getMinutes() / 5) * 5); // ✅ fixed
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

        if (buckets[key]) {
          buckets[key].price = point.price;
          buckets[key].volume += point.volume;
          buckets[key].points.push(point);
        }
      }

      let prevPrice = null;
      aggregatedData = [];
      Object.keys(buckets).sort().forEach(key => {
        const bucket = buckets[key];
        if (bucket.price === null && prevPrice !== null) bucket.price = prevPrice;
        else if (bucket.price !== null) prevPrice = bucket.price;

        if (bucket.price !== null) {
          bucket.change = bucket.points.length >= 2
            ? ((bucket.points[bucket.points.length - 1].price - bucket.points[0].price) / bucket.points[0].price * 100)
            : 0;
          aggregatedData.push(bucket);
        }
      });

      aggregatedData = aggregatedData.filter((p, i) => i === aggregatedData.findIndex(q => q.timestamp === p.timestamp));
    } else {
      // Daily interval — recalc change over entire window
      if (data.length >= 2) {
        const firstPrice = data[0].price;
        const lastPrice = data[data.length - 1].price;
        const intervalChange = ((lastPrice - firstPrice) / firstPrice * 100) || 0;
        data.forEach(p => p.change = intervalChange);
      } else if (data.length === 1) {
        data[0].change = 0;
      }
      aggregatedData = data;
    }

    console.log(`Returning ${aggregatedData.length} points for interval ${interval}`);
    console.log("Latest DB timestamp:", aggregatedData[aggregatedData.length - 1]?.timestamp);
    res.json(aggregatedData);

  } catch (err) {
    console.error("Error fetching chart data:", err);
    const fallbackData = memoryCache.filter(p => new Date(p.timestamp) >= new Date(cutoff));
    console.log(`Returning ${fallbackData.length} cached points for interval ${interval}`);
    res.json(fallbackData);
  }
});

// Start server
app.listen(PORT, () => console.log(`✅ BlackCoin backend running on port ${PORT}`));
