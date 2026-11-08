import express, { Request, Response } from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';

const exec = promisify(execCb);

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), '.hum-dono-data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');

const ONLINE_MS = 8000;
const TYPING_MS = 3500;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Ensure data dirs exist
await fsp.mkdir(MEDIA_DIR, { recursive: true });

// --- VAPID KEYS SETUP ---
const b64u = (buf: Buffer | Uint8Array) => Buffer.from(buf).toString('base64url');
const fromB64u = (s: string) => Buffer.from(String(s), 'base64url');

async function getVapidKeys() {
  let jwk: any = null;
  try {
    jwk = JSON.parse(await fsp.readFile(VAPID_FILE, 'utf8'));
  } catch {}
  if (!jwk || !jwk.d) {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    jwk = pair.privateKey.export({ format: 'jwk' });
    await fsp.writeFile(VAPID_FILE, JSON.stringify(jwk), { mode: 0o600 });
  }
  const privateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const pub = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  const publicKey = b64u(Buffer.concat([Buffer.from([4]), fromB64u(pub.x as string), fromB64u(pub.y as string)]));
  return { publicKey, privateKey };
}

const vapid = await getVapidKeys();

// --- DATABASE IN-MEMORY & PERSISTENCE ---
interface Member {
  token: string;
  name: string;
  slot: number;
  lastSeen: number;
  typingAt: number;
  readAt: number;
  joined: number;
  visibleAt?: number;
  subs?: any[];
}

interface Message {
  id: string;
  from: number;
  kind: 'text' | 'image';
  text?: string;
  media?: string;
  ts: number;
  seenAt?: number;
}

interface CallSession {
  id: string;
  kind: 'video' | 'voice';
  caller: number;
  status: 'ringing' | 'active' | 'ended';
  offer: { type: string; sdp: string };
  answer: { type: string; sdp: string } | null;
  ice: { [slot: number]: any[] };
  ts: number;
  startedAt?: number;
  endedAt?: number;
  endReason?: string;
}

interface Room {
  id: string;
  code: string;
  created: number;
  mode?: 'save' | 'day' | 'seen';
  members: Member[];
  messages: Message[];
  call?: CallSession | null;
}

interface DB {
  rooms: { [id: string]: Room };
  tokens: { [token: string]: string };
}

let db: DB = { rooms: {}, tokens: {} };
try {
  db = JSON.parse(await fsp.readFile(DB_FILE, 'utf8'));
} catch {}
db.rooms ??= {};
db.tokens ??= {};

let saveChain = Promise.resolve();
function saveDB() {
  saveChain = saveChain
    .then(async () => {
      const tmp = DB_FILE + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(db));
      await fsp.rename(tmp, DB_FILE);
    })
    .catch((e) => console.error('Database save failed:', e));
  return saveChain;
}

const rand = (n: number, alphabet: string) => {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
};

const safeEq = (a: any, b: any) => {
  const x = Buffer.from(String(a).toUpperCase());
  const y = Buffer.from(String(b).toUpperCase());
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const cleanName = (s: any) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24);

