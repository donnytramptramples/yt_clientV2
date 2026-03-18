import express from 'express';
import { Innertube, UniversalCache } from 'youtubei.js';
import { spawn } from 'child_process';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

process.env.PATH = `${process.env.HOME}/.local/bin:${process.env.PATH}`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 10000;

// Limit concurrent ffmpeg processes to prevent OOM (Render free tier style RAM)
const MAX_CONCURRENT_STREAMS = 3;
let activeStreams = 0;

// Limit concurrent yt-dlp calls (reduces bursty extraction)
const MAX_CONCURRENT_YTDLP = 2;
let activeYtDlp = 0;
const ytdlpWaiters = [];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function acquireYtDlp() {
  if (activeYtDlp < MAX_CONCURRENT_YTDLP) {
    activeYtDlp++;
    return;
  }
  await new Promise(resolve => ytdlpWaiters.push(resolve));
  activeYtDlp++;
}

function releaseYtDlp() {
  activeYtDlp = Math.max(0, activeYtDlp - 1);
  const next = ytdlpWaiters.shift();
  if (next) next();
}

async function runYtDlp(args, timeoutMs = 25000) {
  await acquireYtDlp();
  try {
    return await new Promise((resolve) => {
      const proc = spawn('yt-dlp', args);
      let out = '', err = '';

      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) {}
      }, timeoutMs);

      proc.stdout.on('data', d => { out += d.toString(); });
      proc.stderr.on('data', d => { err += d.toString(); });

      proc.on('close', code => {
        clearTimeout(timer);
        resolve({ code, out, err });
      });

      proc.on('error', () => {
        clearTimeout(timer);
        resolve({ code: -1, out, err: err || 'spawn error' });
      });
    });
  } finally {
    releaseYtDlp();
  }
}

// log yt-dlp version
runYtDlp(['--version'], 8000).then(r => {
  console.log('[yt-dlp] version:', (r.out || r.err || '').trim());
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));

// In-memory URL cache (signed googlevideo URLs expire; keep short-ish TTL)
const urlCache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4h

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of urlCache) {
    if (now - val.ts > CACHE_TTL) urlCache.delete(key);
  }
}, 30 * 60 * 1000);

/**
 * Try to get DASH URLs (video+audio) suitable for ffmpeg mux/transcode (your old flow).
 */
async function getDashStreamUrls(videoId, quality, audioOnly) {
  const key = `${videoId}:dash:${quality}:${audioOnly}`;
  const cached = urlCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.urls;

  // Prefer H.264 for compatibility
  const ytFormat = audioOnly
    ? 'bestaudio/best'
    : [
        `bestvideo[vcodec^=avc1][height<=${quality}]+bestaudio/bestaudio`,
        `bestvideo[height<=${quality}]+bestaudio/bestaudio`,
        `best[height<=${quality}]`,
        'best'
      ].join('/');

  // Try multiple clients
  const clients = ['mweb', 'android', 'web'];

  for (const client of clients) {
    const args = [
      '--no-check-certificate',
      '--no-warnings',
      '--extractor-args', `youtube:player_client=${client}`,
      '-g',
      '-f', ytFormat,
      '--no-playlist',
      '--socket-timeout', '20',
      `https://www.youtube.com/watch?v=${videoId}`
    ];

    const { code, out, err } = await runYtDlp(args, 25000);

    if (code === 0) {
      const urls = out.trim().split('\n').filter(Boolean);
      if (urls.length > 0) {
        console.log(`[yt-dlp] ${videoId} DASH success with ${client}, ${urls.length} URLs`);
        urlCache.set(key, { urls, ts: Date.now() });
        return urls;
      }
    }

    console.log(`[yt-dlp] ${videoId} DASH failed with ${client}: ${err.slice(-200)}`);
    await sleep(600);
  }

  throw new Error('All player clients failed - YouTube may be blocking requests');
}

/**
 * NEW: Get a single progressive MP4 URL for best browser UX (duration, seek, cache).
 */
