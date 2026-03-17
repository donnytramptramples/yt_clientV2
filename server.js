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
const MAX_CONCURRENT_STREAMS = 2;
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

  // Try multiple player clients for better compatibility
  // web_embedded client often returns direct MP4 URLs that work better
  const clients = ['web_embedded', 'ios', 'android'];
  
  for (const client of clients) {
    try {
      // Prefer H.264 (avc1) for browser compatibility - use progressive formats when possible
      // Progressive formats (single URL) are more reliable than DASH (separate video+audio)
      const ytFormat = audioOnly
        ? 'bestaudio[ext=m4a]/bestaudio'
        : [
            `best[vcodec^=avc1][height<=${quality}][ext=mp4]`,  // Progressive MP4 first
            `bestvideo[vcodec^=avc1][height<=${quality}]+bestaudio[ext=m4a]`,
            `bestvideo[vcodec^=avc1][height<=${quality}]+bestaudio`,
            `best[height<=${quality}]`,
            'best'
          ].join('/');

      const args = [
        '--no-check-certificate',
        '--extractor-args', `youtube:player_client=${client}`,
        '-g', '-f', ytFormat,
        '-J',  // Get JSON info to check codec
        '--no-playlist',
        '--socket-timeout', '20',
        `https://www.youtube.com/watch?v=${videoId}`
      ];

      const proc = spawn('yt-dlp', args, { 
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000 
      });
      
      let out = '', err = '';
      proc.stdout.on('data', d => { out += d; });
      proc.stderr.on('data', d => { err += d; });

      const exitCode = await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          proc.kill('SIGKILL');
          resolve(-1);
        }, 25000);
        proc.on('close', code => {
          clearTimeout(timeout);
          resolve(code);
        });
        proc.on('error', () => {
          clearTimeout(timeout);
          resolve(-1);
        });
      });

      if (exitCode !== 0) continue;

      // Parse JSON output to get format info
      let info;
      try {
        info = JSON.parse(out.trim());
      } catch {
        continue;
      }

      const url = info.url;
      const urls = url ? [url] : [];
      
      // Check if we have separate video and audio
      if (!url && info.requested_formats) {
        for (const fmt of info.requested_formats) {
          if (fmt.url) urls.push(fmt.url);
        }
      }

      if (!urls.length) continue;

      // Determine if we can use copy codec (H.264 + AAC)
      const vcodec = info.vcodec || (info.requested_formats?.[0]?.vcodec) || '';
      const acodec = info.acodec || (info.requested_formats?.[1]?.acodec) || (info.requested_formats?.[0]?.acodec) || '';
      const canCopyVideo = vcodec.startsWith('avc1') || vcodec === 'h264';
      const canCopyAudio = acodec.startsWith('mp4a') || acodec === 'aac';
      const isProgressive = urls.length === 1 && !audioOnly;

      const result = { 
        urls, 
        ts: Date.now(), 
        canCopyVideo, 
        canCopyAudio,
        isProgressive,
        vcodec,
        acodec
      };
      
      urlCache.set(key, result);
      return result;
      
    } catch (e) {
      console.error(`[yt-dlp] ${client} client failed:`, e.message);
      continue;
    }
  }

  throw new Error('All player clients failed to get stream URLs');
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
// Uses stream copy when possible to save CPU/RAM, only transcodes when necessary
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
    const { urls, canCopyVideo, canCopyAudio, isProgressive } = streamInfo;
    const videoUrl = urls[0];
    const audioUrl = urls[1] || null;

    // Build ffmpeg args optimized for low memory usage
    // Use copy codec when source is H.264/AAC to avoid transcoding
    const seekArgs = startSec > 0 ? ['-ss', String(startSec)] : [];
    const hlsArgs = ['-protocol_whitelist', 'file,http,https,tcp,tls,crypto,m3u8'];
    
    // Memory-saving ffmpeg global options
    const memOpts = [
      '-threads', '1',           // Single thread to reduce memory
      '-analyzeduration', '2M',  // Reduce analysis time
      '-probesize', '1M',        // Reduce probe size
    ];
    
    // Fragmented MP4 for progressive playback
    const outFlags = ['-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof+faststart'];

    let ffmpegArgs;
    
    if (isAudioOnly) {
      // Audio only - use copy if AAC, otherwise transcode
      const audioCodec = canCopyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k'];
      ffmpegArgs = [
        ...memOpts, ...hlsArgs, ...seekArgs, '-i', videoUrl,
        '-vn', ...audioCodec,
        ...outFlags, 'pipe:1'
      ];
      res.setHeader('Content-Type', 'audio/mp4');
    } else if (isProgressive && canCopyVideo && canCopyAudio) {
      // Progressive MP4 with H.264 + AAC - just remux (fastest, lowest memory)
      ffmpegArgs = [
        ...memOpts, ...hlsArgs, ...seekArgs, '-i', videoUrl,
        '-c:v', 'copy', '-c:a', 'copy',
        ...outFlags, 'pipe:1'
      ];
      res.setHeader('Content-Type', 'video/mp4');
    } else if (audioUrl) {
      // Separate video + audio streams - need to mux
      const videoCodec = canCopyVideo ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-tune', 'zerolatency'];
      const audioCodec = canCopyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '96k'];
      
      ffmpegArgs = [
        ...memOpts, ...hlsArgs,
        ...seekArgs, '-i', videoUrl,
        ...seekArgs, '-i', audioUrl,
        ...videoCodec, ...audioCodec,
        '-shortest', '-max_muxing_queue_size', '256',
        ...outFlags, 'pipe:1'
      ];
      res.setHeader('Content-Type', 'video/mp4');
    } else {
      // Single URL with video+audio combined
      const videoCodec = canCopyVideo ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-tune', 'zerolatency'];
      const audioCodec = canCopyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '96k'];
      
      ffmpegArgs = [
        ...memOpts, ...hlsArgs, ...seekArgs, '-i', videoUrl,
        ...videoCodec, ...audioCodec,
        '-max_muxing_queue_size', '256',
        ...outFlags, 'pipe:1'
      ];
      res.setHeader('Content-Type', 'video/mp4');
    }

    // Set headers for streaming
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('Cache-Control', 'no-cache');
    
    ffmpeg = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    ffmpeg.stdout.pipe(res);
    
    let ffErr = '';
    ffmpeg.stderr.on('data', d => { 
      ffErr += d.toString();
      // Limit stderr buffer to prevent memory buildup
      if (ffErr.length > 2000) ffErr = ffErr.slice(-1000);
    });

    ffmpeg.on('close', code => {
      cleanup();
      if (code !== 0 && code !== null && !res.writableEnded) {
        console.error(`[ffmpeg stream] exited ${code}:`, ffErr.slice(-400));
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
    const { urls, canCopyVideo, canCopyAudio } = streamInfo;
    const videoUrl = urls[0];
    const audioUrl = urls[1] || null;

    res.setHeader('Content-Disposition', `attachment; filename="download_${videoId}.${ext}"`);

    const memOpts = ['-threads', '1', '-analyzeduration', '2M', '-probesize', '1M'];
    const hlsArgs = ['-protocol_whitelist', 'file,http,https,tcp,tls,crypto,m3u8'];
    let ffmpegArgs;
    
    if (isAudio) {
      const codecMap = { mp3: 'libmp3lame', flac: 'flac', opus: 'libopus', ogg: 'libvorbis' };
      const fmtMap  = { mp3: 'mp3', flac: 'flac', opus: 'opus', ogg: 'ogg' };
      ffmpegArgs = [
        ...memOpts, ...hlsArgs, '-i', videoUrl,
        '-vn', '-c:a', codecMap[format] || 'libmp3lame', '-q:a', '2',
        '-f', fmtMap[format] || 'mp3', 'pipe:1'
      ];
      res.setHeader('Content-Type', `audio/${format}`);
    } else {
      // Use copy when possible, transcode only when needed
      const videoCodec = canCopyVideo ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28'];
      const audioCodec = canCopyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '96k'];
      
      ffmpegArgs = audioUrl
        ? [...memOpts, ...hlsArgs, '-i', videoUrl, '-i', audioUrl, ...videoCodec, ...audioCodec, '-shortest', '-max_muxing_queue_size', '256', '-f', 'mp4', 'pipe:1']
        : [...memOpts, ...hlsArgs, '-i', videoUrl, ...videoCodec, ...audioCodec, '-max_muxing_queue_size', '256', '-f', 'mp4', 'pipe:1'];
      res.setHeader('Content-Type', 'video/mp4');
    }

    ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    ffmpeg.stdout.pipe(res);
    
    let ffErr = '';
    ffmpeg.stderr.on('data', d => {
      ffErr += d.toString();
      if (ffErr.length > 2000) ffErr = ffErr.slice(-1000);
    });
    
    ffmpeg.on('close', code => {
      cleanup();
      if (code !== 0 && code !== null) {
        console.error('[ffmpeg download] exited:', code, ffErr.slice(-300));
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
