import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { Connection, PublicKey } from "@solana/web3.js";

const app = express();
app.use(cors());

// --- CONFIG ---
const heliusApiKey = "fc2112a6-6f31-4224-a92e-08165e6115e8";
const tokenMint = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";
const poolAddress = "8apo3YBrRNvts9boFNLZ1NC1xWEy2snq3ctmYPto162c";
const solMint = "So11111111111111111111111111111111111111112";

const connection = new Connection(
  `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`,
  "confirmed"
);

let chartData = [];

// --- FETCH LIVE PRICE & VOLUME ---
async function fetchBlackCoinPrice() {
  try {
    const poolPubKey = new PublicKey(poolAddress);

    // Token balance in pool
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(poolPubKey, { mint: new PublicKey(tokenMint) });
    const tokenBalance = tokenAccounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;

    // SOL balance in pool
    const solAccounts = await connection.getParsedTokenAccountsByOwner(poolPubKey, { mint: new PublicKey(solMint) });
    const solBalance = solAccounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;

    if(tokenBalance === 0) return;

    // Price in SOL
    const priceSOL = solBalance / tokenBalance;

    // Fetch SOL price in USD from CoinGecko
    const solUSDResp = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const solUSDData = await solUSDResp.json();
    const solUSD = solUSDData?.solana?.usd || 0;

    const priceUSD = priceSOL * solUSD;

    // --- Volume calculation ---
    // Helius token transfers in last 5s
    const now = Math.floor(Date.now() / 1000);
    const fromTimestamp = now - 5; // last 5 seconds
    const transfersResp = await fetch(`https://api.helius.xyz/v0/token-metadata/token-transfers?api-key=${heliusApiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mint: tokenMint,
        startTime: fromTimestamp
      })
    });
    const transfers = await transfersResp.json();
    let volume = 0;
    if(Array.isArray(transfers)) {
      volume = transfers.reduce((acc, t) => acc + (t.amount || 0), 0);
    }

    const timestamp = new Date().toISOString();
    chartData.push({ timestamp, price: priceUSD, volume });

    // Keep last 24h (~17280 points for 5s intervals)
    const cutoff = Date.now() - 24*60*60*1000;
    chartData = chartData.filter(d => new Date(d.timestamp).getTime() >= cutoff);

  } catch (err) {
    console.error("Fetch error:", err);
  }
}

// Fetch every 5 seconds
setInterval(fetchBlackCoinPrice, 5000);

// --- API ENDPOINT ---
app.get("/api/chart", (req, res) => {
  res.json(chartData);
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
