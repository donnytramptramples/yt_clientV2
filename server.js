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
import https from 'https';

// ─── Configuration & Anti-Bot Setup ─────────────────────────────────────────

let FFMPEG;
try { FFMPEG = execSync('which ffmpeg').toString().trim(); } catch { FFMPEG = 'ffmpeg'; }

let YTDLP = (() => {
  try { return execSync('which yt-dlp').toString().trim(); } catch {}
  const homeBin = `${os.homedir()}/bin/yt-dlp`;
  return homeBin;
})();

// Proxy configuration for Render (CRITICAL for datacenter IPs)
const PROXY_URL = process.env.PROXY_URL || null;
const USE_PROXY = !!PROXY_URL;

// Visitor data from environment (helps with bot detection)
const VISITOR_DATA = process.env.YOUTUBE_VISITOR_DATA || null;

// Advanced user agent rotation
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.0.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.0.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.0.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.0.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.0.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.0.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.0.36',
];

const getRandomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// Request delay jitter
const getJitteredDelay = (baseMs = 500) => {
  const jitter = Math.random() * 300;
  return Math.floor(baseMs + jitter);
};

// ─── yt-dlp Setup ────────────────────────────────────────────────────────────

async function ensureYtDlp() {
  if (fs.existsSync(YTDLP)) {
    try {
      const ver = execSync(`${YTDLP} --version`).toString().trim();
      console.log(`[ytdlp] Current version: ${ver}`);
      return;
    } catch {}
  }

  const dir = path.dirname(YTDLP);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  
  console.log('[ytdlp] Downloading latest version...');
  
  const downloadUrls = [
    'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux',
    'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
  ];

  for (const url of downloadUrls) {
    try {
      await new Promise((resolve, reject) => {
        const proc = spawn('curl', [
          '-sL', '--retry', '3', '--connect-timeout', '10',
          '-H', `User-Agent: ${getRandomUA()}`,
          url, '-o', YTDLP,
        ]);
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`curl exited ${code}`)));
        proc.on('error', reject);
      });
      
      fs.chmodSync(YTDLP, 0o755);
      const ver = execSync(`${YTDLP} --version`).toString().trim();
      console.log(`[ytdlp] ${ver} ready`);
      return;
    } catch (e) {
      console.warn(`[ytdlp] Failed to download from ${url}: ${e.message}`);
    }
  }
  
  throw new Error('Failed to download yt-dlp');
}

await ensureYtDlp();

Log.setLevel(Log.Level.ERROR);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

const MAX_CONCURRENT_STREAMS = 2; // Very conservative for datacenter IPs
let activeStreams = 0;

// ─── Caching ─────────────────────────────────────────────────────────────────

const ytdlpCache = new Map();
const YTDLP_TTL = 8 * 60 * 1000; // 8 minutes only
const infoCache = new Map();
const CACHE_TTL = 20 * 60 * 1000;

// ─── YouTube.js Setup with Enhanced Anti-Detection ─────────────────────────

Platform.shim.eval = (data, _env) => {
  return new Function(data.output)();
};

const _nativeFetch = Platform.shim.fetch ?? fetch;
Platform.shim.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  
  // Clean headers
  if (init?.headers && typeof init.headers === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(init.headers)) {
      if (!k.toLowerCase().includes('x-youtube-client-name') && 
          !k.toLowerCase().includes('x-youtube-client-version')) {
        clean[k] = v;
      }
    }
    init = { ...init, headers: clean };
  }

  await new Promise(r => setTimeout(r, getJitteredDelay(100)));

  // Proxy support
  if (USE_PROXY && url.startsWith('http')) {
    try {
      const proxyAgent = new https.Agent({
        rejectUnauthorized: false,
        keepAlive: true,
        maxSockets: 3
      });
      init = { ...init, agent: proxyAgent };
    } catch (e) {
      console.warn('[fetch] Proxy setup failed:', e.message);
    }
  }

  return _nativeFetch(input, init);
};

let youtube;
let refreshTimer = null;

