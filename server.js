javascript

/* server.js — BlackCoin Operator Hub API (Render-ready)
   -------------------------------------------------------------
   Endpoints:
   - GET  /api/health
   - GET  /api/can-post?wallet=...
   - GET  /api/broadcast?limit=100
   - POST /api/broadcast              (DEV-only)
   - POST /api/profile                (upsert hub_profiles)
   - POST /api/avatar-upload          (upload to Storage bucket: hub_avatars)
   - GET  /api/chart?interval=D&page=1&limit=10000
   - GET  /api/latest
   - POST /api/refund
   - GET  /api/refund-history?wallet=...
   - GET  /api/wallet?addr=...

   Env required (Render → Environment Variables):
   - PORT (auto on Render)
   - SUPABASE_URL=https://filozevjygowqajmqznc.supabase.co
   - SUPABASE_SERVICE_ROLE=<your service role key>
   - DEV_WALLET=94BkuiUMv7jMGKBEhQ87gJVqk9kyQiFus5HbR3hGzhru
   - MOD_WALLETS= (optional, comma-separated)
*/
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

// ----------- Config -----------
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const DEV_WALLET = (process.env.DEV_WALLET || '').trim();
const MOD_WALLETS = (process.env.MOD_WALLETS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Fail fast on missing env:
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('[FATAL] SUPABASE_URL and SUPABASE_SERVICE_ROLE are required env vars.');
  process.exit(1);
}

// Supabase (Service Role for secure writes from server)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// Express app
const app = express();
app.set('trust proxy', true);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('tiny'));

// Memory storage for multer (we push the buffer to Supabase Storage)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

// ----------- Helpers -----------
function isDev(wallet) {
  return wallet && DEV_WALLET && wallet === DEV_WALLET;
}
function isMod(wallet) {
  return wallet && MOD_WALLETS.includes(wallet);
}
function roleOf(wallet) {
  if (isDev(wallet)) return 'DEV';
  if (isMod(wallet)) return 'MOD';
  return null;
}
function safeStr(x, max = 2000) {
  if (typeof x !== 'string') return '';
  return x.slice(0, max).trim();
}
function uniqueKey(prefix) {
  const ts = Date.now();
  const rand = crypto.randomBytes(6).toString('hex');
  return `${prefix}/${ts}-${rand}`;
}

// === Chart data poller ===
const TOKEN_MINT = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";
const FETCH_INTERVAL = 5000;
let memoryCache = [];

async function insertPoint(point) {
  try {
    const { error } = await supabase.from("chart_data").insert([point]);
    if (error) console.error("Supabase insert failed:", error.message);
  } catch (err) {
    console.error("Supabase insert exception:", err);
  }
}

