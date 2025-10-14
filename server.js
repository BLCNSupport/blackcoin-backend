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
    const cutoff25h = new Date(now - 25*60*60*1000); // remove oldest hour if >24h
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
  res.json(chartData);
});

// -------------------------
// Start server
// -------------------------
app.listen(PORT, () => console.log(`BlackCoin backend running on port ${PORT}`));
