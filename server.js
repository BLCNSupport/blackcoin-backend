import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { Connection, PublicKey } from "@solana/web3.js";

const app = express();
app.use(cors());

const heliusApiKey = "fc2112a6-6f31-4224-a92e-08165e6115e8";
const tokenMint = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";
const poolAddress = "8apo3YBrRNvts9boFNLZ1NC1xWEy2snq3ctmYPto162c";
const solMint = "So11111111111111111111111111111111111111112";

const connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`, "confirmed");

let chartData = [];

// Function to fetch price from Helius + Solana
async function fetchBlackCoinPrice() {
  try {
    const poolPubKey = new PublicKey(poolAddress);

    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(poolPubKey, { mint: new PublicKey(tokenMint) });
    const tokenBalance = tokenAccounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;

    const solAccounts = await connection.getParsedTokenAccountsByOwner(poolPubKey, { mint: new PublicKey(solMint) });
    const solBalance = solAccounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;

    if(tokenBalance === 0) return;

    const priceSOL = solBalance / tokenBalance;

    // Get SOL USD price from CoinGecko
    const solUSDResp = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const solUSDData = await solUSDResp.json();
    const solUSD = solUSDData?.solana?.usd || 0;

    const priceUSD = priceSOL * solUSD;

    const timestamp = new Date().toISOString();
    chartData.push({ timestamp, price: priceUSD });

    // Keep only last 24 hours (~17,280 points if 5s intervals)
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    chartData = chartData.filter(d => new Date(d.timestamp).getTime() >= cutoff);

    console.log("Fetched price:", priceUSD);
  } catch (e) {
    console.error("Fetch error:", e);
  }
}

// Fetch every 5s
setInterval(fetchBlackCoinPrice, 5000);
fetchBlackCoinPrice(); // fetch immediately

// Endpoint to get chart data
app.get("/api/chart", (req, res) => {
  res.json(chartData);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
