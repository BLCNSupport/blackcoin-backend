import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());

let chartData = [];

// Helius API key
const HELIUS_API_KEY = "fc2112a6-6f31-4224-a92e-08165e6115e8";
const TOKEN_ADDRESS = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";

// Fetch latest BlackCoin price from Helius
async function fetchBlackCoinPrice() {
  try {
    const res = await fetch(
      `https://api.helius.xyz/v1/token-metadata?api-key=${HELIUS_API_KEY}&mint=${TOKEN_ADDRESS}`
    );
    const data = await res.json();

    if (!data || !data[0]) return;

    // Replace these fields with actual Helius API structure for price, volume, change
    const price = parseFloat(data[0].price || 0);
    const change = parseFloat(data[0].change24h || 0); 
    const volume = parseFloat(data[0].volume24h || 0); 

    const timestamp = new Date().toISOString();

    chartData.push({ timestamp, price, change, volume });

    // Keep only last 24 hours (288 points for 5s intervals)
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    chartData = chartData.filter(d => new Date(d.timestamp).getTime() >= cutoff);

  } catch (err) {
    console.error("Fetch error:", err);
  }
}

// Fetch every 5 seconds
setInterval(fetchBlackCoinPrice, 5000);

// API endpoint for frontend
app.get("/api/chart", (req, res) => {
  res.json(chartData);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

