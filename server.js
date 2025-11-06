/**
 * BlackCoin Operator Hub server (shared) — UPSERT profiles & avatars, broadcasts, role check
 * Env:
 *  SUPABASE_URL
 *  SUPABASE_SERVICE_ROLE
 *  DEV_WALLET
 *  MOD_WALLETS (comma separated)
 *  PORT (optional)
 */

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false },
});

const DEV_WALLET = (process.env.DEV_WALLET || '94BkuiUMv7jMGKBEhQ87gJVqk9kyQiFus5HbR3hGzhru').trim();
const MOD_WALLETS = (process.env.MOD_WALLETS || 'MOD_WALLET_1_PLACEHOLDER,MOD_WALLET_2_PLACEHOLDER,MOD_WALLET_3_PLACEHOLDER')
  .split(',').map(s => s.trim()).filter(Boolean);

function roleOf(wallet) {
  if (!wallet) return null;
  if (wallet === DEV_WALLET) return 'DEV';
  if (MOD_WALLETS.includes(wallet)) return 'MOD';
  return null;
}

/* ================= Role check ================= */
app.get('/api/can-post', (req, res) => {
  const wallet = String(req.query.wallet || '').trim();
  const role = roleOf(wallet);
  res.json({ canPost: !!role, role });
});

/* ================= Profile save (UPSERT) ================= */
app.post('/api/profile', async (req, res) => {
  try {
    const { wallet, handle, avatar_url } = req.body || {};
    if (!wallet || !handle) return res.status(400).send('wallet and handle required');
    const payload = {
      wallet,
      handle,
      updated_at: new Date().toISOString(),
    };
    if (avatar_url) payload.avatar_url = avatar_url;

    const { error } = await sb.from('hub_profiles')
      .upsert(payload, { onConflict: 'wallet' });
    if (error) return res.status(500).send(error.message);

    return res.json({ ok: true });
  } catch (e) {
    console.error('profile upsert error', e);
    return res.status(500).send('server error');
  }
});

/* ================= Avatar upload -> storage bucket 'hub_avatars' + table UPSERT ================= */
app.post('/api/avatar-upload', multer({ storage: multer.memoryStorage() }).single('avatar'), async (req, res) => {
  try {
    const wallet = String(req.body.wallet || '').trim();
    if (!wallet) return res.status(400).send('wallet required');
    if (!req.file) return res.status(400).send('avatar file required');

    const ext = (req.file.originalname && req.file.originalname.includes('.'))
      ? req.file.originalname.slice(req.file.originalname.lastIndexOf('.')).toLowerCase()
      : '.png';
    const filePath = `${wallet}${ext}`;

    const bucket = sb.storage.from('hub_avatars');
    await bucket.remove([filePath]).catch(()=>{});

    const { error: upErr } = await bucket.upload(filePath, req.file.buffer, {
      contentType: req.file.mimetype || 'image/png',
      upsert: true,
    });
    if (upErr) return res.status(500).send(upErr.message);

    const { data: pub } = bucket.getPublicUrl(filePath);
    const publicUrl = pub?.publicUrl;

    const { error: avErr } = await sb.from('hub_avatars').upsert({
      wallet,
      url: publicUrl,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'wallet' });
    if (avErr) return res.status(500).send(avErr.message);

    await sb.from('hub_profiles').upsert({
      wallet,
      handle: '@Operator',
      avatar_url: publicUrl,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'wallet' });

    return res.json({ ok: true, url: publicUrl });
  } catch (e) {
    console.error('avatar upload error', e);
    return res.status(500).send('server error');
  }
});

/* ================= Broadcasts ================= */
app.get('/api/broadcasts', async (req, res) => {
  try {
    const { data, error } = await sb
      .from('hub_broadcasts')
      .select('*')
      .order('created_at', { ascending: true })
      .limit(100);
    if (error) return res.status(500).send(error.message);
    return res.json(data || []);
  } catch (e) {
    console.error('broadcasts get error', e);
    return res.status(500).send('server error');
  }
});

app.post('/api/broadcast', async (req, res) => {
  try {
    const { wallet, message, type } = req.body || {};
    if (!wallet || !message) return res.status(400).send('wallet and message required');
    const role = roleOf(wallet);
    if (!role) return res.status(403).send('not allowed');

    const row = {
      wallet,
      message: String(message).slice(0, 1000),
      type: type || 'broadcast',
      created_at: new Date().toISOString(),
    };
    const { error } = await sb.from('hub_broadcasts').insert(row);
    if (error) return res.status(500).send(error.message);
    return res.json({ ok: true });
  } catch (e) {
    console.error('broadcast post error', e);
    return res.status(500).send('server error');
  }
});

// Health
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));