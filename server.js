import express from 'express';
import { Innertube, UniversalCache, Platform, Log, ClientType } from 'youtubei.js';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { spawn, execSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { HttpsProxyAgent } from 'https-proxy-agent';

let FFMPEG;
try {
  FFMPEG = execSync('which ffmpeg').toString().trim();
} catch {
  try {
    const { default: ffmpegStatic } = await import('ffmpeg-static');
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
      FFMPEG = ffmpegStatic;
      console.log('[setup] Using bundled ffmpeg-static:', FFMPEG);
    } else {
      FFMPEG = 'ffmpeg';
    }
  } catch {
    FFMPEG = 'ffmpeg';
  }
}

let YTDLP = (() => {
  try { return execSync('which yt-dlp').toString().trim(); } catch {}
  const homeBin = `${os.homedir()}/bin/yt-dlp`;
  return homeBin;
})();

async function ensureYtDlp() {
  if (fs.existsSync(YTDLP)) return;
  const dir = path.dirname(YTDLP);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  console.log('[setup] yt-dlp not found — downloading...');
  await new Promise((resolve, reject) => {
    const proc = spawn('curl', [
      '-sL', '--retry', '3',
      'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux',
      '-o', YTDLP,
    ]);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`curl exited ${code}`));
      try {
        fs.chmodSync(YTDLP, 0o755);
        const ver = execSync(`${YTDLP} --version`).toString().trim();
        console.log(`[setup] yt-dlp ${ver} ready`);
        resolve();
      } catch (e) { reject(e); }
    });
    proc.on('error', reject);
  });
}

await ensureYtDlp();

const ytdlpCache = new Map();
const YTDLP_TTL = 15 * 60 * 1000;

Log.setLevel(Log.Level.ERROR);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

const MAX_CONCURRENT_STREAMS = 5;
let activeStreams = 0;

const USER_AGENTS = [
  'Mozilla/5.0 (Linux; Android 13; SM-A135F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

const getRandomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// ─── FREE RESIDENTIAL PROXY ROTATION ─────────────────────────────────────────

const FREE_PROXY_SOURCES = [
  'https://api.proxyscrape.com/v2/?request=get&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
];

let proxyPool = [];
let lastProxyFetch = 0;
const PROXY_REFRESH_INTERVAL = 5 * 60 * 1000;

async function fetchFreeProxies() {
  const now = Date.now();
  if (now - lastProxyFetch < PROXY_REFRESH_INTERVAL && proxyPool.length > 0) {
    return proxyPool;
  }

  const newProxies = [];
  
  for (const url of FREE_PROXY_SOURCES) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      
      if (!resp.ok) continue;
      
      const text = await resp.text();
      const lines = text.split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        const match = line.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)$/);
        if (match) {
          newProxies.push(`http://${match[1]}:${match[2]}`);
        }
      }
    } catch (e) {
      console.warn(`[proxy] Failed to fetch from ${url}: ${e.message}`);
    }
  }

  if (newProxies.length > 0) {
    proxyPool = [...new Set([...newProxies, ...proxyPool])].slice(0, 100);
    lastProxyFetch = now;
    console.log(`[proxy] Refreshed pool: ${proxyPool.length} proxies`);
  }

  return proxyPool;
}

function getRandomProxy() {
  if (proxyPool.length === 0) return null;
  return proxyPool[Math.floor(Math.random() * proxyPool.length)];
}

fetchFreeProxies().catch(() => {});
setInterval(() => fetchFreeProxies().catch(() => {}), PROXY_REFRESH_INTERVAL);

// ─── DISABLED: AUTOMATIC PO TOKEN GENERATION (YouTube API changed) ───────────
// The WAA API now returns 400 errors. PO tokens must be obtained manually
// or through other means. Disabling this feature for now.

const poTokenCache = new Map();
const PO_TOKEN_TTL = 25 * 60 * 1000;

// Skip BotGuard - it's broken as of 2024
async function generatePOToken(identifier, isVideoId = false) {
  // Return null to disable PO token generation
  // You can manually set PO_TOKEN env var instead
  return process.env.PO_TOKEN || null;
}

// Generate visitor data if not provided
function generateVisitorData() {
  const bytes = crypto.randomBytes(16);
  return bytes.toString('base64').replace(/[+/=]/g, '').substring(0, 22);
}

// ─── FIXED: Platform Shim with proper undefined handling ─────────────────────

Platform.shim.eval = (data, _env) => {
  return new Function(data.output)();
};

const _nativeFetch = Platform.shim.fetch ?? fetch;

