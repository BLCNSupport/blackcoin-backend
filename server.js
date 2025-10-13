import express from 'express';
import fetch from 'node-fetch'; // if using Node 18+ fetch is global
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Store last 24 hours of data (rolling)
let chartData = [];

// Token info
const TOKEN_MINT = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";
const POOL_ADDRESS = "8apo3YBrRNvts9boFNLZ1NC1xWEy2snq3ctmYPto162c";

// Fetch price, change, volume from DexScreener
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

    // Add to chart data
    chartData.push(point);

    // Keep last 24 hours (~17,280 points if every 5s)
    if (chartData.length > 17280) chartData.shift();
  } catch (e) {
    console.error("Error fetching live data:", e);
  }
}

// Start fetching every 5 seconds
setInterval(fetchLiveData, 5000);
fetchLiveData(); // fetch immediately on start

// API endpoint for frontend
app.get('/api/chart', (req, res) => {
  res.json(chartData);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
