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
    console.log(`[formats] Using cached formats for ${videoId}`);
    return cached.formats;
  }

  if (!youtube) {
    const error = 'YouTube API not initialized';
    console.error(`[formats] ERROR: ${error}`);
    throw new Error(error);
  }

  console.log(`[formats] Fetching formats for video: ${videoId}`);

  try {
    const info = await youtube.getInfo(videoId);
    
    console.log(`[formats] getInfo() completed for ${videoId}`);
    
    if (!info) {
      const error = 'getInfo() returned null/undefined';
      console.error(`[formats] ERROR: ${error} for ${videoId}`);
      throw new Error(error);
    }

    if (!info.streaming_data) {
      console.error(`[formats] ERROR: No streaming_data in response for ${videoId}`);
      console.error(`[formats] Available keys in info:`, Object.keys(info));
      throw new Error('No streaming data available - video may be restricted');
    }

    const muxed = info.streaming_data.formats || [];
    const adaptive = info.streaming_data.adaptive_formats || [];

    console.log(`[formats] ${videoId} - Found ${muxed.length} muxed formats, ${adaptive.length} adaptive formats`);

    if (muxed.length > 0) {
      console.log(`[formats] Muxed formats available:`, muxed.map(f => ({
        itag: f.itag,
        quality: f.quality_label || f.quality,
        height: f.height,
        hasAudio: f.has_audio,
        hasVideo: f.has_video,
        mime: f.mime_type
      })));
    }

    if (adaptive.length > 0) {
      console.log(`[formats] Adaptive formats available:`, adaptive.slice(0, 5).map(f => ({
        itag: f.itag,
        quality: f.quality_label || f.quality,
        height: f.height,
        hasAudio: f.has_audio,
        hasVideo: f.has_video,
        mime: f.mime_type
      })));
    }

    if (muxed.length === 0 && adaptive.length === 0) {
      const error = 'No formats returned - video may be age-restricted, region-locked, or unavailable';
      console.error(`[formats] ERROR: ${error} for ${videoId}`);
      throw new Error(error);
    }

    const formats = {
      videoFormats: muxed,
      adaptiveFormats: adaptive,
      duration: info.basic_info?.duration || 0,
      title: info.basic_info?.title || 'Video'
    };

    formatCache.set(cacheKey, { formats, ts: Date.now() });
    console.log(`[formats] Successfully cached formats for ${videoId}`);
    
    return formats;
  } catch (err) {
    console.error(`[formats] EXCEPTION caught for ${videoId}:`);
    console.error(`[formats] Error type: ${err.constructor.name}`);
    console.error(`[formats] Error message: ${err.message}`);
    console.error(`[formats] Stack trace:`, err.stack);
    throw err;
  }
}

