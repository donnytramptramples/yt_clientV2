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
import { SocksProxyAgent } from 'socks-proxy-agent';

// ─── FFMPEG SETUP ───────────────────────────────────────────────────────────

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

// ─── YT-DLP SETUP ─────────────────────────────────────────────────────────────

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

// ─── CACHE & CONFIG ─────────────────────────────────────────────────────────

const ytdlpCache = new Map();
const YTDLP_TTL = 10 * 60 * 1000;
const infoCache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

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

// ─── PROXY SYSTEM ───────────────────────────────────────────────────────────

class ProxyManager {
  constructor() {
    this.proxies = [];
    this.workingProxies = new Map(); // proxy -> { successCount, failCount, lastUsed }
    this.lastFetch = 0;
    this.fetchInterval = 5 * 60 * 1000; // 5 minutes
    this.testInterval = 2 * 60 * 1000; // 2 minutes
    this.currentIndex = 0;
    this.stickyProxy = null; // Use same proxy for sequential requests
    this.stickyExpiry = 0;
    
    // Only reliable sources
    this.sources = [
      {
        name: 'proxyscrape',
        url: 'https://api.proxyscrape.com/v2/?request=get&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
        parser: 'plain'
      },
      {
        name: 'github-http',
        url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
        parser: 'plain'
      }
    ];
    
    this.startMaintenance();
  }

  async startMaintenance() {
    await this.fetchAllProxies();
    setInterval(() => this.fetchAllProxies(), this.fetchInterval);
    setInterval(() => this.testProxies(), this.testInterval);
  }

  async fetchAllProxies() {
    const now = Date.now();
    if (now - this.lastFetch < this.fetchInterval && this.proxies.length > 0) return;
    
    console.log('[proxy] Fetching fresh proxy lists...');
    const allProxies = [];
    
    const fetchPromises = this.sources.map(source => this.fetchFromSource(source));
    const results = await Promise.allSettled(fetchPromises);
    
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value.length > 0) {
        console.log(`[proxy] ${this.sources[index].name}: ${result.value.length} proxies`);
        allProxies.push(...result.value);
      }
    });
    
    const uniqueProxies = [...new Set(allProxies)].filter(this.isValidProxy);
    
    if (uniqueProxies.length > 0) {
      this.proxies = uniqueProxies;
      this.lastFetch = now;
      console.log(`[proxy] Total unique proxies: ${this.proxies.length}`);
    }
  }

  async fetchFromSource(source) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      
      const resp = await fetch(source.url, { 
        signal: controller.signal,
        headers: { 'User-Agent': getRandomUA() }
      });
      clearTimeout(timeout);
      
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      
      const text = await resp.text();
      return this.parseProxies(text, source.parser);
    } catch (e) {
      return [];
    }
  }

  parseProxies(text, parser) {
    const proxies = [];
    if (parser === 'plain') {
      text.split('\n').forEach(line => {
        const match = line.trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)$/);
        if (match) proxies.push(`http://${match[1]}:${match[2]}`);
      });
    }
    return proxies;
  }

  isValidProxy(proxy) {
    if (!proxy || typeof proxy !== 'string') return false;
    return /^http:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/.test(proxy);
  }

  async testProxies() {
    // Test a small batch of untested or recently failed proxies
    const candidates = this.proxies
      .filter(p => {
        const stats = this.workingProxies.get(p);
        if (!stats) return true; // Never tested
        return stats.failCount > 0 && stats.failCount < 3; // Failed but not dead
      })
      .slice(0, 10);
    
    if (candidates.length === 0) return;
    
    console.log(`[proxy] Testing ${candidates.length} candidates...`);
    await Promise.all(candidates.map(p => this.testProxy(p)));
  }

  async testProxy(proxy) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      
      const agent = new HttpsProxyAgent(proxy);
      
      // Test against YouTube API directly, not just Google
      const resp = await fetch('https://www.youtube.com/iframe_api', {
        agent,
        signal: controller.signal,
        headers: { 'User-Agent': getRandomUA() }
      });
      
      clearTimeout(timeout);
      
      if (resp.status === 200) {
        const stats = this.workingProxies.get(proxy) || { successCount: 0, failCount: 0 };
        stats.successCount++;
        stats.lastUsed = Date.now();
        this.workingProxies.set(proxy, stats);
        return true;
      }
      throw new Error('Bad status');
    } catch {
      const stats = this.workingProxies.get(proxy) || { successCount: 0, failCount: 0 };
      stats.failCount++;
      this.workingProxies.set(proxy, stats);
      return false;
    }
  }

  getProxy() {
    const now = Date.now();
    
    // Use sticky proxy for 30 seconds to avoid connection churn
    if (this.stickyProxy && now < this.stickyExpiry) {
      const stats = this.workingProxies.get(this.stickyProxy);
      if (stats && stats.failCount < 3) {
        return this.stickyProxy;
      }
    }
    
    // Get working proxies sorted by success rate
    const working = [...this.workingProxies.entries()]
      .filter(([proxy, stats]) => stats.successCount > 0 && stats.failCount < 3)
      .sort((a, b) => (b[1].successCount / (b[1].successCount + b[1].failCount)) - 
                      (a[1].successCount / (a[1].successCount + a[1].failCount)))
      .map(([proxy]) => proxy);
    
    if (working.length > 0) {
      // Rotate through top 10 working proxies
      const proxy = working[this.currentIndex % Math.min(working.length, 10)];
      this.currentIndex++;
      this.stickyProxy = proxy;
      this.stickyExpiry = now + 30000; // 30 second sticky
      return proxy;
    }
    
    // Fallback to any proxy if no working ones
    if (this.proxies.length > 0) {
      const proxy = this.proxies[this.currentIndex % this.proxies.length];
      this.currentIndex++;
      return proxy;
    }
    
    return null;
  }

  markFailed(proxy) {
    if (!proxy) return;
    const stats = this.workingProxies.get(proxy) || { successCount: 0, failCount: 0 };
    stats.failCount++;
    this.workingProxies.set(proxy, stats);
    if (this.stickyProxy === proxy) {
      this.stickyProxy = null;
      this.stickyExpiry = 0;
    }
  }

  getStats() {
    const working = [...this.workingProxies.entries()].filter(([_, s]) => s.successCount > 0 && s.failCount < 3);
    return {
      total: this.proxies.length,
      tested: this.workingProxies.size,
      working: working.length,
      sticky: this.stickyProxy
    };
  }
}