// FIX: Properly handle undefined init and headers
Platform.shim.fetch = async (input, init = {}) => {
  // Ensure init is always an object
  if (!init || typeof init !== 'object') {
    init = {};
  }
  
  const url = typeof input === 'string' ? input : input.url;
  
  // FIX: Ensure headers exists and is an object before iterating
  if (init.headers && typeof init.headers === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(init.headers)) clean[k] = v;
    init = { ...init, headers: clean };
  } else {
    // Ensure headers is at least an empty object
    init.headers = {};
  }

  // Only add YouTube headers for YouTube domains
  if (url && (url.includes('youtube.com') || url.includes('googlevideo.com'))) {
    init.headers = {
      ...init.headers,
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': '*/*',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    };
  }

  // Use proxy for YouTube API calls
  if (url && (url.includes('youtubei.googleapis.com') || url.includes('googlevideo.com'))) {
    const proxy = getRandomProxy();
    if (proxy) {
      try {
        const agent = new HttpsProxyAgent(proxy);
        const proxyInit = { ...init, agent };
        return await _nativeFetch(input, proxyInit);
      } catch (e) {
        console.warn('[fetch] Proxy failed, falling back to direct:', e.message);
      }
    }
  }

  return _nativeFetch(input, init);
};

let youtube;
let refreshTimer = null;

const infoCache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

const trendingCache = { data: null, ts: 0 };
const TRENDING_TTL = 30 * 60 * 1000;

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const COOKIES_PATH = path.join(DATA_DIR, 'cookies.txt');
const YOUTUBE_COOKIES_B64 = process.env.YOUTUBE_COOKIES || '';

if (YOUTUBE_COOKIES_B64) {
  try {
    fs.writeFileSync(COOKIES_PATH, Buffer.from(YOUTUBE_COOKIES_B64, 'base64').toString('utf8'));
    console.log('[setup] YouTube cookies written to', COOKIES_PATH);
  } catch (e) {
    console.warn('[setup] Failed to write cookies:', e.message);
  }
}

function hasCookies() {
  return fs.existsSync(COOKIES_PATH) && fs.statSync(COOKIES_PATH).size > 0;
}

// ─── FIXED: YouTube Initialization ───────────────────────────────────────────

async function initYouTube() {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }

  try {
    // FIX: Use WEB client type instead of TV_EMBEDDED (which is broken)
    // Also remove problematic options that cause "includes" error
    const options = {
      client_type: ClientType.WEB,  // Changed from TV_EMBEDDED
      generate_session_locally: true,
      cache: new UniversalCache(false),
      enable_session_cache: false,
    };

    // Only add visitor_data if explicitly provided
    const visitorData = process.env.YOUTUBE_VISITOR_DATA;
    if (visitorData) {
      options.visitor_data = visitorData;
      console.log('[youtubei.js] Using visitor_data:', visitorData.substring(0, 10) + '...');
    }

    // FIX: Wrap in try-catch with better error handling
    try {
      youtube = await Innertube.create(options);
      console.log('>>> [SUCCESS] YouTube API Initialised (WEB client)');
    } catch (createError) {
      console.error('>>> [ERROR] Innertube.create failed:', createError.message);
      
      // Try with minimal options as fallback
      console.log('[youtubei.js] Retrying with minimal options...');
      youtube = await Innertube.create({
        client_type: ClientType.WEB,
        generate_session_locally: true,
      });
      console.log('>>> [SUCCESS] YouTube API Initialised (fallback)');
    }

    // Validate youtube object
    if (!youtube || typeof youtube !== 'object') {
      throw new Error('Innertube.create returned invalid object');
    }

    // Ensure session exists
    if (!youtube.session) {
      console.warn('[youtubei.js] Warning: session not initialized');
      youtube.session = {
        player: null,
        http: {
          fetch_function: fetch
        }
      };
    }

    infoCache.clear();
    console.log(`>>> [BYPASS] Cookies: ${hasCookies()}, PO Token: ${process.env.PO_TOKEN ? 'Yes' : 'No'}, Proxies: ${proxyPool.length}`);
    
    // Refresh every 25 minutes
    refreshTimer = setTimeout(initYouTube, 25 * 60 * 1000);
  } catch (e) {
    console.error('>>> [ERROR] Init Failed:', e.message);
    console.error(e.stack);
    
    // Ensure youtube is at least a valid object to prevent further crashes
    if (!youtube) {
      youtube = {
        session: {
          player: null,
          http: { fetch_function: fetch }
        },
        getInfo: async () => { throw new Error('YouTube API not initialized'); },
        search: async () => { throw new Error('YouTube API not initialized'); },
        getTrending: async () => { throw new Error('YouTube API not initialized'); }
      };
    }
    
    // Retry in 10 seconds
    setTimeout(initYouTube, 10000);
  }
}

await initYouTube();

// ─── SQLite Databases ────────────────────────────────────────────────────────

const authDb = new Database(path.join(DATA_DIR, 'auth.db'));
authDb.pragma('journal_mode = WAL');
authDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

const subsDb = new Database(path.join(DATA_DIR, 'subscriptions.db'));
subsDb.pragma('journal_mode = WAL');
subsDb.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    channel_avatar TEXT DEFAULT '',
    subscribed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, channel_id)
  );
`);

const savedDb = new Database(path.join(DATA_DIR, 'saved.db'));
savedDb.pragma('journal_mode = WAL');
savedDb.exec(`
  CREATE TABLE IF NOT EXISTS saved_videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL,
    thumbnail TEXT DEFAULT '',
    channel TEXT DEFAULT '',
    channel_id TEXT DEFAULT '',
    channel_avatar TEXT DEFAULT '',
    duration TEXT DEFAULT '',
    views TEXT DEFAULT '',
    saved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, video_id)
  );
`);

// ─── Auth helpers ────────────────────────────────────────────────────────────

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  authDb.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(token, userId, expiresAt);
  return token;
}

function getSessionUser(token) {
  if (!token) return null;
  const sess = authDb.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!sess || Date.now() > sess.expires_at) {
    if (sess) authDb.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return authDb.prepare('SELECT id, username, email FROM users WHERE id = ?').get(sess.user_id);
}

function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  const user = getSessionUser(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
}

// ─── Express setup ───────────────────────────────────────────────────────────

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.use((req, res, next) => {
  const cookieHeader = req.headers.cookie || '';
  req.cookies = {};
  cookieHeader.split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=');
    if (k) req.cookies[k.trim()] = decodeURIComponent(v.join('='));
  });
  next();
});

app.use(express.static(path.join(__dirname, 'dist')));

// ─── Cache cleanup ───────────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of infoCache) {
    if (now - val.ts > CACHE_TTL) infoCache.delete(key);
  }
  // Clean expired PO tokens
  for (const [key, val] of poTokenCache) {
    if (now - val.ts > PO_TOKEN_TTL) poTokenCache.delete(key);
  }
  authDb.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
}, 30 * 60 * 1000);

// ─── Auth endpoints ──────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
    if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const hash = await bcrypt.hash(password, 10);
    const stmt = authDb.prepare('INSERT INTO users (username, email, password_hash) VALUES (?,?,?)');
    let result;
    try {
      result = stmt.run(username.trim(), email.trim().toLowerCase(), hash);
    } catch (e) {
      if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username or email already taken' });
      throw e;
    }

    const token = createSession(result.lastInsertRowid);
    res.cookie('session', token, {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
      path: '/',
    });
    res.json({ user: { id: result.lastInsertRowid, username: username.trim(), email: email.trim().toLowerCase() } });
  } catch (e) {
    console.error('[auth] register error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const user = authDb.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = createSession(user.id);
    res.cookie('session', token, {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
      path: '/',
    });
    res.json({ user: { id: user.id, username: user.username, email: user.email } });
  } catch (e) {
    console.error('[auth] login error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.session;
  if (token) authDb.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie('session', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const token = req.cookies?.session;
  const user = getSessionUser(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user });
});

// ─── Subscription endpoints ──────────────────────────────────────────────────

app.get('/api/subscriptions', requireAuth, (req, res) => {
  const subs = subsDb.prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY subscribed_at DESC').all(req.user.id);
  res.json({ subscriptions: subs });
});

app.post('/api/subscriptions', requireAuth, (req, res) => {
  const { channelId, channelName, channelAvatar } = req.body;
  if (!channelId || !channelName) return res.status(400).json({ error: 'channelId and channelName required' });
  try {
    subsDb.prepare('INSERT OR REPLACE INTO subscriptions (user_id, channel_id, channel_name, channel_avatar) VALUES (?,?,?,?)').run(req.user.id, channelId, channelName, channelAvatar || '');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/subscriptions/:channelId', requireAuth, (req, res) => {
  subsDb.prepare('DELETE FROM subscriptions WHERE user_id = ? AND channel_id = ?').run(req.user.id, req.params.channelId);
  res.json({ ok: true });
});

app.get('/api/subscriptions/:channelId/status', requireAuth, (req, res) => {
  const row = subsDb.prepare('SELECT 1 FROM subscriptions WHERE user_id = ? AND channel_id = ?').get(req.user.id, req.params.channelId);
  res.json({ subscribed: !!row });
});

app.post('/api/subscriptions/:channelId', requireAuth, (req, res) => {
  const { channelId } = req.params;
  const { channelName, channelAvatar } = req.body;
  if (!channelName) return res.status(400).json({ error: 'channelName required' });
  try {
    subsDb.prepare('INSERT OR REPLACE INTO subscriptions (user_id, channel_id, channel_name, channel_avatar) VALUES (?,?,?,?)').run(req.user.id, channelId, channelName, channelAvatar || '');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Saved videos endpoints ──────────────────────────────────────────────────

app.get('/api/saved', requireAuth, (req, res) => {
  const videos = savedDb.prepare('SELECT * FROM saved_videos WHERE user_id = ? ORDER BY saved_at DESC').all(req.user.id);
  res.json({ videos: videos.map(v => ({
    id: v.video_id,
    title: v.title,
    thumbnail: v.thumbnail,
    channel: v.channel,
    channelId: v.channel_id,
    channelAvatar: v.channel_avatar,
    duration: v.duration,
    views: v.views,
    savedAt: v.saved_at,
  })) });
});

app.post('/api/saved/:videoId', requireAuth, (req, res) => {
  const { videoId } = req.params;
  const { title, thumbnail, channel, channelId, channelAvatar, duration, views } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    savedDb.prepare(`
      INSERT OR REPLACE INTO saved_videos (user_id, video_id, title, thumbnail, channel, channel_id, channel_avatar, duration, views)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(req.user.id, videoId, title, thumbnail || '', channel || '', channelId || '', channelAvatar || '', duration || '', views || '');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/saved/:videoId', requireAuth, (req, res) => {
  savedDb.prepare('DELETE FROM saved_videos WHERE user_id = ? AND video_id = ?').run(req.user.id, req.params.videoId);
  res.json({ ok: true });
});

app.get('/api/saved/:videoId/status', requireAuth, (req, res) => {
  const row = savedDb.prepare('SELECT 1 FROM saved_videos WHERE user_id = ? AND video_id = ?').get(req.user.id, req.params.videoId);
  res.json({ saved: !!row });
});

// ─── YouTube helpers ─────────────────────────────────────────────────────────

async function getVideoInfo(videoId) {
  const cached = infoCache.get(videoId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.info;

  if (!youtube) throw new Error('YouTube API not initialized');
  
  if (typeof youtube.getInfo !== 'function') {
    throw new Error('YouTube API getInfo not available');
  }
  
  const info = await youtube.getInfo(videoId);
  if (!info) throw new Error('No video info returned');

  infoCache.set(videoId, { info, ts: Date.now() });
  return info;
}

function getFormatsFromInfo(info) {
  return {
    videoFormats: info.streaming_data?.formats || [],
    adaptiveFormats: info.streaming_data?.adaptive_formats || [],
    duration: info.basic_info?.duration || 0,
    title: info.basic_info?.title || 'Video',
  };
}

function selectVideoFormat(formats, targetHeight) {
  const all = [...formats.videoFormats, ...formats.adaptiveFormats].filter(f => f.has_video && f.height);
  if (all.length === 0) throw new Error('No video formats found');
  all.sort((a, b) => {
    const hDiff = Math.abs(a.height - targetHeight) - Math.abs(b.height - targetHeight);
    if (hDiff !== 0) return hDiff;
    return ((a.mime_type || '').includes('mp4') ? 0 : 1) - ((b.mime_type || '').includes('mp4') ? 0 : 1);
  });
  return all[0];
}

function selectAudioFormat(formats) {
  const all = [...formats.videoFormats, ...formats.adaptiveFormats].filter(f => f.has_audio && !f.has_video);
  if (all.length === 0) throw new Error('No audio formats found');
  all.sort((a, b) => {
    const aMp4 = (a.mime_type || '').includes('mp4') ? 0 : 1;
    const bMp4 = (b.mime_type || '').includes('mp4') ? 0 : 1;
    if (aMp4 !== bMp4) return aMp4 - bMp4;
    return (b.bitrate || 0) - (a.bitrate || 0);
  });
  return all[0];
}

function selectBestFormat(formats, qualityLimit = 720, isAudio = false) {
  if (isAudio) return selectAudioFormat(formats);
  return selectVideoFormat(formats, qualityLimit);
}

// Build yt-dlp args - simplified without broken PO token gen
async function buildYtDlpArgs(client = 'web', videoId = null, extraArgs = []) {
  const args = [];

  // Cookies
  if (hasCookies()) {
    args.push('--cookies', COOKIES_PATH);
  }

  // Use manual PO_TOKEN from env if available
  const poToken = process.env.PO_TOKEN;
  const visitorData = process.env.YOUTUBE_VISITOR_DATA || generateVisitorData();
  
  // Build extractor args
  let extractorArg = `youtube:player_client=${client}`;
  extractorArg += `;visitor_data=${visitorData}`;
  
  if (poToken) {
    extractorArg += `;po_token=${poToken}`;
    console.log(`[yt-dlp] Using PO_TOKEN from environment`);
  }

  args.push('--extractor-args', extractorArg);

  // Headers
  args.push('--add-headers', 'Origin:https://www.youtube.com');
  args.push('--add-headers', 'Referer:https://www.youtube.com/');
  args.push('--add-headers', `User-Agent:${getRandomUA()}`);

  args.push(...extraArgs);
  return args;
}

// Get proxy environment for yt-dlp
function getProxyEnv() {
  const proxy = getRandomProxy();
  const env = { ...process.env, HTTP_USER_AGENT: getRandomUA() };
  if (proxy) {
    env.HTTP_PROXY = proxy;
    env.HTTPS_PROXY = proxy;
  }
  return env;
}

// yt-dlp with retry logic
async function getYtDlpFormats(videoId, attempt = 0) {
  const cached = ytdlpCache.get(videoId);
  if (cached && Date.now() - cached.ts < YTDLP_TTL) return cached;

  // Try different clients in order
  const clients = ['web', 'android', 'ios', 'mweb', 'tv_embedded'];
  const client = clients[attempt % clients.length];

  console.log(`[ytdlp] ${videoId} attempt ${attempt + 1} client=${client} cookies=${hasCookies()} proxy=${!!getRandomProxy()}`);

  const ytdlpArgs = await buildYtDlpArgs(client, videoId);

  const raw = await new Promise((resolve, reject) => {
    const args = [
      '--no-playlist', '--quiet', '--no-warnings',
      ...ytdlpArgs,
      '-j', `https://www.youtube.com/watch?v=${videoId}`,
    ];

    const proc = spawn(YTDLP, args, {
      env: getProxyEnv()
    });

    let out = '';
    let err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`yt-dlp exited ${code}: ${err.trim().substring(0, 300)}`));
      try { resolve(JSON.parse(out)); } catch(e) { reject(new Error('Failed to parse yt-dlp JSON')); }
    });
    proc.on('error', reject);
  });

  const formats = (raw.formats || []).filter(f => f.url);
  const meta = {
    duration: raw.duration || 0,
    title: raw.fulltitle || raw.title || '',
    description: raw.description || '',
    uploader: raw.uploader || '',
    thumbnail: raw.thumbnail || '',
  };

  const subtitles = {};
  if (raw.subtitles) {
    for (const [lang, subs] of Object.entries(raw.subtitles)) {
      if (subs && subs.length > 0) subtitles[lang] = subs.map(s => ({ url: s.url, name: s.name, ext: s.ext }));
    }
  }

  const automaticCaptions = {};
  if (raw.automatic_captions) {
    for (const [lang, subs] of Object.entries(raw.automatic_captions)) {
      if (subs && subs.length > 0) automaticCaptions[lang] = subs.map(s => ({ url: s.url, name: s.name, ext: s.ext }));
    }
  }

  const result = { formats, meta, subtitles, automaticCaptions, ts: Date.now() };
  ytdlpCache.set(videoId, result);
  console.log(`[ytdlp] Got ${formats.length} formats for ${videoId}`);
  return result;
}

async function getYtDlpFormatsWithRetry(videoId) {
  const clients = ['web', 'android', 'ios', 'mweb', 'tv_embedded'];
  let lastError;
  for (let i = 0; i < clients.length; i++) {
    try {
      if (i > 0) ytdlpCache.delete(videoId);
      return await getYtDlpFormats(videoId, i);
    } catch (e) {
      lastError = e;
      const isBotError = e.message.includes('bot') || e.message.includes('Sign in') ||
        e.message.includes('403') || e.message.includes('confirm') || e.message.includes('429');
      if (!isBotError) throw e;
      console.log(`[ytdlp] Bot/rate error with client ${clients[i]}, trying next... (${e.message.substring(0, 80)})`);
      if (i < clients.length - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastError;
}

function pickYtDlpVideo(formats, targetHeight) {
  const video = formats.filter(f => f.vcodec !== 'none' && f.url);
  if (!video.length) throw new Error('No video formats from yt-dlp');
  video.sort((a, b) => {
    const hDiff = Math.abs((a.height || 0) - targetHeight) - Math.abs((b.height || 0) - targetHeight);
    if (hDiff !== 0) return hDiff;
    return ((a.vcodec || '').startsWith('avc') ? 0 : 1) - ((b.vcodec || '').startsWith('avc') ? 0 : 1);
  });
  return video[0];
}

function pickYtDlpAudio(formats) {
  const audio = formats.filter(f => f.acodec !== 'none' && f.vcodec === 'none' && f.url);
  if (!audio.length) throw new Error('No audio formats from yt-dlp');
  audio.sort((a, b) => {
    const aM4a = a.ext === 'm4a' ? 0 : 1;
    const bM4a = b.ext === 'm4a' ? 0 : 1;
    if (aM4a !== bM4a) return aM4a - bM4a;
    return (b.tbr || 0) - (a.tbr || 0);
  });
  return audio[0];
}

function ytDlpAvailableHeights(formats) {
  return [...new Set(
    formats.filter(f => f.vcodec !== 'none' && f.height).map(f => f.height)
  )].sort((a, b) => b - a);
}

async function decipherUrl(format, info) {
  if (!youtube?.session?.player) {
    throw new Error('YouTube player not initialized');
  }
  const url = await format.decipher(youtube.session.player);
  if (!url) throw new Error('Could not decipher stream URL');
  return `${url}&cpn=${info.cpn}`;
}

async function fetchFormatStream(format, info, signal, rangeHeader = null) {
  const fetchUrl = await decipherUrl(format, info);
  const headers = {
    'accept': '*/*',
    'origin': 'https://www.youtube.com',
    'referer': 'https://www.youtube.com',
    'DNT': '?1',
    'user-agent': getRandomUA(),
  };
  if (rangeHeader) headers['range'] = rangeHeader;

  const fetchFn = youtube?.session?.http?.fetch_function || fetch;
  
  const resp = await fetchFn(fetchUrl, {
    method: 'GET', headers, redirect: 'follow', signal,
  });
  if (!resp.ok) throw new Error(`Upstream fetch failed: ${resp.status}`);
  return resp;
}