function authRoom(req: Request) {
  const token = req.headers['x-token'] as string;
  if (!token || !db.tokens[token]) return null;
  const room = db.rooms[db.tokens[token]];
  if (!room) return null;
  const member = room.members.find((m) => m.token === token);
  return member ? { room, member, partner: room.members.find((m) => m !== member) || null } : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SEEN_DELETE_MS = 10 * 1000;

async function pruneOld(room: Room) {
  const t = Date.now();
  let gone: Message[] = [];
  if (room.mode === 'day') {
    gone = room.messages.filter((m) => m.ts < t - DAY_MS);
  } else if (room.mode === 'seen') {
    gone = room.messages.filter((m) => m.seenAt && t - m.seenAt > SEEN_DELETE_MS);
  }
  if (!gone.length) return false;
  const ids = new Set(gone.map((m) => m.id));
  room.messages = room.messages.filter((m) => !ids.has(m.id));
  for (const m of gone) {
    if (m.kind === 'image' && m.media) {
      await fsp.unlink(path.join(MEDIA_DIR, path.basename(m.media))).catch(() => {});
    }
  }
  return true;
}

const CALL_RING_MS = 45 * 1000;
const CALL_LOST_MS = 15 * 1000;

function expireCall(room: Room, t: number) {
  const c = room.call;
  if (!c || c.status === 'ended') return;
  const partnerSlot = c.caller === 0 ? 1 : 0;
  const partner = room.members.find((m) => m.slot === partnerSlot);
  if (c.status === 'ringing' && t - c.ts > CALL_RING_MS) {
    c.status = 'ended';
    c.endReason = 'missed';
    c.endedAt = t;
  } else if (c.status === 'active' && (!partner || t - partner.lastSeen > CALL_LOST_MS)) {
    c.status = 'ended';
    c.endReason = 'lost';
    c.endedAt = t;
  }
}

function callView(room: Room, member: Member, t: number) {
  expireCall(room, t);
  const c = room.call;
  if (!c) return null;
  if (c.status === 'ended' && t - (c.endedAt || 0) > 20 * 1000) return null;
  const mine = c.caller === member.slot;
  const out: any = { id: c.id, kind: c.kind, status: c.status, mine, endReason: c.endReason || null };
  if (c.status === 'ringing' && !mine) out.offer = c.offer;
  if (c.status === 'active' && mine) out.answer = c.answer;
  if (c.status !== 'ended') {
    out.iceFromPartner = c.ice[member.slot === 0 ? 1 : 0] || [];
  }
  return out;
}

function statusFor(msg: Message, partner: Member | null) {
  if (!partner) return 'sent';
  if (partner.readAt >= msg.ts) return 'read';
  if (partner.lastSeen >= msg.ts) return 'delivered';
  return 'sent';
}

function viewState(ctx: { room: Room; member: Member; partner: Member | null }) {
  const t = Date.now();
  ctx.member.lastSeen = t;
  const { room, member, partner } = ctx;
  const msgs = room.messages.slice(-300).map((m) => {
    const out: any = { id: m.id, from: m.from === member.slot ? 'me' : 'them', kind: m.kind, ts: m.ts };
    if (m.kind === 'text') out.text = m.text;
    else out.media = m.media;
    if (m.from === member.slot) out.status = statusFor(m, partner);
    return out;
  });
  return {
    me: { name: member.name, slot: member.slot },
    partner: partner
      ? {
          name: partner.name,
          online: t - partner.lastSeen < ONLINE_MS,
          lastSeen: partner.lastSeen,
        }
      : null,
    waiting: !partner,
    settings: { mode: room.mode || 'save' },
    typing: !!partner && t - partner.typingAt < TYPING_MS,
    call: callView(room, member, t),
    messages: msgs,
    serverTime: t,
  };
}

// --- EXPRESS APP SETUP ---
const app = express();
app.use(express.json({ limit: '10mb' }));

// Static media files for photos uploaded in chat
app.use('/media', express.static(MEDIA_DIR, { maxAge: '1d' }));

// 1. Create Room
app.post('/api/room', async (req: Request, res: Response) => {
  const name = cleanName(req.body.name);
  if (!name) return res.status(400).json({ error: 'Pehle apna naam likho' });
  let roomId = '';
  do {
    roomId = rand(12, '0123456789abcdef');
  } while (db.rooms[roomId]);
  const code = rand(8, CODE_CHARS);
  const token = rand(40, 'abcdefghijklmnopqrstuvwxyz0123456789');
  db.rooms[roomId] = {
    id: roomId,
    code,
    created: Date.now(),
    members: [{ token, name, slot: 0, lastSeen: 0, typingAt: 0, readAt: 0, joined: Date.now() }],
    messages: [],
  };
  db.tokens[token] = roomId;
  await saveDB();
  return res.json({ roomId, code, token, slot: 0, name });
});

// 2. Join Room
app.post('/api/join', async (req: Request, res: Response) => {
  const name = cleanName(req.body.name);
  const roomId = String(req.body.roomId || '').trim();
  const room = db.rooms[roomId];
  const codeOk = room && safeEq(room.code, String(req.body.code || '').trim());
  if (!codeOk) {
    await new Promise((r) => setTimeout(r, 600));
    return res.status(404).json({ error: 'Room ya code galat hai — link dobara check karo' });
  }
  if (!name) return res.status(400).json({ error: 'Pehle apna naam likho' });
  if (room.members.length >= 2) return res.status(403).json({ error: 'Ye room full hai — sirf do log allowed hain 💔' });
  const slot = room.members.length;
  const token = rand(40, 'abcdefghijklmnopqrstuvwxyz0123456789');
  room.members.push({ token, name, slot, lastSeen: 0, typingAt: 0, readAt: 0, joined: Date.now() });
  db.tokens[token] = room.id;
  await saveDB();
  return res.json({ roomId: room.id, token, slot, name });
});

// 3. Get State
app.get('/api/state', async (req: Request, res: Response) => {
  const ctx = authRoom(req);
  if (!ctx) return res.status(401).json({ error: 'Session nahi mila — dobara join karo' });
  if (req.headers['x-vis'] === '1') ctx.member.visibleAt = Date.now();
  if (await pruneOld(ctx.room)) await saveDB();
  const out = viewState(ctx);
  return res.json(out);
});

// 4. Send Message (Text or Base64 Image)
app.post('/api/send', async (req: Request, res: Response) => {
  const ctx = authRoom(req);
  if (!ctx) return res.status(401).json({ error: 'Session nahi mila' });
  const ts = Date.now();
  let msg: Message;
  if (req.body.kind === 'image') {
    const m = /^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.dataUrl || ''));
    if (!m) return res.status(400).json({ error: 'Photo samajh nahi aayi' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 5 * 1024 * 1024) return res.status(413).json({ error: 'Photo bahut badi hai' });
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const file = rand(32, '0123456789abcdef') + '.' + ext;
    await fsp.writeFile(path.join(MEDIA_DIR, file), buf);
    msg = { id: rand(16, '0123456789abcdef'), from: ctx.member.slot, kind: 'image', media: '/media/' + file, ts };
  } else {
    const text = String(req.body.text ?? '').replace(/\r\n/g, '\n').trim();
    if (!text) return res.status(400).json({ error: 'Khali message nahi bhej sakte' });
    if (text.length > 4000) return res.status(400).json({ error: 'Message bahut lamba hai' });
    msg = { id: rand(16, '0123456789abcdef'), from: ctx.member.slot, kind: 'text', text, ts };
  }
  ctx.room.messages.push(msg);
  ctx.member.typingAt = 0;
  await saveDB();
  return res.json({ ok: true, id: msg.id, ts });
});

