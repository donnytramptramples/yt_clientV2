import express from 'express';
import { Innertube, UniversalCache, Platform, Log } from 'youtubei.js';
import { BG } from 'bgutils-js';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

// Set log level to ERROR to see critical issues but suppress verbose warnings
Log.setLevel(Log.Level.ERROR);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

const MAX_CONCURRENT_STREAMS = 5;
let activeStreams = 0;

const YT_UA = 'Mozilla/5.0 (Linux; Android 13; SM-A135F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

// v17: eval receives a data object with data.output (compiled JS) + env; the script is self-contained and returns the result
Platform.shim.eval = (data, _env) => {
  return new Function(data.output)();
};

// Safe fetch shim
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

function generatePoToken(visitorData) {
  return BG.PoToken.generateColdStartToken(visitorData);
}

async function initYouTube() {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }

  try {
    const bare = await Innertube.create({ generate_session_locally: true });
    const visitorData = bare.session.context.client.visitorData;

    let po_token;
    try {
      po_token = await generatePoToken(visitorData);
      console.log('>>> [SUCCESS] PoToken generated');
    } catch (e) {
      console.warn('>>> [WARN] PoToken generation failed:', e.message, '— proceeding without it');
    }

    youtube = await Innertube.create({
      visitor_data: visitorData,
      po_token,
      cache: new UniversalCache(false),
      // generate_session_locally must be false so the player JS is fetched from
      // YouTube and signature/n-parameter deciphering algorithms are extracted
      generate_session_locally: false,
      enable_session_cache: true,
      retrieve_player: true,
    });

    // Clear info cache on session refresh so URLs are re-deciphered
    infoCache.clear();

    console.log('>>> [SUCCESS] YouTube API Initialised');
    refreshTimer = setTimeout(initYouTube, 25 * 60 * 1000);
  } catch (e) {
    console.error('>>> [ERROR] Init Failed:', e.message);
    setTimeout(initYouTube, 10000);
  }
}

await initYouTube();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));

// Cache VideoInfo objects (not just raw format data) so we can decipher URLs
const infoCache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of infoCache) {
    if (now - val.ts > CACHE_TTL) infoCache.delete(key);
  }
}, 30 * 60 * 1000);

async function getVideoInfo(videoId) {
  const cached = infoCache.get(videoId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    console.log(`[info] Using cached info for ${videoId}`);
    return cached.info;
  }

  if (!youtube) throw new Error('YouTube API not initialized');

  console.log(`[info] Fetching info for video: ${videoId}`);

  const info = await youtube.getInfo(videoId);

  if (!info || !info.streaming_data) {
    throw new Error('No streaming data available');
  }

  const muxed = info.streaming_data.formats || [];
  const adaptive = info.streaming_data.adaptive_formats || [];
  console.log(`[info] Found ${muxed.length} muxed + ${adaptive.length} adaptive formats`);

  infoCache.set(videoId, { info, ts: Date.now() });
  return info;
}

function getFormatsFromInfo(info) {
  return {
    videoFormats: info.streaming_data.formats || [],
    adaptiveFormats: info.streaming_data.adaptive_formats || [],
    duration: info.basic_info?.duration || 0,
    title: info.basic_info?.title || 'Video',
  };
}

function selectBestFormat(formats, qualityLimit = 720, isAudio = false) {
  const allFormats = [...formats.videoFormats, ...formats.adaptiveFormats];

  if (isAudio) {
    const audioFormats = allFormats
      .filter(f => f.has_audio && !f.has_video)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    if (audioFormats.length > 0) return audioFormats[0];

    const anyAudio = allFormats
      .filter(f => f.has_audio)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    if (anyAudio.length > 0) return anyAudio[0];
    throw new Error('No audio format available');
  }

  // Prefer muxed (audio+video) at or below quality limit
  const muxedFormats = allFormats
    .filter(f => f.has_video && f.has_audio && f.height && f.height <= qualityLimit)
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  if (muxedFormats.length > 0) return muxedFormats[0];

  // Fall back to any muxed regardless of quality
  const anyMuxed = allFormats
    .filter(f => f.has_video && f.has_audio)
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  if (anyMuxed.length > 0) return anyMuxed[0];

  // Last resort: video-only at or below quality limit
  const videoFormats = allFormats
    .filter(f => f.has_video && f.height && f.height <= qualityLimit)
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  if (videoFormats.length > 0) return videoFormats[0];

  const anyVideo = allFormats
    .filter(f => f.has_video)
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  if (anyVideo.length > 0) return anyVideo[0];

  throw new Error('No playable format found');
}