const proxyManager = new ProxyManager();

// ─── PO TOKEN MANAGEMENT ────────────────────────────────────────────────────

class POTokenManager {
  constructor() {
    this.tokens = new Map();
    this.visitorData = process.env.YOUTUBE_VISITOR_DATA || this.generateVisitorData();
    
    if (process.env.PO_TOKEN) {
      this.tokens.set('default', {
        token: process.env.PO_TOKEN,
        ts: Date.now(),
        source: 'env'
      });
    }
  }

  generateVisitorData() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let result = '';
    const bytes = crypto.randomBytes(22);
    for (let i = 0; i < 22; i++) {
      result += chars[bytes[i] % chars.length];
    }
    return result;
  }

  getToken(videoId = null) {
    const cached = this.tokens.get(videoId || 'default');
    if (cached && Date.now() - cached.ts < 20 * 60 * 1000) {
      return cached.token;
    }
    return this.tokens.get('default')?.token || null;
  }

  getVisitorData() {
    return this.visitorData;
  }
}

const poTokenManager = new POTokenManager();

// ─── PLATFORM SHIM ───────────────────────────────────────────────────────────

Platform.shim.eval = (data, _env) => {
  return new Function(data.output)();
};

const _nativeFetch = Platform.shim.fetch ?? fetch;

