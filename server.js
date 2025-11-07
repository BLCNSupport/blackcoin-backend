// server.js — BlackCoin backend (Operator Hub realtime edition)
// ESM + Express + Supabase + WS
// - Chart poller with backoff
// - Profile save/get
// - Avatar upload to Supabase Storage + profile update
// - Broadcasts: insert + list (DESC, 25)
// - Refund: insert + list
// - WebSocket server on /ws broadcasting realtime INSERT/UPDATE/DELETE from hub_broadcasts
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import multer from "multer";
import http from "http";
import * as ws from "ws";
const { WebSocketServer } = ws;

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

function ts(){ const d=new Date(); return `[${d.toTimeString().slice(0,8)}]`; }
const log=(...a)=>console.log(ts(),...a);
const warn=(...a)=>console.warn(ts(),...a);
const err=(...a)=>console.error(ts(),...a);

/* ---------- Supabase ---------- */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // service_role
if (!SUPABASE_URL || !SUPABASE_KEY) {
  err("SUPABASE_URL or SUPABASE_KEY missing"); process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ---------- Health ---------- */
app.get("/healthz", (_req,res)=>res.json({ ok:true, time:new Date().toISOString() }));

/* ---------- Chart poller (unchanged) ---------- */
const TOKEN_MINT = "J3rYdme789g1zAysfbH9oP4zjagvfVM2PX7KJgFDpump";
let FETCH_INTERVAL = 20000;
const BACKOFF_INTERVAL = 60000;
let isBackoff=false, fetchInProgress=false, pollTimer=null;
let memoryCache=[];

async function insertPoint(point){
  try{ const {error}=await supabase.from("chart_data").insert([point]); if(error) err("Supabase insert failed:",error.message); }
  catch(e){ err("Supabase insert exception:",e); }
}
async function fetchOneTick(){
  fetchInProgress=true; log("⏱️  Polling Dexscreener...");
  try{
    const res=await fetch(`https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`,{headers:{"Cache-Control":"no-cache"}});
    if(res.status===429){ warn("⚠️  429 rate limit hit — entering backoff:",`${BACKOFF_INTERVAL/1000}s`); return "backoff"; }
    if(!res.ok){ warn(`⚠️  Upstream returned ${res.status} — keeping normal cadence`); return "softfail"; }
    const json=await res.json(); const pair=json.pairs?.[0];
    if(!pair){ warn("⚠️  No pairs in response — keeping normal cadence"); return "softfail"; }
    const point={ timestamp:new Date().toISOString(), price:+pair.priceUsd, change:+(pair.priceChange?.h24), volume:+(pair.volume?.h24) };
    if([point.price,point.change,point.volume].some(v=>isNaN(v))){ warn("⚠️  Invalid numeric fields — skipping insert"); return "softfail"; }
    memoryCache.push(point); if(memoryCache.length>10000) memoryCache.shift();
    await insertPoint(point); log("✅ Data stored at",point.timestamp); return "ok";
  }catch(e){ err("fetchLiveData failed:",e); return "softfail"; } finally{ fetchInProgress=false; }
}
function scheduleNext(ms){ if(pollTimer){ clearTimeout(pollTimer); pollTimer=null; } pollTimer=setTimeout(pollLoop,ms); }
async function pollLoop(){
  if(fetchInProgress){ warn("⏸️  Prev fetch still running — skip"); return scheduleNext(isBackoff?BACKOFF_INTERVAL:FETCH_INTERVAL); }
  const r=await fetchOneTick();
  if(r==="backoff"){ if(!isBackoff) isBackoff=true; log("⏸️  Backoff active — delaying"); return scheduleNext(BACKOFF_INTERVAL); }
  if(isBackoff && r==="ok"){ isBackoff=false; log("⏳  Backoff ended — resume"); return scheduleNext(FETCH_INTERVAL); }
  scheduleNext(FETCH_INTERVAL);
}
pollLoop();

/* ---------- Chart API ---------- */
function bucketMs(interval){ switch(interval){case"1m":return 60e3;case"5m":return 300e3;case"30m":return 1800e3;case"1h":return 3600e3;case"D":return 86400e3;default:return 60e3;} }
function getWindow(interval){ const now=Date.now(); if(interval==="D") return new Date(now-30*86400e3).toISOString(); if(interval==="1h") return new Date(now-7*86400e3).toISOString(); return new Date(now-86400e3).toISOString(); }
function floorToBucketUTC(tsISO, interval){ const ms=bucketMs(interval); const d=new Date(tsISO); return new Date(Math.floor(d.getTime()/ms)*ms); }
function bucketize(rows,interval){ const m=new Map(); for(const r of rows){ const key=floorToBucketUTC(r.timestamp,interval).toISOString(); const price=+r.price,change=+r.change,vol=+r.volume; if(!m.has(key)) m.set(key,{timestamp:key,price,change,volume:0}); const b=m.get(key); b.price=price; b.change=change; b.volume+=isNaN(vol)?0:vol; } return Array.from(m.values()).sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp)); }
app.get("/api/chart",async(req,res)=>{
  try{
    const interval=req.query.interval||"D", page=Math.max(parseInt(req.query.page)||1,1), limit=Math.min(parseInt(req.query.limit)||10000,20000);
    const offset=(page-1)*limit, cutoff=getWindow(interval);
    const {data,error,count}=await supabase.from("chart_data").select("timestamp, price, change, volume",{count:"exact"}).gte("timestamp",cutoff).order("timestamp",{ascending:true}).range(offset,offset+limit-1);
    if(error) throw error;
    const raw=data?.length?data:memoryCache.filter(p=>new Date(p.timestamp)>=new Date(cutoff));
    const points=bucketize(raw,interval); const latest=raw.length?raw[raw.length-1]:memoryCache.at(-1);
    const totalCount=count||raw.length; const nextPage=offset+limit<totalCount? page+1:null;
    res.json({points,latest,page,nextPage,hasMore:Boolean(nextPage)});
  }catch(e){ err("Error /api/chart:",e); res.status(500).json({error:"Failed to fetch chart data",message:e.message}); }
});
app.get("/api/latest",async(_req,res)=>{
  try{
    let latest=memoryCache.at(-1);
    if(!latest){ const {data}=await supabase.from("chart_data").select("timestamp, price, change, volume").order("timestamp",{ascending:false}).limit(1).maybeSingle(); latest=data; }
    if(!latest) return res.status(404).json({error:"No data"});
    res.json(latest);
  }catch(e){ err("Error /api/latest:",e); res.status(500).json({error:"Failed"}); }
});

