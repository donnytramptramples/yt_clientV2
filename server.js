import express from 'express';
import { Innertube, UniversalCache, Platform, Log, ClientType } from 'youtubei.js';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { spawn, execSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

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

const platform = os.platform();
let YTDLP = (() => {
  const binNames = platform === 'win32' ? ['yt-dlp.exe', 'yt-dlp'] : ['yt-dlp'];
  const lookup = platform === 'win32' ? 'where' : 'which';
  for (const name of binNames) {
    try {
      const resolved = execSync(`${lookup} ${name}`, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim();
      if (resolved) return resolved.split(/\r?\n/)[0];
    } catch {}
  }
  const binName = platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  return path.join(os.homedir(), 'bin', binName);
})();

async function ensureYtDlp() {
  if (fs.existsSync(YTDLP)) return;
  const dir = path.dirname(YTDLP);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  console.log('[setup] yt-dlp not found — downloading...');
  await new Promise((resolve, reject) => {
    const downloadUrl = platform === 'win32'
      ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
      : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
    const proc = spawn('curl', [
      '-sL', '--retry', '3',
      downloadUrl,
      '-o', YTDLP,
    ]);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`curl exited ${code}`));
      try {
        if (platform !== 'win32') fs.chmodSync(YTDLP, 0o755);
        const ver = execSync(`"${YTDLP}" --version`).toString().trim();
        console.log(`[setup] yt-dlp ${ver} ready`);
        resolve();
      } catch (e) { reject(e); }
    });
    proc.on('error', reject);
  });
}

await ensureYtDlp();

const ytdlpCache = new Map();
const ytdlpInFlight = new Map(); // videoId -> Promise (dedup concurrent calls)
const YTDLP_TTL = 15 * 60 * 1000;

Log.setLevel(Log.Level.ERROR);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5000;

const MAX_CONCURRENT_STREAMS = 5;
// Use a Set so cleanup is always idempotent — each stream gets a unique ID
const activeStreamSet = new Set();

// ─── Currently-watching tracker ──────────────────────────────────────────────
// userId → { videoId, title, thumbnail, position, updatedAt }
const watchingNow = new Map();
setInterval(() => {
  const stale = Date.now() - 35000;
  for (const [uid, d] of watchingNow.entries()) {
    if (d.updatedAt < stale) watchingNow.delete(uid);
  }
}, 15000);

// ─── Bandwidth tracker ───────────────────────────────────────────────────────
const BW_BUCKETS = 60;          // keep 60 minutes of history
const BW_BUCKET_MS = 60 * 1000; // 1-minute buckets
const bwPerUser = new Map();    // userId -> [{ t, bytes }]
const bwTotal = [];             // [{ t, bytes }]

function recordBandwidth(userId, bytes) {
  if (!bytes || bytes <= 0) return;
  const t = Math.floor(Date.now() / BW_BUCKET_MS) * BW_BUCKET_MS;

  if (userId !== null && userId !== undefined) {
    if (!bwPerUser.has(userId)) bwPerUser.set(userId, []);
    const arr = bwPerUser.get(userId);
    const last = arr[arr.length - 1];
    if (last && last.t === t) last.bytes += bytes;
    else { arr.push({ t, bytes }); if (arr.length > BW_BUCKETS) arr.shift(); }
  }

  const last = bwTotal[bwTotal.length - 1];
  if (last && last.t === t) last.bytes += bytes;
  else { bwTotal.push({ t, bytes }); if (bwTotal.length > BW_BUCKETS) bwTotal.shift(); }
}

setInterval(() => {
  const cutoff = Date.now() - BW_BUCKETS * BW_BUCKET_MS;
  for (const [uid, arr] of bwPerUser.entries()) {
    const filtered = arr.filter(b => b.t >= cutoff);
    if (filtered.length === 0) bwPerUser.delete(uid);
    else bwPerUser.set(uid, filtered);
  }
}, 5 * 60 * 1000);

const USER_AGENTS = [
  'Mozilla/5.0 (Linux; Android 13; SM-A135F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

const getRandomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

Platform.shim.eval = (data, _env) => {
  return new Function(data.output)();
};

const _nativeFetch = Platform.shim.fetch ?? fetch;
Platform.shim.fetch = (input, init = {}) => {
  if (init?.headers && typeof init.headers === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(init.headers)) clean[k] = v;
    init = { ...init, headers: clean };
  }
  return _nativeFetch(input, init);
};

let youtube;
let refreshTimer = null;

const infoCache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

// Bot bypass environment variables
const YOUTUBE_VISITOR_DATA = process.env.YOUTUBE_VISITOR_DATA || '';
const YOUTUBE_PO_TOKEN = process.env.YOUTUBE_PO_TOKEN || '';
// Base64-encoded cookies.txt content — set this in Render/production env
const YOUTUBE_COOKIES_B64 = process.env.YOUTUBE_COOKIES || '';

// Write cookies to disk once on startup if provided
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Encryption helpers ───────────────────────────────────────────────────────
const KEY_FILE = path.join(DATA_DIR, '.key');
let ENCRYPT_KEY;
try {
  ENCRYPT_KEY = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
  if (ENCRYPT_KEY.length !== 32) throw new Error('bad key length');
} catch {
  ENCRYPT_KEY = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, ENCRYPT_KEY.toString('hex'), 'utf8');
  console.log('[crypto] Generated new encryption key at', KEY_FILE);
}

// AES-256-GCM encrypt — returns 'enc:<base64>' or original value if falsy
function encrypt(text) {
  if (!text) return text;
  const str = String(text);
  if (str.startsWith('enc:')) return str; // already encrypted
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPT_KEY, iv);
  const enc = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'enc:' + Buffer.concat([iv, tag, enc]).toString('base64');
}