Platform.shim.fetch = async (input, init = {}) => {
  if (!init || typeof init !== 'object') init = {};
  const url = typeof input === 'string' ? input : input.url;
  
  if (init.headers && typeof init.headers === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(init.headers)) clean[k] = v;
    init.headers = clean;
  } else {
    init.headers = {};
  }

  if (url?.includes('youtube.com') || url?.includes('googlevideo.com')) {
    init.headers = {
      ...init.headers,
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': '*/*',
      'DNT': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"'
    };
  }

  return _nativeFetch(input, init);
};

// ─── YOUTUBE INITIALIZATION ───────────────────────────────────────────────────

let youtube;
let refreshTimer = null;
const trendingCache = { data: null, ts: 0 };
const TRENDING_TTL = 30 * 60 * 1000;

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const COOKIES_PATH = path.join(DATA_DIR, 'cookies.txt');
const YOUTUBE_COOKIES_B64 = process.env.YOUTUBE_COOKIES || '';

if (YOUTUBE_COOKIES_B64) {
  try {
    const decoded = Buffer.from(YOUTUBE_COOKIES_B64, 'base64').toString('utf8');
    if (decoded.includes('youtube.com') || decoded.includes('google.com')) {
      fs.writeFileSync(COOKIES_PATH, decoded);
      console.log('[setup] Cookies written');
    }
  } catch (e) {
    console.warn('[setup] Invalid cookies');
  }
}

function hasCookies() {
  return fs.existsSync(COOKIES_PATH) && fs.statSync(COOKIES_PATH).size > 0;
}

async function initYouTube() {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }

  try {
    const options = {
      client_type: ClientType.TV_EMBEDDED, // Most reliable for bypass
      generate_session_locally: true,
      cache: new UniversalCache(false),
      enable_session_cache: false,
    };

    const visitorData = poTokenManager.getVisitorData();
    if (visitorData) options.visitor_data = visitorData;

    youtube = await Innertube.create(options);
    console.log('>>> [SUCCESS] YouTube API Initialised (TV_EMBEDDED)');
    
    refreshTimer = setTimeout(initYouTube, 25 * 60 * 1000);
  } catch (e) {
    console.error('>>> [ERROR] Init Failed:', e.message);
    setTimeout(initYouTube, 10000);
  }
}

await initYouTube();

// ─── DATABASES ───────────────────────────────────────────────────────────────

const authDb = new Database(path.join(DATA_DIR, 'auth.db'));
authDb.pragma('journal_mode = WAL');
authDb.exec(`
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, email TEXT UNIQUE, password_hash TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER, expires_at INTEGER);
`);

const subsDb = new Database(path.join(DATA_DIR, 'subscriptions.db'));
subsDb.pragma('journal_mode = WAL');
subsDb.exec(`CREATE TABLE IF NOT EXISTS subscriptions (id INTEGER PRIMARY KEY, user_id INTEGER, channel_id TEXT, channel_name TEXT, channel_avatar TEXT, subscribed_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, channel_id));`);

const savedDb = new Database(path.join(DATA_DIR, 'saved.db'));
savedDb.pragma('journal_mode = WAL');
savedDb.exec(`CREATE TABLE IF NOT EXISTS saved_videos (id INTEGER PRIMARY KEY, user_id INTEGER, video_id TEXT, title TEXT, thumbnail TEXT, channel TEXT, channel_id TEXT, channel_avatar TEXT, duration TEXT, views TEXT, saved_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, video_id));`);

// ─── AUTH HELPERS ─────────────────────────────────────────────────────────────

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
  const user = getSessionUser(req.cookies?.session);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
}

// ─── EXPRESS SETUP ────────────────────────────────────────────────────────────

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

// ─── YT-DLP HELPERS ─────────────────────────────────────────────────────────

async function buildYtDlpArgs(client = 'tv_embedded', videoId = null) {
  const args = [];
  if (hasCookies()) args.push('--cookies', COOKIES_PATH);

  const poToken = poTokenManager.getToken(videoId);
  const visitorData = poTokenManager.getVisitorData();
  
  let extractorArg = `youtube:player_client=${client}`;
  extractorArg += `;visitor_data=${visitorData}`;
  if (poToken) extractorArg += `;po_token=${poToken}`;
  
  args.push('--extractor-args', extractorArg);
  args.push('--add-headers', `User-Agent:${getRandomUA()}`);
  args.push('--add-headers', 'Origin:https://www.youtube.com');
  args.push('--add-headers', 'Referer:https://www.youtube.com/');
  
  return args;
}

// CRITICAL FIX: Proper proxy handling with fallback to direct
async function spawnYtDlp(args, options = {}) {
  const proxy = proxyManager.getProxy();
  const useProxy = proxy && !options.noProxy;
  
  const spawnArgs = [...args];
  if (useProxy) {
    spawnArgs.unshift('--proxy', proxy);
  }
  
  const env = {
    ...process.env,
    HTTP_USER_AGENT: getRandomUA(),
    PYTHONUNBUFFERED: '1'
  };
  
  // Only set env vars if using proxy
  if (useProxy) {
    env.HTTP_PROXY = proxy;
    env.HTTPS_PROXY = proxy;
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP, spawnArgs, { env });
    
    let out = '';
    let err = '';
    let timeoutId;
    let killed = false;
    
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
    
    const kill = (signal = 'SIGTERM') => {
      if (killed) return;
      killed = true;
      try { proc.kill(signal); } catch {}
    };

    // CRITICAL FIX: Shorter timeout, proper cleanup
    timeoutId = setTimeout(() => {
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 3000);
    }, options.timeout || 25000); // 25s default, not 60s

    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    
    proc.on('close', code => {
      cleanup();
      if (killed && code === null) {
        reject(new Error('timeout'));
      } else if (code !== 0) {
        reject(new Error(`exit ${code}: ${err.substring(0, 200)}`));
      } else {
        try { resolve(JSON.parse(out)); } 
        catch { reject(new Error('parse failed')); }
      }
    });
    
    proc.on('error', e => {
      cleanup();
      reject(e);
    });
  });
}

async function getYtDlpFormats(videoId, client = 'tv_embedded') {
  const cached = ytdlpCache.get(videoId);
  if (cached && Date.now() - cached.ts < YTDLP_TTL) return cached;

  const ytdlpArgs = await buildYtDlpArgs(client, videoId);
  
  const raw = await spawnYtDlp([
    '--no-playlist', '--quiet', '--no-warnings',
    ...ytdlpArgs,
    '-j', `https://www.youtube.com/watch?v=${videoId}`
  ]);

  const formats = (raw.formats || []).filter(f => f.url);
  if (formats.length === 0) throw new Error('No formats found');

  const result = {
    formats,
    meta: {
      duration: raw.duration || 0,
      title: raw.fulltitle || raw.title || '',
      description: raw.description || '',
      uploader: raw.uploader || '',
      thumbnail: raw.thumbnail || ''
    },
    subtitles: raw.subtitles || {},
    automaticCaptions: raw.automatic_captions || {},
    ts: Date.now()
  };
  
  ytdlpCache.set(videoId, result);
  return result;
}

async function getYtDlpFormatsWithRetry(videoId) {
  const clients = ['tv_embedded', 'android', 'web'];
  let lastError;
  let usedProxy = true;
  
  for (let i = 0; i < clients.length; i++) {
    try {
      if (i > 0) ytdlpCache.delete(videoId);
      
      // Try without proxy on second attempt if proxy keeps failing
      const noProxy = i === 1 && !usedProxy;
      
      const result = await getYtDlpFormats(videoId, clients[i]);
      return result;
    } catch (e) {
      lastError = e;
      const msg = e.message.toLowerCase();
      
      // Mark proxy as failed if connection error
      if (msg.includes('proxy') || msg.includes('unable to connect') || msg.includes('timeout')) {
        proxyManager.markFailed(proxyManager.stickyProxy);
        usedProxy = false;
      }
      
      if (!msg.includes('bot') && !msg.includes('sign in') && !msg.includes('403') && 
          !msg.includes('429') && !msg.includes('unavailable')) {
        throw e;
      }
      
      console.log(`[ytdlp] ${clients[i]} failed: ${e.message.substring(0, 80)}`);
      if (i < clients.length - 1) await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw lastError;
}

// ─── VIDEO HELPERS ───────────────────────────────────────────────────────────

function pickYtDlpVideo(formats, targetHeight) {
  const video = formats.filter(f => f.vcodec !== 'none' && f.url);
  if (!video.length) throw new Error('No video formats');
  video.sort((a, b) => {
    const hDiff = Math.abs((a.height || 0) - targetHeight) - Math.abs((b.height || 0) - targetHeight);
    if (hDiff !== 0) return hDiff;
    return (a.vcodec || '').startsWith('avc') ? -1 : 1;
  });
  return video[0];
}

function pickYtDlpAudio(formats) {
  const audio = formats.filter(f => f.acodec !== 'none' && f.vcodec === 'none' && f.url);
  if (!audio.length) throw new Error('No audio formats');
  audio.sort((a, b) => {
    if (a.ext === 'm4a' && b.ext !== 'm4a') return -1;
    return (b.tbr || 0) - (a.tbr || 0);
  });
  return audio[0];
}

function ytDlpAvailableHeights(formats) {
  return [...new Set(formats.filter(f => f.vcodec !== 'none' && f.height).map(f => f.height))]
    .sort((a, b) => b - a);
}

// ─── STREAMING HELPERS ───────────────────────────────────────────────────────

async function muxToResponse(videoUrl, audioUrl, res, signal, seekSeconds = 0) {
  return new Promise((resolve, reject) => {
    const ssArgs = seekSeconds > 0 ? ['-ss', seekSeconds.toFixed(3)] : [];
    const ytHeaders = [
      `User-Agent: ${getRandomUA()}`,
      'Accept: */*',
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

    const proc = spawn(FFMPEG, args);
    let killed = false;

    if (signal) {
      signal.addEventListener('abort', () => {
        killed = true;
        try { proc.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
      }, { once: true });
    }

    proc.stdout.pipe(res);
    proc.on('close', code => {
      if (killed || code === 0 || code === null) resolve();
      else reject(new Error(`ffmpeg exit ${code}`));
    });
    proc.on('error', reject);
  });
}

