import express from 'express';
import fetch from 'node-fetch'; // Node 18+ fetch is global
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Store last 24 hours of data (rolling)
let chartData = [];

// Token info
const TOKEN_MINT = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";

// Fetch interval (5 seconds)
const FETCH_INTERVAL = 5000;

// -------------------------
// Fetch live data from DexScreener
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

    const point = {
      timestamp: new Date().toISOString(),
      price,
      change,
      volume
    };

    // Add new point
    chartData.push(point);

    // -------------------------
    // Rolling 24-hour window
    // -------------------------
    const now = Date.now();
    const cutoff25h = new Date(now - 25 * 60 * 60 * 1000); // remove oldest if >24h, with buffer
    chartData = chartData.filter(p => new Date(p.timestamp) >= cutoff25h);

    // Optional: max ~17,280 points (5s intervals for 24h)
    if (chartData.length > 17280) chartData.splice(0, chartData.length - 17280);

  } catch (e) {
    console.error("Error fetching live data:", e);
  }
}

// -------------------------
// Start fetching live data
// -------------------------
setInterval(fetchLiveData, FETCH_INTERVAL);
fetchLiveData(); // fetch immediately on server start

// -------------------------
// API endpoint for frontend
// -------------------------
app.get('/api/chart', (req, res) => {
  let data = [...chartData]; // Copy to avoid mutating original
  const interval = req.query.interval; // e.g., '1m', '5m', '30m', '1h', 'D'

  if (interval) {
    const now = Date.now();
    let timeframeMs;
    switch (interval) {
      case '1m': timeframeMs = 1 * 60 * 1000; break;
      case '5m': timeframeMs = 5 * 60 * 1000; break;
      case '30m': timeframeMs = 30 * 60 * 1000; break;
      case '1h': timeframeMs = 60 * 60 * 1000; break;
      case 'D': timeframeMs = 24 * 60 * 60 * 1000; break;
      default: timeframeMs = 24 * 60 * 60 * 1000;
    }
    const cutoff = new Date(now - timeframeMs);
    data = data.filter(p => new Date(p.timestamp) >= cutoff);

    // Downsample if too many points (aim for ~500 max for chart performance)
    const maxPoints = 500;
    if (data.length > maxPoints) {
      const sampleRate = Math.ceil(data.length / maxPoints);
      data = data.filter((_, i) => i % sampleRate === 0);
    }
  }

  res.json(data);
});

// -------------------------
// Start server
// -------------------------
app.listen(PORT, () => console.log(`BlackCoin backend running on port ${PORT}`));