// AES-256-GCM decrypt — accepts 'enc:<base64>' or plain (legacy) text
function decrypt(encoded) {
  if (!encoded) return encoded;
  const str = String(encoded);
  if (!str.startsWith('enc:')) return str; // not yet encrypted (legacy data)
  try {
    const buf = Buffer.from(str.slice(4), 'base64');
    const iv = buf.slice(0, 12);
    const tag = buf.slice(12, 28);
    const data = buf.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPT_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch { return encoded; }
}

// SHA-256 hash for email lookups (deterministic, no salt needed for high-entropy values)
function emailHash(email) {
  return crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
}

const COOKIES_PATH = path.join(DATA_DIR, 'cookies.txt');
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

async function initYouTube() {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }

  try {
    const options = {
      client_type: ClientType.TV_EMBEDDED,
      generate_session_locally: true,
      cache: new UniversalCache(false),
      enable_session_cache: false,
    };

    if (YOUTUBE_VISITOR_DATA) {
      options.visitor_data = YOUTUBE_VISITOR_DATA;
      console.log('[youtubei.js] Using provided visitor_data');
    }

    youtube = await Innertube.create(options);

    infoCache.clear();
    console.log('>>> [SUCCESS] YouTube API Initialised (TV_EMBEDDED)');
    refreshTimer = setTimeout(initYouTube, 25 * 60 * 1000);
  } catch (e) {
    console.error('>>> [ERROR] Init Failed:', e.message);
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
    last_seen INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS admin_config (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS admin_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    max_accounts INTEGER DEFAULT 1000,
    max_connections INTEGER DEFAULT 500,
    max_sessions INTEGER DEFAULT 0,
    show_passwords INTEGER DEFAULT 0,
    allow_co_watch INTEGER DEFAULT 0
  );
  INSERT OR IGNORE INTO admin_settings (id, max_accounts, max_connections) VALUES (1, 1000, 500);
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS watch_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL,
    channel TEXT DEFAULT '',
    channel_id TEXT DEFAULT '',
    thumbnail TEXT DEFAULT '',
    watched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS user_preferences (
    user_id INTEGER PRIMARY KEY,
    subscriptions_weight REAL DEFAULT 1.0,
    trending_weight REAL DEFAULT 0.5,
    show_trending INTEGER DEFAULT 1,
    preferred_categories TEXT DEFAULT '{}',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// Migrations
try { authDb.exec('ALTER TABLE sessions ADD COLUMN last_seen INTEGER DEFAULT 0'); } catch {}
try { authDb.exec('ALTER TABLE user_preferences ADD COLUMN use_algorithm INTEGER DEFAULT 1'); } catch {}
try { authDb.exec('ALTER TABLE users ADD COLUMN plain_password TEXT DEFAULT NULL'); } catch {}
try { authDb.exec('ALTER TABLE users ADD COLUMN email_hash TEXT DEFAULT NULL'); } catch {}
try { authDb.exec('ALTER TABLE admin_settings ADD COLUMN max_sessions INTEGER DEFAULT 0'); } catch {}
try { authDb.exec('ALTER TABLE admin_settings ADD COLUMN show_passwords INTEGER DEFAULT 0'); } catch {}
try { authDb.exec('ALTER TABLE admin_settings ADD COLUMN allow_co_watch INTEGER DEFAULT 0'); } catch {}
authDb.prepare('UPDATE admin_settings SET max_sessions = 0 WHERE max_sessions IS NULL').run();
authDb.prepare('UPDATE admin_settings SET show_passwords = 0 WHERE show_passwords IS NULL').run();
authDb.prepare('UPDATE admin_settings SET allow_co_watch = 0 WHERE allow_co_watch IS NULL').run();

// Encrypt existing plaintext emails and plain_passwords, and populate email_hash
{
  const rows = authDb.prepare(`SELECT id, email, plain_password FROM users WHERE email NOT LIKE 'enc:%'`).all();
  const upd = authDb.prepare('UPDATE users SET email = ?, email_hash = ?, plain_password = ? WHERE id = ?');
  for (const row of rows) {
    const encEmail = encrypt(row.email);
    const hash = emailHash(row.email);
    const encPwd = row.plain_password && !row.plain_password.startsWith('enc:') ? encrypt(row.plain_password) : row.plain_password;
    upd.run(encEmail, hash, encPwd, row.id);
  }
  // Also ensure email_hash is set for already-encrypted rows missing a hash
  const missingHash = authDb.prepare(`SELECT id, email FROM users WHERE email_hash IS NULL`).all();
  const updHash = authDb.prepare('UPDATE users SET email_hash = ? WHERE id = ?');
  for (const row of missingHash) {
    try { updHash.run(emailHash(decrypt(row.email)), row.id); } catch {}
  }
  if (rows.length > 0) console.log(`[crypto] Encrypted ${rows.length} existing user records`);
}

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
  const u = authDb.prepare('SELECT id, username, email FROM users WHERE id = ?').get(sess.user_id);
  if (u) u.email = decrypt(u.email);
  return u;
}

function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  const user = getSessionUser(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  // Update last_seen
  authDb.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?').run(Date.now(), token);
  next();
}

// ─── Admin auth helpers ───────────────────────────────────────────────────────

function isAdminSetup() {
  return !!authDb.prepare('SELECT id FROM admin_config WHERE id = 1').get();
}

function getAdminSession(token) {
  if (!token) return null;
  const sess = authDb.prepare('SELECT * FROM admin_sessions WHERE token = ?').get(token);
  if (!sess || Date.now() > sess.expires_at) {
    if (sess) authDb.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
    return null;
  }
  return { admin: true };
}

function requireAdmin(req, res, next) {
  const token = req.cookies?.admin_token;
  const session = getAdminSession(token);
  if (!session) return res.status(401).json({ error: 'Admin not authenticated' });
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
  authDb.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
}, 30 * 60 * 1000);

// ─── Auth endpoints ──────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
    if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    // Check max accounts limit
    const settings = authDb.prepare('SELECT max_accounts FROM admin_settings WHERE id = 1').get();
    if (settings) {
      const userCount = authDb.prepare('SELECT COUNT(*) as cnt FROM users').get();
      if (userCount.cnt >= settings.max_accounts) {
        return res.status(403).json({ error: 'Registration is currently closed (account limit reached)' });
      }
    }

    const hash = await bcrypt.hash(password, 10);
    const cleanEmail = email.trim().toLowerCase();
    const stmt = authDb.prepare('INSERT INTO users (username, email, email_hash, password_hash, plain_password) VALUES (?,?,?,?,?)');
    let result;
    try {
      result = stmt.run(username.trim(), encrypt(cleanEmail), emailHash(cleanEmail), hash, encrypt(password));
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

    const user = authDb.prepare('SELECT * FROM users WHERE username = ? OR email_hash = ?').get(username, emailHash(username));
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    // Check concurrent session limit
    const loginSettings = authDb.prepare('SELECT max_sessions FROM admin_settings WHERE id = 1').get();
    if (loginSettings?.max_sessions > 0) {
      const activeSessions = authDb.prepare('SELECT COUNT(*) as cnt FROM sessions WHERE expires_at > ?').get(Date.now()).cnt;
      if (activeSessions >= loginSettings.max_sessions) {
        return res.status(429).json({ error: 'Server is full — maximum concurrent sessions reached. Try again later.' });
      }
    }

    const token = createSession(user.id);
    res.cookie('session', token, {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
      path: '/',
    });
    res.json({ user: { id: user.id, username: user.username, email: decrypt(user.email) } });
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

// ─── Admin endpoints ─────────────────────────────────────────────────────────

app.get('/api/admin/status', (req, res) => {
  res.json({ setup: isAdminSetup() });
});

app.post('/api/admin/setup', async (req, res) => {
  try {
    if (isAdminSetup()) return res.status(409).json({ error: 'Admin password already set. Cannot change.' });
    const { password } = req.body;
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const hash = await bcrypt.hash(password, 12);
    authDb.prepare('INSERT INTO admin_config (id, password_hash) VALUES (1, ?)').run(hash);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/login', async (req, res) => {
  try {
    if (!isAdminSetup()) return res.status(403).json({ error: 'Admin not set up yet' });
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });
    const config = authDb.prepare('SELECT password_hash FROM admin_config WHERE id = 1').get();
    const ok = await bcrypt.compare(password, config.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid password' });
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    authDb.prepare('INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?,?,?)').run(token, now, now + 4 * 60 * 60 * 1000);
    res.cookie('admin_token', token, { httpOnly: true, maxAge: 4 * 60 * 60 * 1000, sameSite: 'lax', path: '/' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = req.cookies?.admin_token;
  if (token) authDb.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
  res.clearCookie('admin_token', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/admin/check', requireAdmin, (req, res) => {
  res.json({ ok: true });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  try {
    const users = authDb.prepare(`
      SELECT u.id, u.username, u.email, u.created_at, u.plain_password,
        (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) as active_sessions,
        (SELECT MAX(s.last_seen) FROM sessions s WHERE s.user_id = u.id) as last_seen,
        (SELECT COUNT(*) FROM watch_history wh WHERE wh.user_id = u.id) as watch_count
      FROM users u ORDER BY u.created_at DESC
    `).all(Date.now());

    // Decrypt sensitive fields — only expose plain_password when show_passwords is enabled
    const adminCfg = authDb.prepare('SELECT show_passwords FROM admin_settings WHERE id = 1').get();
    const showPwds = !!(adminCfg?.show_passwords);
    for (const u of users) {
      const decEmail = decrypt(u.email);
      // If decryption failed the raw enc: string is returned — hide it
      u.email = (decEmail && !decEmail.startsWith('enc:')) ? decEmail : null;
      if (showPwds && u.plain_password) {
        const dec = decrypt(u.plain_password);
        u.plain_password = (dec && !dec.startsWith('enc:') && !dec.startsWith('$2')) ? dec : null;
      } else {
        delete u.plain_password;
      }
    }

    // Attach subscription count from subsDb
    const subCounts = subsDb.prepare(`
      SELECT user_id, COUNT(*) as sub_count FROM subscriptions GROUP BY user_id
    `).all();
    const subMap = {};
    for (const row of subCounts) subMap[row.user_id] = row.sub_count;
    for (const u of users) u.sub_count = subMap[u.id] || 0;

    const totalUsers = users.length;
    const now = Date.now();
    const recentThreshold = now - 15 * 60 * 1000;
    const connectedUsers = users.filter(u => u.last_seen && u.last_seen > recentThreshold).length;

    const settings = authDb.prepare('SELECT * FROM admin_settings WHERE id = 1').get();

    res.json({ users, totalUsers, connectedUsers, settings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    authDb.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    authDb.prepare('DELETE FROM watch_history WHERE user_id = ?').run(id);
    authDb.prepare('DELETE FROM user_preferences WHERE user_id = ?').run(id);
    subsDb.prepare('DELETE FROM subscriptions WHERE user_id = ?').run(id);
    savedDb.prepare('DELETE FROM saved_videos WHERE user_id = ?').run(id);
    authDb.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/users/:id/reset-password', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const hash = await bcrypt.hash(password, 10);
    authDb.prepare('UPDATE users SET password_hash = ?, plain_password = ? WHERE id = ?').run(hash, encrypt(password), id);
    authDb.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/users/:id/watch-history', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const history = authDb.prepare(`
      SELECT * FROM watch_history WHERE user_id = ? ORDER BY watched_at DESC LIMIT 100
    `).all(id);
    const user = authDb.prepare('SELECT id, username, email FROM users WHERE id = ?').get(id);
    res.json({ user, history });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/users/:id/subscriptions', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const subs = subsDb.prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY subscribed_at DESC').all(id);
    const user = authDb.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
    res.json({ user, subscriptions: subs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const settings = authDb.prepare('SELECT * FROM admin_settings WHERE id = 1').get();
  res.json({ settings });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  try {
    const { max_accounts, max_connections, max_sessions, show_passwords, allow_co_watch } = req.body;
    if (max_accounts !== undefined) {
      authDb.prepare('UPDATE admin_settings SET max_accounts = ? WHERE id = 1').run(parseInt(max_accounts));
    }
    if (max_connections !== undefined) {
      authDb.prepare('UPDATE admin_settings SET max_connections = ? WHERE id = 1').run(parseInt(max_connections));
    }
    if (max_sessions !== undefined) {
      authDb.prepare('UPDATE admin_settings SET max_sessions = ? WHERE id = 1').run(Math.max(0, parseInt(max_sessions) || 0));
    }
    if (show_passwords !== undefined) {
      authDb.prepare('UPDATE admin_settings SET show_passwords = ? WHERE id = 1').run(show_passwords ? 1 : 0);
    }
    if (allow_co_watch !== undefined) {
      authDb.prepare('UPDATE admin_settings SET allow_co_watch = ? WHERE id = 1').run(allow_co_watch ? 1 : 0);
    }
    const settings = authDb.prepare('SELECT * FROM admin_settings WHERE id = 1').get();
    res.json({ settings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Currently-watching reporting (user-facing) ──────────────────────────────

// Admin WebSocket clients for real-time watching updates
const adminWsClients = new Set();

// Maps each admin WS connection → the userId they are currently co-watching (if any)
const coWatchTargets = new Map();

// Throttle watching-list broadcasts: userId → last broadcast timestamp
// Prevents flooding admins at 200ms WS update rate (max once per 2s per user)
const watchingBroadcastThrottle = new Map();

function broadcastWatchingToAdmins() {
  if (adminWsClients.size === 0) return;
  const cfg = authDb.prepare('SELECT allow_co_watch FROM admin_settings WHERE id = 1').get();
  if (!cfg?.allow_co_watch) return;
  const now = Date.now();
  const active = [];
  for (const entry of watchingNow.values()) {
    if (now - entry.updatedAt < 35000) active.push(entry);
  }
  const msg = JSON.stringify({ type: 'watching_update', watching: active });
  for (const ws of adminWsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// Push a single user's state to every admin WS that registered interest via cowatch_join
function pushCowatchUpdate(userId, entry) {
  if (coWatchTargets.size === 0) return;
  const msg = JSON.stringify({ type: 'cowatch_update', data: entry });
  for (const [ws, targetId] of coWatchTargets.entries()) {
    if (targetId === userId && ws.readyState === 1) ws.send(msg);
  }
}

app.post('/api/watching', requireAuth, (req, res) => {
  const { videoId, title, thumbnail, position, paused, speed, quality, subtitleLang, subtitlesOn } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });
  const entry = {
    userId: req.user.id,
    username: req.user.username,
    videoId,
    title: title || '',
    thumbnail: thumbnail || '',
    position: parseFloat(position) || 0,
    paused: !!paused,
    speed: parseFloat(speed) || 1,
    quality: quality || null,
    subtitleLang: subtitleLang || null,
    subtitlesOn: !!subtitlesOn,
    updatedAt: Date.now(),
  };
  watchingNow.set(req.user.id, entry);
  broadcastWatchingToAdmins();
  pushCowatchUpdate(req.user.id, entry); // real-time push to co-watching admins
  res.json({ ok: true });
});

app.post('/api/watching/stop', requireAuth, (req, res) => {
  watchingNow.delete(req.user.id);
  broadcastWatchingToAdmins();
  res.json({ ok: true });
});

app.get('/api/admin/watching', requireAdmin, (req, res) => {
  const cfg = authDb.prepare('SELECT allow_co_watch FROM admin_settings WHERE id = 1').get();
  if (!cfg?.allow_co_watch) return res.status(403).json({ error: 'Co-watch is disabled' });
  const now = Date.now();
  const active = [];
  for (const entry of watchingNow.values()) {
    if (now - entry.updatedAt < 35000) active.push(entry);
  }
  res.json({ watching: active });
});

app.get('/api/admin/watching/:userId', requireAdmin, (req, res) => {
  const cfg = authDb.prepare('SELECT allow_co_watch FROM admin_settings WHERE id = 1').get();
  if (!cfg?.allow_co_watch) return res.status(403).json({ error: 'Co-watch is disabled' });
  const entry = watchingNow.get(parseInt(req.params.userId));
  if (!entry) return res.status(404).json({ error: 'User not currently watching' });
  res.json(entry);
});

// ─── Bandwidth stats ─────────────────────────────────────────────────────────

app.get('/api/admin/bandwidth', requireAdmin, (req, res) => {
  const users = authDb.prepare('SELECT id, username FROM users').all();
  const userMap = new Map(users.map(u => [u.id, u.username]));

  const now = Math.floor(Date.now() / BW_BUCKET_MS) * BW_BUCKET_MS;
  const times = Array.from({ length: BW_BUCKETS }, (_, i) => now - (BW_BUCKETS - 1 - i) * BW_BUCKET_MS);

  const totalData = times.map(t => {
    const entry = bwTotal.find(e => e.t === t);
    return entry ? entry.bytes : 0;
  });

  const usersData = [];
  for (const [userId, log] of bwPerUser.entries()) {
    const data = times.map(t => {
      const entry = log.find(e => e.t === t);
      return entry ? entry.bytes : 0;
    });
    if (data.some(b => b > 0)) {
      usersData.push({ userId, username: userMap.get(userId) || `User ${userId}`, data });
    }
  }

  res.json({ times, total: totalData, users: usersData });
});

// ─── Watch history (user-facing) ─────────────────────────────────────────────

app.post('/api/watch/:videoId', requireAuth, (req, res) => {
  try {
    const { videoId } = req.params;
    const { title, channel, channelId, thumbnail } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    // Keep only last 200 history entries per user
    const count = authDb.prepare('SELECT COUNT(*) as cnt FROM watch_history WHERE user_id = ?').get(req.user.id);
    if (count.cnt >= 200) {
      authDb.prepare('DELETE FROM watch_history WHERE user_id = ? AND id = (SELECT MIN(id) FROM watch_history WHERE user_id = ?)').run(req.user.id, req.user.id);
    }
    // Check if already watched recently (last 30 min), don't duplicate
    const recent = authDb.prepare(`SELECT id FROM watch_history WHERE user_id = ? AND video_id = ? AND watched_at > datetime('now', '-30 minutes')`).get(req.user.id, videoId);
    if (!recent) {
      authDb.prepare('INSERT INTO watch_history (user_id, video_id, title, channel, channel_id, thumbnail) VALUES (?,?,?,?,?,?)').run(req.user.id, videoId, title, channel || '', channelId || '', thumbnail || '');
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/watch/history', requireAuth, (req, res) => {
  try {
    const history = authDb.prepare('SELECT * FROM watch_history WHERE user_id = ? ORDER BY watched_at DESC LIMIT 50').all(req.user.id);
    res.json({ history });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── User preferences (feed settings) ────────────────────────────────────────

app.get('/api/preferences', requireAuth, (req, res) => {
  try {
    let prefs = authDb.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(req.user.id);
    if (!prefs) {
      prefs = { user_id: req.user.id, subscriptions_weight: 1.0, trending_weight: 0.5, show_trending: 1, use_algorithm: 1, preferred_categories: '{}' };
    }
    res.json({ preferences: { ...prefs, preferred_categories: JSON.parse(prefs.preferred_categories || '{}') } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/preferences', requireAuth, (req, res) => {
  try {
    const { subscriptions_weight, trending_weight, show_trending, use_algorithm, preferred_categories } = req.body;
    const existing = authDb.prepare('SELECT user_id FROM user_preferences WHERE user_id = ?').get(req.user.id);
    if (existing) {
      authDb.prepare(`UPDATE user_preferences SET 
        subscriptions_weight = COALESCE(?, subscriptions_weight),
        trending_weight = COALESCE(?, trending_weight),
        show_trending = COALESCE(?, show_trending),
        use_algorithm = COALESCE(?, use_algorithm),
        preferred_categories = COALESCE(?, preferred_categories),
        updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?`).run(
        subscriptions_weight ?? null,
        trending_weight ?? null,
        show_trending !== undefined ? (show_trending ? 1 : 0) : null,
        use_algorithm !== undefined ? (use_algorithm ? 1 : 0) : null,
        preferred_categories !== undefined ? JSON.stringify(preferred_categories) : null,
        req.user.id
      );
    } else {
      authDb.prepare(`INSERT INTO user_preferences (user_id, subscriptions_weight, trending_weight, show_trending, use_algorithm, preferred_categories) VALUES (?,?,?,?,?,?)`).run(
        req.user.id,
        subscriptions_weight ?? 1.0,
        trending_weight ?? 0.5,
        show_trending !== undefined ? (show_trending ? 1 : 0) : 1,
        use_algorithm !== undefined ? (use_algorithm ? 1 : 0) : 1,
        preferred_categories !== undefined ? JSON.stringify(preferred_categories) : '{}'
      );
    }
    let prefs = authDb.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(req.user.id);
    res.json({ preferences: { ...prefs, preferred_categories: JSON.parse(prefs.preferred_categories || '{}') } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
    const user = authDb.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const match = await bcrypt.compare(currentPassword || '', user.password_hash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(newPassword, 10);
    authDb.prepare('UPDATE users SET password_hash = ?, plain_password = ? WHERE id = ?').run(hash, encrypt(newPassword), req.user.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/delete-account', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    const user = authDb.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const match = await bcrypt.compare(password || '', user.password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect password' });
    authDb.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
    authDb.prepare('DELETE FROM watch_history WHERE user_id = ?').run(req.user.id);
    authDb.prepare('DELETE FROM user_preferences WHERE user_id = ?').run(req.user.id);
    subsDb.prepare('DELETE FROM subscriptions WHERE user_id = ?').run(req.user.id);
    try { savedDb.prepare('DELETE FROM saved_videos WHERE user_id = ?').run(req.user.id); } catch {}
    authDb.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
    res.clearCookie('session');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// ─── Chapter parsing ─────────────────────────────────────────────────────────
function parseChaptersFromDescription(description, videoDuration) {
  if (!description) return [];
  const lines = description.split('\n');
  const chapters = [];
  // Match patterns like "0:00", "1:30", "1:02:30"
  const tsRe = /^(?:(\d+):)?(\d+):(\d{2})\b/;
  for (const line of lines) {
    const m = line.match(tsRe);
    if (!m) continue;
    const h = parseInt(m[1] || 0);
    const mn = parseInt(m[2]);
    const s = parseInt(m[3]);
    const time = h * 3600 + mn * 60 + s;
    // Everything after the timestamp, stripping common separators
    const title = line.replace(tsRe, '').replace(/^\s*[-–—|·•:]\s*/, '').trim();
    if (title && time >= 0) chapters.push({ time, title });
  }
  // Must have at least 2 chapters and the first must be at 0:00
  if (chapters.length < 2 || chapters[0].time !== 0) return [];
  // Deduplicate by time
  const seen = new Set();
  const deduped = chapters.filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; });
  // Add endTime for each chapter
  for (let i = 0; i < deduped.length; i++) {
    deduped[i].endTime = deduped[i + 1]?.time ?? (videoDuration || 0);
  }
  return deduped;
}

function extractChaptersFromInfo(info, videoDuration) {
  try {
    const playerOverlays = info.player_overlays;
    if (!playerOverlays) return [];
    // Try the observe array / get method
    let mmBar = null;
    if (typeof playerOverlays.get === 'function') {
      mmBar = playerOverlays.get('MultiMarkersPlayerBar');
    } else if (Array.isArray(playerOverlays)) {
      mmBar = playerOverlays.find(n => n?.type === 'MultiMarkersPlayerBar');
    }
    if (!mmBar?.markers_map) return [];
    for (const marker of mmBar.markers_map) {
      const chaps = marker?.value?.chapters;
      if (chaps?.length >= 2) {
        const result = chaps.map((c, i, arr) => ({
          title: String(c.title),
          time: Math.floor((c.time_range_start_millis || 0) / 1000),
          endTime: i + 1 < arr.length
            ? Math.floor((arr[i + 1].time_range_start_millis || 0) / 1000)
            : (videoDuration || 0),
        }));
        if (result.length >= 2) return result;
      }
    }
  } catch {}
  return [];
}

async function getVideoInfo(videoId) {
  const cached = infoCache.get(videoId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.info;

  if (!youtube) throw new Error('YouTube API not initialized');
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

// Build yt-dlp args with full bot bypass support
function buildYtDlpArgs(client = 'tv_embedded', extraArgs = []) {
  const args = [];

  // Cookies (most effective bypass)
  if (hasCookies()) {
    args.push('--cookies', COOKIES_PATH);
  }

  // Extractor args with optional visitor_data and po_token
  let extractorArg = `youtube:player_client=${client}`;
  if (YOUTUBE_VISITOR_DATA) extractorArg += `;visitor_data=${YOUTUBE_VISITOR_DATA}`;
  if (YOUTUBE_PO_TOKEN && YOUTUBE_VISITOR_DATA) {
    extractorArg += `;po_token=${YOUTUBE_VISITOR_DATA}+${YOUTUBE_PO_TOKEN}`;
  }
  args.push('--extractor-args', extractorArg);

  args.push('--add-headers', 'Origin:https://www.youtube.com');
  args.push('--add-headers', 'Referer:https://www.youtube.com/');

  args.push(...extraArgs);
  return args;
}

// yt-dlp with multiple client fallbacks and bot bypass
async function getYtDlpFormats(videoId, attempt = 0) {
  const cached = ytdlpCache.get(videoId);
  if (cached && Date.now() - cached.ts < YTDLP_TTL) return cached;

  const clients = ['tv_embedded', 'android_vr', 'mweb', 'android', 'ios', 'web'];
  const client = clients[attempt % clients.length];

  console.log(`[ytdlp] ${videoId} attempt ${attempt + 1} client=${client} cookies=${hasCookies()} po_token=${!!YOUTUBE_PO_TOKEN}`);

  const ytdlpArgs = buildYtDlpArgs(client);

  const raw = await new Promise((resolve, reject) => {
    const args = [
      '--no-playlist', '--quiet', '--no-warnings',
      ...ytdlpArgs,
      '-j', `https://www.youtube.com/watch?v=${videoId}`,
    ];

    const proc = spawn(YTDLP, args, {
      env: { ...process.env, HTTP_USER_AGENT: getRandomUA() }
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

async function _doYtDlpFormatsWithRetry(videoId) {
  const clients = ['tv_embedded', 'android_vr', 'mweb', 'android', 'ios', 'web'];
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
      if (i < clients.length - 1) {
        // Human-like delay: base + random jitter so retries don't look robotic
        const base = 1500 + i * 1000;
        const jitter = Math.floor(Math.random() * 1000);
        await new Promise(r => setTimeout(r, base + jitter));
      }
    }
  }
  throw lastError;
}

async function getYtDlpFormatsWithRetry(videoId) {
  // Return cached result immediately if still fresh
  const cached = ytdlpCache.get(videoId);
  if (cached && Date.now() - cached.ts < YTDLP_TTL) return cached;

  // Deduplicate concurrent callers — all share the same in-flight promise
  if (ytdlpInFlight.has(videoId)) {
    return ytdlpInFlight.get(videoId);
  }

  const promise = _doYtDlpFormatsWithRetry(videoId).finally(() => {
    ytdlpInFlight.delete(videoId);
  });
  ytdlpInFlight.set(videoId, promise);
  return promise;
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
  // CRITICAL FIX: Also include formats that have both audio and video (for audio extraction)
  // Some YouTube formats have both, we can extract just the audio
  const audio = formats.filter(f => f.acodec !== 'none' && f.url);
  if (!audio.length) throw new Error('No audio formats from yt-dlp');
  audio.sort((a, b) => {
    // Prefer audio-only formats (no video)
    const aAudioOnly = a.vcodec === 'none' ? 0 : 1;
    const bAudioOnly = b.vcodec === 'none' ? 0 : 1;
    if (aAudioOnly !== bAudioOnly) return aAudioOnly - bAudioOnly;

    // Then prefer m4a/mp4
    const aM4a = a.ext === 'm4a' ? 0 : 1;
    const bM4a = b.ext === 'm4a' ? 0 : 1;
    if (aM4a !== bM4a) return aM4a - bM4a;

    // Then by bitrate
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

  const resp = await youtube.session.http.fetch_function(fetchUrl, {
    method: 'GET', headers, redirect: 'follow', signal,
  });
  if (!resp.ok) throw new Error(`Upstream fetch failed: ${resp.status}`);
  return resp;
}

// CRITICAL FIX: Completely rewritten muxToResponse for reliability
function muxToResponse(videoUrl, audioUrl, res, signal, seekSeconds = 0, rangeHeader = null, isDownload = false) {
  return new Promise((resolve, reject) => {
    // Validate inputs
    if (!videoUrl || !audioUrl) {
      return reject(new Error(`Missing URL: video=${!!videoUrl}, audio=${!!audioUrl}`));
    }

    const ssArg = seekSeconds > 0 ? seekSeconds.toFixed(3) : null;
    const useRange = !ssArg && rangeHeader;

    const ytHeaders = [
      `User-Agent: ${getRandomUA()}`,
      'Accept: */*',
      'Accept-Language: en-US,en;q=0.9',
      'Origin: https://www.youtube.com',
      'Referer: https://www.youtube.com/',
    ].join('\r\n') + '\r\n';

    // CRITICAL FIX: Build args array carefully to avoid undefined elements
    const args = ['-loglevel', 'error'];

    // Protocol whitelist
    args.push('-protocol_whitelist', 'file,http,https,tcp,tls,crypto');

    // Video input
    args.push('-headers', ytHeaders);
    args.push('-reconnect', '1');
    args.push('-reconnect_on_network_error', '1');
    args.push('-reconnect_delay_max', '5');

    // Add seek before video input if needed
    if (ssArg) {
      args.push('-ss', ssArg);
    }

    args.push('-i', videoUrl);

    // Audio input - CRITICAL: Must have the same headers and seek
    args.push('-headers', ytHeaders);
    args.push('-reconnect', '1');
    args.push('-reconnect_on_network_error', '1');
    args.push('-reconnect_delay_max', '5');

    // Add seek before audio input if needed (CRITICAL for A/V sync)
    if (ssArg) {
      args.push('-ss', ssArg);
    }

    args.push('-i', audioUrl);

    // Mappings
    args.push('-map', '0:v:0');
    args.push('-map', '1:a:0');

    // Codecs
    args.push('-c:v', 'copy');
    args.push('-c:a', 'copy');

    // A/V SYNC FIX: Normalize timestamps so both streams start at 0
    // This compensates for video keyframe alignment offset vs audio seek precision
    args.push('-avoid_negative_ts', 'make_zero');
    args.push('-max_muxing_queue_size', '4096');

    // CRITICAL FIX: Use fragmented MP4 for pipe output - works for both streaming AND downloads
    // frag_keyframe = fragment at keyframes (required for streaming)
    // empty_moov = empty moov atom at start (allows pipe output without seeking)
    // default_base_moof = default base media offset (required for proper playback)
    // faststart is NOT compatible with pipe output - removed!
    const movFlags = 'frag_keyframe+empty_moov+default_base_moof';
    args.push('-movflags', movFlags);

    args.push('-f', 'mp4');
    args.push('pipe:1');

    console.log(`[ffmpeg] Muxing video+audio seek=${seekSeconds}s isDownload=${isDownload}`);
    console.log(`[ffmpeg] Video: ${videoUrl.substring(0, 80)}...`);
    console.log(`[ffmpeg] Audio: ${audioUrl.substring(0, 80)}...`);
    console.log(`[ffmpeg] movflags=${movFlags}`);

    const proc = spawn(FFMPEG, args);

    if (signal) {
      signal.addEventListener('abort', () => { 
        try { proc.kill('SIGTERM'); } catch {} 
      }, { once: true });
    }

    let stderrData = '';
    proc.stderr.on('data', d => {
      const msg = d.toString().trim();
      if (msg) {
        stderrData += msg + '\n';
        if (msg.includes('Error') || msg.includes('error') || msg.includes('Invalid')) {
          console.error('[ffmpeg]', msg);
        }
      }
    });

    // Set headers
    // CRITICAL FIX: Fragmented MP4 doesn't support byte ranges, so never advertise Accept-Ranges
    res.setHeader('Accept-Ranges', 'none');

    // CRITICAL FIX: For downloads, we still set Content-Disposition but the format is fragmented MP4
    // This is the only way to pipe MP4 - standard MP4 requires seekable output
    if (isDownload) {
      // Note: The file will be a valid fragmented MP4, playable in all modern players
      // Some very old players might not support fragmented MP4, but this is unavoidable
      // when piping. For maximum compatibility, users should use the direct proxy endpoint
      // for streaming instead of download if they need standard MP4.
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }

    proc.stdout.pipe(res);

    proc.stdout.on('error', (err) => {
      console.error('[ffmpeg] stdout error:', err.message);
    });

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

// FIXED: Correct URL logic for UC IDs vs @ handles vs plain names
async function fetchChannelVideos(channelId, page = 1, pageSize = 60) {
  const start = (page - 1) * pageSize + 1;
  const end = page * pageSize;
  const cacheKey = `ch:${channelId}:${start}-${end}`;
  const cached = channelCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CHANNEL_TTL) return cached;

  // Build URL priority list without mixing ID formats
  const urls = [];
  const isUCId = /^UC[a-zA-Z0-9_\-]{10,}$/.test(channelId);
  const isHandle = channelId.startsWith('@');

  if (isUCId) {
    // YouTube channel IDs always use /channel/UCxxx/videos
    urls.push(`https://www.youtube.com/channel/${channelId}/videos`);
  } else if (isHandle) {
    // Handle with @ prefix: /@handle/videos
    urls.push(`https://www.youtube.com/${channelId}/videos`);
  } else {
    // Plain name: try @handle, then /c/ (legacy custom URLs), then /channel/ as last resort
    urls.push(`https://www.youtube.com/@${channelId}/videos`);
    urls.push(`https://www.youtube.com/c/${channelId}/videos`);
    urls.push(`https://www.youtube.com/channel/${channelId}/videos`);
  }

  let entries = [];
  let channelMeta = {};

  for (const url of urls) {
    try {
      const ytdlpArgs = buildYtDlpArgs('tv_embedded');

      const raw = await new Promise((resolve, reject) => {
        const args = [
          '--flat-playlist', '--no-warnings', '--quiet',
          ...ytdlpArgs,
          '--playlist-items', `${start}-${end}`,
          '-J', url,
        ];
        const proc = spawn(YTDLP, args, {
          env: { ...process.env, HTTP_USER_AGENT: getRandomUA() }
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
          const trimmed = out.trimStart();
          if (trimmed.startsWith('<')) return reject(new Error('yt-dlp returned HTML instead of JSON (channel may be restricted)'));
          try { resolve(JSON.parse(trimmed)); } catch { reject(new Error('JSON parse failed')); }
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
      if (entries.length > 0) break; // success
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

  const result = { videos, channel: channelMeta, hasMore: entries.length >= pageSize, ts: Date.now() };
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

// Query-string version — avoids routing failures when channelId contains slashes or other special chars
app.get('/api/channel/videos', async (req, res) => {
  try {
    const channelId = req.query.id || '';
    if (!channelId) return res.status(400).json({ error: 'id is required' });
    const { sort = 'newest', page = '1', pageSize = '60' } = req.query;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const pageSizeNum = Math.min(200, Math.max(10, parseInt(pageSize) || 60));

    const data = await fetchChannelVideos(channelId, pageNum, pageSizeNum);
    let videos = [...data.videos];

    if (sort === 'oldest') videos = videos.reverse();
    else if (sort === 'popular') {
      videos = videos.sort((a, b) => {
        const aV = parseInt((a.views || '0').replace(/[^\d]/g, '')) || 0;
        const bV = parseInt((b.views || '0').replace(/[^\d]/g, '')) || 0;
        return bV - aV;
      });
    }

    res.json({ videos, channel: data.channel, hasMore: data.hasMore, page: pageNum });
  } catch (e) {
    console.error('[channel/videos] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/channel/:channelId/videos', async (req, res) => {
  try {
    const { channelId } = req.params;
    const { sort = 'newest', page = '1', pageSize = '60' } = req.query;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const pageSizeNum = Math.min(200, Math.max(10, parseInt(pageSize) || 60));

    const data = await fetchChannelVideos(channelId, pageNum, pageSizeNum);
    let videos = [...data.videos];

    if (sort === 'oldest') videos = videos.reverse();
    else if (sort === 'popular') {
      videos = videos.sort((a, b) => {
        const aV = parseInt((a.views || '0').replace(/[^\d]/g, '')) || 0;
        const bV = parseInt((b.views || '0').replace(/[^\d]/g, '')) || 0;
        return bV - aV;
      });
    }

    res.json({ videos, channel: data.channel, hasMore: data.hasMore, page: pageNum });
  } catch (e) {
    console.error('[channel/videos] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Feed (YouTube-like algorithm: subscriptions + trending) ─────────────────

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

    // Load user preferences
    let prefs = authDb.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(req.user.id);
    if (!prefs) prefs = { subscriptions_weight: 1.0, trending_weight: 0.5, show_trending: 1, use_algorithm: 1 };

    const useAlgorithm = prefs.use_algorithm !== 0;
    const subWeight = Math.max(0, Math.min(2, prefs.subscriptions_weight ?? 1.0));
    const trendWeight = Math.max(0, Math.min(2, prefs.trending_weight ?? 0.5));
    const showTrending = prefs.show_trending !== 0;

    // ── Subscription videos ───────────────────────────────────────────────────
    if (subs.length > 0) {
      const channelResults = await Promise.allSettled(
        subs.slice(0, 12).map(sub => fetchChannelVideos(sub.channel_id, 1, 15))
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
          const score = subWeight * (0.4 + recency * 0.65 + popularity * 0.2 + channelBoost + random);
          allVideos.push({ ...v, channel: v.channel || sub.channel_name, channelId: v.channelId || sub.channel_id, channelAvatar: v.channelAvatar || sub.channel_avatar || '', _score: score, _src: 'subscription' });
        }
      }
    }

    // ── Trending videos ───────────────────────────────────────────────────────
    if (showTrending) {
      let trendingVideos = [];
      try {
        if (trendingCache.data && Date.now() - trendingCache.ts < TRENDING_TTL) {
          trendingVideos = trendingCache.data.videos || [];
        } else {
          const raw = await fetchTrendingYtDlp();
          trendingVideos = raw;
          trendingCache.data = { videos: raw };
          trendingCache.ts = Date.now();
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
        const score = trendWeight * ((isSub ? 0.3 : 0.05) + recency * 0.4 + popularity * 0.35 + random);
        allVideos.push({ ...v, _score: score, _src: 'trending' });
      }
    }

    // Deduplicate by video ID, keeping highest score
    const seen = new Map();
    for (const v of allVideos) {
      if (!seen.has(v.id) || seen.get(v.id)._score < v._score) seen.set(v.id, v);
    }

    let videos;
    if (useAlgorithm) {
      // Sort by algorithm score
      videos = [...seen.values()]
        .sort((a, b) => b._score - a._score)
        .slice(0, 60)
        .map(({ _score, _src, ...v }) => v);
    } else {
      // Algorithm off: chronological subscription content only
      videos = [...seen.values()]
        .filter(v => v._src === 'subscription')
        .sort((a, b) => getFeedRecencyScore(b.published) - getFeedRecencyScore(a.published))
        .slice(0, 60)
        .map(({ _score, _src, ...v }) => v);
    }

    res.json({ videos });
  } catch (e) {
    console.error('[feed] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Video info / formats / subtitles ────────────────────────────────────────

app.get('/api/info/:videoId', async (req, res) => {
  const { videoId } = req.params;

  let duration = 0, title = '', chapters = [], description = '';

  try {
    const info = await getVideoInfo(videoId);
    duration = info.basic_info?.duration || 0;
    title = info.basic_info?.title || '';
    description = info.basic_info?.short_description || '';
    // Try to get chapters from the YouTube API first
    chapters = extractChaptersFromInfo(info, duration);
  } catch {}

  if (!duration || !title) {
    try {
      const data = await getYtDlpFormatsWithRetry(videoId);
      if (!duration && data.meta?.duration) duration = data.meta.duration;
      if (!title && data.meta?.title) title = data.meta.title;
      if (!description && data.meta?.description) description = data.meta.description;
    } catch {}
  }

  // Fallback: parse chapters from description
  if (chapters.length === 0 && description) {
    chapters = parseChaptersFromDescription(description, duration);
  }

  if (!duration && !title) {
    return res.status(502).json({
      error: 'Could not fetch video info',
      fallback: { type: 'youtube-embed', url: `https://www.youtube.com/embed/${videoId}` },
    });
  }

  res.json({ duration, title, chapters, source: 'combined' });
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

// ─── Video details (description + comments) ──────────────────────────────────

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
    const ytdlpArgs = buildYtDlpArgs('tv_embedded');
    const commentData = await new Promise((resolve) => {
      const args = [
        '--no-playlist', '--skip-download', '--write-comments', '--quiet', '--no-warnings',
        '--extractor-args', 'youtube:comment_sort=top;max_comments=30,all,top,0',
        ...ytdlpArgs,
        '-j', `https://www.youtube.com/watch?v=${videoId}`,
      ];
      const proc = spawn(YTDLP, args, {
        env: { ...process.env, HTTP_USER_AGENT: getRandomUA() }
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

app.get('/api/subtitles/:videoId/translate', async (req, res) => {
  const { videoId } = req.params;
  const { lang = 'en', auto = 'false', to = 'en' } = req.query;

  try {
    const data = await getYtDlpFormatsWithRetry(videoId);

    const autoCapsSrc = data.automaticCaptions;
    if (autoCapsSrc && autoCapsSrc[to]) {
      const subs = autoCapsSrc[to];
      const vttSub = subs.find(s => s.ext === 'vtt') || subs[0];
      if (vttSub?.url) {
        const r = await fetch(vttSub.url, { headers: { 'user-agent': getRandomUA() } });
        if (r.ok) {
          res.setHeader('Content-Type', 'text/vtt');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          res.setHeader('X-Translation-Source', 'youtube-auto');
          return res.send(await r.text());
        }
      }
    }

    const subtitleSource = auto === 'true' ? data.automaticCaptions : data.subtitles;
    const srcSubs = subtitleSource?.[lang];
    if (!srcSubs?.length) return res.status(404).json({ error: 'Source subtitles not found' });

    const vttSub = srcSubs.find(s => s.ext === 'vtt') || srcSubs[0];
    const r = await fetch(vttSub.url, { headers: { 'user-agent': getRandomUA() } });
    if (!r.ok) return res.status(502).json({ error: 'Failed to fetch source subtitles' });

    const vttText = await r.text();

    const cueRegex = /(\d{2}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})[^\n]*\n([\s\S]*?)(?=\n\n|\n*$)/g;
    const cues = [];
    let m;
    while ((m = cueRegex.exec(vttText)) !== null) {
      const text = m[3].replace(/<[^>]+>/g, '').trim();
      if (text) cues.push({ start: m[1], end: m[2], text });
    }

    if (!cues.length) {
      res.setHeader('Content-Type', 'text/vtt');
      return res.send(vttText);
    }

    const DELIM = ' ||| ';
    const batch = cues.map(c => c.text).join(DELIM);

    let translated = batch;
    try {
      const gtUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(batch)}`;
      const gtRes = await fetch(gtUrl, {
        headers: { 'user-agent': 'Mozilla/5.0', 'accept': '*/*' },
        signal: AbortSignal.timeout(10000),
      });
      if (gtRes.ok) {
        const gtData = await gtRes.json();
        translated = (gtData[0] || []).map(part => part[0] || '').join('');
      }
    } catch (e) {
      console.warn('[translate] Google Translate failed:', e.message);
    }

    const translatedParts = translated.split(DELIM);
    const vttLines = ['WEBVTT', ''];
    cues.forEach((cue, i) => {
      vttLines.push(`${cue.start} --> ${cue.end}`);
      vttLines.push(translatedParts[i]?.trim() || cue.text);
      vttLines.push('');
    });

    res.setHeader('Content-Type', 'text/vtt');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Translation-Source', 'google-translate');
    res.send(vttLines.join('\n'));
  } catch (e) {
    console.error('[translate] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Stream availability check (called before video loads) ───────────────────
// Uses activeStreamSet — the live count of open proxy connections, accurate in real-time.

app.get('/api/stream/available', requireAuth, (req, res) => {
  const streamSettings = authDb.prepare('SELECT max_connections FROM admin_settings WHERE id = 1').get();
  const maxStreams = streamSettings?.max_connections ?? MAX_CONCURRENT_STREAMS;
  // Use the live activeStreamSet count — accurate in real-time, no staleness issues
  const current = activeStreamSet.size;
  const available = current < maxStreams;
  res.json({ available, current, max: maxStreams });
});

// ─── Proxy (streaming) ───────────────────────────────────────────────────────

app.get('/api/proxy/:videoId', async (req, res) => {
  const { videoId } = req.params;
  // BUG FIX: Support both 't' (YouTube style) and 'start' (HTML5 standard) parameters
  // Priority: start > t > 0
  const { quality = '720', t, start } = req.query;

  // BUG FIX: Properly parse seek time from either parameter
  let seekSeconds = 0;
  if (start !== undefined) {
    seekSeconds = Math.max(0, parseFloat(start) || 0);
  } else if (t !== undefined) {
    // Support YouTube time formats: "123" (seconds) or "2m3s"
    const tStr = String(t);
    if (/^\d+$/.test(tStr)) {
      seekSeconds = parseInt(tStr, 10);
    } else {
      // Parse "1h2m3s" format
      const match = tStr.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?/);
      if (match) {
        const hours = parseInt(match[1] || 0) * 3600;
        const mins = parseInt(match[2] || 0) * 60;
        const secs = parseInt(match[3] || 0);
        seekSeconds = hours + mins + secs;
      }
    }
  }

  const rangeHeader = req.headers.range;

  console.log(`[proxy] ${videoId} q=${quality} seek=${seekSeconds}s range=${rangeHeader || 'none'}`);

  // Optional user detection for bandwidth accounting
  const _bwUser = getSessionUser(req.cookies?.session);
  const _bwUid = _bwUser?.id ?? null;
  const _origWrite = res.write.bind(res);
  const _origEnd = res.end.bind(res);
  res.write = function (chunk, ...args) {
    if (chunk) recordBandwidth(_bwUid, Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk));
    return _origWrite(chunk, ...args);
  };
  res.end = function (chunk, ...args) {
    if (chunk) recordBandwidth(_bwUid, Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk));
    return _origEnd(chunk, ...args);
  };

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  // ── Concurrent stream limit (admins bypass) ────────────────────────────────
  const _proxyIsAdmin = !!getAdminSession(req.cookies?.admin_token);
  if (!_proxyIsAdmin) {
    const _proxySettings = authDb.prepare('SELECT max_connections FROM admin_settings WHERE id = 1').get();
    const _proxyMax = _proxySettings?.max_connections ?? MAX_CONCURRENT_STREAMS;
    if (activeStreamSet.size >= _proxyMax) {
      return res.status(503).json({ error: 'Server is busy, please try again later.', current: activeStreamSet.size, max: _proxyMax });
    }
  }
  const _proxyStreamId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  activeStreamSet.add(_proxyStreamId);
  let _proxyCleaned = false;
  const _proxyCleanup = () => { if (!_proxyCleaned) { _proxyCleaned = true; activeStreamSet.delete(_proxyStreamId); } };
  req.on('close', _proxyCleanup);

  try {
    const qualityNum = parseInt(quality, 10);
    const data = await getYtDlpFormatsWithRetry(videoId);
    const { formats: ytFmts } = data;

    const videoFmt = pickYtDlpVideo(ytFmts, qualityNum);

    if (videoFmt.acodec !== 'none') {
      // Progressive stream (video+audio combined)
      const fetchHeaders = {
        'accept': '*/*',
        'origin': 'https://www.youtube.com',
        'referer': 'https://www.youtube.com',
        'user-agent': getRandomUA()
      };

      // BUG FIX: When seeking, we must NOT use range headers from client
      // because the byte positions won't correspond after time-based seeking.
      // Instead, we rely on ffmpeg or the upstream to handle seeking.
      // For direct progressive streams without transcoding, we pass range only if not seeking.
      if (rangeHeader && seekSeconds === 0) {
        fetchHeaders['range'] = rangeHeader;
      }

      const resp = await fetch(videoFmt.url, {
        headers: fetchHeaders,
        signal: controller.signal
      });

      if (!resp.ok && resp.status !== 206) throw new Error(`Upstream: ${resp.status}`);

      res.status(resp.status === 206 ? 206 : 200);
      res.setHeader('Content-Type', videoFmt.ext === 'webm' ? 'video/webm' : 'video/mp4');

      // BUG FIX: Only advertise Accept-Ranges when not seeking
      if (seekSeconds === 0) {
        res.setHeader('Accept-Ranges', 'bytes');
      } else {
        res.setHeader('Accept-Ranges', 'none');
      }

      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length');

      if (resp.headers.get('content-length')) res.setHeader('Content-Length', resp.headers.get('content-length'));
      if (resp.headers.get('content-range')) res.setHeader('Content-Range', resp.headers.get('content-range'));

      await pipeline(Readable.fromWeb(resp.body), res);
    } else {
      // DASH stream - need to mux video + audio
      const audioFmt = pickYtDlpAudio(ytFmts);

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache');

      // BUG FIX: Pass rangeHeader to muxToResponse so it can handle it properly
      // Note: isDownload=false for proxy endpoint (streaming)
      await muxToResponse(videoFmt.url, audioFmt.url, res, controller.signal, seekSeconds, rangeHeader, false);
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
  } finally {
    _proxyCleanup();
  }
});

// ─── Stream ──────────────────────────────────────────────────────────────────

app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  // BUG FIX: Added seek support to stream endpoint
  const { quality = '720', audioOnly = 'false', t, start } = req.query;

  // BUG FIX: Parse seek time (same logic as proxy)
  let seekSeconds = 0;
  if (start !== undefined) {
    seekSeconds = Math.max(0, parseFloat(start) || 0);
  } else if (t !== undefined) {
    const tStr = String(t);
    if (/^\d+$/.test(tStr)) {
      seekSeconds = parseInt(tStr, 10);
    } else {
      const match = tStr.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?/);
      if (match) {
        const hours = parseInt(match[1] || 0) * 3600;
        const mins = parseInt(match[2] || 0) * 60;
        const secs = parseInt(match[3] || 0);
        seekSeconds = hours + mins + secs;
      }
    }
  }

  const streamSettings = authDb.prepare('SELECT max_connections FROM admin_settings WHERE id = 1').get();
  const maxStreams = streamSettings?.max_connections ?? MAX_CONCURRENT_STREAMS;
  if (activeStreamSet.size >= maxStreams) {
    return res.status(503).json({ error: 'Server is busy, please try again later.' });
  }

  const streamId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  activeStreamSet.add(streamId);
  let streamCleaned = false;
  const cleanup = () => { if (!streamCleaned) { streamCleaned = true; activeStreamSet.delete(streamId); } };

  // Bandwidth accounting for stream route
  const _sBwUser = getSessionUser(req.cookies?.session);
  const _sBwUid = _sBwUser?.id ?? null;
  const _sOrigWrite = res.write.bind(res);
  const _sOrigEnd = res.end.bind(res);
  res.write = function (chunk, ...args) {
    if (chunk) recordBandwidth(_sBwUid, Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk));
    return _sOrigWrite(chunk, ...args);
  };
  res.end = function (chunk, ...args) {
    if (chunk) recordBandwidth(_sBwUid, Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk));
    return _sOrigEnd(chunk, ...args);
  };

  const controller = new AbortController();
  req.on('close', () => { controller.abort(); cleanup(); });

  try {
    const info = await getVideoInfo(videoId);
    const formats = getFormatsFromInfo(info);
    const qualityNum = parseInt(quality, 10);

    const format = audioOnly === 'true'
      ? selectBestFormat(formats, 999, true)
      : selectBestFormat(formats, qualityNum, false);

    // BUG FIX: If seeking is requested and format is separate video/audio (DASH),
    // we need to use muxToResponse instead of direct streaming
    if (seekSeconds > 0 && (!format.has_audio || !format.has_video)) {
      // Need to mux for seeking - fetch separate formats
      const videoFmt = selectVideoFormat(formats, qualityNum);
      const audioFmt = selectAudioFormat(formats);

      const videoUrl = await decipherUrl(videoFmt, info);
      const audioUrl = await decipherUrl(audioFmt, info);

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'none');
      res.setHeader('Cache-Control', 'no-cache');

      // Note: isDownload=false for stream endpoint
      await muxToResponse(videoUrl, audioUrl, res, controller.signal, seekSeconds, null, false);
    } else {
      // Direct stream (no seek or progressive format)
      const resp = await fetchFormatStream(format, info, controller.signal);
      res.setHeader('Content-Type', format.mime_type || 'video/mp4');
      res.setHeader('Cache-Control', 'public, max-age=3600');

      // BUG FIX: Only support ranges when not seeking
      if (seekSeconds === 0) {
        res.setHeader('Accept-Ranges', 'bytes');
      } else {
        res.setHeader('Accept-Ranges', 'none');
      }

      await pipeline(Readable.fromWeb(resp.body), res);
    }
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

function getDownloadFormatConfig(format, bitrate, compression) {
  const configs = {
    mp4: {
      ext: 'mp4',
      mime: 'video/mp4',
      audioCodec: 'copy',
      isAudio: false,
    },
    mp3: {
      ext: 'mp3',
      mime: 'audio/mpeg',
      audioCodec: 'libmp3lame',
      args: ['-b:a', bitrate || '320k', '-ar', '44100'],
      isAudio: true,
    },
    flac: {
      ext: 'flac',
      mime: 'audio/flac',
      audioCodec: 'flac',
      args: ['-compression_level', String(compression ?? 5)],
      isAudio: true,
    },
    opus: {
      ext: 'opus',
      mime: 'audio/ogg',
      audioCodec: 'libopus',
      args: ['-b:a', bitrate || '160k', '-ar', '48000'],
      isAudio: true,
    },
    ogg: {
      ext: 'ogg',
      mime: 'audio/ogg',
      audioCodec: 'libvorbis',
      args: ['-b:a', bitrate || '192k', '-ar', '44100'],
      isAudio: true,
    },
    m4a: {
      ext: 'm4a',
      mime: 'audio/mp4',
      audioCodec: 'aac',
      args: ['-b:a', bitrate || '256k'],
      isAudio: true,
    },
  };
  return configs[format] || configs.mp4;
}

function spawnFfmpegAudio(audioUrl, codec, ffmpegFormat, extraArgs, signal, seekSeconds = 0) {
  return new Promise((resolve) => {
    const ytHeaders = [
      `User-Agent: ${getRandomUA()}`,
      'Accept: */*',
      'Accept-Language: en-US,en;q=0.9',
      'Origin: https://www.youtube.com',
      'Referer: https://www.youtube.com/',
    ].join('\r\n') + '\r\n';

    const ssArgs = seekSeconds > 0 ? ['-ss', seekSeconds.toFixed(3)] : [];

    const args = [
      '-loglevel', 'warning',
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      '-headers', ytHeaders,
      '-reconnect', '1',
      '-reconnect_on_network_error', '1',
      '-reconnect_delay_max', '5',
      ...ssArgs,
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

function sanitizeFilenameForHeader(filename) {
  if (!filename) return 'download';

  let sanitized = filename
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/\s+/g, '_')
    .trim();

  sanitized = sanitized.replace(/^[._]+|[._]+$/g, '');

  if (sanitized.length > 100) {
    sanitized = sanitized.substring(0, 100);
  }

  if (!sanitized) {
    sanitized = 'download';
  }

  return sanitized;
}

// Temp-file mux: download video+audio to disk, then serve with known Content-Length
function muxToTempFile(videoUrl, audioUrl, tempPath, signal, seekSeconds = 0) {
  return new Promise((resolve, reject) => {
    const ytHeaders = [
      `User-Agent: ${getRandomUA()}`,
      'Accept: */*',
      'Accept-Language: en-US,en;q=0.9',
      'Origin: https://www.youtube.com',
      'Referer: https://www.youtube.com/',
    ].join('\r\n') + '\r\n';

    const ssArg = seekSeconds > 0 ? seekSeconds.toFixed(3) : null;

    const args = ['-loglevel', 'error'];
    args.push('-protocol_whitelist', 'file,http,https,tcp,tls,crypto');

    // Video input
    args.push('-headers', ytHeaders);
    args.push('-reconnect', '1');
    args.push('-reconnect_streamed', '1');
    args.push('-reconnect_on_network_error', '1');
    args.push('-reconnect_delay_max', '10');
    if (ssArg) args.push('-ss', ssArg);
    args.push('-i', videoUrl);

    // Audio input
    args.push('-headers', ytHeaders);
    args.push('-reconnect', '1');
    args.push('-reconnect_streamed', '1');
    args.push('-reconnect_on_network_error', '1');
    args.push('-reconnect_delay_max', '10');
    if (ssArg) args.push('-ss', ssArg);
    args.push('-i', audioUrl);

    args.push('-map', '0:v:0');
    args.push('-map', '1:a:0');
    args.push('-c:v', 'copy');
    args.push('-c:a', 'copy');
    args.push('-avoid_negative_ts', 'make_zero');
    args.push('-max_muxing_queue_size', '4096');

    // Write to file — faststart puts moov atom at front for instant seek
    args.push('-movflags', '+faststart');
    args.push('-f', 'mp4');
    args.push(tempPath);

    console.log(`[ffmpeg-dl] Muxing to temp file seek=${seekSeconds}s → ${tempPath}`);

    const proc = spawn(FFMPEG, args);

    if (signal) {
      signal.addEventListener('abort', () => { try { proc.kill('SIGTERM'); } catch {} }, { once: true });
    }

    let stderrData = '';
    proc.stderr.on('data', d => {
      const msg = d.toString().trim();
      if (msg) {
        stderrData += msg + '\n';
        if (msg.includes('Error') || msg.includes('error') || msg.includes('Invalid')) {
          console.error('[ffmpeg-dl]', msg);
        }
      }
    });

    proc.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        if (stderrData) console.error('[ffmpeg-dl stderr]', stderrData.substring(0, 500));
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

// Temp-file audio: transcode audio to disk, then serve with known Content-Length
function audioToTempFile(audioUrl, codec, ffmpegFormat, extraArgs, tempPath, signal, seekSeconds = 0) {
  return new Promise((resolve, reject) => {
    const ytHeaders = [
      `User-Agent: ${getRandomUA()}`,
      'Accept: */*',
      'Accept-Language: en-US,en;q=0.9',
      'Origin: https://www.youtube.com',
      'Referer: https://www.youtube.com/',
    ].join('\r\n') + '\r\n';

    const ssArgs = seekSeconds > 0 ? ['-ss', seekSeconds.toFixed(3)] : [];

    const args = [
      '-loglevel', 'warning',
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      '-headers', ytHeaders,
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_on_network_error', '1',
      '-reconnect_delay_max', '10',
      ...ssArgs,
      '-i', audioUrl,
      '-vn',
      '-c:a', codec,
      ...extraArgs,
      '-f', ffmpegFormat,
      tempPath,
    ];

    console.log(`[ffmpeg-dl] Audio to temp file codec=${codec} → ${tempPath}`);

    const proc = spawn(FFMPEG, args);

    if (signal) {
      signal.addEventListener('abort', () => { try { proc.kill('SIGTERM'); } catch {} }, { once: true });
    }

    let stderrData = '';
    proc.stderr.on('data', d => {
      const msg = d.toString().trim();
      if (msg) {
        stderrData += msg + '\n';
        if (msg.includes('Error') || msg.includes('error') || msg.includes('Invalid')) {
          console.error('[ffmpeg-dl]', msg);
        }
      }
    });

    proc.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        if (stderrData) console.error('[ffmpeg-dl stderr]', stderrData.substring(0, 500));
        reject(new Error(`ffmpeg audio exited with code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

// ─── Download job store ───────────────────────────────────────────────────────
// jobs: { status:'preparing'|'muxing'|'ready'|'error', tempPath, ext, mime,
//          title, estimatedSize, finalSize, error, createdAt }
const downloadJobs = new Map();

function cleanupJob(jobId) {
  const job = downloadJobs.get(jobId);
  if (job) {
    try { fs.unlinkSync(job.tempPath); } catch {}
    downloadJobs.delete(jobId);
  }
}

// Phase 1 – start a job and return immediately
app.post('/api/download/start', async (req, res) => {
  const { videoId, format = 'mp4', quality = '720', title: titleParam, bitrate, compression } = req.query;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });

  const jobId = crypto.randomBytes(10).toString('hex');
  const formatConfig = getDownloadFormatConfig(format, bitrate, compression);
  const tempPath = path.join(os.tmpdir(), `ytdl_${jobId}.${formatConfig.ext}`);

  const job = {
    status: 'preparing',
    tempPath,
    ext: formatConfig.ext,
    mime: formatConfig.mime,
    title: titleParam || `video_${videoId}`,
    estimatedSize: null,
    finalSize: null,
    error: null,
    createdAt: Date.now(),
  };
  downloadJobs.set(jobId, job);

  // Respond immediately so the client isn't kept waiting
  res.json({ jobId, title: job.title });

  // Run FFmpeg in background
  (async () => {
    try {
      ytdlpCache.delete(videoId);
      ytdlpInFlight.delete(videoId);

      let data;
      try {
        data = await getYtDlpFormatsWithRetry(videoId);
      } catch (ytdlpError) {
        const info = await getVideoInfo(videoId);
        const fmts = getFormatsFromInfo(info);
        data = {
          formats: [
            ...fmts.videoFormats.map(f => ({
              url: f.url, height: f.height, width: f.width,
              vcodec: f.has_video ? 'avc1' : 'none', acodec: f.has_audio ? 'mp4a' : 'none',
              ext: 'mp4', format_id: f.itag,
            })),
            ...fmts.adaptiveFormats.map(f => ({
              url: f.url, height: f.height, width: f.width,
              vcodec: f.has_video ? 'avc1' : 'none', acodec: f.has_audio ? 'mp4a' : 'none',
              ext: 'mp4', format_id: f.itag,
            })),
          ],
          meta: { title: info.basic_info?.title || '', duration: info.basic_info?.duration || 0 },
        };
      }

      const { formats: ytFmts, meta } = data;
      if (meta?.title) job.title = meta.title;

      const qualityNum = parseInt(quality, 10);

      if (format === 'mp4') {
        const videoFmt = pickYtDlpVideo(ytFmts, qualityNum);
        const audioFmt = pickYtDlpAudio(ytFmts);
        if (!videoFmt || !audioFmt) throw new Error('No suitable video or audio formats found');

        // Use yt-dlp reported sizes for a realistic total estimate
        const vs = videoFmt.filesize || videoFmt.filesize_approx || 0;
        const as = audioFmt.filesize || audioFmt.filesize_approx || 0;
        if (vs + as > 0) job.estimatedSize = vs + as;

        job.status = 'muxing';
        await muxToTempFile(videoFmt.url, audioFmt.url, tempPath, null, 0);
      } else {
        const audioFmt = pickYtDlpAudio(ytFmts);
        if (!audioFmt) throw new Error('No audio format available');

        const as = audioFmt.filesize || audioFmt.filesize_approx || 0;
        if (as > 0) job.estimatedSize = as;

        job.status = 'muxing';
        const ffmpegFormat = format === 'm4a' ? 'mp4' : formatConfig.ext;
        await audioToTempFile(
          audioFmt.url, formatConfig.audioCodec, ffmpegFormat,
          formatConfig.args || [], tempPath, null, 0,
        );
      }

      const { size } = fs.statSync(tempPath);
      job.finalSize = size;
      job.status = 'ready';
      console.log(`[download] job=${jobId} ${format} size=${(size/1024/1024).toFixed(1)}MB ready`);

      // Auto-clean after 30 minutes if client never fetches
      setTimeout(() => cleanupJob(jobId), 30 * 60 * 1000);
    } catch (err) {
      console.error(`[download] job=${jobId} error:`, err.message);
      job.status = 'error';
      job.error = err.message;
      try { fs.unlinkSync(tempPath); } catch {}
      setTimeout(() => downloadJobs.delete(jobId), 5 * 60 * 1000);
    }
  })();
});

// Phase 2 – poll status + size on disk for progress
app.get('/api/download/status/:jobId', (req, res) => {
  const job = downloadJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  let fileSizeOnDisk = 0;
  if (job.status === 'muxing' || job.status === 'ready') {
    try { fileSizeOnDisk = fs.statSync(job.tempPath).size; } catch {}
  }

  res.json({
    status: job.status,
    fileSizeOnDisk,
    estimatedSize: job.finalSize || job.estimatedSize || null,
    title: job.title,
    ext: job.ext,
    error: job.error,
  });
});

// Phase 3 – serve the completed file
app.get('/api/download/file/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = downloadJobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'ready') return res.status(409).json({ error: `Not ready: ${job.status}` });

  const safeTitle = sanitizeFilenameForHeader(job.title);
  res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.${job.ext}"`);
  res.setHeader('Content-Type', job.mime);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  console.log(`[download] job=${jobId} sending ${(job.finalSize/1024/1024).toFixed(1)}MB to client`);

  res.sendFile(job.tempPath, { dotfiles: 'allow' }, (err) => {
    cleanupJob(jobId);
    if (err && !res.headersSent) {
      console.error('[download] sendFile error:', err.message);
    }
  });
});

// ─── Trending ────────────────────────────────────────────────────────────────

const trendingCache = { data: null, ts: 0 };
const TRENDING_TTL = 30 * 60 * 1000;

async function fetchTrendingYtDlp() {
  // Primary: use youtubei.js search (YouTube's trending feed URL is blocked for bots)
  if (youtube) {
    try {
      const results = await youtube.search('trending');
      const vids = (results.videos || []).slice(0, 40).map(v => ({
        id: v.id,
        title: v.title?.text || v.title || 'Video',
        thumbnail: v.best_thumbnail?.url || v.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
        duration: v.duration?.text || v.duration || '',
        views: v.view_count?.text || v.short_view_count?.text || '',
        channel: v.author?.name || v.channel?.name || '',
        channelId: v.author?.id || v.channel?.id || '',
        channelAvatar: v.author?.best_thumbnail?.url || v.author?.thumbnails?.[0]?.url || '',
        published: v.published?.text || '',
      })).filter(v => v.id);
      if (vids.length > 0) {
        console.log(`[trending] got ${vids.length} videos via search`);
        return vids;
      }
    } catch (e) {
      console.warn('[trending] youtube.search failed:', e.message);
    }
  }

  // Fallback: yt-dlp search syntax (ytsearch doesn't hit the blocked trending URL)
  try {
    const raw = await new Promise((resolve, reject) => {
      const args = [
        '--flat-playlist', '--no-warnings', '--quiet',
        ...buildYtDlpArgs('web'),
        '--playlist-items', '1-40',
        '-J', 'ytsearch40:trending',
      ];
      const proc = spawn(YTDLP, args, { env: { ...process.env, HTTP_USER_AGENT: getRandomUA() } });
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
    const entries = raw.entries || [];
    if (entries.length > 0) {
      return entries.map(v => ({
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
  } catch (e) {
    console.warn('[trending] yt-dlp search fallback failed:', e.message);
  }

  throw new Error('All trending sources failed');
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

// ─── Shorts (actual YouTube Shorts — duration ≤ 60s) ─────────────────────────

const shortsCache = { data: null, ts: 0 };
const SHORTS_TTL = 20 * 60 * 1000;

function isActualShort(v) {
  // A video is considered a short if it has a duration <= 62s OR if the URL contains /shorts/
  if (v.duration && v.duration > 62) return false;
  if (v.webpage_url && v.webpage_url.includes('/shorts/')) return true;
  if (v.url && v.url.includes('/shorts/')) return true;
  if (v.duration && v.duration <= 62) return true;
  // No duration info — accept it only from shorts-specific sources
  return false;
}

async function fetchActualShorts(offset = 0) {
  // ── 1. Try innertube hashtag API (most reliable for actual shorts) ───────
  if (youtube) {
    try {
      const hashtag = await youtube.getHashtag('shorts');
      const videos = hashtag?.videos || hashtag?.contents || [];
      const shorts = videos
        .filter(v => v.id || v.video_id)
        .map(v => {
          const id = v.id || v.video_id || v.videoId;
          const durSecs = v.duration?.seconds ?? v.duration ?? 0;
          return {
            id,
            title: v.title?.text || v.title || 'Short',
            thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            duration: durSecs ? formatSecondsToTime(durSecs) : '',
            durationSecs: durSecs,
            views: v.view_count?.text || v.views?.text || '',
            channel: v.author?.name || v.channel?.name || '',
            channelId: v.author?.id || v.channel?.id || '',
            channelAvatar: v.author?.thumbnails?.[0]?.url || '',
            isShort: true,
          };
        })
        .filter(v => v.id && (!v.durationSecs || v.durationSecs <= 62))
        .slice(0, 30);

      if (shorts.length >= 5) {
        console.log(`[shorts] Got ${shorts.length} shorts via innertube hashtag`);
        return shorts;
      }
    } catch (e) {
      console.warn('[shorts] innertube hashtag failed:', e.message);
    }
  }

  // ── 2. yt-dlp from the /shorts/ page ─────────────────────────────────────
  const ytdlpArgs = buildYtDlpArgs('tv_embedded');
  const start = offset + 1;
  const end = offset + 60;

  const sources = [
    'https://www.youtube.com/shorts/',
    'https://www.youtube.com/hashtag/shorts',
  ];

  for (const src of sources) {
    try {
      const raw = await new Promise((resolve, reject) => {
        const args = [
          '--flat-playlist', '--no-warnings', '--quiet',
          ...ytdlpArgs,
          '--playlist-items', `${start}-${end}`,
          '-J', src,
        ];
        const proc = spawn(YTDLP, args, { env: { ...process.env, HTTP_USER_AGENT: getRandomUA() } });
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
      // From /shorts/ page: all entries are actual shorts; also enforce duration when available
      const shorts = entries
        .filter(v => !v.duration || v.duration <= 62)
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

  // ── 3. Final fallback: search #shorts via innertube ───────────────────────
  if (youtube) {
    try {
      const results = await youtube.search('#shorts', { type: 'video' });
      return (results.videos || [])
        .filter(v => v.id)
        .map(v => {
          const durSecs = v.duration?.seconds ?? 0;
          return {
            id: v.id,
            title: v.title?.text || 'Short',
            thumbnail: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
            duration: v.duration?.text || '',
            durationSecs: durSecs,
            views: v.view_count?.text || '',
            channel: v.author?.name || '',
            channelId: v.author?.id || '',
            channelAvatar: v.author?.thumbnails?.[0]?.url || '',
            isShort: true,
          };
        })
        .filter(v => !v.durationSecs || v.durationSecs <= 62)
        .slice(0, 30);
    } catch (e) {
      console.warn('[shorts] search fallback failed:', e.message);
    }
  }

  return [];
}

app.get('/api/shorts', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    if (!force && shortsCache.data && Date.now() - shortsCache.ts < SHORTS_TTL) {
      return res.json(shortsCache.data);
    }

    if (force) {
      shortsCache.data = null;
      shortsCache.ts = 0;
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

// ─── Personalized Shorts (based on watch history) ────────────────────────────

app.get('/api/shorts/personalized', requireAuth, async (req, res) => {
  try {
    // Get recent channel IDs from watch history (last 30 entries, distinct channels)
    const historyRows = authDb.prepare(
      'SELECT DISTINCT channel_id FROM watch_history WHERE user_id = ? AND channel_id != "" ORDER BY watched_at DESC LIMIT 30'
    ).all(req.user.id);

    const channelIds = historyRows.map(r => r.channel_id).filter(Boolean);

    if (channelIds.length === 0) {
      return res.status(200).json({ shorts: [] });
    }

    const ytdlpArgs = buildYtDlpArgs('tv_embedded');
    const results = [];

    // Pick up to 6 channels, shuffle for variety
    const shuffled = channelIds.sort(() => Math.random() - 0.5).slice(0, 6);

    await Promise.allSettled(shuffled.map(async (channelId) => {
      try {
        const channelUrl = /^UC[a-zA-Z0-9_\-]{10,}$/.test(channelId)
          ? `https://www.youtube.com/channel/${channelId}/shorts`
          : `https://www.youtube.com/${channelId}/shorts`;

        const raw = await new Promise((resolve, reject) => {
          const args = [
            '--flat-playlist', '--no-warnings', '--quiet',
            ...ytdlpArgs,
            '--playlist-items', '1-15',
            '-J', channelUrl,
          ];
          const proc = spawn(YTDLP, args, { env: { ...process.env, HTTP_USER_AGENT: getRandomUA() } });
          let out = '';
          const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} reject(new Error('timeout')); }, 20000);
          proc.stdout.on('data', d => { out += d; });
          proc.stderr.on('data', () => {});
          proc.on('close', code => {
            clearTimeout(timer);
            if (code !== 0) return reject(new Error(`exit ${code}`));
            try { resolve(JSON.parse(out)); } catch { reject(new Error('parse')); }
          });
          proc.on('error', e => { clearTimeout(timer); reject(e); });
        });

        const entries = (raw.entries || []).filter(v => v.id && (!v.duration || v.duration <= 62));
        entries.slice(0, 5).forEach(v => {
          results.push({
            id: v.id,
            title: v.title || 'Short',
            thumbnail: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
            duration: v.duration ? formatSecondsToTime(v.duration) : '',
            durationSecs: v.duration || 0,
            views: v.view_count ? formatViewCount(v.view_count) : '',
            channel: v.uploader || v.channel || raw.uploader || raw.channel || '',
            channelId: v.uploader_id || v.channel_id || channelId,
            channelAvatar: '',
            isShort: true,
          });
        });
      } catch {}
    }));

    if (results.length < 5) {
      return res.status(200).json({ shorts: [] });
    }

    // Shuffle results
    const shorts = results.sort(() => Math.random() - 0.5);
    res.json({ shorts });
  } catch (e) {
    console.error('[shorts/personalized] error:', e.message);
    res.status(500).json({ shorts: [], error: e.message });
  }
});

// ─── Health ──────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    youtube: !!youtube,
    activeStreams: activeStreamSet.size,
    cookies: hasCookies(),
    visitorData: !!YOUTUBE_VISITOR_DATA,
    poToken: !!YOUTUBE_PO_TOKEN,
  });
});

// Catch unmatched API routes and return JSON (not HTML)
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

// Global error handler — ensures unhandled exceptions return JSON, not HTML
app.use((err, req, res, next) => {
  console.error('[server] unhandled error:', err?.message || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err?.message || 'Internal server error' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Bot bypass: cookies=${hasCookies()} visitor_data=${!!YOUTUBE_VISITOR_DATA} po_token=${!!YOUTUBE_PO_TOKEN}`);
});

const wss = new WebSocketServer({ server });
const wsClients = new Map(); // videoId -> Set of clients

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const videoId = url.searchParams.get('v');
  const isAdmin = url.searchParams.get('admin') === '1';

  // Parse cookies from the WS upgrade request (Express middleware doesn't run here)
  const wsCookies = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=');
    if (k) wsCookies[k.trim()] = decodeURIComponent(v.join('='));
  });
  const wsUser = !isAdmin ? getSessionUser(wsCookies.session) : null;

  if (isAdmin) {
    adminWsClients.add(ws);
    // Send current watching state immediately on connect
    const cfg = authDb.prepare('SELECT allow_co_watch FROM admin_settings WHERE id = 1').get();
    if (cfg?.allow_co_watch) {
      const now = Date.now();
      const active = [];
      for (const entry of watchingNow.values()) {
        if (now - entry.updatedAt < 35000) active.push(entry);
      }
      ws.send(JSON.stringify({ type: 'watching_update', watching: active }));
    } else {
      ws.send(JSON.stringify({ type: 'watching_update', watching: [] }));
    }
  } else if (videoId) {
    if (!wsClients.has(videoId)) {
      wsClients.set(videoId, new Set());
    }
    wsClients.get(videoId).add(ws);
    ws.send(JSON.stringify({ type: 'ready', videoId }));
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      // Peer seek broadcast (video room clients)
      if (msg.type === 'seek' && msg.time !== undefined && videoId) {
        const clients = wsClients.get(videoId);
        if (clients) {
          clients.forEach(client => {
            if (client !== ws && client.readyState === 1) {
              client.send(JSON.stringify({ type: 'seek', time: msg.time, from: 'peer' }));
            }
          });
        }
      }
      // Co-watch interest registration — admin indicates which user they are watching
      if (msg.type === 'cowatch_join' && isAdmin && msg.userId) {
        coWatchTargets.set(ws, parseInt(msg.userId, 10));
        // Immediately push the current state of that user if available
        const entry = watchingNow.get(parseInt(msg.userId, 10));
        if (entry && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'cowatch_update', data: entry }));
        }
      }
      if (msg.type === 'cowatch_leave' && isAdmin) {
        coWatchTargets.delete(ws);
      }
      // Real-time position update from a user's player — 200ms interval, no HTTP involved
      if (msg.type === 'position_update' && !isAdmin && wsUser?.id) {
        const entry = {
          userId: wsUser.id,
          username: wsUser.username,
          videoId: msg.videoId || videoId || '',
          title: msg.title || '',
          thumbnail: msg.thumbnail || '',
          position: parseFloat(msg.position) || 0,
          paused: !!msg.paused,
          speed: parseFloat(msg.speed) || 1,
          quality: msg.quality || null,
          subtitleLang: msg.subtitleLang || null,
          subtitlesOn: !!msg.subtitlesOn,
          updatedAt: Date.now(),
        };
        watchingNow.set(wsUser.id, entry);
        pushCowatchUpdate(wsUser.id, entry); // instant push to co-watching admin detail view
        // Also update the admin watching list, throttled to max once per 2s per user
        const lastBroadcast = watchingBroadcastThrottle.get(wsUser.id) || 0;
        if (Date.now() - lastBroadcast > 2000) {
          watchingBroadcastThrottle.set(wsUser.id, Date.now());
          broadcastWatchingToAdmins();
        }
      }
    } catch (e) {
      // Invalid JSON, ignore
    }
  });

  ws.on('close', () => {
    if (isAdmin) {
      adminWsClients.delete(ws);
      coWatchTargets.delete(ws); // clean up any co-watch registration
    } else {
      if (wsUser?.id) watchingBroadcastThrottle.delete(wsUser.id);
      if (videoId && wsClients.has(videoId)) {
        wsClients.get(videoId).delete(ws);
        if (wsClients.get(videoId).size === 0) wsClients.delete(videoId);
      }
    }
  });
});