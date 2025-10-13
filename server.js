import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());

let chartData = [];

// Function to fetch latest BlackCoin price from Helius
async function fetchBlackCoinPrice() {
  try {
    const res = await fetch(
      "https://api.helius.xyz/v1/tokens/0xBLACKCOIN_ADDRESS?api-key=fc2112a6-6f31-4224-a92e-08165e6115e8"
    );
    const data = await res.json();

    // Helius returns an object with a 'result' array, not the root object
    if (!data.result || !data.result.length) return;

    const tokenInfo = data.result[0];
    const price = parseFloat(tokenInfo.price || 0);
    const volume = parseFloat(tokenInfo.volume || 0);
    const change = parseFloat(tokenInfo.change || 0);
    const timestamp = new Date().toISOString();

    chartData.push({ timestamp, price, volume, change });

    // Keep last 24h (~17,280 points for 5s interval)
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    chartData = chartData.filter((d) => new Date(d.timestamp).getTime() >= cutoff);
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
