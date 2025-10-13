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

let chartData = []; // stores last 24h chart points
let lastTxSignature = null; // track last transaction fetched

async function fetchNewTransactions() {
  const body = { account: poolAddress, limit: 1000 };
  if (lastTxSignature) body.before = lastTxSignature;

  const resp = await fetch(
    `https://api.helius.xyz/v0/transactions?api-key=${heliusApiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) return [];

  lastTxSignature = data[0].signature; // newest tx signature
  return data.reverse(); // oldest to newest
}

async function fetchBlackCoinPrice() {
  try {
    const poolPubKey = new PublicKey(poolAddress);

    // Get balances for price
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(poolPubKey, {
      mint: new PublicKey(tokenMint),
    });
    const tokenBalance = tokenAccounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;

    const solAccounts = await connection.getParsedTokenAccountsByOwner(poolPubKey, {
      mint: new PublicKey(solMint),
    });
    const solBalance = solAccounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;

    if (tokenBalance === 0) return;

    const priceSOL = solBalance / tokenBalance;

    const solUSDResp = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const solUSDData = await solUSDResp.json();
    const solUSD = solUSDData?.solana?.usd || 0;

    const priceUSD = priceSOL * solUSD;

    // Fetch new transactions for volume
    const newTxs = await fetchNewTransactions();
    let volume = chartData.length > 0 ? chartData[chartData.length - 1].volume : 0;

    for (const tx of newTxs) {
      if (tx.changes && tx.changes[tokenMint]) {
        const tokenAmount = tx.changes[tokenMint].diff?.uiAmount || 0;
        volume += Math.abs(tokenAmount * priceUSD);
      }
    }

    // 24h % change
    const change =
      chartData.length > 0
        ? ((priceUSD - chartData[chartData.length - 1].price) / chartData[chartData.length - 1].price) * 100
        : 0;

    const timestamp = new Date().toISOString();
    chartData.push({ timestamp, price: priceUSD, change, volume });

    // Keep last 24h (~17280 points for 5s intervals)
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    chartData = chartData.filter(d => new Date(d.timestamp).getTime() >= cutoff);
  } catch (err) {
    console.error("Fetch error:", err);
  }
}

// Fetch every 5 seconds
setInterval(fetchBlackCoinPrice, 5000);

app.get("/api/chart", (req, res) => {
  res.json(chartData);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
