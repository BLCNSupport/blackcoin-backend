import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());

let chartData = [];

// Replace with your Helius API key
const HELIUS_API_KEY = "fc2112a6-6f31-4224-a92e-08165e6115e8";
const TOKEN_MINT = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";

// Function to fetch the latest BlackCoin price from Helius
async function fetchBlackCoinPrice() {
  try {
    const res = await fetch(`https://api.helius.xyz/v1/tokens/values?api-key=${HELIUS_API_KEY}&mint=${TOKEN_MINT}`);
    const data = await res.json();

    if (!data || !data[0]) return; // Helius returns an array of token objects
    const token = data[0];

    const price = parseFloat(token.priceUsd || 0);
    const volume = parseFloat(token.volume || 0);
    const timestamp = new Date().toISOString();

    chartData.push({ timestamp, price, volume });

    // Keep only last 24 hours (~17,280 points for 5s interval)
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    chartData = chartData.filter(d => new Date(d.timestamp).getTime() >= cutoff);

  } catch (err) {
    console.error("Fetch error:", err);
  }
}

// Fetch every 5 seconds
fetchBlackCoinPrice(); // initial fetch
setInterval(fetchBlackCoinPrice, 5000);

// Endpoint to get chart data
app.get("/api/chart", (req, res) => {
  res.json(chartData);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
