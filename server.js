import express from 'express';
import { Innertube, UniversalCache } from 'youtubei.js';
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

const YT_UA =
  'Mozilla/5.0 (Linux; Android 13; SM-A135F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Convert any Headers-like / iterable / plain object into
 * a clean plain object with string keys and string values.
 * This strips Symbol keys which cause:
 * "Request constructor: init.headers is a symbol..."
 */
function normalizeHeaders(input) {
  const out = {};
  if (!input) return out;

  // WHATWG Headers (undici / node fetch)
  if (typeof input.entries === 'function') {
    for (const [k, v] of input.entries()) out[String(k)] = String(v);
    return out;
  }

  // Array of tuples: [[k,v], ...]
  if (Array.isArray(input)) {
    for (const [k, v] of input) out[String(k)] = String(v);
    return out;
  }

  // Plain object: only copy enumerable string keys (Object.keys ignores symbols)
  for (const k of Object.keys(input)) {
    const v = input[k];
    if (v !== undefined) out[String(k)] = String(v);
  }

  return out;
}

/**
 * Standard fetch timeout using AbortController
 */
async function fetchWithTimeout(url, init = {}, ms = 30000) {
  // If caller already provided a signal, we respect it but still enforce timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);

  // If upstream init.signal aborts, abort our controller too
  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

let youtube;

async function initYouTube() {
  try {
    youtube = await Innertube.create({
      cache: new UniversalCache(false),
      generate_session_locally: true,
      enable_session_cache: true,
      retrieve_player: true,

      // IMPORTANT: normalize headers so no Symbol keys reach undici Request()
      fetch: (url, options = {}) => {
        const baseHeaders = normalizeHeaders(options.headers);

        // Ensure UA is applied last so it wins
        const headers = {
          ...baseHeaders,
          'User-Agent': YT_UA
        };

        // Avoid passing the original headers object through
        const { headers: _ignored, ...rest } = options;

        return fetch(url, { ...rest, headers });
      }
    });

    console.log('>>> [SUCCESS] YouTube API Initialised');
  } catch (e) {
    console.error('>>> [ERROR] Init Failed:', e?.message || e);
    setTimeout(initYouTube, 10000);
  }
}

await initYouTube();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));

const formatCache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000;

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
    console.error(`[innertube] getVideoFormats failed for ${videoId}:`, err?.message || err);
    throw err;
  }
}

function selectBestFormat(formats, qualityLimit = 720, isAudio = false) {
  const allFormats = [...formats.videoFormats, ...formats.adaptiveFormats];

  if (isAudio) {
    return allFormats
      .filter((f) => f.audio_channels && !f.video_channels)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
  }

  const videoFormats = allFormats
    .filter((f) => f.video_channels && f.height && f.height <= qualityLimit)
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  return videoFormats[0] || allFormats.filter((f) => f.height)[0];
}

app.get('/api/search', async (req, res) => {
  try {
    if (!youtube) return res.status(503).json({ error: 'API Initialising...' });
    const { q } = req.query;
    const results = await youtube.search(q, { type: 'video' });

    const videos = (results.videos || []).map((v) => ({
      id: v.id,
      title: v.title?.text || 'Video',
      thumbnail: v.thumbnails?.[0]?.url || '',
      duration: v.duration?.text || '0:00',
      views: v.view_count?.text || '0',
      channel: v.author?.name || 'Channel',
      channelAvatar: v.author?.thumbnails?.[0]?.url || ''
    }));

    res.json({ videos });
  } catch (error) {
    console.error('[search] error:', error?.message || error);
    res.status(500).json({ error: error?.message || String(error) });
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
    console.error('[info] error:', error?.message || error);
    res.status(502).json({
      error: 'Could not fetch video info',
      fallback: { type: 'youtube-embed', url: `https://www.youtube.com/embed/${videoId}` }
    });
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
      Referer: 'https://www.youtube.com/'
    };
    if (req.headers.range) headers.Range = req.headers.range;

    console.log(
      `[proxy] ${videoId} quality=${quality} using format height=${format.height} itag=${format.itag}`
    );

    const upstream = await fetchWithTimeout(
      format.url,
      {
        headers,
        signal: controller.signal
      },
      30000
    );

    if (!upstream.ok) {
      throw new Error(`Upstream error: ${upstream.status}`);
    }

    res.status(upstream.status);

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

    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Vary', 'Range');

    if (!upstream.body) {
      throw new Error('Upstream returned no body');
    }

    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (e) {
    if (controller.signal.aborted) return;
    console.error('[proxy] error:', e?.message || e);
    if (!res.headersSent) {
      res.status(502).json({
        error: e?.message || String(e),
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
      Referer: 'https://www.youtube.com/'
    };

    const upstream = await fetchWithTimeout(format.url, { headers }, 30000);

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
    console.error('[stream] error:', error?.message || error);
    if (!res.headersSent) {
      res.status(502).json({
        error: error?.message || String(error),
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

    const selectedFormat =
      format === 'mp4' ? selectBestFormat(formats, qualityNum, false) : selectBestFormat(formats, 999, true);

    if (!selectedFormat || !selectedFormat.url) {
      throw new Error('No suitable format found');
    }

    const headers = {
      'User-Agent': YT_UA,
      Referer: 'https://www.youtube.com/'
    };

    const upstream = await fetchWithTimeout(selectedFormat.url, { headers }, 30000);

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
    console.error('[download] error:', error?.message || error);
    if (!res.headersSent) {
      res.status(502).json({ error: error?.message || String(error) });
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

console.log('Server fully staged and ready for traffic');
