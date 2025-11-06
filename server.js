/* server.js — BlackCoin Operator Hub API (Render-ready)
   -------------------------------------------------------------
   Endpoints:
   - GET  /api/health
   - GET  /api/can-post?wallet=...
   - GET  /api/broadcast?limit=100
   - POST /api/broadcast              (DEV-only)
   - POST /api/profile                (upsert hub_profiles)
   - POST /api/avatar-upload          (upload to Storage bucket: hub_avatars)

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
      .order('created_at', { ascending: true })
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
