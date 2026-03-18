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
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached;

  // Use web client - most reliable for direct URLs
  // Request H.264 (avc1) which browsers can play natively
  const ytFormat = audioOnly
    ? 'bestaudio[ext=m4a]/bestaudio'
    : [
        `bestvideo[vcodec^=avc1][height<=${quality}]+bestaudio[ext=m4a]`,
        `bestvideo[vcodec^=avc1][height<=${quality}]+bestaudio`,
        `bestvideo[height<=${quality}]+bestaudio`,
        'best'
      ].join('/');

  // First get format info with -j (lowercase, single video info)
  const infoArgs = [
    '--no-check-certificate',
    '-j', '-f', ytFormat,
    '--no-playlist',
    '--socket-timeout', '15',
    `https://www.youtube.com/watch?v=${videoId}`
  ];

  const infoProc = spawn('yt-dlp', infoArgs);
  let infoOut = '', infoErr = '';
  infoProc.stdout.on('data', d => { infoOut += d; });
  infoProc.stderr.on('data', d => { infoErr += d; });

  const infoCode = await new Promise((resolve) => {
    const timeout = setTimeout(() => { infoProc.kill('SIGKILL'); resolve(-1); }, 20000);
    infoProc.on('close', code => { clearTimeout(timeout); resolve(code); });
    infoProc.on('error', () => { clearTimeout(timeout); resolve(-1); });
  });

  let vcodec = '', acodec = '';
  if (infoCode === 0) {
    try {
      const info = JSON.parse(infoOut.trim());
      vcodec = info.vcodec || (info.requested_formats?.[0]?.vcodec) || '';
      acodec = info.acodec || (info.requested_formats?.[1]?.acodec) || (info.requested_formats?.[0]?.acodec) || '';
    } catch (_) {}
  }

  // Now get the actual URLs with -g
  const urlArgs = [
    '--no-check-certificate',
    '-g', '-f', ytFormat,
    '--no-playlist',
    '--socket-timeout', '15',
    `https://www.youtube.com/watch?v=${videoId}`
  ];

  const urlProc = spawn('yt-dlp', urlArgs);
  let urlOut = '', urlErr = '';
  urlProc.stdout.on('data', d => { urlOut += d; });
  urlProc.stderr.on('data', d => { urlErr += d; });

  const urlCode = await new Promise((resolve) => {
    const timeout = setTimeout(() => { urlProc.kill('SIGKILL'); resolve(-1); }, 20000);
    urlProc.on('close', code => { clearTimeout(timeout); resolve(code); });
    urlProc.on('error', () => { clearTimeout(timeout); resolve(-1); });
  });

  if (urlCode !== 0) {
    throw new Error(urlErr.slice(-300) || 'yt-dlp failed to get URLs');
  }

  const urls = urlOut.trim().split('\n').filter(Boolean);
  if (!urls.length) throw new Error('No stream URLs returned');

  // Determine if we can use copy codec (H.264 + AAC) - avoids transcoding
  const canCopyVideo = vcodec.startsWith('avc1') || vcodec.includes('h264');
  const canCopyAudio = acodec.startsWith('mp4a') || acodec.includes('aac');

  const result = { 
    urls, 
    ts: Date.now(), 
    canCopyVideo, 
    canCopyAudio,
    vcodec,
    acodec
  };
  
  urlCache.set(key, result);
  console.log(`[yt-dlp] Got ${urls.length} URL(s), vcodec=${vcodec}, acodec=${acodec}, canCopy=${canCopyVideo}/${canCopyAudio}`);
  return result;
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

