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
// FIX: Render uses 10000 by default; changed from 3000 to prevent 502 Bad Gateway
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));

let youtube;

// Background Initialization
async function initYouTube() {
  try {
    // FIX: retrieve_player is CRITICAL for the "Signature Decipher" error
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
      '--extractor-args', 'youtube:player_client=ios,android;player_skip=webpage',
      '--print', 'duration',
      '--print', 'title',
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

// Stream endpoint - uses yt-dlp to get URLs, ffmpeg to mux into streamable fragmented MP4
app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { quality = '720', audioOnly = 'false', start = '0' } = req.query;
  const startSec = parseFloat(start) || 0;

  // Force H.264 + AAC for universal browser compatibility
  // Prefer mp4/m4a containers; fall back progressively if not available
  const ytFormat = audioOnly === 'true'
    ? 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio'
    : [
        `bestvideo[height<=${quality}][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]`,
        `bestvideo[height<=${quality}][vcodec^=avc1]+bestaudio[ext=m4a]`,
        `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]`,
        `bestvideo[height<=${quality}]+bestaudio`,
        `best[height<=${quality}]`,
        'best'
      ].join('/');

  const getUrlArgs = [
    '--no-check-certificate',
    '--extractor-args', 'youtube:player_client=ios,android;player_skip=webpage',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    '-g',
    '-f', ytFormat,
    `https://www.youtube.com/watch?v=${videoId}`
  ];

  try {
    const urlProcess = spawn('yt-dlp', getUrlArgs);
    let urlOutput = '';
    let errOutput = '';
    urlProcess.stdout.on('data', (d) => { urlOutput += d.toString(); });
    urlProcess.stderr.on('data', (d) => { errOutput += d.toString(); });

    await new Promise((resolve, reject) => {
      urlProcess.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(errOutput.trim() || 'yt-dlp URL extraction failed'));
      });
    });

    const urls = urlOutput.trim().split('\n').filter(Boolean);
    if (!urls.length) throw new Error('No stream URLs found');

    const videoUrl = urls[0];
    const audioUrl = urls[1] || null;

    const reconnectArgs = ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
    const seekArgs = startSec > 0 ? ['-ss', String(startSec)] : [];
    const outputArgs = ['-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof'];

    let ffmpegArgs;
    if (audioOnly === 'true') {
      ffmpegArgs = [...seekArgs, ...reconnectArgs, '-i', videoUrl, '-vn', '-c:a', 'aac', '-b:a', '192k', ...outputArgs, 'pipe:1'];
      res.setHeader('Content-Type', 'audio/mp4');
    } else if (audioUrl) {
      ffmpegArgs = [...seekArgs, ...reconnectArgs,
        '-i', videoUrl, ...seekArgs, '-i', audioUrl,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        ...outputArgs, 'pipe:1'
      ];
      res.setHeader('Content-Type', 'video/mp4');
    } else {
      ffmpegArgs = [...seekArgs, ...reconnectArgs, '-i', videoUrl, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-c:a', 'aac', ...outputArgs, 'pipe:1'];
      res.setHeader('Content-Type', 'video/mp4');
    }

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    ffmpeg.stdout.pipe(res);
    ffmpeg.stderr.on('data', () => {}); // suppress ffmpeg logs

    ffmpeg.on('error', (err) => {
      console.error('ffmpeg error:', err.message);
      if (!res.headersSent) res.status(500).send('Streaming error');
    });

    req.on('close', () => { try { ffmpeg.kill(); } catch (_) {} });

  } catch (error) {
    console.error('Stream error:', error.message);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// Download endpoint - uses yt-dlp for URL extraction, ffmpeg for muxing/conversion
app.get('/api/download/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { format = 'mp4', quality = '720' } = req.query;
  const formatMap = { mp4: 'mp4', mp3: 'mp3', flac: 'flac', opus: 'opus', ogg: 'ogg' };
  const ext = formatMap[format] || 'mp4';
  const isAudio = format !== 'mp4';

  const ytFormat = isAudio
    ? 'bestaudio[ext=m4a]/bestaudio'
    : `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]`;

  const getUrlArgs = [
    '--no-check-certificate',
    '--extractor-args', 'youtube:player_client=ios,android;player_skip=webpage',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    '-g', '-f', ytFormat,
    `https://www.youtube.com/watch?v=${videoId}`
  ];

  try {
    const urlProcess = spawn('yt-dlp', getUrlArgs);
    let urlOutput = '';
    let errOutput = '';
    urlProcess.stdout.on('data', (d) => { urlOutput += d.toString(); });
    urlProcess.stderr.on('data', (d) => { errOutput += d.toString(); });

    await new Promise((resolve, reject) => {
      urlProcess.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(errOutput.trim() || 'yt-dlp failed'));
      });
    });

    const urls = urlOutput.trim().split('\n').filter(Boolean);
    if (!urls.length) throw new Error('No URLs found');

    const videoUrl = urls[0];
    const audioUrl = urls[1] || null;

    res.setHeader('Content-Disposition', `attachment; filename="download_${videoId}.${ext}"`);

    let ffmpegArgs = ['-i', videoUrl];
    if (isAudio) {
      const codecMap = { mp3: 'libmp3lame', flac: 'flac', opus: 'libopus', ogg: 'libvorbis' };
      const ffFormat = { mp3: 'mp3', flac: 'flac', opus: 'opus', ogg: 'ogg' };
      ffmpegArgs.push('-vn', '-c:a', codecMap[format] || 'libmp3lame', '-q:a', '0', '-f', ffFormat[format] || 'mp3', 'pipe:1');
      res.setHeader('Content-Type', `audio/${format}`);
    } else {
      if (audioUrl) ffmpegArgs.push('-i', audioUrl);
      ffmpegArgs.push('-c:v', 'copy', '-c:a', 'aac', '-f', 'mp4', 'pipe:1');
      res.setHeader('Content-Type', 'video/mp4');
    }

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    ffmpeg.stdout.pipe(res);
    ffmpeg.stderr.on('data', () => {});
    ffmpeg.on('error', (err) => {
      console.error('ffmpeg download error:', err.message);
      if (!res.headersSent) res.status(500).send('Download error');
    });
    req.on('close', () => { try { ffmpeg.kill(); } catch (_) {} });

  } catch (error) {
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