// 5. Typing Indicator
app.post('/api/typing', (req: Request, res: Response) => {
  const ctx = authRoom(req);
  if (!ctx) return res.status(401).json({ error: 'Unauthorized' });
  ctx.member.typingAt = Date.now();
  return res.json({ ok: true });
});

// 6. Mark Read
app.post('/api/read', async (req: Request, res: Response) => {
  const ctx = authRoom(req);
  if (!ctx) return res.status(401).json({ error: 'Unauthorized' });
  const t = Date.now();
  const upTo = Math.min(Number(req.body.upTo) || 0, t);
  if (upTo > ctx.member.readAt) ctx.member.readAt = upTo;
  for (const m of ctx.room.messages) {
    if (m.from !== ctx.member.slot && m.ts <= upTo && !m.seenAt) m.seenAt = t;
  }
  await saveDB();
  return res.json({ ok: true });
});

// 7. Settings (save, day, seen)
app.post('/api/settings', async (req: Request, res: Response) => {
  const ctx = authRoom(req);
  if (!ctx) return res.status(401).json({ error: 'Unauthorized' });
  const mode = req.body.mode;
  if (['save', 'day', 'seen'].includes(mode)) {
    ctx.room.mode = mode;
    await pruneOld(ctx.room);
    await saveDB();
    return res.json({ ok: true, settings: { mode } });
  }
  return res.status(400).json({ error: 'Invalid mode' });
});