async function initYouTube() {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }

  try {
    // Use TV_EMBEDDED - most reliable for bypassing bot detection
    youtube = await Innertube.create({
      client_type: ClientType.TV_EMBEDDED,
      generate_session_locally: true,
      cache: new UniversalCache(false),
      enable_session_cache: true,
      retrieve_player: true,
    });

    // Set visitor data if available
    if (VISITOR_DATA) {
      try {
        youtube.session.context.client.visitorData = VISITOR_DATA;
        console.log('[youtube] Visitor data set');
      } catch (e) {
        console.warn('[youtube] Could not set visitor data:', e.message);
      }
    }

    infoCache.clear();
    console.log('>>> [SUCCESS] YouTube API Initialised (TV_EMBEDDED)');
    refreshTimer = setTimeout(initYouTube, 10 * 60 * 1000); // Refresh every 10 min
  } catch (e) {
    console.error('>>> [ERROR] Init Failed:', e.message);
    setTimeout(initYouTube, 5000);
  }
}

await initYouTube();

// ─── SQLite Databases ───────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

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

// ─── Auth helpers ───────────────────────────────────────────────────────────

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

// ─── Express setup ─────────────────────────────────────────────────────────

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

// ─── Enhanced yt-dlp with Multiple Client Fallbacks ───────────────────────────

// Client priority based on bot detection resistance
const CLIENT_PRIORITY = [
  { client: 'tv_embedded', poToken: false },      // No PO token needed
  { client: 'android_vr', poToken: false },       // No PO token needed  
  { client: 'web_safari', poToken: true },        // Needs PO token but less flagged
  { client: 'mweb', poToken: true },              // Mobile web, less scrutiny
  { client: 'android', poToken: false },          // Android client
  { client: 'ios', poToken: false },              // iOS client
];

function spawnYtDlp(args, options = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      'HTTP_USER_AGENT': getRandomUA(),
    };

    if (USE_PROXY) {
      env['HTTP_PROXY'] = PROXY_URL;
      env['HTTPS_PROXY'] = PROXY_URL;
    }

    const proc = spawn(YTDLP, args, {
      env,
      timeout: options.timeout || 45000,
    });

    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    proc.on('close', code => {
      if (code !== 0) {
        const error = new Error(`yt-dlp exited ${code}: ${stderr.substring(0, 500)}`);
        error.stderr = stderr;
        error.stdout = stdout;
        error.isBotError = stderr.includes('bot') || stderr.includes('Sign in') || stderr.includes('403');
        return reject(error);
      }
      resolve({ stdout, stderr });
    });

    proc.on('error', reject);
  });
}

