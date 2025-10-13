// server.js
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

const connection = new Connection(
  `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`,
  "confirmed"
);

// 24h chart data
let chartData = [];
let lastPrice = 0;

async function recordPricePoint() {
  try {
    const poolPubKey = new PublicKey(poolAddress);

    // Get pool balances
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(poolPubKey, { mint: new PublicKey(tokenMint) });
    const solAccounts = await connection.getParsedTokenAccountsByOwner(poolPubKey, { mint: new PublicKey(solMint) });

    const tokenBalance = tokenAccounts.value.reduce(
      (acc, acct) => acc + (acct.account.data.parsed.info.tokenAmount.uiAmount || 0),
      0
    );
    const solBalance = solAccounts.value.reduce(
      (acc, acct) => acc + (acct.account.data.parsed.info.tokenAmount.uiAmount || 0),
      0
    );

    if (tokenBalance === 0) return;

    // Get SOL/USD
    const solUSDResp = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
    );
    const solUSDData = await solUSDResp.json();
    const solUSD = solUSDData?.solana?.usd || 0;

    const price = (solBalance / tokenBalance) * solUSD;
    const change = lastPrice > 0 ? ((price - lastPrice) / lastPrice) * 100 : 0;
    lastPrice = price;

    // Approximate 5s volume
    const circulatingSupply = 1_000_000_000; // replace if known
    const volume = Math.abs(price - lastPrice) * circulatingSupply;

    chartData.push({
      timestamp: new Date().toISOString(),
      price,
      change,
      volume
    });

    // Keep only last 24h
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    chartData = chartData.filter(d => new Date(d.timestamp).getTime() >= cutoff);
  } catch (err) {
    console.error("Error recording price:", err);
  }
}

// Record every 5s
recordPricePoint();
setInterval(recordPricePoint, 5000);

// Chart endpoint
app.get("/api/chart", (req, res) => res.json(chartData));

app.listen(process.env.PORT || 3000, () => console.log("Server running"));