async function getProgressiveMp4Url(videoId, quality) {
  const key = `${videoId}:mp4:${quality}`;
  const cached = urlCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.urls[0];

  // Prefer a single-file MP4 (progressive) so browsers can seek + show duration properly
  const fmt = [
    `best[ext=mp4][height<=${quality}]`,
    `best[ext=mp4]`,
    `best`
  ].join('/');

  // Put android first (it worked for you with Rick)
  const clients = ['android', 'mweb', 'web'];

  for (const client of clients) {
    const args = [
      '--no-check-certificate',
      '--no-warnings',
      '--extractor-args', `youtube:player_client=${client}`,
      '-g',
      '-f', fmt,
      '--no-playlist',
      '--socket-timeout', '20',
      `https://www.youtube.com/watch?v=${videoId}`
    ];

    const { code, out, err } = await runYtDlp(args, 25000);

    if (code === 0) {
      const url = out.trim().split('\n').filter(Boolean)[0];
      if (url) {
        console.log(`[yt-dlp] ${videoId} MP4 success with ${client}`);
        urlCache.set(key, { urls: [url], ts: Date.now() });
        return url;
      }
    }

    console.log(`[yt-dlp] ${videoId} MP4 failed with ${client}: ${err.slice(-200)}`);
    await sleep(600);
  }

  throw new Error('Could not get progressive MP4 URL (all clients failed)');
}

let youtube;

// YouTube.js init
async function initYouTube() {
  try {
    youtube = await Innertube.create({
      cache: new UniversalCache(false),
      generate_session_locally: false,
      enable_session_cache: true,
      retrieve_player: true
    });
    console.log(">>> [SUCCESS] YouTube API Initialised");
  } catch (e) {
    console.error(">>> [ERROR] Init Failed:", e.message);
  }
}
initYouTube();

/**
 * SEARCH
 */
app.get('/api/search', async (req, res) => {
  try {
    if (!youtube) return res.status(503).json({ error: "API Initialising..." });
    const { q } = req.query;
    const results = await youtube.search(q, { type: 'video' });

    const videos = (results.videos || []).map(v => ({
      id: v.id,
      title: v.title?.text || "Video",
      thumbnail: v.thumbnails?.[0]?.url || "",
      duration: v.duration?.text || "0:00",
      views: v.view_count?.text || "0",
      channel: v.author?.name || "Channel",
      channelAvatar: v.author?.thumbnails?.[0]?.url || ""
    }));

    res.json({ videos });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * INFO (duration/title)
 * Tries youtubei.js first; falls back to yt-dlp.
 */
app.get('/api/info/:videoId', async (req, res) => {
  const { videoId } = req.params;

  // 1) Try youtubei.js basic info first
  if (youtube) {
    try {
      const info = await youtube.getBasicInfo(videoId);
      const duration = Number(info?.basic_info?.duration) || 0;
      const title = info?.basic_info?.title || '';
      if (duration > 0) return res.json({ duration, title, source: 'youtubei.js' });
    } catch (e) {
      console.log('[info] youtubei.js failed:', e.message);
    }
  }

  // 2) Fallback to yt-dlp
  const clients = ['android', 'mweb', 'web'];
  for (const client of clients) {
    try {
      const ytArgs = [
        '--no-check-certificate',
        '--no-warnings',
        '--extractor-args', `youtube:player_client=${client}`,
        '--print', 'duration',
        '--print', 'title',
        '--no-playlist',
        '--socket-timeout', '15',
        `https://www.youtube.com/watch?v=${videoId}`
      ];

      const { code, out, err } = await runYtDlp(ytArgs, 20000);
      if (code === 0) {
        const lines = out.trim().split('\n');
        const duration = parseFloat(lines[0]) || 0;
        const title = lines.slice(1).join('\n') || '';
        if (duration > 0) return res.json({ duration, title, source: `yt-dlp:${client}` });
      } else {
        console.log(`[info] yt-dlp failed ${client}: ${err.slice(-200)}`);
      }
    } catch (_) {}
  }

  console.error('Info error: All clients failed for', videoId);
  res.status(502).json({
    error: 'Could not fetch video info',
    fallback: { type: 'youtube-embed', url: `https://www.youtube.com/embed/${videoId}` }
  });
});

/**
 * NEW: PROXY endpoint for playback (recommended)
 * - Forwards Range requests to upstream so browser seeking works.
 * - Much better UX than fragmented MP4 piping.
 */
app.get('/api/proxy/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { quality = '720' } = req.query;

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const upstreamUrl = await getProgressiveMp4Url(videoId, quality);

    const headers = {};
    if (req.headers.range) headers['Range'] = req.headers.range;

    const upstream = await fetch(upstreamUrl, {
      headers,
      signal: controller.signal
    });

    // Mirror status (200 or 206 typically)
    res.status(upstream.status);

    // Pass through key headers
    const passthrough = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'etag',
      'last-modified'
    ];
    for (const h of passthrough) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }

    // Improve caching behavior (browser + SW)
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Vary', 'Range');

    if (!upstream.body) {
      return res.status(502).json({
        error: 'Upstream returned no body',
        fallback: { type: 'youtube-embed', url: `https://www.youtube.com/embed/${videoId}` }
      });
    }

    // Convert WebStream to Node stream and pipe
    await pipeline(Readable.fromWeb(upstream.body), res);

  } catch (e) {
    if (controller.signal.aborted) return;
    console.error('[proxy] error:', e.message);
    res.status(502).json({
      error: e.message,
      fallback: { type: 'youtube-embed', url: `https://www.youtube.com/embed/${videoId}` }
    });
  }
});

