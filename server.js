import express from 'express';
import { Innertube } from 'youtubei.js';
import { spawn } from 'child_process';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 7860;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));

let youtube;

async function initYouTube() {
  youtube = await Innertube.create();
}

initYouTube();

// Search endpoint
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    const results = await youtube.search(q);
    const videos = results.videos.map(v => ({
      id: v.id,
      title: v.title.text,
      thumbnail: v.thumbnails[0].url,
      duration: v.duration.text,
      views: v.view_count.text,
      channel: v.author.name,
      channelAvatar: v.author.thumbnails?.[0]?.url
    }));
    res.json({ videos });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stream endpoint with 403 bypass
app.get('/api/stream/:videoId', (req, res) => {
  const { videoId } = req.params;
  const { quality = '720', audioOnly = 'false' } = req.query;
  
  const userAgents = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36'
  ];
  const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)];
  
  const args = [
    '--user-agent', randomUA,
    '--extractor-args', 'youtube:player_client=ios,android;player_skip=webpage',
    '-f', audioOnly === 'true' ? 'bestaudio' : `bestvideo[height<=${quality}]+bestaudio`,
    '-o', '-',
    `https://www.youtube.com/watch?v=${videoId}`
  ];
  
  const ytdlp = spawn('yt-dlp', args);
  
  ytdlp.stdout.pipe(res);
  ytdlp.stderr.on('data', (data) => console.error(data.toString()));
  
  req.on('close', () => ytdlp.kill());
});

// Download endpoint
app.get('/api/download/:videoId', (req, res) => {
  const { videoId } = req.params;
  const { format = 'mp4', quality = '720' } = req.query;
  
  const formatMap = {
    mp4: 'mp4',
    mp3: 'mp3',
    flac: 'flac',
    opus: 'opus',
    ogg: 'ogg'
  };
  
  const args = [
    '--user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
    '--extractor-args', 'youtube:player_client=ios,android;player_skip=webpage',
    '-f', format === 'mp4' ? `bestvideo[height<=${quality}]+bestaudio` : 'bestaudio',
    '--extract-audio',
    '--audio-format', formatMap[format] || 'mp3',
    '--audio-quality', '320K',
    '-o', '-',
    `https://www.youtube.com/watch?v=${videoId}`
  ];
  
  const ytdlp = spawn('yt-dlp', args);
  
  res.setHeader('Content-Type', `audio/${format}`);
  res.setHeader('Content-Disposition', `attachment; filename="video.${format}"`);
  
  ytdlp.stdout.pipe(res);
  ytdlp.stderr.on('data', (data) => console.error(data.toString()));
});

// Serve React app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  ws.on('message', (message) => {
    ws.send(JSON.stringify({ progress: 50 }));
  });
});