// 8. Clear Chat
app.post('/api/clear', async (req: Request, res: Response) => {
  const ctx = authRoom(req);
  if (!ctx) return res.status(401).json({ error: 'Unauthorized' });
  const old = ctx.room.messages;
  ctx.room.messages = [];
  for (const m of old) {
    if (m.kind === 'image' && m.media) {
      await fsp.unlink(path.join(MEDIA_DIR, path.basename(m.media))).catch(() => {});
    }
  }
  await saveDB();
  return res.json({ ok: true });
});

// 9. WebRTC Calls
app.post('/api/call/start', async (req: Request, res: Response) => {
  const ctx = authRoom(req);
  if (!ctx) return res.status(401).json({ error: 'Unauthorized' });
  const t = Date.now();
  const kind = String(req.body.kind || '');
  if (!['video', 'voice'].includes(kind)) return res.status(400).json({ error: 'Call ka type galat hai' });
  if (ctx.room.members.length < 2) return res.status(400).json({ error: 'Partner abhi join nahi hua' });
  expireCall(ctx.room, t);
  if (ctx.room.call && ctx.room.call.status !== 'ended') return res.status(409).json({ error: 'Pehle se ek call chal rahi hai' });
  const offer = req.body.offer;
  if (!offer || offer.type !== 'offer' || typeof offer.sdp !== 'string' || offer.sdp.length > 25000) {
    return res.status(400).json({ error: 'Call shuru nahi ho paayi' });
  }
  const id = rand(16, '0123456789abcdef');
  ctx.room.call = {
    id,
    kind: kind as 'video' | 'voice',
    caller: ctx.member.slot,
    status: 'ringing',
    offer: { type: 'offer', sdp: offer.sdp },
    answer: null,
    ice: { 0: [], 1: [] },
    ts: t,
  };
  await saveDB();
  return res.json({ ok: true, id });
});

app.post('/api/call/answer', async (req: Request, res: Response) => {
  const ctx = authRoom(req);
  if (!ctx) return res.status(401).json({ error: 'Unauthorized' });
  const c = ctx.room.call;
  expireCall(ctx.room, Date.now());
  if (!c || c.id !== req.body.id || c.status !== 'ringing' || c.caller === ctx.member.slot) {
    return res.status(409).json({ error: 'Call ab nahi uth sakti' });
  }
  const a = req.body.answer;
  if (!a || a.type !== 'answer' || typeof a.sdp !== 'string') {
    return res.status(400).json({ error: 'Call uthane me dikkat hui' });
  }
  c.answer = { type: 'answer', sdp: a.sdp };
  c.status = 'active';
  c.startedAt = Date.now();
  await saveDB();
  return res.json({ ok: true });
});

app.post('/api/call/ice', (req: Request, res: Response) => {
  const ctx = authRoom(req);
  if (!ctx) return res.status(401).json({ error: 'Unauthorized' });
  const c = ctx.room.call;
  if (!c || c.id !== req.body.id || c.status === 'ended') return res.json({ ok: false });
  const cand = req.body.candidate;
  if (cand && typeof cand.candidate === 'string' && cand.candidate.length < 1000) {
    const list = c.ice[ctx.member.slot];
    if (list.length < 80) list.push(cand);
  }
  return res.json({ ok: true });
});

app.post('/api/call/end', async (req: Request, res: Response) => {
  const ctx = authRoom(req);
  if (!ctx) return res.status(401).json({ error: 'Unauthorized' });
  const c = ctx.room.call;
  if (!c || c.id !== req.body.id || c.status === 'ended') return res.json({ ok: true });
  let reason = req.body.reason || 'hangup';
  if (c.status === 'ringing' && c.caller !== ctx.member.slot && reason === 'hangup') reason = 'declined';
  if (c.status === 'ringing' && c.caller === ctx.member.slot && reason === 'hangup') reason = 'cancelled';
  c.status = 'ended';
  c.endReason = reason;
  c.endedAt = Date.now();
  await saveDB();
  return res.json({ ok: true, reason });
});