/* ---------- Profiles & Avatars ---------- */
app.post("/api/profile", async (req,res)=>{
  try{
    let { wallet, handle, avatar_url } = req.body;
    if(!wallet) return res.status(400).json({error:"Missing wallet"});
    if(typeof handle==="string") handle=handle.trim();
    if(!handle) handle="@Operator";
    const { data, error } = await supabase.from("hub_profiles").upsert(
      { wallet, handle, avatar_url: avatar_url ?? null, updated_at:new Date().toISOString() },
      { onConflict:"wallet" }
    ).select();
    if(error) throw error;
    res.json({ success:true, data });
  }catch(e){ err("Error /api/profile:",e); res.status(500).json({error:e.message}); }
});
app.get("/api/profile", async (req,res)=>{
  try{
    const wallet=req.query.wallet; if(!wallet) return res.status(400).json({error:"Missing wallet"});
    const { data, error } = await supabase.from("hub_profiles").select("*").eq("wallet",wallet).maybeSingle();
    if(error) throw error;
    if(!data) return res.status(404).json({error:"Not found"});
    res.json(data);
  }catch(e){ err("Error /api/profile[GET]:",e); res.status(500).json({error:e.message}); }
});

const upload = multer({ storage: multer.memoryStorage() });
app.post("/api/avatar-upload", upload.single("avatar"), async (req,res)=>{
  try{
    const { wallet } = req.body; const file = req.file;
    if(!wallet || !file) return res.status(400).json({error:"Missing fields"});
    const fileName = `avatars/${wallet}_${Date.now()}.jpg`;
    const { error: uploadErr } = await supabase.storage.from("hub_avatars").upload(fileName, file.buffer, { contentType:file.mimetype, upsert:true });
    if(uploadErr) throw uploadErr;
    const { data: publicURL } = supabase.storage.from("hub_avatars").getPublicUrl(fileName);
    const url = publicURL.publicUrl;
    const { error: updErr } = await supabase.from("hub_profiles").upsert({ wallet, avatar_url:url, updated_at:new Date().toISOString() }, { onConflict:"wallet" });
    if(updErr) throw updErr;
    res.json({ success:true, url });
  }catch(e){ err("Error /api/avatar-upload:",e); res.status(500).json({error:e.message}); }
});

/* ---------- Broadcasts ---------- */
const hhmm = (iso)=>{ try{ const d=new Date(iso); return d.toTimeString().slice(0,5);}catch{return "";} };

// Normalize DB row into a stable payload for clients
function normRow(r){
  if(!r) return null;
  return {
    id: r.id,
    wallet: r.wallet,
    message: r.message,
    created_at: r.created_at,
    display_time: hhmm(r.created_at)
  };
}

app.post("/api/broadcast", async (req,res)=>{
  try{
    const { wallet, message } = req.body;
    if(!wallet || !message) return res.status(400).json({error:"Missing fields"});
    const { data, error } = await supabase.from("hub_broadcasts").insert([{ wallet, message }]).select().maybeSingle();
    if(error) throw error;
    const row = normRow(data);

    // Instant echo so the poster sees it immediately (others still get realtime)
    wsBroadcast({ type:"insert", row });

    res.json({ success:true, data: row });
  }catch(e){ err("Error /api/broadcast:",e); res.status(500).json({error:e.message}); }
});

