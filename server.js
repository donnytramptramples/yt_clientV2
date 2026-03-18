import express from 'express';
import { Innertube, UniversalCache, Platform } from 'youtubei.js';
import { BG } from 'bgutils-js';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

const MAX_CONCURRENT_STREAMS = 5;
let activeStreams = 0;

const YT_UA = 'Mozilla/5.0 (Linux; Android 13; SM-A135F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const YT_REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';

// --- Fix #1: N-parameter shim ---
// Enables YouTube.js to run the player's JS decipher/throttle challenge inside Node,
// preventing the ~50 KB/s speed cap YouTube enforces on unsigned requests.
Platform.shim.eval = (code, env) => {
  return new Function(...Object.keys(env), code)(...Object.values(env));
};

// --- Fix #3: Safe fetch shim ---
// youtubei.js with po_token injects Symbol-keyed entries into init.headers for
// internal tracking. The native fetch Request constructor rejects Symbol keys.
// We patch Platform.shim.fetch (used by ALL youtubei.js requests) to strip them.
const _nativeFetch = Platform.shim.fetch ?? fetch;
Platform.shim.fetch = (input, init = {}) => {
  if (init?.headers && typeof init.headers === 'object') {
    const clean = {};
    // Object.entries only yields string-keyed props — Symbols are silently dropped
    for (const [k, v] of Object.entries(init.headers)) clean[k] = v;
    init = { ...init, headers: clean };
  }
  return _nativeFetch(input, init);
};

let youtube;
let refreshTimer = null;

// --- Fix #2: PoToken generation via bgutils-js ---
// generateColdStartToken is a pure-JS implementation — no browser APIs needed.
// It works for most videos (StreamProtectionStatus ≤ 2) and runs fine in Node.js.
function generatePoToken(visitorData) {
  return BG.PoToken.generateColdStartToken(visitorData);
}

async function initYouTube() {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }

  try {
    // First create a bare instance to obtain a stable visitorData
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
      generate_session_locally: true,
      enable_session_cache: true,
      retrieve_player: true,
    });

    console.log('>>> [SUCCESS] YouTube API Initialised');

    // Refresh every 25 minutes — PoTokens expire after ~30 minutes
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

const formatCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour — YouTube stream URLs expire, keep cache short

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of formatCache) {
    if (now - val.ts > CACHE_TTL) formatCache.delete(key);
  }
}, 30 * 60 * 1000);

async function getVideoFormats(videoId) {
  const cacheKey = `formats:${videoId}`;
  const cached = formatCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.formats;
  }

  if (!youtube) {
    throw new Error('YouTube API not initialized');
  }

  try {
    const info = await youtube.getInfo(videoId);
    if (!info || !info.streaming_data) {
      throw new Error('No streaming data available');
    }

    const formats = {
      videoFormats: info.streaming_data.formats || [],
      adaptiveFormats: info.streaming_data.adaptive_formats || [],
      duration: info.basic_info?.duration || 0,
      title: info.basic_info?.title || 'Video'
    };

    formatCache.set(cacheKey, { formats, ts: Date.now() });
    return formats;
  } catch (err) {
    console.error(`[innertube] getVideoFormats failed for ${videoId}:`, err.message);
    throw err;
  }
}

function selectBestFormat(formats, qualityLimit = 720, isAudio = false) {
  if (isAudio) {
    // Best audio-only adaptive format
    const audioOnly = formats.adaptiveFormats
      .filter(f => f.has_audio && !f.has_video)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    if (audioOnly.length > 0) return audioOnly[0];
    // Fallback: any format with audio
    return [...formats.videoFormats, ...formats.adaptiveFormats]
      .filter(f => f.has_audio)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
  }

  // 1. Prefer muxed formats (streaming_data.formats) — they have both audio + video combined
  //    These are what a browser <video> element can play natively with sound.
  const muxedAtLimit = formats.videoFormats
    .filter(f => f.has_video && f.height && f.height <= qualityLimit)
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  if (muxedAtLimit.length > 0) {
    console.log(`[format] muxed ${muxedAtLimit[0].height}p itag=${muxedAtLimit[0].itag}`);
    return muxedAtLimit[0];
  }

  // 2. Any muxed format (ignore quality limit — best available)
  const anyMuxed = formats.videoFormats
    .filter(f => f.has_video && f.height)
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  if (anyMuxed.length > 0) {
    console.log(`[format] muxed fallback ${anyMuxed[0].height}p itag=${anyMuxed[0].itag}`);
    return anyMuxed[0];
  }

  // 3. Last resort: adaptive video stream (no audio, but at least something plays)
  const adaptiveVideo = formats.adaptiveFormats
    .filter(f => f.has_video && f.height && f.height <= qualityLimit)
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  if (adaptiveVideo.length > 0) {
    console.warn(`[format] WARNING: using video-only adaptive stream — no audio`);
    return adaptiveVideo[0];
  }

  return formats.adaptiveFormats.filter(f => f.has_video)[0];
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
    const formats = await getVideoFormats(videoId);
    res.json({
      duration: formats.duration,
      title: formats.title,
      source: 'innertube'
    });
  } catch (error) {
    console.error('[info] error:', error.message);
    res.status(502).json({
      error: 'Could not fetch video info',
      fallback: { type: 'youtube-embed', url: `https://www.youtube.com/embed/${videoId}` }
    });
  }
});

