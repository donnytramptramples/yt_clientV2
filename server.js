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

// N-parameter shim
Platform.shim.eval = (code, env) => {
  return new Function(...Object.keys(env), code)(...Object.values(env));
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
      generate_session_locally: true,
      enable_session_cache: true,
      retrieve_player: true,
    });

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

const formatCache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

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
    console.log(`[formats] Using cached formats for ${videoId}`);
    return cached.formats;
  }

  if (!youtube) {
    throw new Error('YouTube API not initialized');
  }

  console.log(`[formats] Fetching formats for video: ${videoId}`);

  try {
    const info = await youtube.getInfo(videoId);
    
    if (!info) {
      throw new Error('getInfo() returned null/undefined');
    }

    const hasStreamingData = info.streaming_data && 
      (info.streaming_data.formats?.length > 0 || info.streaming_data.adaptive_formats?.length > 0);

    if (!hasStreamingData) {
      console.error(`[formats] No streaming_data for ${videoId}, status:`, info.playability_status?.status);
      throw new Error('No streaming data available - video may be restricted');
    }

    let muxed = info.streaming_data.formats || [];
    let adaptive = info.streaming_data.adaptive_formats || [];

    // Decipher all formats that need it
    console.log(`[formats] Processing ${muxed.length} muxed + ${adaptive.length} adaptive formats`);
    
    for (const f of [...muxed, ...adaptive]) {
      if (f.signature_cipher && !f.url) {
        try {
          await f.decipher(youtube.session.player);
        } catch (e) {
          console.warn(`[formats] Decipher failed for itag=${f.itag}:`, e.message);
        }
      }
    }

    // Filter to only formats with valid URLs
    muxed = muxed.filter(f => f.url);
    adaptive = adaptive.filter(f => f.url);

    console.log(`[formats] After decipher: ${muxed.length} muxed, ${adaptive.length} adaptive with URLs`);

    if (muxed.length === 0 && adaptive.length === 0) {
      throw new Error('No formats with valid URLs after deciphering');
    }

    const formats = {
      videoFormats: muxed,
      adaptiveFormats: adaptive,
      duration: info.basic_info?.duration || 0,
      title: info.basic_info?.title || 'Video'
    };

    formatCache.set(cacheKey, { formats, ts: Date.now() });
    console.log(`[formats] Successfully cached ${videoId}`);
    
    return formats;
  } catch (err) {
    console.error(`[formats] Error for ${videoId}:`, err.message);
    throw err;
  }
}

function selectBestFormat(formats, qualityLimit = 720, isAudio = false) {
  if (isAudio) {
    const audioOnly = formats.adaptiveFormats
      .filter(f => f.has_audio && !f.has_video)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    
    if (audioOnly.length > 0) return audioOnly[0];
    
    const anyAudio = [...formats.videoFormats, ...formats.adaptiveFormats]
      .filter(f => f.has_audio)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    
    if (anyAudio.length > 0) return anyAudio[0];
    throw new Error('No audio format available');
  }

  // Prefer muxed formats
  const muxedAtLimit = formats.videoFormats
    .filter(f => f.has_video && f.height && f.height <= qualityLimit)
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  
  if (muxedAtLimit.length > 0) return muxedAtLimit[0];

  const anyMuxed = formats.videoFormats
    .filter(f => f.has_video && f.height)
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  
  if (anyMuxed.length > 0) return anyMuxed[0];

  // Fallback to adaptive
  const adaptiveVideo = formats.adaptiveFormats
    .filter(f => f.has_video && f.height && f.height <= qualityLimit)
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  
  if (adaptiveVideo.length > 0) return adaptiveVideo[0];

  const anyVideo = [...formats.videoFormats, ...formats.adaptiveFormats]
    .filter(f => f.has_video)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  
  if (anyVideo.length > 0) return anyVideo[0];
  
  throw new Error('No playable format found');
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

  console.log(`[proxy] Request for ${videoId}, quality=${quality}`);

  const controller = new AbortController();
  req.on('close', () => {
    console.log(`[proxy] Client disconnected for ${videoId}`);
    controller.abort();
  });

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
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    console.log(`[proxy] Using format: height=${format.height}p, itag=${format.itag}, hasAudio=${format.has_audio}`);

    const upstream = await fetch(format.url, {
      headers,
      signal: controller.signal,
      timeout: 30000
    });

    if (!upstream.ok) {
      if (upstream.status === 403 || upstream.status === 410) {
        console.log(`[proxy] URL expired (${upstream.status}), evicting cache`);
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
    
    if (!upstream.headers.get('accept-ranges')) {
      res.setHeader('Accept-Ranges', 'bytes');
    }

    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Vary', 'Range');

    if (!upstream.body) {
      throw new Error('Upstream returned no body');
    }

    await pipeline(Readable.fromWeb(upstream.body), res);
    console.log(`[proxy] Successfully streamed ${videoId}`);

  } catch (e) {
    if (controller.signal.aborted) return;
    
    console.error(`[proxy] Error for ${videoId}:`, e.message);
    
    if (!res.headersSent) {
      res.status(502).json({
        error: e.message,
        videoId: videoId,
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