function muxToResponse(videoUrl, audioUrl, res, signal, seekSeconds = 0) {
  return new Promise((resolve, reject) => {
    const ssArgs = seekSeconds > 0 ? ['-ss', seekSeconds.toFixed(3)] : [];

    const ytHeaders = [
      `User-Agent: ${getRandomUA()}`,
      'Accept: */*',
      'Accept-Language: en-US,en;q=0.9',
      'Origin: https://www.youtube.com',
      'Referer: https://www.youtube.com/',
    ].join('\r\n') + '\r\n';

    const args = [
      '-loglevel', 'error',
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      '-headers', ytHeaders,
      '-reconnect', '1',
      '-reconnect_on_network_error', '1',
      '-reconnect_delay_max', '5',
      ...ssArgs,
      '-i', videoUrl,
      '-headers', ytHeaders,
      '-reconnect', '1',
      '-reconnect_on_network_error', '1',
      '-reconnect_delay_max', '5',
      ...ssArgs,
      '-i', audioUrl,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof+faststart',
      '-f', 'mp4',
      'pipe:1',
    ];

    console.log(`[ffmpeg] Muxing with seek=${seekSeconds}s`);

    const proc = spawn(FFMPEG, args);

    if (signal) {
      signal.addEventListener('abort', () => { try { proc.kill('SIGTERM'); } catch {} }, { once: true });
    }

    let stderrData = '';
    proc.stderr.on('data', d => {
      const msg = d.toString().trim();
      if (msg) {
        stderrData += msg + '\n';
        if (msg.includes('Error') || msg.includes('error')) console.error('[ffmpeg]', msg);
      }
    });

    proc.stdout.pipe(res);
    proc.stdout.on('error', () => {});

    proc.on('close', code => {
      if (code === 0 || code === null || res.writableEnded) {
        resolve();
      } else {
        console.error(`[ffmpeg] Exit ${code}`);
        if (stderrData) console.error('[ffmpeg stderr]', stderrData.substring(0, 500));
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

// ─── Search ──────────────────────────────────────────────────────────────────

const searchContinuations = new Map();

app.get('/api/search', async (req, res) => {
  try {
    if (!youtube) return res.status(503).json({ error: 'API Initialising...' });
    const { q } = req.query;
    if (!q) return res.json({ videos: [], searchId: null });

    if (typeof youtube.search !== 'function') {
      return res.status(503).json({ error: 'Search not available' });
    }

    const results = await youtube.search(q, { type: 'video' });
    const searchId = crypto.randomBytes(8).toString('hex');
    searchContinuations.set(searchId, results);
    setTimeout(() => searchContinuations.delete(searchId), 30 * 60 * 1000);

    const videos = mapSearchResults(results.videos || []);
    const hasMore = typeof results.has_continuation === 'undefined' ? videos.length >= 10 : !!results.has_continuation;
    res.json({ videos, searchId, hasMore });
  } catch (error) {
    console.error('[search] error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/search/more', async (req, res) => {
  try {
    const { searchId } = req.query;
    if (!searchId) return res.status(400).json({ error: 'searchId required' });

    const prev = searchContinuations.get(searchId);
    if (!prev) return res.status(404).json({ error: 'Search session expired, please search again' });

    let next;
    try {
      next = await prev.getContinuation();
    } catch (e) {
      return res.status(404).json({ error: 'No more results', hasMore: false, videos: [] });
    }

    searchContinuations.set(searchId, next);
    const videos = mapSearchResults(next.videos || []);
    const hasMore = typeof next.has_continuation === 'undefined' ? videos.length >= 10 : !!next.has_continuation;
    res.json({ videos, searchId, hasMore });
  } catch (error) {
    console.error('[search/more] error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

function mapSearchResults(videos) {
  return videos.map(v => ({
    id: v.id,
    title: v.title?.text || 'Video',
    thumbnail: v.thumbnails?.[0]?.url || '',
    duration: v.duration?.text || '0:00',
    views: v.view_count?.text || '0',
    channel: v.author?.name || 'Channel',
    channelId: v.author?.id || '',
    channelAvatar: v.author?.thumbnails?.[0]?.url || '',
  }));
}

// ─── Channel search ──────────────────────────────────────────────────────────

app.get('/api/channel/search', async (req, res) => {
  try {
    if (!youtube) return res.status(503).json({ error: 'API Initialising...' });
    const { q } = req.query;
    if (!q) return res.json({ channels: [] });

    if (typeof youtube.search !== 'function') {
      return res.status(503).json({ error: 'Search not available' });
    }

    const results = await youtube.search(q, { type: 'video' });
    const seen = new Set();
    const channels = [];

    for (const v of (results.videos || [])) {
      const id = v.author?.id;
      const name = v.author?.name;
      if (id && name && !seen.has(id)) {
        seen.add(id);
        channels.push({
          id,
          name,
          avatar: v.author?.thumbnails?.[0]?.url || '',
          subscribers: '',
          description: '',
        });
      }
    }

    res.json({ channels });
  } catch (e) {
    console.error('[channel/search] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Channel videos via yt-dlp ───────────────────────────────────────────────

const channelCache = new Map();
const CHANNEL_TTL = 10 * 60 * 1000;

async function fetchChannelVideos(channelId, limit = 40) {
  const cacheKey = `ch:${channelId}:${limit}`;
  const cached = channelCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CHANNEL_TTL) return cached;

  const urls = [];
  const isUCId = /^UC[a-zA-Z0-9_\-]{10,}$/.test(channelId);
  const isHandle = channelId.startsWith('@');

  if (isUCId) {
    urls.push(`https://www.youtube.com/channel/${channelId}/videos`);
  } else if (isHandle) {
    urls.push(`https://www.youtube.com/${channelId}/videos`);
  } else {
    urls.push(`https://www.youtube.com/@${channelId}/videos`);
    urls.push(`https://www.youtube.com/c/${channelId}/videos`);
    urls.push(`https://www.youtube.com/channel/${channelId}/videos`);
  }

  let entries = [];
  let channelMeta = {};

  for (const url of urls) {
    try {
      const ytdlpArgs = await buildYtDlpArgs('web');

      const raw = await new Promise((resolve, reject) => {
        const args = [
          '--flat-playlist', '--no-warnings', '--quiet',
          ...ytdlpArgs,
          '--playlist-items', `1-${limit}`,
          '-J', url,
        ];
        const proc = spawn(YTDLP, args, {
          env: getProxyEnv()
        });
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
          reject(new Error('yt-dlp timeout'));
        }, 45000);
        proc.stdout.on('data', d => { out += d; });
        proc.stderr.on('data', d => { err += d; });
        proc.on('close', code => {
          clearTimeout(timer);
          if (code !== 0) return reject(new Error(`yt-dlp exit ${code}: ${err.substring(0, 200)}`));
          try { resolve(JSON.parse(out)); } catch { reject(new Error('JSON parse failed')); }
        });
        proc.on('error', e => { clearTimeout(timer); reject(e); });
      });

      entries = raw.entries || [];
      channelMeta = {
        name: raw.uploader || raw.channel || raw.title || '',
        avatar: raw.thumbnails?.[0]?.url || raw.channel_thumbnail || '',
        description: raw.description || '',
        subscribers: raw.channel_follower_count
          ? formatViewCount(raw.channel_follower_count).replace(' views', '')
          : '',
        id: raw.uploader_id || raw.channel_id || channelId,
      };
      if (entries.length > 0) break;
      console.warn(`[channel] ${url} returned 0 entries, trying next...`);
    } catch (e) {
      console.warn(`[channel] failed with ${url}: ${e.message}`);
    }
  }

  const videos = entries.map(v => ({
    id: v.id,
    title: v.title || 'Video',
    thumbnail: v.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
    duration: v.duration ? formatSecondsToTime(v.duration) : '',
    views: v.view_count ? formatViewCount(v.view_count) : '',
    published: v.upload_date ? formatUploadDate(v.upload_date) : '',
    channel: channelMeta.name || channelId,
    channelId,
    channelAvatar: channelMeta.avatar || '',
  })).filter(v => v.id);

  const result = { videos, channel: channelMeta, ts: Date.now() };
  channelCache.set(cacheKey, result);
  return result;
}

function formatSecondsToTime(secs) {
  const s = Math.floor(secs || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function formatViewCount(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B views`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M views`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K views`;
  return `${n} views`;
}

function formatUploadDate(d) {
  if (!d || d.length < 8) return '';
  return `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}`;
}

app.get('/api/channel/:channelId/videos', async (req, res) => {
  try {
    const { channelId } = req.params;
    const { sort = 'newest' } = req.query;

    const data = await fetchChannelVideos(channelId, 60);
    let videos = [...data.videos];

    if (sort === 'oldest') videos = videos.reverse();
    else if (sort === 'popular') {
      videos = videos.sort((a, b) => {
        const aV = parseInt((a.views || '0').replace(/[^\d]/g, '')) || 0;
        const bV = parseInt((b.views || '0').replace(/[^\d]/g, '')) || 0;
        return bV - aV;
      });
    }

    res.json({ videos, channel: data.channel });
  } catch (e) {
    console.error('[channel/videos] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Feed ────────────────────────────────────────────────────────────────────

function getFeedRecencyScore(published) {
  if (!published) return 0;
  const p = String(published);
  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) {
    const daysAgo = (Date.now() - new Date(p).getTime()) / (1000 * 86400);
    return Math.max(0, 1 - daysAgo / 90);
  }
  const lower = p.toLowerCase();
  if (lower.includes('hour') || lower.includes('minute') || lower.includes('second')) return 1.0;
  if (lower.includes('day')) { const d = parseInt(lower) || 1; return Math.max(0, 1 - d / 90); }
  if (lower.includes('week')) { const w = parseInt(lower) || 1; return Math.max(0, 1 - (w * 7) / 90); }
  if (lower.includes('month')) { const m = parseInt(lower) || 1; return Math.max(0, 1 - (m * 30) / 365); }
  if (lower.includes('year')) return 0.01;
  return 0;
}

function getFeedPopularityScore(views) {
  if (!views) return 0;
  const n = parseInt(String(views).replace(/[^\d]/g, '')) || 0;
  if (!n) return 0;
  return Math.min(1, Math.log10(n + 1) / 7);
}

app.get('/api/feed', requireAuth, async (req, res) => {
  try {
    const subs = subsDb.prepare('SELECT * FROM subscriptions WHERE user_id = ?').all(req.user.id);
    const allVideos = [];

    if (subs.length > 0) {
      const channelResults = await Promise.allSettled(
        subs.slice(0, 12).map(sub => fetchChannelVideos(sub.channel_id, 15))
      );
      for (let i = 0; i < channelResults.length; i++) {
        const result = channelResults[i];
        if (result.status !== 'fulfilled') continue;
        const sub = subs[i];
        for (const v of result.value.videos.slice(0, 10)) {
          const recency = getFeedRecencyScore(v.published);
          const popularity = getFeedPopularityScore(v.views);
          const channelBoost = (subs.length - i) / Math.max(subs.length, 1) * 0.1;
          const random = Math.random() * 0.05;
          const score = 0.4 + recency * 0.65 + popularity * 0.2 + channelBoost + random;
          allVideos.push({ ...v, channel: v.channel || sub.channel_name, channelId: v.channelId || sub.channel_id, channelAvatar: v.channelAvatar || sub.channel_avatar || '', _score: score, _src: 'subscription' });
        }
      }
    }

    let trendingVideos = [];
    try {
      if (trendingCache.data && Date.now() - trendingCache.ts < TRENDING_TTL) {
        trendingVideos = trendingCache.data.videos || [];
      } else {
        const raw = await fetchTrendingYtDlp();
        trendingVideos = raw;
      }
    } catch (e) {
      console.warn('[feed] trending fetch failed:', e.message);
    }

    const subChannelIds = new Set(subs.map(s => s.channel_id));
    for (const v of trendingVideos) {
      const popularity = getFeedPopularityScore(v.views);
      const recency = getFeedRecencyScore(v.published);
      const isSub = subChannelIds.has(v.channelId);
      const random = Math.random() * 0.08;
      const score = (isSub ? 0.3 : 0.05) + recency * 0.4 + popularity * 0.35 + random;
      allVideos.push({ ...v, _score: score, _src: 'trending' });
    }

    const seen = new Map();
    for (const v of allVideos) {
      if (!seen.has(v.id) || seen.get(v.id)._score < v._score) seen.set(v.id, v);
    }

    const videos = [...seen.values()]
      .sort((a, b) => b._score - a._score)
      .slice(0, 60)
      .map(({ _score, _src, ...v }) => v);

    res.json({ videos });
  } catch (e) {
    console.error('[feed] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Video info / formats / subtitles ────────────────────────────────────────

app.get('/api/info/:videoId', async (req, res) => {
  const { videoId } = req.params;

  let duration = 0, title = '';

  try {
    const info = await getVideoInfo(videoId);
    duration = info.basic_info?.duration || 0;
    title = info.basic_info?.title || '';
  } catch {}

  if (!duration || !title) {
    try {
      const data = await getYtDlpFormatsWithRetry(videoId);
      if (!duration && data.meta?.duration) duration = data.meta.duration;
      if (!title && data.meta?.title) title = data.meta.title;
    } catch {}
  }

  if (!duration && !title) {
    return res.status(502).json({
      error: 'Could not fetch video info',
      fallback: { type: 'youtube-embed', url: `https://www.youtube.com/embed/${videoId}` },
    });
  }

  res.json({ duration, title, source: 'combined' });
});

app.get('/api/formats/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    const data = await getYtDlpFormatsWithRetry(videoId);
    const heights = ytDlpAvailableHeights(data.formats);
    res.json({ availableHeights: heights });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Video details ───────────────────────────────────────────────────────────

app.get('/api/video/:videoId/details', async (req, res) => {
  const { videoId } = req.params;
  let description = '';
  let comments = [];

  try {
    const data = await getYtDlpFormatsWithRetry(videoId);
    description = data.meta?.description || '';
  } catch {}

  if (!description) {
    try {
      const info = await getVideoInfo(videoId);
      description = info.basic_info?.short_description || '';
    } catch {}
  }

  try {
    const ytdlpArgs = await buildYtDlpArgs('web', videoId);
    const commentData = await new Promise((resolve) => {
      const args = [
        '--no-playlist', '--skip-download', '--write-comments', '--quiet', '--no-warnings',
        '--extractor-args', 'youtube:comment_sort=top;max_comments=30,all,top,0',
        ...ytdlpArgs,
        '-j', `https://www.youtube.com/watch?v=${videoId}`,
      ];
      const proc = spawn(YTDLP, args, {
        env: getProxyEnv()
      });
      let out = '';
      proc.stdout.on('data', d => { out += d; });
      proc.stderr.on('data', () => {});
      const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve(null); }, 20000);
      proc.on('close', () => { clearTimeout(timer); try { resolve(JSON.parse(out)); } catch { resolve(null); } });
      proc.on('error', () => { clearTimeout(timer); resolve(null); });
    });

    if (commentData?.comments?.length) {
      comments = commentData.comments
        .filter(c => c.parent === 'root' && c.text)
        .slice(0, 30)
        .map(c => ({
          id: c.id || Math.random().toString(36),
          author: c.author || 'User',
          authorAvatar: c.author_thumbnail || '',
          text: c.text || '',
          likes: c.like_count ?? 0,
          published: c.timestamp ? new Date(c.timestamp * 1000).toLocaleDateString() : '',
        }));
    }
  } catch (e) {
    console.warn('[details] comments fetch failed:', e.message);
  }

  res.json({ description, comments });
});

// ─── Subtitles ───────────────────────────────────────────────────────────────

app.get('/api/subtitles/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { lang = 'en', auto = 'false' } = req.query;

  try {
    const data = await getYtDlpFormatsWithRetry(videoId);
    const subtitleSource = auto === 'true' ? data.automaticCaptions : data.subtitles;

    if (!subtitleSource || !subtitleSource[lang]) {
      return res.status(404).json({ error: 'Subtitles not available for this language' });
    }

    const subs = subtitleSource[lang];
    const vttSub = subs.find(s => s.ext === 'vtt') || subs.find(s => s.ext === 'srt') || subs[0];

    if (!vttSub || !vttSub.url) return res.status(404).json({ error: 'No subtitle URL found' });

    const resp = await fetch(vttSub.url, { headers: { 'user-agent': getRandomUA() } });
    if (!resp.ok) return res.status(502).json({ error: 'Failed to fetch subtitles' });

    const content = await resp.text();
    res.setHeader('Content-Type', 'text/vtt');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(content);
  } catch (e) {
    console.error('[subtitles] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/subtitles/:videoId/list', async (req, res) => {
  const { videoId } = req.params;
  try {
    const data = await getYtDlpFormatsWithRetry(videoId);
    const availableSubs = [];

    if (data.subtitles) {
      for (const [lang, subs] of Object.entries(data.subtitles)) {
        if (subs && subs.length > 0) availableSubs.push({ lang, name: subs[0].name || lang, auto: false });
      }
    }

    if (data.automaticCaptions) {
      for (const [lang, subs] of Object.entries(data.automaticCaptions)) {
        if (subs && subs.length > 0) {
          const existing = availableSubs.find(s => s.lang === lang);
          if (existing) existing.hasAuto = true;
          else availableSubs.push({ lang, name: subs[0].name || lang, auto: true });
        }
      }
    }

    res.json({ subtitles: availableSubs });
  } catch (e) {
    console.error('[subtitles list] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Proxy (streaming) ───────────────────────────────────────────────────────

app.get('/api/proxy/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { quality = '720', t = '0', start } = req.query;

  const seekSeconds = Math.max(0, parseFloat(start || t) || 0);

  console.log(`[proxy] ${videoId} q=${quality} seek=${seekSeconds}s`);

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const qualityNum = parseInt(quality, 10);
    const data = await getYtDlpFormatsWithRetry(videoId);
    const { formats: ytFmts } = data;

    const videoFmt = pickYtDlpVideo(ytFmts, qualityNum);

    if (videoFmt.acodec !== 'none') {
      const fetchHeaders = {
        'accept': '*/*',
        'origin': 'https://www.youtube.com',
        'referer': 'https://www.youtube.com',
        'user-agent': getRandomUA()
      };

      const resp = await fetch(videoFmt.url, {
        headers: fetchHeaders,
        signal: controller.signal
      });

      if (!resp.ok) throw new Error(`Upstream: ${resp.status}`);

      res.status(200);
      res.setHeader('Content-Type', videoFmt.ext === 'webm' ? 'video/webm' : 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Access-Control-Allow-Origin', '*');

      await pipeline(Readable.fromWeb(resp.body), res);
    } else {
      const audioFmt = pickYtDlpAudio(ytFmts);

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'none');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache');

      await muxToResponse(videoFmt.url, audioFmt.url, res, controller.signal, seekSeconds);
    }
  } catch (e) {
    if (controller.signal.aborted) return;
    console.error(`[proxy] Error: ${e.message}`);
    if (!res.headersSent) {
      res.status(502).json({
        error: e.message,
        videoId,
        fallback: { type: 'youtube-embed', url: `https://www.youtube.com/embed/${videoId}` },
      });
    }
  }
});

// ─── Stream ──────────────────────────────────────────────────────────────────

app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { quality = '720', audioOnly = 'false' } = req.query;

  if (activeStreams >= MAX_CONCURRENT_STREAMS) {
    return res.status(503).json({ error: 'Server busy, please try again' });
  }

  activeStreams++;
  const cleanup = () => { activeStreams = Math.max(0, activeStreams - 1); };

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const info = await getVideoInfo(videoId);
    const formats = getFormatsFromInfo(info);
    const qualityNum = parseInt(quality, 10);

    const format = audioOnly === 'true'
      ? selectBestFormat(formats, 999, true)
      : selectBestFormat(formats, qualityNum, false);

    const resp = await fetchFormatStream(format, info, controller.signal);
    res.setHeader('Content-Type', format.mime_type || 'video/mp4');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    await pipeline(Readable.fromWeb(resp.body), res);
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error('[stream] error:', error.message);
      if (!res.headersSent) res.status(502).json({ error: error.message });
    }
  } finally {
    cleanup();
  }
});

// ─── Download ────────────────────────────────────────────────────────────────

function spawnFfmpegAudio(audioUrl, codec, ffmpegFormat, extraArgs, signal) {
  return new Promise((resolve) => {
    const ytHeaders = [
      `User-Agent: ${getRandomUA()}`,
      'Accept: */*',
      'Accept-Language: en-US,en;q=0.9',
      'Origin: https://www.youtube.com',
      'Referer: https://www.youtube.com/',
    ].join('\r\n') + '\r\n';

    const args = [
      '-loglevel', 'warning',
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      '-headers', ytHeaders,
      '-reconnect', '1',
      '-reconnect_on_network_error', '1',
      '-reconnect_delay_max', '5',
      '-i', audioUrl,
      '-vn',
      '-c:a', codec,
      ...extraArgs,
      '-f', ffmpegFormat,
      'pipe:1',
    ];

    const proc = spawn(FFMPEG, args);

    if (signal) {
      signal.addEventListener('abort', () => { try { proc.kill('SIGTERM'); } catch {} }, { once: true });
    }

    proc.stderr.on('data', d => {
      const m = d.toString().trim();
      if (m) console.error('[ffmpeg-audio]', m);
    });

    resolve(proc);
  });
}

app.get('/api/download/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { format = 'mp4', quality = '720', title: titleParam, bitrate, compression } = req.query;

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const qualityNum = parseInt(quality, 10);
    const data = await getYtDlpFormatsWithRetry(videoId);
    const { formats: ytFmts, meta } = data;

    const rawTitle = meta?.title || titleParam || `video_${videoId}`;
    const safeTitle = rawTitle.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, '_').substring(0, 100) || `video_${videoId}`;

    if (format === 'mp4') {
      const videoFmt = pickYtDlpVideo(ytFmts, qualityNum);
      const audioFmt = videoFmt.acodec === 'none' ? pickYtDlpAudio(ytFmts) : null;

      res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.mp4"`);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Access-Control-Allow-Origin', '*');

      if (videoFmt.acodec !== 'none') {
        const ytHeaders = {
          'accept': '*/*',
          'origin': 'https://www.youtube.com',
          'referer': 'https://www.youtube.com',
          'user-agent': getRandomUA()
        };
        const resp = await fetch(videoFmt.url, { headers: ytHeaders, signal: controller.signal });
        if (!resp.ok) throw new Error(`Upstream: ${resp.status}`);
        if (resp.headers.get('content-length')) res.setHeader('Content-Length', resp.headers.get('content-length'));
        await pipeline(Readable.fromWeb(resp.body), res);
      } else {
        await muxToResponse(videoFmt.url, audioFmt.url, res, controller.signal, 0);
      }
    } else {
      const audioFmt = pickYtDlpAudio(ytFmts);
      if (!audioFmt) return res.status(404).json({ error: 'No audio format available' });

      const userBitrate = bitrate || null;
      const userCompression = compression ? parseInt(compression) : null;

      const formatConfig = {
        mp3:  { codec: 'libmp3lame', ext: 'mp3',  mime: 'audio/mpeg', fmt: 'mp3',  args: ['-b:a', userBitrate || '320k', '-ar', '44100'] },
        flac: { codec: 'flac',       ext: 'flac', mime: 'audio/flac', fmt: 'flac', args: ['-compression_level', String(userCompression ?? 5)] },
        opus: { codec: 'libopus',    ext: 'opus', mime: 'audio/ogg',  fmt: 'ogg',  args: ['-b:a', userBitrate || '160k', '-ar', '48000'] },
        ogg:  { codec: 'libvorbis',  ext: 'ogg',  mime: 'audio/ogg',  fmt: 'ogg',  args: ['-b:a', userBitrate || '192k', '-ar', '44100'] },
        m4a:  { codec: 'aac',        ext: 'm4a',  mime: 'audio/mp4',  fmt: 'mp4',  args: ['-b:a', userBitrate || '256k'] },
      }[format] || { codec: 'libmp3lame', ext: 'mp3', mime: 'audio/mpeg', fmt: 'mp3', args: ['-b:a', '320k'] };

      res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.${formatConfig.ext}"`);
      res.setHeader('Content-Type', formatConfig.mime);
      res.setHeader('Access-Control-Allow-Origin', '*');

      console.log(`[download] ${videoId} format=${format} codec=${formatConfig.codec}`);

      const proc = await spawnFfmpegAudio(audioFmt.url, formatConfig.codec, formatConfig.fmt, formatConfig.args, controller.signal);
      proc.stdout.pipe(res);
      proc.stdout.on('error', () => {});

      await new Promise((resolve, reject) => {
        proc.on('close', c => {
          if (c === 0 || c === null || res.writableEnded) resolve();
          else reject(new Error(`ffmpeg exit ${c}`));
        });
        proc.on('error', reject);
      });
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error('[download] error:', error.message);
      if (!res.headersSent) res.status(502).json({ error: error.message });
    }
  }
});

// ─── Trending ────────────────────────────────────────────────────────────────

async function fetchTrendingYtDlp() {
  const ytdlpArgs = await buildYtDlpArgs('web');
  const raw = await new Promise((resolve, reject) => {
    const args = [
      '--flat-playlist', '--no-warnings', '--quiet',
      ...ytdlpArgs,
      '--playlist-items', '1-40',
      '-J', 'https://www.youtube.com/feed/trending',
    ];
    const proc = spawn(YTDLP, args, { env: getProxyEnv() });
    let out = '';
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} reject(new Error('timeout')); }, 30000);
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', () => {});
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`exit ${code}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('parse failed')); }
    });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
  });

  return (raw.entries || []).map(v => ({
    id: v.id,
    title: v.title || 'Video',
    thumbnail: v.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
    duration: v.duration ? formatSecondsToTime(v.duration) : '',
    views: v.view_count ? formatViewCount(v.view_count) : '',
    channel: v.uploader || v.channel || '',
    channelId: v.uploader_id || v.channel_id || '',
    channelAvatar: '',
    published: v.upload_date ? formatUploadDate(v.upload_date) : '',
  })).filter(v => v.id);
}

app.get('/api/trending', async (req, res) => {
  try {
    if (trendingCache.data && Date.now() - trendingCache.ts < TRENDING_TTL) {
      return res.json(trendingCache.data);
    }

    let videos = [];

    try {
      if (youtube && typeof youtube.getTrending === 'function') {
        const results = await youtube.getTrending();
        const items = results.videos || results.items || [];
        const section = Array.isArray(items) ? items : (results.contents?.[0]?.contents || []);

        videos = section
          .filter(v => v.id && (v.title?.text || v.title))
          .slice(0, 40)
          .map(v => ({
            id: v.id,
            title: v.title?.text || v.title || 'Video',
            thumbnail: v.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
            duration: v.duration?.text || '',
            views: v.view_count?.text || v.short_view_count?.text || '',
            channel: v.author?.name || v.channel?.name || '',
            channelId: v.author?.id || v.channel?.id || '',
            channelAvatar: v.author?.thumbnails?.[0]?.url || '',
            published: v.published?.text || '',
          }));
      }
    } catch (apiErr) {
      console.warn('[trending] API failed:', apiErr.message);
    }

    if (videos.length === 0) {
      try {
        videos = await fetchTrendingYtDlp();
      } catch (e) {
        console.warn('[trending] yt-dlp fallback failed:', e.message);
      }
    }

    const result = { videos };
    trendingCache.data = result;
    trendingCache.ts = Date.now();
    res.json(result);
  } catch (e) {
    console.error('[trending] error:', e.message);
    res.status(500).json({ videos: [], error: e.message });
  }
});

// ─── Shorts ──────────────────────────────────────────────────────────────────

const shortsCache = { data: null, ts: 0 };
const SHORTS_TTL = 20 * 60 * 1000;

async function fetchActualShorts() {
  const sources = [
    'https://www.youtube.com/shorts/',
    'https://www.youtube.com/hashtag/shorts',
    'https://www.youtube.com/feed/trending',
  ];

  const ytdlpArgs = await buildYtDlpArgs('web');

  for (const src of sources) {
    try {
      const raw = await new Promise((resolve, reject) => {
        const args = [
          '--flat-playlist', '--no-warnings', '--quiet',
          ...ytdlpArgs,
          '--playlist-items', '1-60',
          '-JJ', src,
        ];
J', src,
        ];
        const proc = spawn(YTDLP, args, { env: getProxyEnv() });
        let out = '';
        const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} reject(new Error('timeout')); }, 30000);
        proc.stdout.on('data', d => { out += d; });
        proc.stderr.on('data', () => {});
        proc.on('close', code => {
          clearTimeout(timer);
          if (code !== 0) return reject(new Error(`exit ${code}`));
          try { resolve(JSON.parse(out)); } catch { reject(new Error('parse')); }
        });
        proc.on('error', e => { clearTimeout(timer); reject(e); });
      });

      const entries = (raw.entries || []).filter(v => v.id);

      const isShortsSrc = src.includes('/shorts/') || src.includes('hashtag/shorts');
      const shorts = entries
        .filter(v => {
          if (isShortsSrc) return true;
          return v.duration && v.duration <= 62;
        })
        .slice(0, 30)
        .map(v => ({
          id: v.id,
          title: v.title || 'Short',
          thumbnail: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
          duration: v.duration ? formatSecondsToTime(v.duration) : '',
          durationSecs: v.duration || 0,
          views: v.view_count ? formatViewCount(v.view_count) : '',
          channel: v.uploader || v.channel || '',
          channelId: v.uploader_id || v.channel_id || '',
          channelAvatar: '',
          isShort: true,
        }));

      if (shorts.length >= 5) {
        console.log(`[shorts] Got ${shorts.length} shorts from ${src}`);
        return shorts;
      }
    } catch (e) {
      console.warn(`[shorts] source ${src} failed:`, e.message);
    }
  }

  if (youtube) {
    try {
      if (typeof youtube.search === 'function') {
        const results = await youtube.search('#shorts', { type: 'video' });
        return (results.videos || [])
          .filter(v => v.id)
          .slice(0, 30)
          .map(v => ({
            id: v.id,
            title: v.title?.text || 'Short',
            thumbnail: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
            duration: v.duration?.text || '',
            durationSecs: 0,
            views: v.view_count?.text || '',
            channel: v.author?.name || '',
            channelId: v.author?.id || '',
            channelAvatar: v.author?.thumbnails?.[0]?.url || '',
            isShort: true,
          }));
      }
    } catch (e) {
      console.warn('[shorts] search fallback failed:', e.message);
    }
  }

  return [];
}

app.get('/api/shorts', async (req, res) => {
  try {
    if (shortsCache.data && Date.now() - shortsCache.ts < SHORTS_TTL) {
      return res.json(shortsCache.data);
    }

    const shorts = await fetchActualShorts();

    const result = { shorts };
    shortsCache.data = result;
    shortsCache.ts = Date.now();
    res.json(result);
  } catch (e) {
    console.error('[shorts] error:', e.message);
    res.status(500).json({ shorts: [], error: e.message });
  }
});

// ─── Health ──────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    youtube: !!youtube && !!youtube.session,
    activeStreams,
    cookies: hasCookies(),
    poToken: process.env.PO_TOKEN ? 'configured' : 'not configured',
    proxyPool: proxyPool.length,
    bypass: {
      cookies: hasCookies(),
      poToken: !!process.env.PO_TOKEN,
      visitorData: !!process.env.YOUTUBE_VISITOR_DATA,
      proxies: proxyPool.length > 0,
    }
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Bot bypass: cookies=${hasCookies()} po_token=${!!process.env.PO_TOKEN} visitor_data=${!!process.env.YOUTUBE_VISITOR_DATA} proxies=${proxyPool.length}`);
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.on('message', () => ‌‍