// Stream endpoint - uses yt-dlp to get CDN URLs, ffmpeg to mux/transcode
// Always transcodes to ensure browser compatibility and fix format errors
app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { quality = '720', audioOnly = 'false', start = '0' } = req.query;
  const startSec = parseFloat(start) || 0;
  const isAudioOnly = audioOnly === 'true';

  // Rate limit concurrent streams to prevent OOM
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
    const streamInfo = await getStreamUrls(videoId, quality, isAudioOnly);
    const { urls, canCopyVideo, canCopyAudio } = streamInfo;
    const videoUrl = urls[0];
    const audioUrl = urls[1] || null;

    console.log(`[stream] ${videoId} - URLs: ${urls.length}, canCopy: v=${canCopyVideo} a=${canCopyAudio}`);

    // Build ffmpeg args - always use fragmented MP4 for streaming
    const seekArgs = startSec > 0 ? ['-ss', String(startSec)] : [];
    
    // Memory-saving options
    const memOpts = ['-threads', '2', '-analyzeduration', '1M', '-probesize', '1M'];
    
    // Fragmented MP4 flags - essential for streaming without Content-Length
    const outFlags = ['-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof'];

    let ffmpegArgs;
    
    if (isAudioOnly) {
      ffmpegArgs = [
        ...memOpts, ...seekArgs, '-i', videoUrl,
        '-vn', '-c:a', 'aac', '-b:a', '128k',
        ...outFlags, 'pipe:1'
      ];
      res.setHeader('Content-Type', 'audio/mp4');
    } else if (audioUrl) {
      // Two separate streams - mux them together
      // Always transcode video to H.264 to ensure compatibility
      ffmpegArgs = [
        ...memOpts,
        ...seekArgs, '-i', videoUrl,
        ...seekArgs, '-i', audioUrl,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-shortest',
        ...outFlags, 'pipe:1'
      ];
      res.setHeader('Content-Type', 'video/mp4');
    } else {
      // Single URL - transcode to ensure compatibility
      ffmpegArgs = [
        ...memOpts, ...seekArgs, '-i', videoUrl,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        ...outFlags, 'pipe:1'
      ];
      res.setHeader('Content-Type', 'video/mp4');
    }

    // Set headers for streaming
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('Cache-Control', 'no-cache');
    
    console.log(`[ffmpeg] Starting with args:`, ffmpegArgs.slice(0, 8).join(' '), '...');
    
    ffmpeg = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    ffmpeg.stdout.pipe(res);
    
    let ffErr = '';
    ffmpeg.stderr.on('data', d => { 
      ffErr += d.toString();
      if (ffErr.length > 4000) ffErr = ffErr.slice(-2000);
    });

    ffmpeg.on('close', code => {
      cleanup();
      if (code !== 0 && code !== null && !res.writableEnded) {
        console.error(`[ffmpeg stream] exited ${code}:`, ffErr.slice(-500));
      }
    });
    
    ffmpeg.on('error', err => {
      cleanup();
      console.error('[ffmpeg stream] spawn error:', err.message);
      if (!res.headersSent) res.status(500).send('Streaming error');
    });

    req.on('close', cleanup);
    req.on('error', cleanup);

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
    const streamInfo = await getStreamUrls(videoId, quality, isAudio);
    const { urls } = streamInfo;
    const videoUrl = urls[0];
    const audioUrl = urls[1] || null;

    res.setHeader('Content-Disposition', `attachment; filename="download_${videoId}.${ext}"`);

    const memOpts = ['-threads', '2', '-analyzeduration', '1M', '-probesize', '1M'];
    let ffmpegArgs;
    
    if (isAudio) {
      const codecMap = { mp3: 'libmp3lame', flac: 'flac', opus: 'libopus', ogg: 'libvorbis' };
      const fmtMap  = { mp3: 'mp3', flac: 'flac', opus: 'opus', ogg: 'ogg' };
      ffmpegArgs = [
        ...memOpts, '-i', videoUrl,
        '-vn', '-c:a', codecMap[format] || 'libmp3lame', '-q:a', '2',
        '-f', fmtMap[format] || 'mp3', 'pipe:1'
      ];
      res.setHeader('Content-Type', `audio/${format}`);
    } else {
      // Always transcode to H.264/AAC for compatibility
      ffmpegArgs = audioUrl
        ? [...memOpts, '-i', videoUrl, '-i', audioUrl, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', '-f', 'mp4', 'pipe:1']
        : [...memOpts, '-i', videoUrl, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-f', 'mp4', 'pipe:1'];
      res.setHeader('Content-Type', 'video/mp4');
    }

    ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    ffmpeg.stdout.pipe(res);
    
    let ffErr = '';
    ffmpeg.stderr.on('data', d => {
      ffErr += d.toString();
      if (ffErr.length > 4000) ffErr = ffErr.slice(-2000);
    });
    
    ffmpeg.on('close', code => {
      cleanup();
      if (code !== 0 && code !== null) {
        console.error('[ffmpeg download] exited:', code, ffErr.slice(-400));
      }
    });
    
    ffmpeg.on('error', err => {
      cleanup();
      console.error('[ffmpeg download] error:', err.message);
      if (!res.headersSent) res.status(500).send('Download error');
    });
    
    req.on('close', cleanup);
    req.on('error', cleanup);

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