async function getYtDlpFormatsWithBypass(videoId) {
  const cached = ytdlpCache.get(videoId);
  if (cached && Date.now() - cached.ts < YTDLP_TTL) return cached;

  let lastError = null;
  
  for (let i = 0; i < CLIENT_PRIORITY.length; i++) {
    const { client } = CLIENT_PRIORITY[i];
    
    // Exponential backoff between attempts
    if (i > 0) {
      await new Promise(r => setTimeout(r, 800 * Math.pow(1.5, i - 1)));
    }

    try {
      console.log(`[ytdlp] Trying client ${client} (${i + 1}/${CLIENT_PRIORITY.length})`);
      
      const args = [
        '--no-playlist', '--quiet', '--no-warnings',
        '--extractor-args', `youtube:player_client=${client}`,
        '--add-headers', 'Origin:https://www.youtube.com',
        '--add-headers', 'Referer:https://www.youtube.com/',
        '--socket-timeout', '25',
        '--retries', '2',
        '--fragment-retries', '2',
        '-j', `https://www.youtube.com/watch?v=${videoId}`,
      ];

      const { stdout } = await spawnYtDlp(args, { timeout: 35000 });
      const raw = JSON.parse(stdout);
      
      if (!raw.formats || raw.formats.length === 0) {
        throw new Error('No formats returned');
      }

      // Check for bot detection in response
      if (raw.playability_status?.status === 'LOGIN_REQUIRED' || 
          raw.playability_status?.reason?.includes('bot')) {
        throw new Error('Bot detection in playability_status');
      }

      const formats = raw.formats.filter(f => f.url);
      if (formats.length === 0) {
        throw new Error('No formats with URLs');
      }

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
          if (subs?.length) subtitles[lang] = subs.map(s => ({ url: s.url, name: s.name, ext: s.ext }));
        }
      }

      const automaticCaptions = {};
      if (raw.automatic_captions) {
        for (const [lang, subs] of Object.entries(raw.automatic_captions)) {
          if (subs?.length) automaticCaptions[lang] = subs.map(s => ({ url: s.url, name: s.name, ext: s.ext }));
        }
      }

      const result = { 
        formats, 
        meta, 
        subtitles, 
        automaticCaptions, 
        clientUsed: client,
        ts: Date.now() 
      };
      
      ytdlpCache.set(videoId, result);
      console.log(`[ytdlp] Success with ${client}: ${formats.length} formats`);
      return result;

    } catch (e) {
      lastError = e;
      
      if (e.isBotError || e.message?.includes('bot') || e.message?.includes('Sign in')) {
        console.log(`[ytdlp] Bot detection with ${client}, trying next...`);
        continue;
      }
      
      // For non-bot errors, don't retry
      if (!e.message?.includes('formats') && !e.message?.includes('bot')) {
        throw e;
      }
    }
  }

  throw lastError || new Error('All clients failed - likely bot detection');
}

// ─── Format Selection Helpers ───────────────────────────────────────────────

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

// ─── Auth Endpoints ─────────────────────────────────────────────────────────

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

// ─── Subscription Endpoints ─────────────────────────────────────────────────

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

// ─── Search using YouTube.js (more reliable for search) ─────────────────────

const searchContinuations = new Map();

app.get('/api/search', async (req, res) => {
  try {
    if (!youtube) return res.status(503).json({ error: 'API Initialising...' });
    const { q } = req.query;
    if (!q) return res.json({ videos: [], searchId: null });

    await new Promise(r => setTimeout(r, getJitteredDelay(200)));

    const results = await youtube.search(q, { type: 'video' });
    const searchId = crypto.randomBytes(8).toString('hex');
    searchContinuations.set(searchId, results);
    setTimeout(() => searchContinuations.delete(searchId), 20 * 60 * 1000);

    const videos = mapSearchResults(results.videos || []);
    const hasMore = !!results.has_continuation;
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
    if (!prev) return res.status(404).json({ error: 'Search session expired' });

    await new Promise(r => setTimeout(r, getJitteredDelay(300)));

    let next;
    try {
      next = await prev.getContinuation();
    } catch (e) {
      return res.status(404).json({ error: 'No more results', hasMore: false, videos: [] });
    }

    searchContinuations.set(searchId, next);
    const videos = mapSearchResults(next.videos || []);
    const hasMore = !!next.has_continuation;
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
    duration: v.duration?.text || '',
    views: v.view_count?.text || '',
    channel: v.author?.name || 'Channel',
    channelId: v.author?.id || '',
    channelAvatar: v.author?.thumbnails?.[0]?.url || '',
  }));
}

// ─── Channel Search & Videos ────────────────────────────────────────────────