// ─── CHANNEL HELPERS ─────────────────────────────────────────────────────────

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
  }

  let entries = [];
  let channelMeta = {};

  for (const url of urls) {
    try {
      const ytdlpArgs = await buildYtDlpArgs('tv_embedded');
      
      const raw = await spawnYtDlp([
        '--flat-playlist', '--no-warnings', '--quiet',
        ...ytdlpArgs,
        '--playlist-items', `1-${limit}`,
        '-J', url
      ], { timeout: 20000 }); // Shorter timeout for channels

      entries = raw.entries || [];
      channelMeta = {
        name: raw.uploader || raw.channel || '',
        avatar: raw.thumbnails?.[0]?.url || '',
        id: raw.uploader_id || raw.channel_id || channelId
      };
      
      if (entries.length > 0) break;
    } catch (e) {
      console.warn(`[channel] ${url}: ${e.message.substring(0, 100)}`);
      // Don't retry with same proxy if it failed
      if (e.message.includes('timeout') || e.message.includes('exit')) {
        proxyManager.markFailed(proxyManager.stickyProxy);
      }
    }
  }

  const videos = entries.map(v => ({
    id: v.id,
    title: v.title || 'Video',
    thumbnail: v.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
    duration: v.duration ? formatSecondsToTime(v.duration) : '',
    views: v.view_count ? formatViewCount(v.view_count) : '',
    channel: channelMeta.name,
    channelId,
    channelAvatar: channelMeta.avatar
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

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Auth routes
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
    
    const hash = await bcrypt.hash(password, 10);
    const result = authDb.prepare('INSERT INTO users (username, email, password_hash) VALUES (?,?,?)')
      .run(username.trim(), email.trim().toLowerCase(), hash);
    
    const token = createSession(result.lastInsertRowid);
    res.cookie('session', token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
    res.json({ user: { id: result.lastInsertRowid, username, email } });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username/email taken' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = authDb.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username.toLowerCase());
    if (!user || !await bcrypt.compare(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = createSession(user.id);
    res.cookie('session', token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
    res.json({ user: { id: user.id, username: user.username, email: user.email } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  authDb.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies?.session || '');
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = getSessionUser(req.cookies?.session);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user });
});

// Subscriptions
app.get('/api/subscriptions', requireAuth, (req, res) => {
  const subs = subsDb.prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY subscribed_at DESC').all(req.user.id);
  res.json({ subscriptions: subs });
});

app.post('/api/subscriptions', requireAuth, (req, res) => {
  const { channelId, channelName, channelAvatar } = req.body;
  subsDb.prepare('INSERT OR REPLACE INTO subscriptions (user_id, channel_id, channel_name, channel_avatar) VALUES (?,?,?,?)')
    .run(req.user.id, channelId, channelName, channelAvatar || '');
  res.json({ ok: true });
});

app.delete('/api/subscriptions/:channelId', requireAuth, (req, res) => {
  subsDb.prepare('DELETE FROM subscriptions WHERE user_id = ? AND channel_id = ?').run(req.user.id, req.params.channelId);
  res.json({ ok: true });
});

// Saved videos
app.get('/api/saved', requireAuth, (req, res) => {
  const videos = savedDb.prepare('SELECT * FROM saved_videos WHERE user_id = ? ORDER BY saved_at DESC').all(req.user.id);
  res.json({ videos: videos.map(v => ({...v, id: v.video_id, savedAt: v.saved_at})) });
});

app.post('/api/saved/:videoId', requireAuth, (req, res) => {
  const { title, thumbnail, channel, channelId, channelAvatar, duration, views } = req.body;
  savedDb.prepare(`INSERT OR REPLACE INTO saved_videos (user_id, video_id, title, thumbnail, channel, channel_id, channel_avatar, duration, views) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, req.params.videoId, title, thumbnail || '', channel || '', channelId || '', channelAvatar || '', duration || '', views || '');
  res.json({ ok: true });
});

app.delete('/api/saved/:videoId', requireAuth, (req, res) => {
  savedDb.prepare('DELETE FROM saved_videos WHERE user_id = ? AND video_id = ?').run(req.user.id, req.params.videoId);
  res.json({ ok: true });
});

// Video info
app.get('/api/info/:videoId', async (req, res) => {
  try {
    const data = await getYtDlpFormatsWithRetry(req.params.videoId);
    res.json({ duration: data.meta.duration, title: data.meta.title, source: 'yt-dlp' });
  } catch (e) {
    res.status(502).json({ error: e.message, fallback: { type: 'youtube-embed', url: `https://www.youtube.com/embed/${req.params.videoId}` } });
  }
});

app.get('/api/formats/:videoId', async (req, res) => {
  try {
    const data = await getYtDlpFormatsWithRetry(req.params.videoId);
    res.json({ availableHeights: ytDlpAvailableHeights(data.formats) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/video/:videoId/details', async (req, res) => {
  const { videoId } = req.params;
  try {
    const data = await getYtDlpFormatsWithRetry(videoId);
    res.json({ description: data.meta.description, comments: [] });
  } catch (e) {
    res.json({ description: '', comments: [] });
  }
});

// Subtitles
app.get('/api/subtitles/:videoId', async (req, res) => {
  try {
    const data = await getYtDlpFormatsWithRetry(req.params.videoId);
    const subs = data.subtitles[req.query.lang || 'en'] || data.automaticCaptions[req.query.lang || 'en'];
    if (!subs?.length) return res.status(404).json({ error: 'No subtitles' });
    
    const vttSub = subs.find(s => s.ext === 'vtt') || subs[0];
    const resp = await fetch(vttSub.url, { headers: { 'User-Agent': getRandomUA() } });
    if (!resp.ok) throw new Error('Failed to fetch');
    
    res.setHeader('Content-Type', 'text/vtt');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(await resp.text());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/subtitles/:videoId/list', async (req, res) => {
  try {
    const data = await getYtDlpFormatsWithRetry(req.params.videoId);
    const available = [];
    for (const [lang, subs] of Object.entries(data.subtitles || {})) {
      if (subs?.length) available.push({ lang, name: subs[0].name || lang, auto: false });
    }
    res.json({ subtitles: available });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy streaming
app.get('/api/proxy/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { quality = '720', start } = req.query;
  const seekSeconds = Math.max(0, parseFloat(start) || 0);

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const data = await getYtDlpFormatsWithRetry(videoId);
    const videoFmt = pickYtDlpVideo(data.formats, parseInt(quality));

    if (videoFmt.acodec !== 'none') {
      // Direct stream
      const resp = await fetch(videoFmt.url, {
        headers: {
          'User-Agent': getRandomUA(),
          'Origin': 'https://www.youtube.com',
          'Referer': 'https://www.youtube.com'
        },
        signal: controller.signal
      });
      
      if (!resp.ok) throw new Error(`Upstream ${resp.status}`);
      
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      await pipeline(Readable.fromWeb(resp.body), res);
    } else {
      // Mux audio+video
      const audioFmt = pickYtDlpAudio(data.formats);
      res.setHeader('Content-Type', 'video/mp4');
      await muxToResponse(videoFmt.url, audioFmt.url, res, controller.signal, seekSeconds);
    }
  } catch (e) {
    if (!controller.signal.aborted && !res.headersSent) {
      res.status(502).json({ error: e.message, fallback: { url: `https://www.youtube.com/embed/${videoId}` } });
    }
  }
});

// Stream
app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { quality = '720', audioOnly } = req.query;

  if (activeStreams >= MAX_CONCURRENT_STREAMS) {
    return res.status(503).json({ error: 'Server busy' });
  }

  activeStreams++;
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const data = await getYtDlpFormatsWithRetry(videoId);
    
    if (audioOnly === 'true') {
      const audioFmt = pickYtDlpAudio(data.formats);
      const resp = await fetch(audioFmt.url, {
        headers: { 'User-Agent': getRandomUA() },
        signal: controller.signal
      });
      res.setHeader('Content-Type', 'audio/mp4');
      await pipeline(Readable.fromWeb(resp.body), res);
    } else {
      const videoFmt = pickYtDlpVideo(data.formats, parseInt(quality));
      
      if (videoFmt.acodec !== 'none') {
        const resp = await fetch(videoFmt.url, {
          headers: { 'User-Agent': getRandomUA() },
          signal: controller.signal
        });
        res.setHeader('Content-Type', 'video/mp4');
        await pipeline(Readable.fromWeb(resp.body), res);
      } else {
        const audioFmt = pickYtDlpAudio(data.formats);
        res.setHeader('Content-Type', 'video/mp4');
        await muxToResponse(videoFmt.url, audioFmt.url, res, controller.signal, 0);
      }
    }
  } catch (e) {
    if (!controller.signal.aborted && !res.headersSent) {
      res.status(502).json({ error: e.message });
    }
  } finally {
    activeStreams = Math.max(0, activeStreams - 1);
  }
});

// Download
app.get('/api/download/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { format = 'mp4', quality = '720' } = req.query;
  
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const data = await getYtDlpFormatsWithRetry(videoId);
    const safeTitle = (data.meta.title || videoId).replace(/[<>:"/\\|?*]/g, '').substring(0, 100);

    if (format === 'mp4') {
      const videoFmt = pickYtDlpVideo(data.formats, parseInt(quality));
      
      res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.mp4"`);
      res.setHeader('Content-Type', 'video/mp4');

      if (videoFmt.acodec !== 'none') {
        const resp = await fetch(videoFmt.url, {
          headers: { 'User-Agent': getRandomUA() },
          signal: controller.signal
        });
        await pipeline(Readable.fromWeb(resp.body), res);
      } else {
        const audioFmt = pickYtDlpAudio(data.formats);
        await muxToResponse(videoFmt.url, audioFmt.url, res, controller.signal, 0);
      }
    } else {
      // Audio only
      const audioFmt = pickYtDlpAudio(data.formats);
      const configs = {
        mp3: { codec: 'libmp3lame', ext: 'mp3', mime: 'audio/mpeg', args: ['-b:a', '320k'] },
        m4a: { codec: 'aac', ext: 'm4a', mime: 'audio/mp4', args: ['-b:a', '256k'] }
      };
      const cfg = configs[format] || configs.mp3;
      
      res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.${cfg.ext}"`);
      res.setHeader('Content-Type', cfg.mime);
      
      // FFmpeg audio extraction
      const proc = spawn(FFMPEG, [
        '-loglevel', 'warning',
        '-i', audioFmt.url,
        '-vn',
        '-c:a', cfg.codec,
        ...cfg.args,
        '-f', cfg.ext === 'm4a' ? 'mp4' : cfg.ext,
        'pipe:1'
      ]);
      
      proc.stdout.pipe(res);
      await new Promise((resolve, reject) => {
        proc.on('close', c => c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}`)));
        proc.on('error', reject);
      });
    }
  } catch (e) {
    if (!controller.signal.aborted && !res.headersSent) {
      res.status(502).json({ error: e.message });
    }
  }
});

// Search
const searchContinuations = new Map();

app.get('/api/search', async (req, res) => {
  try {
    if (!youtube) return res.status(503).json({ error: 'API Initialising' });
    const results = await youtube.search(req.query.q, { type: 'video' });
    const searchId = crypto.randomBytes(8).toString('hex');
    searchContinuations.set(searchId, results);
    setTimeout(() => searchContinuations.delete(searchId), 30 * 60 * 1000);
    
    res.json({
      videos: (results.videos || []).map(v => ({
        id: v.id,
        title: v.title?.text,
        thumbnail: v.thumbnails?.[0]?.url,
        duration: v.duration?.text,
        views: v.view_count?.text,
        channel: v.author?.name,
        channelId: v.author?.id
      })),
      searchId,
      hasMore: !!results.has_continuation
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/search/more', async (req, res) => {
  try {
    const prev = searchContinuations.get(req.query.searchId);
    if (!prev) return res.status(404).json({ error: 'Expired' });
    
    const next = await prev.getContinuation();
    searchContinuations.set(req.query.searchId, next);
    
    res.json({
      videos: (next.videos || []).map(v => ({
        id: v.id,
        title: v.title?.text,
        thumbnail: v.thumbnails?.[0]?.url,
        duration: v.duration?.text,
        views: v.view_count?.text,
        channel: v.author?.name
      })),
      hasMore: !!next.has_continuation
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Channel
app.get('/api/channel/:channelId/videos', async (req, res) => {
  try {
    const data = await fetchChannelVideos(req.params.channelId, 60);
    let videos = [...data.videos];
    
    if (req.query.sort === 'oldest') videos.reverse();
    else if (req.query.sort === 'popular') {
      videos.sort((a, b) => parseInt((b.views || '').replace(/\D/g, '')) - parseInt((a.views || '').replace(/\D/g, '')));
    }
    
    res.json({ videos, channel: data.channel });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Feed
app.get('/api/feed', requireAuth, async (req, res) => {
  try {
    const subs = subsDb.prepare('SELECT * FROM subscriptions WHERE user_id = ?').all(req.user.id);
    const allVideos = [];

    // Subscription videos
    if (subs.length) {
      const results = await Promise.allSettled(subs.slice(0, 10).map(s => fetchChannelVideos(s.channel_id, 10)));
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          allVideos.push(...r.value.videos.map(v => ({...v, channel: v.channel || subs[i].channel_name, _score: Math.random()})));
        }
      });
    }

    res.json({ videos: allVideos.sort((a, b) => b._score - a._score).slice(0, 60) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trending
async function fetchTrendingYtDlp() {
  const ytdlpArgs = await buildYtDlpArgs('tv_embedded');
  const raw = await spawnYtDlp([
    '--flat-playlist', '--no-warnings', '--quiet',
    ...ytdlpArgs,
    '--playlist-items', '1-40',
    '-J', 'https://www.youtube.com/feed/trending'
  ], { timeout: 15000 });
  
  return (raw.entries || []).map(v => ({
    id: v.id,
    title: v.title,
    thumbnail: v.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
    duration: v.duration ? formatSecondsToTime(v.duration) : '',
    views: v.view_count ? formatViewCount(v.view_count) : '',
    channel: v.uploader,
    channelId: v.uploader_id
  }));
}

app.get('/api/trending', async (req, res) => {
  try {
    if (trendingCache.data && Date.now() - trendingCache.ts < TRENDING_TTL) {
      return res.json(trendingCache.data);
    }
    
    let videos = [];
    try {
      if (youtube) {
        const results = await youtube.getTrending();
        videos = (results.videos || []).map(v => ({
          id: v.id,
          title: v.title?.text,
          thumbnail: v.thumbnails?.[0]?.url,
          duration: v.duration?.text,
          views: v.view_count?.text,
          channel: v.author?.name,
          channelId: v.author?.id
        }));
      }
    } catch (e) {
      console.warn('[trending] API failed:', e.message);
    }
    
    if (!videos.length) {
      videos = await fetchTrendingYtDlp();
    }
    
    trendingCache.data = { videos };
    trendingCache.ts = Date.now();
    res.json({ videos });
  } catch (e) {
    res.status(500).json({ videos: [], error: e.message });
  }
});

// Shorts
app.get('/api/shorts', async (req, res) => {
  try {
    const ytdlpArgs = await buildYtDlpArgs('tv_embedded');
    const raw = await spawnYtDlp([
      '--flat-playlist', '--no-warnings',
      ...ytdlpArgs,
      '--playlist-items', '1-30',
      '-J', 'https://www.youtube.com/shorts/'
    ], { timeout: 15000 });
    
    const shorts = (raw.entries || []).slice(0, 30).map(v => ({
      id: v.id,
      title: v.title || 'Short',
      thumbnail: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
      duration: v.duration ? formatSecondsToTime(v.duration) : '',
      views: v.view_count ? formatViewCount(v.view_count) : '',
      isShort: true
    }));
    
    res.json({ shorts });
  } catch (e) {
    res.status(500).json({ shorts: [], error: e.message });
  }
});

// Health
app.get('/api/health', (req, res) => {
  const stats = proxyManager.getStats();
  res.json({
    status: 'ok',
    youtube: !!youtube,
    activeStreams,
    cookies: hasCookies(),
    poToken: !!poTokenManager.getToken(),
    proxy: stats
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.on('message', () => ws.send(JSON.stringify({ progress: 100 })));
});