// 10. Web Push Public Key
app.get('/api/push/key', (_req: Request, res: Response) => {
  return res.json({ publicKey: vapid.publicKey });
});

// --- GITHUB REPOSITORY AUTOMATION ENDPOINTS ---

// Check local Git status and remotes
app.get('/api/github/status', async (_req: Request, res: Response) => {
  try {
    let branch = 'main';
    try {
      const { stdout } = await exec('git branch --show-current');
      branch = stdout.trim() || 'main';
    } catch {}

    let lastCommit = '';
    let commitCount = 0;
    try {
      const { stdout } = await exec('git log -1 --format="%h - %s (%cr)"');
      lastCommit = stdout.trim();
      const countRes = await exec('git rev-list --count HEAD');
      commitCount = parseInt(countRes.stdout.trim()) || 0;
    } catch {}

    let remoteUrl = '';
    try {
      const { stdout } = await exec('git remote get-url origin');
      remoteUrl = stdout.trim();
    } catch {}

    const { stdout: statusOutput } = await exec('git status --short');
    const isClean = statusOutput.trim().length === 0;

    return res.json({
      initialized: true,
      branch,
      commitCount,
      lastCommit,
      remoteUrl,
      isClean,
      changedFiles: statusOutput.split('\n').filter(Boolean),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Stage and Commit changes locally
app.post('/api/github/commit', async (req: Request, res: Response) => {
  try {
    const msg = String(req.body.message || 'Update project files').trim();
    await exec('git add -A');
    try {
      await exec(`git commit -m "${msg.replace(/"/g, '\\"')}"`);
    } catch (e: any) {
      if (!e.stdout?.includes('nothing to commit')) throw e;
    }
    const { stdout: lastCommit } = await exec('git log -1 --format="%h - %s"');
    return res.json({ success: true, message: lastCommit.trim() });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Create repository on GitHub via GitHub REST API and push
app.post('/api/github/create-and-push', async (req: Request, res: Response) => {
  const token = String(req.body.token || '').trim();
  const repoName = String(req.body.repoName || 'hum-dono-couple-chat').trim().replace(/[^a-zA-Z0-9._-]/g, '-');
  const isPrivate = Boolean(req.body.isPrivate);
  const description = String(req.body.description || 'Hum Dono — Private Couple Chat & WebRTC Suite').trim();

  if (!token) {
    return res.status(400).json({ error: 'GitHub Personal Access Token is required' });
  }

  try {
    // 1. Verify token with GitHub
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'HumDono-GitHub-Pusher',
      },
    });

    if (!userRes.ok) {
      const errData = await userRes.json().catch(() => ({}));
      return res.status(401).json({
        error: `Invalid GitHub token (${userRes.status}): ${errData.message || 'Could not authenticate with GitHub'}`,
      });
    }

    const userData = await userRes.json();
    const username = userData.login;

    // 2. Create the GitHub repository (or check if it exists)
    let repoUrl = `https://github.com/${username}/${repoName}`;
    const createRes = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'HumDono-GitHub-Pusher',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: repoName,
        private: isPrivate,
        description,
        auto_init: false,
      }),
    });

    if (createRes.status === 201) {
      const repoData = await createRes.json();
      repoUrl = repoData.html_url;
    } else if (createRes.status === 422) {
      // Repository already exists; we will push to it
      console.log('Repository already exists, pushing updates to it');
    } else {
      const errData = await createRes.json().catch(() => ({}));
      return res.status(createRes.status).json({
        error: `GitHub repository creation failed: ${errData.message || 'Unknown error'}`,
      });
    }

    // 3. Stage and commit all files locally
    await exec('git add -A');
    try {
      await exec('git commit -m "Initial commit: Hum Dono private couple chat & video calling app"');
    } catch {}

    // Ensure main branch
    await exec('git branch -M main');

    // 4. Set remote origin
    const authenticatedRemote = `https://${token}@github.com/${username}/${repoName}.git`;
    try {
      await exec('git remote remove origin');
    } catch {}
    await exec(`git remote add origin ${authenticatedRemote}`);

    // 5. Push to GitHub
    await exec('git push -u origin main --force');

    return res.json({
      success: true,
      repoUrl,
      username,
      repoName,
      message: `Successfully created and pushed repository to ${repoUrl}!`,
    });
  } catch (err: any) {
    console.error('Git push error:', err);
    return res.status(500).json({ error: err.message || 'Failed to push to GitHub' });
  }
});

// Download full repository as a .zip archive
app.get('/api/github/download-zip', async (_req: Request, res: Response) => {
  try {
    // Stage and commit any pending files to ensure clean archive
    await exec('git add -A');
    try {
      await exec('git commit -m "Auto snapshot before archive download"');
    } catch {}

    const zipFile = path.join(os.tmpdir(), `repo-${Date.now()}.zip`);
    await exec(`git archive --format=zip HEAD -o "${zipFile}"`);

    res.download(zipFile, 'hum-dono-couple-chat.zip', async () => {
      await fsp.unlink(zipFile).catch(() => {});
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- GEMINI AI NEURAL INSIGHT FOR PATTERN MATRIX ---
app.post('/api/ai/pattern-insight', async (req: Request, res: Response) => {
  const history = Array.isArray(req.body.history) ? req.body.history.slice(-20) : [];
  const historyStr = history.join(',');

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      const ai = new GoogleGenAI();
      const prompt = `You are an expert game algorithm pattern analyst for Wingo / Big-Small color lottery.
Given this sequence of recent Big/Small results (oldest to newest): [${historyStr}].
Analyze trends (Zig-Zag B-S-B-S, Pairing B-B-S-S, Staircase, Fatigue/Anti-Dragon reversal, Violet pivot 0/5 impact).
Output exactly ONE short, punchy strategy advice sentence in Latin Hindi (Hinglish).
Example: "Pattern Zig-Zag se break ho raha hai, sambhal kar khele." or "Dragon fatigue detected, Small ke reversal par nazar rakhe."
Do not include quotation marks or extra explanation. Just the 1 sentence.`;

      const aiResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });

      const text = aiResponse.text?.trim();
      if (text) return res.json({ insight: text });
    }
  } catch (e) {
    console.warn('Gemini API call failed, falling back to local heuristic:', e);
  }

  // Smart Heuristic Fallback
  let advice = 'History accumulate ho rahi hai, low stakes se shuru karein.';
  const len = history.length;
  if (len >= 4) {
    const last4 = history.slice(-4).join('');
    if (last4 === 'BBBB' || last4 === 'SSSS') {
      advice = 'Dragon trend fatigue detect hui hai! Agle round mein reversal (Anti-Dragon) ke chances badh gaye hain.';
    } else if (last4 === 'BSBS' || last4 === 'SBSP') {
      advice = 'Strong Zig-Zag pattern chal raha hai, trap se bachne ke liye 1 round wait karein.';
    } else if (last4 === 'BBSS' || last4 === 'SSBB') {
      advice = 'Double pairing cycle active hai, pattern follow karein par budget strictly control rakhein.';
    } else {
      advice = 'Pattern transition phase mein hai, Martingale 3X level 1 par safe play karein.';
    }
  }

  return res.json({ insight: advice });
});

// --- MOUNT VITE MIDDLEWARES IN DEV ---
const isProduction = process.env.NODE_ENV === 'production';
if (!isProduction) {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
} else {
  const distDir = path.resolve('dist');
  app.use(express.static(distDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Hum Dono server running on http://0.0.0.0:${PORT}`);
});