function selectBestFormat(formats, qualityLimit = 720, isAudio = false) {
  console.log(`[selectFormat] Starting format selection - qualityLimit: ${qualityLimit}, isAudio: ${isAudio}`);
  console.log(`[selectFormat] Available: ${formats.videoFormats.length} muxed, ${formats.adaptiveFormats.length} adaptive`);

  if (isAudio) {
    console.log(`[selectFormat] Audio-only mode requested`);
    // Best audio-only adaptive format
    const audioOnly = formats.adaptiveFormats
      .filter(f => f.has_audio && !f.has_video)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    
    if (audioOnly.length > 0) {
      console.log(`[selectFormat] ✓ Selected audio-only format: itag=${audioOnly[0].itag}, bitrate=${audioOnly[0].bitrate}`);
      return audioOnly[0];
    }
    
    // Fallback: any format with audio
    const anyAudio = [...formats.videoFormats, ...formats.adaptiveFormats]
      .filter(f => f.has_audio)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    
    if (anyAudio.length > 0) {
      console.log(`[selectFormat] ✓ Fallback audio format: itag=${anyAudio[0].itag}`);
      return anyAudio[0];
    }
    
    console.error(`[selectFormat] ✗ No audio formats found!`);
    throw new Error('No audio format available');
  }

  // 1. Prefer muxed formats (streaming_data.formats) — they have both audio + video combined
  console.log(`[selectFormat] Step 1: Looking for muxed formats <= ${qualityLimit}p`);
  const muxedAtLimit = formats.videoFormats
    .filter(f => f.has_video && f.height && f.height <= qualityLimit)
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  
  if (muxedAtLimit.length > 0) {
    const selected = muxedAtLimit[0];
    console.log(`[selectFormat] ✓ Step 1 SUCCESS: muxed format ${selected.height}p, itag=${selected.itag}, hasAudio=${selected.has_audio}, mime=${selected.mime_type}`);
    return selected;
  }
  console.log(`[selectFormat] ✗ Step 1 failed: No muxed formats at or below ${qualityLimit}p`);

  // 2. Any muxed format (ignore quality limit — best available)
  console.log(`[selectFormat] Step 2: Looking for any muxed formats with height`);
  const anyMuxed = formats.videoFormats
    .filter(f => f.has_video && f.height)
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  
  if (anyMuxed.length > 0) {
    const selected = anyMuxed[0];
    console.log(`[selectFormat] ✓ Step 2 SUCCESS: muxed format ${selected.height}p (any quality), itag=${selected.itag}, hasAudio=${selected.has_audio}`);
    return selected;
  }
  console.log(`[selectFormat] ✗ Step 2 failed: No muxed formats with height property`);

  // 3. Try any muxed format without quality filter
  console.log(`[selectFormat] Step 3: Looking for any muxed formats (no filters)`);
  const anyMuxedNoFilter = formats.videoFormats
    .filter(f => f.has_video)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  
  if (anyMuxedNoFilter.length > 0) {
    const selected = anyMuxedNoFilter[0];
    console.log(`[selectFormat] ✓ Step 3 SUCCESS: muxed format (unfiltered), itag=${selected.itag}, bitrate=${selected.bitrate}, hasAudio=${selected.has_audio}`);
    return selected;
  }
  console.log(`[selectFormat] ✗ Step 3 failed: No muxed formats with video`);

  // 4. Last resort: adaptive video stream (no audio, but at least something plays)
  console.log(`[selectFormat] Step 4: Looking for adaptive video formats <= ${qualityLimit}p`);
  const adaptiveVideo = formats.adaptiveFormats
    .filter(f => f.has_video && f.height && f.height <= qualityLimit)
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  
  if (adaptiveVideo.length > 0) {
    const selected = adaptiveVideo[0];
    console.warn(`[selectFormat] ⚠ Step 4 WARNING: Using video-only adaptive stream (NO AUDIO) - ${selected.height}p, itag=${selected.itag}`);
    return selected;
  }
  console.log(`[selectFormat] ✗ Step 4 failed: No adaptive video formats at or below ${qualityLimit}p`);

  // 5. Ultimate fallback: any format with video
  console.log(`[selectFormat] Step 5: Looking for ANY format with video (ultimate fallback)`);
  const anyVideo = [...formats.videoFormats, ...formats.adaptiveFormats]
    .filter(f => f.has_video)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  
  if (anyVideo.length > 0) {
    const selected = anyVideo[0];
    console.warn(`[selectFormat] ⚠ Step 5 FALLBACK: Using any available video format - itag=${selected.itag}, hasAudio=${selected.has_audio}, bitrate=${selected.bitrate}`);
    return selected;
  }

  console.error(`[selectFormat] ✗✗✗ ALL STEPS FAILED - No playable format found`);
  console.error(`[selectFormat] Debug info:`, {
    totalMuxed: formats.videoFormats.length,
    totalAdaptive: formats.adaptiveFormats.length,
    muxedWithVideo: formats.videoFormats.filter(f => f.has_video).length,
    adaptiveWithVideo: formats.adaptiveFormats.filter(f => f.has_video).length
  });
  
  throw new Error('No playable format found after exhaustive search');
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

  console.log(`[proxy] ▶ Request received for ${videoId}, quality=${quality}`);

  const controller = new AbortController();
  req.on('close', () => {
    console.log(`[proxy] Client disconnected for ${videoId}`);
    controller.abort();
  });

  try {
    console.log(`[proxy] Step 1: Fetching formats for ${videoId}`);
    const formats = await getVideoFormats(videoId);
    
    const qualityNum = parseInt(quality, 10);
    console.log(`[proxy] Step 2: Selecting best format for quality ${qualityNum}p`);
    const format = selectBestFormat(formats, qualityNum, false);

    if (!format) {
      const error = 'selectBestFormat returned null/undefined';
      console.error(`[proxy] ERROR: ${error}`);
      throw new Error(error);
    }

    if (!format.url) {
      const error = 'Selected format has no URL';
      console.error(`[proxy] ERROR: ${error}, format:`, format);
      throw new Error(error);
    }

    const headers = {
      'User-Agent': YT_UA,
      'Referer': 'https://www.youtube.com/',
    };
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
      console.log(`[proxy] Range request: ${req.headers.range}`);
    }

    console.log(`[proxy] Step 3: Selected format details:`, {
      itag: format.itag,
      height: format.height,
      hasAudio: format.has_audio,
      hasVideo: format.has_video,
      mime: format.mime_type,
      bitrate: format.bitrate
    });

    console.log(`[proxy] Step 4: Fetching from YouTube upstream...`);
    const upstream = await fetch(format.url, {
      headers,
      signal: controller.signal,
      timeout: 30000
    });

    console.log(`[proxy] Upstream response status: ${upstream.status}`);

    if (!upstream.ok) {
      console.error(`[proxy] Upstream returned non-OK status: ${upstream.status} ${upstream.statusText}`);
      
      // If URL has expired (403/410), evict cache and retry once
      if (upstream.status === 403 || upstream.status === 410) {
        console.log(`[proxy] URL expired (${upstream.status}), evicting cache and retrying...`);
        formatCache.delete(`formats:${videoId}`);
      }
      throw new Error(`Upstream error: ${upstream.status} ${upstream.statusText}`);
    }

    console.log(`[proxy] Step 5: Streaming response to client...`);
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
      const error = 'Upstream returned no body';
      console.error(`[proxy] ERROR: ${error}`);
      throw new Error(error);
    }

    await pipeline(Readable.fromWeb(upstream.body), res);
    console.log(`[proxy] ✓ Successfully streamed ${videoId} to client`);

  } catch (e) {
    if (controller.signal.aborted) {
      console.log(`[proxy] Request aborted for ${videoId}`);
      return;
    }
    
    console.error(`[proxy] ✗✗✗ FATAL ERROR for ${videoId}:`);
    console.error(`[proxy] Error type: ${e.constructor.name}`);
    console.error(`[proxy] Error message: ${e.message}`);
    console.error(`[proxy] Stack:`, e.stack);
    
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
