import { Innertube, UniversalCache } from 'youtubei.js';
import { spawn } from 'child_process';

process.env.PATH = `${process.env.HOME}/.local/bin:${process.env.PATH}`;

// Limit concurrent ffmpeg processes to prevent OOM (512MB total RAM)
const MAX_CONCURRENT_STREAMS = 2;
let activeStreams = 0;

// URL cache: avoids re-running yt-dlp for the same video within a session.
const urlCache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000;

// Cleanup old cache entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of urlCache) {
    if (now - val.ts > CACHE_TTL) urlCache.delete(key);
  }
}, 30 * 60 * 1000);

async function getStreamUrls(videoId, quality, audioOnly) {
  const key = `${videoId}:${quality}:${audioOnly}`;
  const cached = urlCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached;

  // Try multiple player clients for better compatibility
  const clients = ['web_embedded', 'ios', 'android'];
  
  for (const client of clients) {
    try {
      const ytFormat = audioOnly
        ? 'bestaudio[ext=m4a]/bestaudio'
        : [
            `best[vcodec^=avc1][height<=${quality}][ext=mp4]`,
            `bestvideo[vcodec^=avc1][height<=${quality}]+bestaudio[ext=m4a]`,
            `bestvideo[vcodec^=avc1][height<=${quality}]+bestaudio`,
            `best[height<=${quality}]`,
            'best'
          ].join('/');

      const args = [
        '--no-check-certificate',
        '--extractor-args', `youtube:player_client=${client}`,
        '-f', ytFormat,
        '-J',
        '--no-playlist',
        '--socket-timeout', '20',
        `https://www.youtube.com/watch?v=${videoId}`
      ];

      const proc = spawn('yt-dlp', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      
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

      let info;
      try {
        info = JSON.parse(out.trim());
      } catch {
        continue;
      }

      const url = info.url;
      const urls = url ? [url] : [];
      
      if (!url && info.requested_formats) {
        for (const fmt of info.requested_formats) {
          if (fmt.url) urls.push(fmt.url);
        }
      }

      if (!urls.length) continue;

      const vcodec = info.vcodec || (info.requested_formats?.[0]?.vcodec) || '';
      const acodec = info.acodec || (info.requested_formats?.[1]?.acodec) || (info.requested_formats?.[0]?.acodec) || '';
      const canCopyVideo = vcodec.startsWith('avc1') || vcodec === 'h264';
      const canCopyAudio = acodec.startsWith('mp4a') || acodec === 'aac';
      const isProgressive = urls.length === 1 && !audioOnly;

      const result = { urls, ts: Date.now(), canCopyVideo, canCopyAudio, isProgressive, vcodec, acodec };
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

// Parse URL query params
function parseQuery(url) {
  const queryStr = url.split('?')[1] || '';
  const params = {};
  for (const pair of queryStr.split('&')) {
    const [key, val] = pair.split('=');
    if (key) params[key] = decodeURIComponent(val || '');
  }
  return params;
}

// Extract path param like /api/stream/:videoId
function extractParam(pattern, url) {
  const urlPath = url.split('?')[0];
  const patternParts = pattern.split('/');
  const urlParts = urlPath.split('/');
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = urlParts[i];
    }
  }
  return params;
}

export function setupApi(app) {
  // Search endpoint
  app.use(async (req, res, next) => {
    if (req.url.startsWith('/api/search')) {
      try {
        if (!youtube) {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: "API Initialising..." }));
          return;
        }
        const { q } = parseQuery(req.url);
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
        
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ videos }));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    next();
  });

  // Info endpoint
  app.use(async (req, res, next) => {
    if (req.url.startsWith('/api/info/')) {
      const { videoId } = extractParam('/api/info/:videoId', req.url);
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
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ duration, title }));
      } catch (error) {
        console.error('Info error:', error.message);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    next();
  });

  // Stream endpoint
  app.use(async (req, res, next) => {
    if (req.url.startsWith('/api/stream/')) {
      const { videoId } = extractParam('/api/stream/:videoId', req.url);
      const { quality = '720', audioOnly = 'false', start = '0' } = parseQuery(req.url);
      const startSec = parseFloat(start) || 0;
      const isAudioOnly = audioOnly === 'true';

      if (activeStreams >= MAX_CONCURRENT_STREAMS) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Server busy, please try again' }));
        return;
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

        const seekArgs = startSec > 0 ? ['-ss', String(startSec)] : [];
        const hlsArgs = ['-protocol_whitelist', 'file,http,https,tcp,tls,crypto,m3u8'];
        const memOpts = ['-threads', '1', '-analyzeduration', '2M', '-probesize', '1M'];
        const outFlags = ['-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof+faststart'];

        let ffmpegArgs;
        
        if (isAudioOnly) {
          const audioCodec = canCopyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k'];
          ffmpegArgs = [...memOpts, ...hlsArgs, ...seekArgs, '-i', videoUrl, '-vn', ...audioCodec, ...outFlags, 'pipe:1'];
          res.setHeader('Content-Type', 'audio/mp4');
        } else if (isProgressive && canCopyVideo && canCopyAudio) {
          ffmpegArgs = [...memOpts, ...hlsArgs, ...seekArgs, '-i', videoUrl, '-c:v', 'copy', '-c:a', 'copy', ...outFlags, 'pipe:1'];
          res.setHeader('Content-Type', 'video/mp4');
        } else if (audioUrl) {
          const videoCodec = canCopyVideo ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-tune', 'zerolatency'];
          const audioCodec = canCopyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '96k'];
          ffmpegArgs = [...memOpts, ...hlsArgs, ...seekArgs, '-i', videoUrl, ...seekArgs, '-i', audioUrl, ...videoCodec, ...audioCodec, '-shortest', '-max_muxing_queue_size', '256', ...outFlags, 'pipe:1'];
          res.setHeader('Content-Type', 'video/mp4');
        } else {
          const videoCodec = canCopyVideo ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-tune', 'zerolatency'];
          const audioCodec = canCopyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '96k'];
          ffmpegArgs = [...memOpts, ...hlsArgs, ...seekArgs, '-i', videoUrl, ...videoCodec, ...audioCodec, '-max_muxing_queue_size', '256', ...outFlags, 'pipe:1'];
          res.setHeader('Content-Type', 'video/mp4');
        }

        res.setHeader('Accept-Ranges', 'none');
        res.setHeader('Cache-Control', 'no-cache');
        
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
            console.error(`[ffmpeg stream] exited ${code}:`, ffErr.slice(-400));
          }
        });
        
        ffmpeg.on('error', err => {
          cleanup();
          console.error('[ffmpeg stream] spawn error:', err.message);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end('Streaming error');
          }
        });

        req.on('close', cleanup);
        req.on('error', cleanup);

      } catch (error) {
        cleanup();
        console.error('Stream error:', error.message);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: error.message }));
        }
      }
      return;
    }
    next();
  });

  // Download endpoint
  app.use(async (req, res, next) => {
    if (req.url.startsWith('/api/download/')) {
      const { videoId } = extractParam('/api/download/:videoId', req.url);
      const { format = 'mp4', quality = '720' } = parseQuery(req.url);
      const ext = { mp4: 'mp4', mp3: 'mp3', flac: 'flac', opus: 'opus', ogg: 'ogg' }[format] || 'mp4';
      const isAudio = format !== 'mp4';

      if (activeStreams >= MAX_CONCURRENT_STREAMS) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Server busy, please try again' }));
        return;
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
          const fmtMap = { mp3: 'mp3', flac: 'flac', opus: 'opus', ogg: 'ogg' };
          ffmpegArgs = [...memOpts, ...hlsArgs, '-i', videoUrl, '-vn', '-c:a', codecMap[format] || 'libmp3lame', '-q:a', '2', '-f', fmtMap[format] || 'mp3', 'pipe:1'];
          res.setHeader('Content-Type', `audio/${format}`);
        } else {
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
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end('Download error');
          }
        });
        
        req.on('close', cleanup);
        req.on('error', cleanup);

      } catch (error) {
        cleanup();
        console.error('Download error:', error.message);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: error.message }));
        }
      }
      return;
    }
    next();
  });

  console.log(">>> API routes registered in Vite dev server");
}
