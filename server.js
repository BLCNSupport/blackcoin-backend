import express from "express";
import fetch from "node-fetch";
import { Connection, PublicKey } from "@solana/web3.js";

const app = express();
const PORT = process.env.PORT || 3000;

// --- Helius / Solana setup ---
const heliusApiKey = "fc2112a6-6f31-4224-a92e-08165e6115e8";
const tokenMint = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";
const poolAddress = "8apo3YBrRNvts9boFNLZ1NC1xWEy2snq3ctmYPto162c";
const solMint = "So11111111111111111111111111111111111111112";
const connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`, "confirmed");

// Store last 24h of data (~17,280 points for 5s interval)
let chartData = [];

// --- Helper to fetch token price ---
async function fetchTokenPrice() {
  try {
    const poolPubKey = new PublicKey(poolAddress);

    // Token balance in pool
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(poolPubKey, { mint: new PublicKey(tokenMint) });
    const tokenBalance = tokenAccounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;

    // SOL balance in pool
    const solAccounts = await connection.getParsedTokenAccountsByOwner(poolPubKey, { mint: new PublicKey(solMint) });
    const solBalance = solAccounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;

    if(tokenBalance === 0) return null;

    const priceSOL = solBalance / tokenBalance;

    // Fetch SOL price in USD
    const solUSDResp = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const solUSDData = await solUSDResp.json();
    const solUSD = solUSDData.solana.usd || 0;

    const priceUSD = priceSOL * solUSD;

    return priceUSD;
  } catch(e) {
    console.error("Error fetching token price:", e);
    return null;
  }
}

// --- Record data every 5 seconds ---
async function recordPricePoint() {
  const price = await fetchTokenPrice();
  if(price === null) return;

  const now = new Date();
  const lastPrice = chartData.length ? chartData[chartData.length - 1].price : price;
  const change = lastPrice ? ((price - lastPrice) / lastPrice) * 100 : 0;

  // For simplicity, volume = price * 1000 (replace with real on-chain volume if available)
  const volume = price * 1000;

  chartData.push({
    timestamp: now.toISOString(),
    price,
    change,
    volume
  });

  // Keep last 24h (~17,280 points for 5s)
  if(chartData.length > 17280) chartData.shift();
}

setInterval(recordPricePoint, 5000);

// --- API endpoint ---
app.get("/api/chart", (req, res) => {
  res.json(chartData);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
