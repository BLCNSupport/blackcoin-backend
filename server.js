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

let chartData = [];

// Fetch live price and volume from pool
async function recordPricePoint() {
  try {
    const poolPubKey = new PublicKey(poolAddress);

    // Token balances
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(poolPubKey, {
      mint: new PublicKey(tokenMint)
    });
    const solAccounts = await connection.getParsedTokenAccountsByOwner(poolPubKey, {
      mint: new PublicKey(solMint)
    });

    const tokenBalance = tokenAccounts.value.reduce(
      (acc, acct) => acc + (acct.account.data.parsed.info.tokenAmount.uiAmount || 0),
      0
    );
    const solBalance = solAccounts.value.reduce(
      (acc, acct) => acc + (acct.account.data.parsed.info.tokenAmount.uiAmount || 0),
      0
    );

    // Price in USD
    const solUSDResp = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
    );
    const solUSDData = await solUSDResp.json();
    const solUSD = solUSDData?.solana?.usd || 0;
    const price = tokenBalance > 0 ? (solBalance / tokenBalance) * solUSD : 0;

    // Compute 24h change
    const lastPrice = chartData.length > 0 ? chartData[chartData.length - 1].price : price;
    const change = lastPrice > 0 ? ((price - lastPrice) / lastPrice) * 100 : 0;

    // Fetch recent swap transactions from Helius for this pool
    const swapResp = await fetch(`https://api.helius.xyz/v0/transactions?api-key=${heliusApiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accounts: [poolAddress],
        limit: 10
      })
    });
    const swaps = await swapResp.json();

    // Estimate volume in USD for this interval
    let volume = 0;
    for (const tx of swaps) {
      if (!tx?.parsedInstructions) continue;
      for (const instr of tx.parsedInstructions) {
        if (instr.program === "spl-token" && instr.parsed?.type === "transfer") {
          const amt = parseFloat(instr.parsed.info.amount || 0);
          if (instr.parsed.info.mint === tokenMint) {
            volume += amt * price; // BlackCoin -> USD
          } else if (instr.parsed.info.mint === solMint) {
            volume += amt * solUSD; // SOL -> USD
          }
        }
      }
    }

    chartData.push({
      timestamp: new Date().toISOString(),
      price,
      change,
      volume
    });

    // Keep only last 24h (~17,280 points for 5s interval)
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    chartData = chartData.filter(d => new Date(d.timestamp).getTime() >= cutoff);

    console.log(`Recorded: $${price.toFixed(6)}, Vol: $${volume.toFixed(2)}`);
  } catch (err) {
    console.error("Error recording price:", err);
  }
}

setInterval(recordPricePoint, 5000);
recordPricePoint();

app.get("/api/chart", (req, res) => res.json(chartData));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