// Decipher a format's URL using the active session and fetch it as a Node stream
async function fetchFormatStream(format, info, signal) {
  const url = await format.decipher(youtube.session.player);
  if (!url) throw new Error('Could not decipher stream URL');

  // YouTube requires cpn (client playback nonce) and stream headers
  const fetchUrl = `${url}&cpn=${info.cpn}`;

  const resp = await youtube.session.http.fetch_function(fetchUrl, {
    method: 'GET',
    headers: {
      'accept': '*/*',
      'origin': 'https://www.youtube.com',
      'referer': 'https://www.youtube.com',
      'DNT': '?1',
    },
    redirect: 'follow',
    signal,
  });

  if (!resp.ok) throw new Error(`Upstream fetch failed: ${resp.status}`);
  return resp;
}

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
    console.error('[search] error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/info/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    const info = await getVideoInfo(videoId);
    const formats = getFormatsFromInfo(info);
    res.json({ duration: formats.duration, title: formats.title, source: 'innertube' });
  } catch (error) {
    console.error('[info] error:', error.message);
    res.status(502).json({
      error: 'Could not fetch video info',
      fallback: { type: 'youtube-embed', url: `https://www.youtube.com/embed/${videoId}` },
    });
  }
});

app.get('/api/formats/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    const info = await getVideoInfo(videoId);
    const formats = getFormatsFromInfo(info);
    res.json({
      muxed: formats.videoFormats.map(f => ({
        itag: f.itag,
        height: f.height,
        has_audio: f.has_audio,
        has_video: f.has_video,
        mime: f.mime_type,
        bitrate: f.bitrate,
      })),
      adaptive: formats.adaptiveFormats.map(f => ({
        itag: f.itag,
        height: f.height,
        has_audio: f.has_audio,
        has_video: f.has_video,
        mime: f.mime_type,
        bitrate: f.bitrate,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/proxy/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { quality = '720' } = req.query;

  console.log(`[proxy] Request for ${videoId}, quality=${quality}`);

  const controller = new AbortController();
  req.on('close', () => {
    console.log(`[proxy] Client disconnected for ${videoId}`);
    controller.abort();
  });

  try {
    const info = await getVideoInfo(videoId);
    const formats = getFormatsFromInfo(info);
    const qualityNum = parseInt(quality, 10);
    const format = selectBestFormat(formats, qualityNum, false);

    console.log(`[proxy] Using format: height=${format.height}p, itag=${format.itag}`);

    const resp = await fetchFormatStream(format, info, controller.signal);

    res.setHeader('Content-Type', format.mime_type || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (resp.headers.get('content-length')) {
      res.setHeader('Content-Length', resp.headers.get('content-length'));
    }

    await pipeline(Readable.fromWeb(resp.body), res);
    console.log(`[proxy] Successfully streamed ${videoId}`);
  } catch (e) {
    if (controller.signal.aborted) return;
    console.error(`[proxy] Error for ${videoId}:`, e.message);
    if (!res.headersSent) {
      res.status(502).json({
        error: e.message,
        videoId,
        fallback: { type: 'youtube-embed', url: `https://www.youtube.com/embed/${videoId}` },
      });
    }
  }
});

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

    console.log(`[stream] ${videoId} q=${quality} audioOnly=${audioOnly}`);

    const resp = await fetchFormatStream(format, info, controller.signal);

    res.setHeader('Content-Type', format.mime_type || 'video/mp4');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    await pipeline(Readable.fromWeb(resp.body), res);
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error('[stream] error:', error.message);
      if (!res.headersSent) {
        res.status(502).json({
          error: error.message,
          fallback: { type: 'youtube-embed', url: `https://www.youtube.com/embed/${videoId}` },
        });
      }
    }
  } finally {
    cleanup();
  }
});

app.get('/api/download/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { format = 'mp4', quality = '720' } = req.query;
  const safeTitle = `video_${videoId}`;

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const info = await getVideoInfo(videoId);
    const formats = getFormatsFromInfo(info);
    const qualityNum = parseInt(quality, 10);

    const selectedFormat = format === 'mp4'
      ? selectBestFormat(formats, qualityNum, false)
      : selectBestFormat(formats, 999, true);

    const resp = await fetchFormatStream(selectedFormat, info, controller.signal);

    const ext = { mp4: 'mp4', mp3: 'mp3', flac: 'flac', opus: 'opus', ogg: 'ogg' }[format] || 'mp4';
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.${ext}"`);
    res.setHeader('Content-Type', selectedFormat.mime_type || 'application/octet-stream');
    if (resp.headers.get('content-length')) {
      res.setHeader('Content-Length', resp.headers.get('content-length'));
    }

    await pipeline(Readable.fromWeb(resp.body), res);
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error('[download] error:', error.message);
      if (!res.headersSent) {
        res.status(502).json({ error: error.message });
      }
    }
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
  ws.on('message', () => {
    ws.send(JSON.stringify({ progress: 100 }));
  });
});

console.log("Server fully staged and ready for traffic");