/**
 * STREAM (legacy / fallback): yt-dlp URLs + ffmpeg -> fragmented MP4 pipe
 */
app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { quality = '720', audioOnly = 'false', start = '0' } = req.query;
  const startSec = parseFloat(start) || 0;

  if (activeStreams >= MAX_CONCURRENT_STREAMS) {
    return res.status(503).json({ error: 'Server busy, please try again' });
  }

  activeStreams++;
  let ffmpeg = null;

  const cleanup = () => {
    activeStreams = Math.max(0, activeStreams - 1);
    if (ffmpeg) {
      try { ffmpeg.kill('SIGKILL'); } catch (_) {}
    }
  };

  try {
    const urls = await getDashStreamUrls(videoId, quality, audioOnly === 'true');
    const videoUrl = urls[0];
    const audioUrl = urls[1] || null;

    console.log(`[stream] ${videoId} q=${quality} audioOnly=${audioOnly} urls=${urls.length}`);

    const seekArgs = startSec > 0 ? ['-ss', String(startSec)] : [];
    const inputOpts = [
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5'
    ];

    // Fragmented MP4 for pipe output
    const outFlags = ['-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof'];

    let ffmpegArgs;
    if (audioOnly === 'true') {
      ffmpegArgs = [
        ...inputOpts, ...seekArgs, '-i', videoUrl,
        '-vn', '-c:a', 'aac', '-b:a', '128k',
        ...outFlags, 'pipe:1'
      ];
      res.setHeader('Content-Type', 'audio/mp4');
    } else if (audioUrl) {
      ffmpegArgs = [
        ...inputOpts, ...seekArgs, '-i', videoUrl,
        ...inputOpts, ...seekArgs, '-i', audioUrl,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-shortest',
        ...outFlags, 'pipe:1'
      ];
      res.setHeader('Content-Type', 'video/mp4');
    } else {
      ffmpegArgs = [
        ...inputOpts, ...seekArgs, '-i', videoUrl,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        ...outFlags, 'pipe:1'
      ];
      res.setHeader('Content-Type', 'video/mp4');
    }

    ffmpeg = spawn('ffmpeg', ffmpegArgs);

    let ffErr = '';
    let bytesWritten = 0;

    ffmpeg.stdout.on('data', chunk => {
      bytesWritten += chunk.length;
      if (!res.writableEnded) res.write(chunk);
    });

    ffmpeg.stdout.on('end', () => {
      if (!res.writableEnded) res.end();
    });

    ffmpeg.stderr.on('data', d => {
      ffErr += d.toString();
      if (ffErr.length > 8000) ffErr = ffErr.slice(-4000);
    });

    ffmpeg.on('close', code => {
      cleanup();
      if (code !== 0 && code !== null) {
        console.error(`[ffmpeg stream] ${videoId} exited ${code}, bytes written: ${bytesWritten}`);
        console.error(`[ffmpeg stderr]:`, ffErr.slice(-800));
      }
    });

    ffmpeg.on('error', err => {
      cleanup();
      console.error('[ffmpeg stream] spawn error:', err.message);
      if (!res.headersSent) res.status(500).send('Streaming error');
    });

    req.on('close', cleanup);

  } catch (error) {
    cleanup();
    console.error('Stream error:', error.message);
    if (!res.headersSent) {
      res.status(502).json({
        error: error.message,
        fallback: { type: 'youtube-embed', url: `https://www.youtube.com/embed/${videoId}` }
      });
    }
  }
});

