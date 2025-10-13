import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());

let chartData = [];

// Function to fetch the latest BlackCoin price
async function fetchBlackCoinPrice() {
  try {
    const res = await fetch(
      "https://api.dexscreener.com/latest/dex/tokens/J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump"
    );
    const data = await res.json();
    if (!data.pairs || !data.pairs[0]) return;

    const pair = data.pairs[0];
    const price = parseFloat(pair.priceUsd || 0);
    const timestamp = new Date().toISOString();

    // Push to chartData array
    chartData.push({ time: timestamp, price });

    // Keep only last 24 hours (roughly 17,280 points for 5s intervals)
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    chartData = chartData.filter((d) => new Date(d.time).getTime() >= cutoff);
  } catch (err) {
    console.error("Fetch error:", err);
  }
}

// Fetch every 5 seconds
setInterval(fetchBlackCoinPrice, 5000);

// Endpoint to get chart data
app.get("/api/chart", (req, res) => {
  res.json(chartData);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