app.get('/api/channel/search', async (req, res) => {
  try {
    if (!youtube) return res.status(503).json({ error: 'API Initialising...' });
    const { q } = req.query;
    if (!q) return res.json({ channels: [] });

    await new Promise(r => setTimeout(r, getJitteredDelay(150)));

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

const channelCache = new Map();
const CHANNEL_TTL = 5 * 60 * 1000;

async function fetchChannelVideos(channelId, limit = 30) {
  const cacheKey = `ch:${channelId}`;
  const cached = channelCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CHANNEL_TTL) return cached;

  const urls = [
    `https://www.youtube.com/channel/${channelId}/videos`,
    `https://www.youtube.com/@${channelId}/videos`,
    `https://www.youtube.com/c/${channelId}/videos`,
  ];

  let entries = [];
  let channelMeta = {};

  for (const url of urls) {
    try {
      await new Promise(r => setTimeout(r, getJitteredDelay(400)));
      
      const args = [
        '--flat-playlist', '--no-warnings', '--quiet',
        '--extractor-args', 'youtube:player_client=tv_embedded',
        '--playlist-items', `1-${limit}`,
        '-J', url,
      ];

      const { stdout } = await spawnYtDlp(args, { timeout: 25000 });
      const raw = JSON.parse(stdout);

      entries = raw.entries || [];
      channelMeta = {
        name: raw.uploader || raw.channel || raw.title || '',
        avatar: raw.thumbnails?.[0]?.url || raw.channel_thumbnail || '',
        description: raw.description || '',
        subscribers: raw.channel_follower_count ? String(raw.channel_follower_count) : '',
        id: raw.uploader_id || raw.channel_id || channelId,
      };
      break;
    } catch (e) {
      console.warn(`[channel] failed with ${url}: ${e.message}`);
      if (e.isBotError) await new Promise(r => setTimeout(r, 2000));
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

app.get('/api/channel/:channelId/videos', async (req, res) => {
  try {
    const { channelId } = req.params;
    const { sort = 'newest' } = req.query;

    const data = await fetchChannelVideos(channelId, 40);
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

// ─── Feed ───────────────────────────────────────────────────────────────────

app.get('/api/feed', requireAuth, async (req, res) => {
  try {
    const subs = subsDb.prepare('SELECT * FROM subscriptions WHERE user_id = ?').all(req.user.id);
    if (!subs.length) return res.json({ videos: [] });

    const channelResults = await Promise.allSettled(
      subs.slice(0, 10).map(sub => fetchChannelVideos(sub.channel_id, 12))
    );

    const allVideos = [];
    for (let i = 0; i < channelResults.length; i++) {
      const result = channelResults[i];
      if (result.status !== 'fulfilled') continue;
      const sub = subs[i];
      for (const v of result.value.videos.slice(0, 8)) {
        const recency = getFeedRecencyScore(v.published);
        const popularity = getFeedPopularityScore(v.views);
        const channelBoost = (subs.length - i) / subs.length * 0.1;
        const random = Math.random() * 0.05;
        const score = recency * 0.65 + popularity * 0.2 + channelBoost + random;
        allVideos.push({ ...v, channel: sub.channel_name, channelId: sub.channel_id, channelAvatar: sub.channel_avatar || '', _score: score });
      }
    }

    allVideos.sort((a, b) => b._score - a._score);

    const seen = new Set();
    const deduped = allVideos.filter(v => { if (seen.has(v.id)) return false; seen.add(v.id); return true; });

    const videos = deduped.map(({ _score, ...v }) => v);
    res.json({ videos });
  } catch (e) {
    console.error('[feed] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

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
  const year = d.substring(0, 4);
  const month = d.substring(4, 6);
  const day = d.substring(6, 8);
  return `${year}-${month}-${day}`;
}

// ─── Video Info & Formats ───────────────────────────────────────────────────

app.get('/api/info/:videoId', async (req, res) => {
  const { videoId } = req.params;

  try {
    const data = await getYtDlpFormatsWithBypass(videoId);
    res.json({ 
      duration: data.meta?.duration || 0, 
      title: data.meta?.title || '',
      description: data.meta?.description || '',
      client: data.clientUsed
    });
  } catch (e) {
    console.error('[info] error:', e.message);
    res.status(502).json({
      error: 'Could not fetch video info',
      details: e.message,
      fallback: { type: 'youtube-embed', url: `https://www.youtube.com/embed/${videoId}` },
    });
  }
});

app.get('/api/formats/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    const data = await getYtDlpFormatsWithBypass(videoId);
    const heights = ytDlpAvailableHeights(data.formats);
    res.json({ availableHeights: heights, client: data.clientUsed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Video Details ────────────────────────────────────────────────────────────

app.get('/api/video/:videoId/details', async (req, res) => {
  const { videoId } = req.params;
  let description = '';
  let comments = [];

  try {
    const data = await getYtDlpFormatsWithBypass(videoId);
    description = data.meta?.description || '';
  } catch (e) {
    console.warn('[details] Failed to get info:', e.message);
  }

  res.json({ description, comments: [] }); // Comments disabled to reduce bot risk
});

// ─── Subtitles ──────────────────────────────────────────────────────────────

app.get('/api/subtitles/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { lang = 'en', auto = 'false' } = req.query;

  try {
    const data = await getYtDlpFormatsWithBypass(videoId);
    const subtitleSource = auto === 'true' ? data.automaticCaptions : data.subtitles;

    if (!subtitleSource || !subtitleSource[lang]) {
      return res.status(404).json({ error: 'Subtitles not available' });
    }

    const subs = subtitleSource[lang];
    const vttSub = subs.find(s => s.ext === 'vtt') || subs[0];

    if (!vttSub?.url) return res.status(404).json({ error: 'No subtitle URL' });

    const resp = await fetch(vttSub.url, { 
      headers: { 'user-agent': getRandomUA() },
      signal: AbortSignal.timeout(8000)
    });
    
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
    const data = await getYtDlpFormatsWithBypass(videoId);
    const availableSubs = [];

    if (data.subtitles) {
      for (const [lang, subs] of Object.entries(data.subtitles)) {
        if (subs?.length) availableSubs.push({ lang, name: subs[0].name || lang, auto: false });
      }
    }

    if (data.automaticCaptions) {
      for (const [lang, subs] of Object.entries(data.automatic_captions)) {
        if (subs?.length && !availableSubs.find(s => s.lang === lang)) {
          availableSubs.push({ lang, name: subs[0].name || lang, auto: true });
        }
      }
    }

    res.json({ subtitles: availableSubs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Proxy/Stream Endpoint (PRIMARY: YouTube.js, FALLBACK: yt-dlp) ───────────

app.get('/api/proxy/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { quality = '720', t = '0' } = req.query;
  const seekSeconds = Math.max(0, parseFloat(t) || 0);

  console.log(`[proxy] ${videoId} q=${quality}`);

  if (activeStreams >= MAX_CONCURRENT_STREAMS) {
    return res.status(503).json({ error: 'Server busy, max concurrent streams reached' });
  }

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    activeStreams++;

    // STRATEGY 1: Try YouTube.js first (handles PO tokens internally via TV_EMBEDDED)
    try {
      console.log('[proxy] Trying YouTube.js streaming...');
      await streamViaYouTubeJs(videoId, parseInt(quality), seekSeconds, res, controller);
      return;
    } catch (ytjsError) {
      console.warn('[proxy] YouTube.js failed:', ytjsError.message);
      if (controller.signal.aborted) throw ytjsError;
    }

    // STRATEGY 2: Fallback to yt-dlp with client rotation
    console.log('[proxy] Falling back to yt-dlp...');
    await streamViaYtdlp(videoId, parseInt(quality), seekSeconds, res, controller);

  } catch (e) {
    activeStreams = Math.max(0, activeStreams - 1);
    
    if (controller.signal.aborted) return;
    
    console.error(`[proxy] Error: ${e.message}`);
    
    if (!res.headersSent) {
      res.status(502).json({
        error: e.message, 
        videoId,
        fallback: { type: 'youtube-embed', url: `https://www.youtube.com/embed/${videoId}` },
      });
    }
  } finally {
    activeStreams = Math.max(0, activeStreams - 1);
  }
});

// YouTube.js streaming (most reliable for bypass)
async function streamViaYouTubeJs(videoId, quality, seekSeconds, res, controller) {
  if (!youtube) throw new Error('YouTube API not initialized');

  const info = await youtube.getInfo(videoId);
  if (!info) throw new Error('No video info returned');

  const formats = info.streaming_data?.formats || [];
  const adaptiveFormats = info.streaming_data?.adaptive_formats || [];
  const allFormats = [...formats, ...adaptiveFormats];

  // Find best format
  const videoFormats = allFormats.filter(f => f.has_video);
  const targetFormat = videoFormats.sort((a, b) => 
    Math.abs((a.height || 0) - quality) - Math.abs((b.height || 0) - quality)
  )[0];

  if (!targetFormat) throw new Error('No suitable format found');

  // Decipher URL
  const url = await targetFormat.decipher(youtube.session.player);
  if (!url) throw new Error('Could not decipher URL');

  // Check if combined or separate
  if (targetFormat.has_audio) {
    // Combined stream
    const fetchHeaders = {
      'accept': '*/*',
      'origin': 'https://www.youtube.com',
      'referer': 'https://www.youtube.com',
      'user-agent': getRandomUA(),
    };

    const resp = await fetch(url, {
      headers: fetchHeaders,
      signal: controller.signal,
    });

    if (!resp.ok) throw new Error(`Upstream: ${resp.status}`);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    await pipeline(Readable.fromWeb(resp.body), res);
  } else {
    // Need audio - use ffmpeg to mux
    const audioFormats = allFormats.filter(f => f.has_audio && !f.has_video);
    const audioFormat = audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    
    if (!audioFormat) throw new Error('No audio format found');

    const audioUrl = await audioFormat.decipher(youtube.session.player);
    
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    await muxStreams(url, audioUrl, res, controller.signal, seekSeconds);
  }
}

// yt-dlp streaming fallback
async function streamViaYtdlp(videoId, quality, seekSeconds, res, controller) {
  const data = await getYtDlpFormatsWithBypass(videoId);
  const { formats: ytFmts } = data;

  const videoFmt = pickYtDlpVideo(ytFmts, quality);

  if (videoFmt.acodec !== 'none') {
    // Combined stream
    const fetchHeaders = {
      'accept': '*/*',
      'origin': 'https://www.youtube.com',
      'referer': 'https://www.youtube.com',
      'user-agent': getRandomUA(),
    };

    const resp = await fetch(videoFmt.url, {
      headers: fetchHeaders,
      signal: controller.signal,
    });

    if (!resp.ok) throw new Error(`Upstream: ${resp.status}`);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    await pipeline(Readable.fromWeb(resp.body), res);
  } else {
    // Separate audio/video
    const audioFmt = pickYtDlpAudio(ytFmts);
    
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    await muxStreams(videoFmt.url, audioFmt.url, res, controller.signal, seekSeconds);
  }
}

// FFmpeg muxing helper
function muxStreams(videoUrl, audioUrl, res, signal, seekSeconds = 0) {
  return new Promise((resolve, reject) => {
    const ssArgs = seekSeconds > 0 ? ['-ss', seekSeconds.toFixed(3)] : [];
    const args = [
      '-loglevel', 'error',
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      ...ssArgs,
      '-reconnect', '1',
      '-reconnect_on_network_error', '1',
      '-reconnect_delay_max', '5',
      '-i', videoUrl,
      ...ssArgs,
      '-reconnect', '1',
      '-reconnect_on_network_error', '1',
      '-reconnect_delay_max', '5',
      '-i', audioUrl,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof+faststart',
      '-f', 'mp4', 'pipe:1',
    ];

    const proc = spawn(FFMPEG, args);
    
    if (signal) {
      signal.addEventListener('abort', () => {
        try { proc.kill('SIGTERM'); } catch {}
      }, { once: true });
    }

    proc.stderr.on('data', d => {
      const msg = d.toString().trim();
      if (msg) console.error('[ffmpeg]', msg);
    });

    proc.stdout.pipe(res);
    proc.stdout.on('error', () => {});
    
    proc.on('close', code => {
      if (code === 0 || code === null || res.writableEnded) resolve();
      else reject(new Error(`ffmpeg exited ${code}`));
    });
    
    proc.on('error', reject);
  });
}

// ─── Download Endpoint ────────────────────────────────────────────────────────

app.get('/api/download/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { format = 'mp4', quality = '720', title: titleParam } = req.query;

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const qualityNum = parseInt(quality, 10);
    const data = await getYtDlpFormatsWithBypass(videoId);
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
        const resp = await fetch(videoFmt.url, {
          headers: {
            'accept': '*/*',
            'origin': 'https://www.youtube.com',
            'referer': 'https://www.youtube.com',
            'user-agent': getRandomUA(),
          },
          signal: controller.signal,
        });
        
        if (!resp.ok) throw new Error(`Upstream: ${resp.status}`);
        
        if (resp.headers.get('content-length')) {
          res.setHeader('Content-Length', resp.headers.get('content-length'));
        }
        
        await pipeline(Readable.fromWeb(resp.body), res);
      } else {
        await muxStreams(videoFmt.url, audioFmt.url, res, controller.signal, 0);
      }
    } else {
      // Audio-only
      const audioFmt = pickYtDlpAudio(ytFmts);
      if (!audioFmt) return res.status(404).json({ error: 'No audio format available' });

      const ffmpegCodec = {
        mp3: ['libmp3lame', 'mp3'],
        flac: ['flac', 'flac'],
        opus: ['copy', 'opus'],
        ogg: ['libvorbis', 'ogg'],
        m4a: ['copy', 'm4a'],
      }[format] || ['copy', 'm4a'];

      const [codec, ext] = ffmpegCodec;
      res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.${ext}"`);
      res.setHeader('Content-Type', ext === 'mp3' ? 'audio/mpeg' : `audio/${ext}`);
      res.setHeader('Access-Control-Allow-Origin', '*');

      if (codec === 'copy' && audioFmt.ext === ext) {
        const resp = await fetch(audioFmt.url, {
          headers: {
            'accept': '*/*',
            'origin': 'https://www.youtube.com',
            'referer': 'https://www.youtube.com',
            'user-agent': getRandomUA(),
          },
          signal: controller.signal,
        });
        
        if (!resp.ok) throw new Error(`Upstream: ${resp.status}`);
        
        if (resp.headers.get('content-length')) {
          res.setHeader('Content-Length', resp.headers.get('content-length'));
        }
        
        await pipeline(Readable.fromWeb(resp.body), res);
      } else {
        await new Promise((resolve, reject) => {
          const args = [
            '-loglevel', 'error',
            '-reconnect', '1',
            '-reconnect_on_network_error', '1',
            '-i', audioFmt.url,
            '-c:a', codec,
          ];
          
          if (codec !== 'copy') args.push('-b:a', '192k');
          args.push('-f', ext, 'pipe:1');

          const proc = spawn(FFMPEG, args);
          
          controller.signal.addEventListener('abort', () => {
            try { proc.kill('SIGTERM'); } catch {}
          }, { once: true });
          
          proc.stderr.on('data', d => console.error('[ffmpeg]', d.toString().trim()));
          proc.stdout.pipe(res);
          proc.stdout.on('error', () => {});
          
          proc.on('close', c => {
            if (c === 0 || res.writableEnded) resolve();
            else reject(new Error(`ffmpeg exit ${c}`));
          });
          
          proc.on('error', reject);
        });
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error('[download] error:', error.message);
      if (!res.headersSent) res.status(502).json({ error: error.message });
    }
  }
});

// ─── Health Check ───────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    youtube: !!youtube,
    proxy: USE_PROXY,
    activeStreams,
    maxStreams: MAX_CONCURRENT_STREAMS,
  });
});

// ─── Cleanup & Shutdown ────────────────────────────────────────────────────

function cleanup() {
  console.log('[shutdown] Cleaning up...');
  if (refreshTimer) clearTimeout(refreshTimer);
  authDb.close();
  subsDb.close();
  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// ─── SPA Fallback ───────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// ─── Server Start ─────────────────────────────────────────────────────────────

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`[config] Proxy: ${USE_PROXY ? 'enabled' : 'disabled'}`);
  console.log(`[config] Visitor Data: ${VISITOR_DATA ? 'set' : 'not set'}`);
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.on('message', () => ws.send(JSON.stringify({ progress: 100 })));
});

console.log('Server staged with anti-bot protection');