/**
 * DOWNLOAD: keeps your old behavior (ffmpeg muxing/conversion).
 * You may also switch this to proxy+range if you want “download original mp4”.
 */
app.get('/api/download/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { format = 'mp4', quality = '720' } = req.query;
  const ext = { mp4: 'mp4', mp3: 'mp3', flac: 'flac', opus: 'opus', ogg: 'ogg' }[format] || 'mp4';
  const isAudio = format !== 'mp4';

  if (activeStreams >= MAX_CONCURRENT_STREAMS) {
    return res.status(503).json({ error: 'Server busy, please try again' });
  }

  activeStreams++;
  let ffmpeg = null;

  const cleanup = () => {
    activeStreams = Math.max(0, activeStreams - 1);
    if (ffmpeg) {
      try { ffmpeg.kill('SIGKILL'); } catch (_) {}
    }
  };

  try {
    const urls = await getDashStreamUrls(videoId, quality, isAudio);
    const videoUrl = urls[0];
    const audioUrl = urls[1] || null;

    res.setHeader('Content-Disposition', `attachment; filename="download_${videoId}.${ext}"`);

    const inputOpts = [
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5'
    ];

    let ffmpegArgs;
    if (isAudio) {
      const codecMap = { mp3: 'libmp3lame', flac: 'flac', opus: 'libopus', ogg: 'libvorbis' };
      const fmtMap = { mp3: 'mp3', flac: 'flac', opus: 'opus', ogg: 'ogg' };
      ffmpegArgs = [
        ...inputOpts, '-i', videoUrl,
        '-vn', '-c:a', codecMap[format] || 'libmp3lame', '-q:a', '0',
        '-f', fmtMap[format] || 'mp3', 'pipe:1'
      ];
      res.setHeader('Content-Type', `audio/${format}`);
    } else {
      ffmpegArgs = audioUrl
        ? [...inputOpts, '-i', videoUrl, ...inputOpts, '-i', audioUrl,
           '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
           '-c:a', 'aac', '-shortest', '-f', 'mp4', 'pipe:1']
        : [...inputOpts, '-i', videoUrl,
           '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
           '-c:a', 'aac', '-f', 'mp4', 'pipe:1'];
      res.setHeader('Content-Type', 'video/mp4');
    }

    ffmpeg = spawn('ffmpeg', ffmpegArgs);
    ffmpeg.stdout.pipe(res);
    ffmpeg.stderr.on('data', () => {});
    ffmpeg.on('error', err => {
      cleanup();
      console.error('[ffmpeg download] error:', err.message);
      if (!res.headersSent) res.status(500).send('Download error');
    });
    ffmpeg.on('close', () => cleanup());
    req.on('close', cleanup);

  } catch (error) {
    cleanup();
    console.error('Download error:', error.message);
    if (!res.headersSent) {
      res.status(502).json({
        error: error.message,
        fallback: { type: 'youtube-embed', url: `https://www.youtube.com/embed/${videoId}` }
      });
    }
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

// WebSocket (your progress signaling)
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  ws.on('message', () => {
    ws.send(JSON.stringify({ progress: 100 }));
    console.log('Progress signaled to client');
  });
});

console.log("Server fully staged and ready for traffic");
