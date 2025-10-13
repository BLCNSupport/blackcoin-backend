import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());

const HELIUS_API_KEY = "fc2112a6-6f31-4224-a92e-08165e6115e8";
const TOKEN_MINT = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";

let chartData = [];

// Fetch latest token price from Helius
async function fetchBlackCoinPrice() {
  try {
    const res = await fetch(`https://api.helius.xyz/v1/tokens/values?api-key=${HELIUS_API_KEY}&mint=${TOKEN_MINT}`);
    const data = await res.json();

    if (!data || !data[0] || !data[0].priceUsd) return;

    const price = parseFloat(data[0].priceUsd);
    const volume = parseFloat(data[0].volume24h || 0);
    const change = parseFloat(data[0].change24h || 0);
    const timestamp = new Date().toISOString();

    chartData.push({ timestamp, price, change, volume });

    // Keep last 24h of points (5s interval ~17280)
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    chartData = chartData.filter(d => new Date(d.timestamp).getTime() >= cutoff);

  } catch (err) {
    console.error("Helius fetch error:", err);
  }
}

// Poll every 5s
setInterval(fetchBlackCoinPrice, 5000);

// Endpoint to serve chart data
app.get("/api/chart", (req, res) => {
  res.json(chartData);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
