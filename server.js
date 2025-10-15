import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import fs from 'fs';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// -------------------------
// Persistent storage setup
// -------------------------
const DATA_FILE = './chartData.json';
let chartData = [];
let lastSavedIndex = 0;

// -------------------------
// Load only last 24 hours on startup
// -------------------------
if (fs.existsSync(DATA_FILE)) {
  try {
    const now = Date.now();
    const cutoff = new Date(now - 24 * 60 * 60 * 1000);

    const lines = fs.readFileSync(DATA_FILE, 'utf-8').split('\n').filter(Boolean);

    chartData = lines
      .map(line => JSON.parse(line))
      .filter(p => new Date(p.timestamp) >= cutoff);

    lastSavedIndex = chartData.length;
    console.log(`Loaded ${chartData.length} points from last 24h from disk.`);
  } catch (e) {
    console.error("Error loading chart data file:", e);
  }
}

// -------------------------
// Append new points to disk and trim old data
// -------------------------
function saveChartData() {
  try {
    const now = Date.now();
    const cutoff = new Date(now - 24 * 60 * 60 * 1000);

    // Trim chartData in memory to last 24h
    chartData = chartData.filter(p => new Date(p.timestamp) >= cutoff);

    if (lastSavedIndex < chartData.length) {
      const newPoints = chartData.slice(lastSavedIndex);

      // Append new points
      const fileHandle = fs.openSync(DATA_FILE, 'a');
      newPoints.forEach(point => fs.writeSync(fileHandle, JSON.stringify(point) + '\n'));
      fs.closeSync(fileHandle);

      lastSavedIndex = chartData.length;
    }

    // -------------------------
    // Trim file on disk to last 24h (once per minute)
    // -------------------------
    if (chartData.length > 0 && Math.random() < 0.2) { // roughly every minute if 5s interval
      const dataToSave = chartData.map(p => JSON.stringify(p)).join('\n') + '\n';
      fs.writeFileSync(DATA_FILE, dataToSave);
      lastSavedIndex = chartData.length;
    }

  } catch (e) {
    console.error("Error saving chart data:", e);
  }
}

// -------------------------
// Token info
// -------------------------
const TOKEN_MINT = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";
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

    chartData.push(point);

    // -------------------------
    // Rolling 24-hour window
    // -------------------------
    const now = Date.now();
    const cutoff25h = new Date(now - 25 * 60 * 60 * 1000);
    chartData = chartData.filter(p => new Date(p.timestamp) >= cutoff25h);

    // Optional: max ~17,280 points
    if (chartData.length > 17280) chartData.splice(0, chartData.length - 17280);

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
// Persist new points to disk every 5 seconds
// -------------------------
setInterval(saveChartData, 5000);

// -------------------------
// API endpoint for frontend
// -------------------------
app.get('/api/chart', (req, res) => {
  let data = [...chartData];
  const interval = req.query.interval;

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

    // Downsample if too many points
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