async function fetchLiveData() {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`,
      { headers: { "Cache-Control": "no-cache" } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const pair = json.pairs?.[0];
    if (!pair) return;

    const point = {
      timestamp: new Date().toISOString(),
      price: parseFloat(pair.priceUsd),
      change: parseFloat(pair.priceChange?.h24),
      volume: parseFloat(pair.volume?.h24),
    };

    if ([point.price, point.change, point.volume].some((v) => isNaN(v))) return;
    memoryCache.push(point);
    if (memoryCache.length > 10000) memoryCache.shift();

    await insertPoint(point);
  } catch (err) {
    console.error("fetchLiveData failed:", err);
  }
}
fetchLiveData();
setInterval(fetchLiveData, FETCH_INTERVAL);

// === Chart helpers ===
function bucketMs(interval) {
  switch (interval) {
    case "1m":
      return 60 * 1000;
    case "5m":
      return 5 * 60 * 1000;
    case "30m":
      return 30 * 60 * 1000;
    case "1h":
      return 60 * 60 * 1000;
    case "D":
      return 24 * 60 * 60 * 1000;
    default:
      return 60 * 1000;
  }
}
function getWindow(interval) {
  const now = Date.now();
  if (interval === "D")
    return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  if (interval === "1h")
    return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  return new Date(now - 24 * 60 * 60 * 1000).toISOString();
}
function floorToBucketUTC(tsISO, interval) {
  const ms = bucketMs(interval);
  const d = new Date(tsISO);
  return new Date(Math.floor(d.getTime() / ms) * ms);
}
function bucketize(rows, interval) {
  const byKey = new Map();
  for (const r of rows) {
    const key = floorToBucketUTC(r.timestamp, interval).toISOString();
    const price = +r.price,
      change = +r.change,
      vol = +r.volume;
    if (!byKey.has(key))
      byKey.set(key, { timestamp: key, price, change, volume: 0 });
    const b = byKey.get(key);
    b.price = price;
    b.change = change;
    b.volume += isNaN(vol) ? 0 : vol;
  }
  return Array.from(byKey.values()).sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );
}

// ----------- Routes -----------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'BlackCoin Operator Hub API', time: new Date().toISOString() });
});

// Can the given wallet post?
app.get('/api/can-post', (req, res) => {
  const wallet = safeStr(req.query.wallet || '', 128);
  const role = roleOf(wallet);
  // As per spec: posting is DEV-only (even though MOD role exists we return canPost=false for MOD)
  const canPost = role === 'DEV';
  return res.json({ wallet, role, canPost });
});

// Fetch broadcasts
app.get('/api/broadcast', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 300);
  try {
    const { data, error } = await supabase
      .from('hub_broadcasts')
      .select('*')
      .order('created_at', { ascending: false }) // Changed to descending to match old behavior
      .limit(limit);

    if (error) throw error;
    res.json({ ok: true, rows: data || [] });
  } catch (e) {
    console.error('[broadcast:list] error', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Create broadcast — DEV only
app.post('/api/broadcast', async (req, res) => {
  try {
    const wallet = safeStr(req.body.wallet || '', 128);
    const message = safeStr(req.body.message || '', 2000);
    const type = safeStr(req.body.type || 'broadcast', 32) || 'broadcast';

    if (!wallet || !message) {
      return res.status(400).json({ ok: false, error: 'wallet and message are required' });
    }
    if (!isDev(wallet)) {
      return res.status(403).json({ ok: false, error: 'Only DEV wallet may post broadcasts.' });
    }

    const row = {
      wallet,
      message,
      role: 'DEV',
      type,
      created_at: new Date().toISOString(),
    };

    const { data, error } = await supabase.from('hub_broadcasts').insert(row).select().single();
    if (error) throw error;

    res.json({ ok: true, row: data });
  } catch (e) {
    console.error('[broadcast:create] error', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Upsert profile (wallet, handle, optional avatar_url)
app.post('/api/profile', async (req, res) => {
  try {
    const wallet = safeStr(req.body.wallet || '', 128);
    const handle = safeStr(req.body.handle || '', 64);
    const avatar_url = safeStr(req.body.avatar_url || '', 1024);

    if (!wallet) {
      return res.status(400).json({ ok: false, error: 'wallet is required' });
    }

    const patch = {
      wallet,
      updated_at: new Date().toISOString(),
    };
    if (handle) patch.handle = handle;
    if (avatar_url) patch.avatar_url = avatar_url;

    const { data, error } = await supabase
      .from('hub_profiles')
      .upsert(patch, { onConflict: 'wallet' })
      .select()
      .single();

    if (error) throw error;
    res.json({ ok: true, row: data });
  } catch (e) {
    console.error('[profile:upsert] error', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Avatar upload → Supabase Storage (bucket: hub_avatars) then update profile
app.post('/api/avatar-upload', upload.single('avatar'), async (req, res) => {
  try {
    const wallet = safeStr(req.body.wallet || '', 128);
    if (!wallet) return res.status(400).json({ ok: false, error: 'wallet is required' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'avatar file is required' });

    const ext = path.extname(req.file.originalname || '').toLowerCase() || '.png';
    const key = uniqueKey(wallet) + ext; // e.g., <wallet>/<ts>-<rand>.png

    // Upload to Storage
    const { data: up, error: upErr } = await supabase.storage
      .from('hub_avatars')
      .upload(key, req.file.buffer, {
        contentType: req.file.mimetype || 'image/png',
        upsert: true,
      });
    if (upErr) throw upErr;

    // Build a public URL (bucket must be public; otherwise use signed URL)
    const { data: pub } = supabase.storage.from('hub_avatars').getPublicUrl(up.path);
    const avatar_url = pub?.publicUrl;

    // Update profile with avatar_url
    const { data: profile, error: pErr } = await supabase
      .from('hub_profiles')
      .upsert({ wallet, avatar_url, updated_at: new Date().toISOString() }, { onConflict: 'wallet' })
      .select()
      .single();
    if (pErr) throw pErr;

    res.json({ ok: true, url: avatar_url, row: profile });
  } catch (e) {
    console.error('[avatar-upload] error', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// === Chart API ===
app.get("/api/chart", async (req, res) => {
  try {
    const interval = req.query.interval || "D";
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 10000, 20000);
    const offset = (page - 1) * limit;
    const cutoff = getWindow(interval);

    const { data, error, count } = await supabase
      .from("chart_data")
      .select("timestamp, price, change, volume", { count: "exact" })
      .gte("timestamp", cutoff)
      .order("timestamp", { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    const raw = data?.length
      ? data
      : memoryCache.filter((p) => new Date(p.timestamp) >= new Date(cutoff));

    const points = bucketize(raw, interval);
    const latest = raw.length ? raw[raw.length - 1] : memoryCache.at(-1);
    const totalCount = count || raw.length;
    const nextPage = offset + limit < totalCount ? page + 1 : null;

    res.json({ points, latest, page, nextPage, hasMore: Boolean(nextPage) });
  } catch (err) {
    console.error("Error /api/chart:", err);
    res
      .status(500)
      .json({ error: "Failed to fetch chart data", message: err.message });
  }
});

// === Latest tick ===
app.get("/api/latest", async (req, res) => {
  try {
    let latest = memoryCache.at(-1);
    if (!latest) {
      const { data } = await supabase
        .from("chart_data")
        .select("timestamp, price, change, volume")
        .order("timestamp", { ascending: false })
        .limit(1)
        .maybeSingle();
      latest = data;
    }
    if (!latest) return res.status(404).json({ error: "No data" });
    res.json(latest);
  } catch (err) {
    console.error("Error /api/latest:", err);
    res.status(500).json({ error: "Failed" });
  }
});

// === Log refund transaction (enhanced, with replication buffer) ===
app.post("/api/refund", async (req, res) => {
  try {
    const { wallet, token, rent, tx, status } = req.body;
    if (!wallet || !tx) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }

    const record = {
      wallet,
      token: token || "UNKNOWN",
      rent_reclaimed: rent ?? 0,
      tx,
      status: status || "Success",
      created_at: new Date().toISOString(),
    };

    // 🧾 Insert into Supabase
    const { data, error } = await supabase
      .from("hub_refund_history")
      .insert([record])
      .select();

    if (error) throw error;

    console.log(`✅ Logged refund for ${wallet}: ${token} ${rent} SOL`);

    // 🕒 Wait for Supabase replication
    await new Promise((r) => setTimeout(r, 1500));

    // 🧩 Verify visibility
    const { data: verifyRows, error: verifyErr } = await supabase
      .from("hub_refund_history")
      .select("id, wallet, tx, created_at")
      .eq("wallet", wallet)
      .order("created_at", { ascending: false })
      .limit(1);

    if (verifyErr)
      console.warn("⚠️ Verification query failed:", verifyErr.message);
    else if (verifyRows?.length > 0)
      console.log("🧩 Verified new refund visible:", verifyRows[0]);
    else console.warn("⚠️ Verification: no rows yet (still syncing).");

    res.json({ ok: true, inserted: data });
  } catch (err) {
    console.error("❌ Error inserting refund:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// === Fetch refund history for a wallet (fresh + consistent) ===
app.get("/api/refund-history", async (req, res) => {
  try {
    const { wallet } = req.query;
    if (!wallet) return res.status(400).json({ ok: false, error: "Missing wallet" });

    res.set("Cache-Control", "no-store");

    const { data, error } = await supabase
      .from("hub_refund_history")
      .select("*")
      .eq("wallet", wallet)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("Error /api/refund-history:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// === Fetch wallet summary (placeholder) ===
app.get("/api/wallet", async (req, res) => {
  try {
    const addr = req.query.addr;
    if (!addr) return res.status(400).json({ ok: false, error: "Missing addr" });
    res.json({
      address: addr,
      balances: [
        { name: "SOL", amount: 12.34, value: 12.34 * 305 },
        { name: "BlackCoin", amount: 1000000, value: 187.5 },
      ],
    });
  } catch (err) {
    console.error("Error /api/wallet:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Root
app.get('/', (_req, res) => {
  res.type('text/plain').send('BlackCoin Operator Hub API is running.');
});

// Start
app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  console.log(`- DEV wallet: ${DEV_WALLET || '(not set)'}`);
  console.log(`- MOD wallets: ${MOD_WALLETS.join(', ') || '(none)'}`);
});