app.get("/api/broadcasts", async (_req,res)=>{
  try{
    const { data, error } = await supabase
      .from("hub_broadcasts")
      .select("id, wallet, message, created_at")
      .order("created_at",{ascending:false})
      .limit(25);
    if(error) throw error;
    const rows = (data||[]).map(normRow);
    res.json(rows);
  }catch(e){ err("Error /api/broadcasts:",e); res.status(500).json({error:e.message}); }
});

/* ---------- Refunds ---------- */
app.post("/api/refund", async (req,res)=>{
  try{
    const { wallet, token, rent, tx, status } = req.body;
    if(!wallet || !tx) return res.status(400).json({error:"Missing required fields"});
    const record = { wallet, token:token||"UNKNOWN", rent_reclaimed: rent ?? 0, tx, status: status || "Success" };
    const { data, error } = await supabase.from("hub_refund_history").insert([record]).select();
    if(error) throw error;
    res.json({ success:true, inserted:data });
  }catch(e){ err("❌ Error inserting refund:",e); res.status(500).json({error:e.message}); }
});
app.get("/api/refund-history", async (req,res)=>{
  try{
    const { wallet } = req.query;
    if(!wallet) return res.status(400).json({error:"Missing wallet"});
    res.set("Cache-Control","no-store");
    const { data, error } = await supabase
      .from("hub_refund_history")
      .select("*")
      .eq("wallet",wallet)
      .order("created_at",{ascending:false})
      .limit(50);
    if(error) throw error;
    res.json(data||[]);
  }catch(e){ err("Error /api/refund-history:",e); res.status(500).json({error:e.message}); }
});

/* ---------- WebSocket + realtime bridge ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path:"/ws" });
const clients = new Set();

wss.on("connection", async (socket)=>{
  socket.isAlive = true;
  clients.add(socket);
  socket.on("pong", ()=> socket.isAlive=true);
  socket.on("close", ()=> clients.delete(socket));
  socket.on("error", (e)=> err("WS error:", e?.message||e));

  // send last 25 on connect (DESC -> client sorts; or show as-is)
  try{
    const { data, error } = await supabase
      .from("hub_broadcasts")
      .select("id, wallet, message, created_at")
      .order("created_at",{ascending:false})
      .limit(25);
    if(!error && data){
      const rows = (data||[]).map(normRow);
      socket.send(JSON.stringify({ type:"hello", rows }));
    }
  }catch(e){ err("WS hello failed:", e?.message||e); }
});

setInterval(()=>{
  for(const s of clients){
    if(s.isAlive===false) { try{s.terminate();}catch{}; continue; }
    s.isAlive=false; try{s.ping();}catch{}
  }
}, 30000);

function wsBroadcast(o){
  const msg = JSON.stringify(o);
  for(const s of clients){ if(s.readyState===s.OPEN) s.send(msg); }
}

/* ---------- Supabase Realtime: resilient subscription ---------- */
// we wrap the subscription logic so we can re-subscribe on failures
let rtChannel = null;
function subscribeToBroadcasts() {
  try {
    if (rtChannel) {
      try { supabase.removeChannel(rtChannel); } catch {}
      rtChannel = null;
    }

    rtChannel = supabase
      .channel("rt:hub_broadcasts", {
        config: { broadcast: { ack: true }, presence: { key: "server" } }
      })
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "hub_broadcasts" },
        (payload) => {
          const row = normRow(payload?.new || payload?.record);
          log("🔔 INSERT hub_broadcasts id=", row?.id);
          if (row) wsBroadcast({ type:"insert", row });
        }
      )
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "hub_broadcasts" },
        (payload) => {
          const row = normRow(payload?.new || payload?.record);
          log("🔧 UPDATE hub_broadcasts id=", row?.id);
          if (row) wsBroadcast({ type:"update", row });
        }
      )
      .on("postgres_changes",
        { event: "DELETE", schema: "public", table: "hub_broadcasts" },
        (payload) => {
          const old = payload?.old || payload?.record || null;
          const id = old?.id;
          log("🗑️  DELETE hub_broadcasts id=", id);
          if (id) wsBroadcast({ type:"delete", id });
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") log("✅ Realtime subscribed: hub_broadcasts");
        else if (status === "CHANNEL_ERROR") { err("❌ Realtime CHANNEL_ERROR — retrying in 2s"); setTimeout(subscribeToBroadcasts, 2000); }
        else if (status === "TIMED_OUT") { warn("⚠️ Realtime TIMED_OUT — retrying in 2s"); setTimeout(subscribeToBroadcasts, 2000); }
        else if (status === "CLOSED") { warn("⚠️ Realtime CLOSED — retrying in 2s"); setTimeout(subscribeToBroadcasts, 2000); }
      });
  } catch (e) {
    err("Realtime subscribe failed:", e?.message || e);
    setTimeout(subscribeToBroadcasts, 2000);
  }
}
subscribeToBroadcasts();

server.listen(PORT, ()=> log(`✅ BlackCoin backend running on port ${PORT}`));