// Debug endpoint — lists available formats for a video
app.get('/api/formats/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    const formats = await getVideoFormats(videoId);
    res.json({
      muxed: formats.videoFormats.map(f => ({
        itag: f.itag, height: f.height, has_audio: f.has_audio, has_video: f.has_video,
        mime: f.mime_type, bitrate: f.bitrate
      })),
      adaptive: formats.adaptiveFormats.map(f => ({
        itag: f.itag, height: f.height, has_audio: f.has_audio, has_video: f.has_video,
        mime: f.mime_type, bitrate: f.bitrate
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/proxy/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { quality = '720' } = req.query;

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const formats = await getVideoFormats(videoId);
    const qualityNum = parseInt(quality, 10);
    const format = selectBestFormat(formats, qualityNum, false);

    if (!format || !format.url) {
      throw new Error('No suitable format found');
    }

    const headers = {
      'User-Agent': YT_UA,
      'Referer': 'https://www.youtube.com/',
    };
    if (req.headers.range) headers['Range'] = req.headers.range;

    console.log(`[proxy] ${videoId} quality=${quality} format: height=${format.height} has_audio=${format.has_audio} has_video=${format.has_video} itag=${format.itag}`);

    const upstream = await fetch(format.url, {
      headers,
      signal: controller.signal,
      timeout: 30000
    });

    if (!upstream.ok) {
      // If URL has expired (403/410), evict cache and retry once
      if (upstream.status === 403 || upstream.status === 410) {
        formatCache.delete(`formats:${videoId}`);
      }
      throw new Error(`Upstream error: ${upstream.status}`);
    }

    res.status(upstream.status);

    const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
    for (const h of passthrough) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    // Always declare we support range requests so browsers can seek
    if (!upstream.headers.get('accept-ranges')) {
      res.setHeader('Accept-Ranges', 'bytes');
    }

    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Vary', 'Range');

    if (!upstream.body) {
      throw new Error('Upstream returned no body');
    }

    await pipeline(Readable.fromWeb(upstream.body), res);

  } catch (e) {
    if (controller.signal.aborted) return;
    console.error('[proxy] error:', e.message);
    if (!res.headersSent) {
      res.status(502).json({
        error: e.message,
        fallback: { type: 'youtube-embed', url: `https://www.youtube.com/embed/${videoId}` }
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

  const cleanup = () => {
    activeStreams = Math.max(0, activeStreams - 1);
  };

  try {
    const formats = await getVideoFormats(videoId);
    const qualityNum = parseInt(quality, 10);

    let format;
    if (audioOnly === 'true') {
      format = selectBestFormat(formats, 999, true);
    } else {
      format = selectBestFormat(formats, qualityNum, false);
    }

    if (!format || !format.url) {
      throw new Error('No suitable format found');
    }

    console.log(`[stream] ${videoId} q=${quality} audioOnly=${audioOnly}`);

    const headers = {
      'User-Agent': YT_UA,
      'Referer': 'https://www.youtube.com/',
    };

    const upstream = await fetch(format.url, {
      headers,
      timeout: 30000
    });

    if (!upstream.ok) {
      throw new Error(`Upstream error: ${upstream.status}`);
    }

    res.setHeader('Content-Type', format.mime_type || 'video/mp4');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    if (!upstream.body) {
      throw new Error('Upstream returned no body');
    }

    await pipeline(Readable.fromWeb(upstream.body), res);

  } catch (error) {
    cleanup();
    console.error('[stream] error:', error.message);
    if (!res.headersSent) {
      res.status(502).json({
        error: error.message,
        fallback: { type: 'youtube-embed', url: `https://www.youtube.com/embed/${videoId}` }
      });
    }
  } finally {
    cleanup();
  }
});

app.get('/api/download/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { format = 'mp4', quality = '720' } = req.query;
  const safeTitle = `video_${videoId}`;

  try {
    const formats = await getVideoFormats(videoId);
    const qualityNum = parseInt(quality, 10);

    const selectedFormat = format === 'mp4'
      ? selectBestFormat(formats, qualityNum, false)
      : selectBestFormat(formats, 999, true);

    if (!selectedFormat || !selectedFormat.url) {
      throw new Error('No suitable format found');
    }

    const headers = {
      'User-Agent': YT_UA,
      'Referer': 'https://www.youtube.com/',
    };

    const upstream = await fetch(selectedFormat.url, {
      headers,
      timeout: 30000
    });

    if (!upstream.ok) {
      throw new Error(`Upstream error: ${upstream.status}`);
    }

    const ext = { mp4: 'mp4', mp3: 'mp3', flac: 'flac', opus: 'opus', ogg: 'ogg' }[format] || 'mp4';
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.${ext}"`);
    res.setHeader('Content-Type', selectedFormat.mime_type || 'application/octet-stream');

    const cl = upstream.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);

    if (!upstream.body) {
      throw new Error('Upstream returned no body');
    }

    await pipeline(Readable.fromWeb(upstream.body), res);

  } catch (error) {
    console.error('[download] error:', error.message);
    if (!res.headersSent) {
      res.status(502).json({ error: error.message });
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
