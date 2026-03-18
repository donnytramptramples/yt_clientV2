import express from 'express';
import { Innertube, UniversalCache } from 'youtubei.js';
import { spawn } from 'child_process';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

process.env.PATH = `${process.env.HOME}/.local/bin:${process.env.PATH}`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 10000;

// Limit concurrent ffmpeg processes to prevent OOM (512MB total RAM)
// ultrafast preset uses ~100MB per stream, so 3 is safe
const MAX_CONCURRENT_STREAMS = 3;
let activeStreams = 0;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));

// URL cache: avoids re-running yt-dlp for the same video within a session.
// YouTube CDN URLs are signed and stay valid for ~6 hours.
const urlCache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000;

// Cleanup old cache entries periodically to save memory
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of urlCache) {
    if (now - val.ts > CACHE_TTL) urlCache.delete(key);
  }
}, 30 * 60 * 1000); // Every 30 minutes

async function getStreamUrls(videoId, quality, audioOnly) {
  const key = `${videoId}:${quality}:${audioOnly}`;
  const cached = urlCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.urls;

  // Prefer H.264 (avc1) so ffmpeg can copy-mux without re-encoding when possible.
  // ios client is reliable - returns HLS manifest URLs for both video and audio.
  const ytFormat = audioOnly
    ? 'bestaudio'
    : [
        `bestvideo[vcodec^=avc1][height<=${quality}]+bestaudio`,
        `bestvideo[height<=${quality}]+bestaudio`,
        `best[height<=${quality}]`,
        'best'
      ].join('/');

  const args = [
    '--no-check-certificate',
    '--extractor-args', 'youtube:player_client=ios',
    '-g', '-f', ytFormat,
    '--no-playlist',
    '--socket-timeout', '30',
    `https://www.youtube.com/watch?v=${videoId}`
  ];

  const proc = spawn('yt-dlp', args);
  let out = '', err = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { err += d; });

  await new Promise((resolve, reject) => {
    proc.on('close', code =>
      code === 0 ? resolve() : reject(new Error(err.slice(-800) || 'yt-dlp failed'))
    );
  });

  const urls = out.trim().split('\n').filter(Boolean);
  if (!urls.length) throw new Error('No stream URLs returned');

  urlCache.set(key, { urls, ts: Date.now() });
  return urls;
}

let youtube;

// Background Initialization
async function initYouTube() {
  try {
    youtube = await Innertube.create({
      cache: new UniversalCache(false),
      generate_session_locally: true,
      retrieve_player: true
    });
    console.log(">>> [SUCCESS] YouTube API Initialised");
  } catch (e) {
    console.error(">>> [ERROR] Init Failed:", e.message);
  }
}

initYouTube();

// Search endpoint
app.get('/api/search', async (req, res) => {
  try {
    if (!youtube) return res.status(503).json({ error: "API Initialising..." });
    const { q } = req.query;
    // type: 'video' avoids the ThumbnailView parser crash
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

// Info endpoint - returns duration and basic info for a video
app.get('/api/info/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    const ytArgs = [
      '--no-check-certificate',
      '--extractor-args', 'youtube:player_client=ios',
      '--print', 'duration',
      '--print', 'title',
      '--no-playlist',
      '--socket-timeout', '30',
      `https://www.youtube.com/watch?v=${videoId}`
    ];
    const proc = spawn('yt-dlp', ytArgs);
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    await new Promise((resolve, reject) => {
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(err.trim())));
    });
    const lines = out.trim().split('\n');
    const duration = parseFloat(lines[0]) || 0;
    const title = lines[1] || '';
    res.json({ duration, title });
  } catch (error) {
    console.error('Info error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Stream endpoint - uses yt-dlp to get CDN URLs, ffmpeg to transcode + mux
// into a fragmented MP4 the browser can play progressively without Content-Length.
app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { quality = '720', audioOnly = 'false', start = '0' } = req.query;
  const startSec = parseFloat(start) || 0;

  // Rate limit concurrent streams to prevent OOM (512MB RAM)
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
    const urls = await getStreamUrls(videoId, quality, audioOnly === 'true');
    const videoUrl = urls[0];
    const audioUrl = urls[1] || null;

    console.log(`[stream] ${videoId} q=${quality} audioOnly=${audioOnly} urls=${urls.length}`);

    // Always transcode to H.264/AAC fragmented MP4 - guarantees browser compatibility
    // protocol_whitelist + reconnect options for reliable HLS streaming
    const seekArgs = startSec > 0 ? ['-ss', String(startSec)] : [];
    const inputOpts = [
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data',
      '-reconnect', '1',
      '-reconnect_streamed', '1', 
      '-reconnect_delay_max', '5'
    ];
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
        ...inputOpts,
        ...seekArgs, '-i', videoUrl,
        ...inputOpts,
        ...seekArgs, '-i', audioUrl,
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
    ffmpeg.stdout.pipe(res);
    let ffErr = '';
    ffmpeg.stderr.on('data', d => { ffErr += d; });

    ffmpeg.on('close', code => {
      cleanup();
      if (code !== 0 && code !== null) {
        console.error(`[ffmpeg stream] exited ${code}:`, ffErr.slice(-400));
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
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// Download endpoint - uses yt-dlp for URL extraction, ffmpeg for muxing/conversion
app.get('/api/download/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { format = 'mp4', quality = '720' } = req.query;
  const ext = { mp4: 'mp4', mp3: 'mp3', flac: 'flac', opus: 'opus', ogg: 'ogg' }[format] || 'mp4';
  const isAudio = format !== 'mp4';

  // Rate limit concurrent downloads
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
    const urls = await getStreamUrls(videoId, quality, isAudio);
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
      const fmtMap  = { mp3: 'mp3', flac: 'flac', opus: 'opus', ogg: 'ogg' };
      ffmpegArgs = [
        ...inputOpts, '-i', videoUrl,
        '-vn', '-c:a', codecMap[format] || 'libmp3lame', '-q:a', '0',
        '-f', fmtMap[format] || 'mp3', 'pipe:1'
      ];
      res.setHeader('Content-Type', `audio/${format}`);
    } else {
      ffmpegArgs = audioUrl
        ? [...inputOpts, '-i', videoUrl, ...inputOpts, '-i', audioUrl, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-c:a', 'aac', '-shortest', '-f', 'mp4', 'pipe:1']
        : [...inputOpts, '-i', videoUrl, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-c:a', 'aac', '-f', 'mp4', 'pipe:1'];
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
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  ws.on('message', (message) => {
    // Restored your manual progress message logic
    ws.send(JSON.stringify({ progress: 100 }));
    console.log('Progress signaled to client');
  });
});

console.log("Server fully staged and ready for traffic");
