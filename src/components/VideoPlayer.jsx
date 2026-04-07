import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  ArrowLeft, Play, Pause, Volume2, VolumeX, Maximize, Minimize,
  Loader2, Settings, Download, Video, Music, Disc3, Headphones, FileAudio,
  Subtitles, ChevronDown, ChevronUp, MessageSquare, ThumbsUp, Bookmark, BookmarkCheck,
  Share2, Check
} from 'lucide-react';

// sessionStorage cache — auto-cleared when the tab closes
const SS_TTL = 30 * 60 * 1000; // 30 minutes

function ssGet(key) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const { data, exp } = JSON.parse(raw);
    if (Date.now() > exp) { sessionStorage.removeItem(key); return null; }
    return data;
  } catch { return null; }
}

function ssSet(key, data) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ data, exp: Date.now() + SS_TTL }));
  } catch {}
}

function formatTime(secs) {
  const s = Math.floor(secs || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function parseTimestamp(ts) {
  const parts = ts.trim().replace(',', '.').split(':');
  if (parts.length === 3) return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
  if (parts.length === 2) return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
  return parseFloat(parts[0]);
}

function decodeHtml(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function parseVTT(text) {
  const cues = [];
  if (!text) return cues;
  const blocks = text.replace(/\r\n/g, '\n').split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const tsIdx = lines.findIndex(l => l.includes('-->'));
    if (tsIdx === -1) continue;
    const tsParts = lines[tsIdx].split('-->');
    if (tsParts.length < 2) continue;
    const start = parseTimestamp(tsParts[0].trim().split(' ')[0]);
    const end = parseTimestamp(tsParts[1].trim().split(' ')[0]);
    if (isNaN(start) || isNaN(end)) continue;

    const rawText = lines.slice(tsIdx + 1).join('\n');

    const words = [];
    const wordRe = /<(\d{2}:\d{2}[:.]\d{3})><c>(.*?)<\/c>/g;
    let wm;
    while ((wm = wordRe.exec(rawText)) !== null) {
      const wStart = parseTimestamp(wm[1]);
      const wText = decodeHtml(wm[2]);
      if (!isNaN(wStart) && wText.trim()) words.push({ start: wStart, text: wText });
    }

    const cleanText = decodeHtml(rawText.replace(/<[^>]+>/g, '')).trim();
    if (cleanText) cues.push({ start, end, text: cleanText, words: words.length >= 2 ? words : null });
  }
  return cues;
}

function SubtitleOverlay({ cue, currentTime, size, pos }) {
  if (!cue) return null;

  const baseStyle = {
    left: '50%',
    maxWidth: '90%',
    textAlign: 'center'
  };

  let posStyle;
  switch (pos) {
    case 'center':
      posStyle = { top: '50%', transform: 'translateX(-50%) translateY(-50%)', bottom: 'auto' };
      break;
    case 'top':
      posStyle = { top: '12px', bottom: 'auto', transform: 'translateX(-50%)' };
      break;
    case 'bottom':
    default:
      posStyle = { bottom: '68px', top: 'auto', transform: 'translateX(-50%)' };
  }

  return (
    <div
      className="absolute left-1/2 pointer-events-none text-center"
      style={{ ...baseStyle, ...posStyle }}
    >
      <span
        className="inline-block px-3 py-1 rounded"
        style={{ fontSize: `${size}px`, backgroundColor: 'rgba(0,0,0,0.82)', lineHeight: 1.4, whiteSpace: 'pre-wrap', textAlign: 'center' }}
      >
        {cue.words ? (
          cue.words.map((word, i) => {
            const nextStart = cue.words[i + 1]?.start ?? cue.end;
            const active = currentTime >= word.start && currentTime < nextStart;
            return (
              <span key={i} style={{ color: active ? '#fff' : 'rgba(255,255,255,0.6)', fontWeight: active ? 700 : 400, transition: 'color 0.1s' }}>
                {word.text}{' '}
              </span>
            );
          })
        ) : (
          <span style={{ color: '#fff' }}>{cue.text}</span>
        )}
      </span>
    </div>
  );
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

const FORMAT_OPTIONS = [
  { value: 'mp4',  label: 'MP4 (Video)',      Icon: Video,     hasQuality: true,  hasBitrate: false, hasCompression: false },
  { value: 'mp3',  label: 'MP3 (Audio)',       Icon: Music,     hasQuality: false, hasBitrate: true,  hasCompression: false },
  { value: 'flac', label: 'FLAC (Lossless)',   Icon: Disc3,     hasQuality: false, hasBitrate: false, hasCompression: true  },
  { value: 'opus', label: 'Opus',              Icon: Headphones,hasQuality: false, hasBitrate: true,  hasCompression: false },
  { value: 'ogg',  label: 'Ogg Vorbis',        Icon: FileAudio, hasQuality: false, hasBitrate: true,  hasCompression: false },
  { value: 'm4a',  label: 'M4A (AAC)',         Icon: Music,     hasQuality: false, hasBitrate: true,  hasCompression: false },
];

const BITRATE_OPTIONS = ['96k', '128k', '192k', '256k', '320k'];
const COMPRESSION_OPTIONS = [
  { value: '0', label: '0 – Fastest' },
  { value: '3', label: '3 – Fast' },
  { value: '5', label: '5 – Default' },
  { value: '8', label: '8 – Best' },
];

function DownloadPanel({ video, quality, availableHeights, onClose }) {
  const [selFormat, setSelFormat] = useState('mp4');
  const [selQuality, setSelQuality] = useState(quality || '720');
  const [selBitrate, setSelBitrate] = useState('320k');
  const [selCompression, setSelCompression] = useState('5');
  const [downloading, setDownloading] = useState(false);

  const fmt = FORMAT_OPTIONS.find(f => f.value === selFormat);

  const handleDownload = () => {
    let url = `/api/download/${video.id}?format=${selFormat}&title=${encodeURIComponent(video.title || 'video')}`;
    if (fmt?.hasQuality) url += `&quality=${selQuality}`;
    if (fmt?.hasBitrate) url += `&bitrate=${selBitrate}`;
    if (fmt?.hasCompression) url += `&compression=${selCompression}`;

    const safeTitle = (video.title || 'video').replace(/[<>:"/\\|?*]/g, '');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeTitle}.${selFormat}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setDownloading(true);
    setTimeout(() => { setDownloading(false); onClose(); }, 3000);
  };

  return (
    <div
      className="absolute bottom-full right-0 mb-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4 min-w-[280px] z-50 text-[var(--text-primary)]"
      style={{ boxShadow: '0 -4px 32px rgba(0,0,0,0.6)' }}
      onClick={e => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-semibold">Download</span>
        <button onClick={onClose} className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-lg leading-none">×</button>
      </div>

      {/* Format selector */}
      <div className="mb-3">
        <label className="block text-xs font-semibold mb-1.5 text-[var(--text-secondary)] uppercase tracking-wide">Format</label>
        <div className="grid grid-cols-3 gap-1">
          {FORMAT_OPTIONS.map(({ value, label, Icon }) => (
            <button
              key={value}
              onClick={() => setSelFormat(value)}
              className={`flex flex-col items-center gap-1 p-2 rounded text-xs transition-colors ${selFormat === value ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-primary)] hover:bg-[var(--border)]'}`}
            >
              <Icon size={14} />
              {value.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Quality selector (MP4 only) */}
      {fmt?.hasQuality && availableHeights.length > 0 && (
        <div className="mb-3">
          <label className="block text-xs font-semibold mb-1.5 text-[var(--text-secondary)] uppercase tracking-wide">Quality</label>
          <div className="flex flex-wrap gap-1">
            {availableHeights.map(h => (
              <button
                key={h}
                onClick={() => setSelQuality(String(h))}
                className={`px-2.5 py-1 rounded text-xs transition-colors ${selQuality === String(h) ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-primary)] hover:bg-[var(--border)]'}`}
              >
                {h}p
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Bitrate selector (audio formats) */}
      {fmt?.hasBitrate && (
        <div className="mb-3">
          <label className="block text-xs font-semibold mb-1.5 text-[var(--text-secondary)] uppercase tracking-wide">Bitrate</label>
          <div className="flex flex-wrap gap-1">
            {BITRATE_OPTIONS.map(b => (
              <button
                key={b}
                onClick={() => setSelBitrate(b)}
                className={`px-2.5 py-1 rounded text-xs transition-colors ${selBitrate === b ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-primary)] hover:bg-[var(--border)]'}`}
              >
                {b}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Compression selector (FLAC) */}
      {fmt?.hasCompression && (
        <div className="mb-3">
          <label className="block text-xs font-semibold mb-1.5 text-[var(--text-secondary)] uppercase tracking-wide">Compression</label>
          <select
            value={selCompression}
            onChange={e => setSelCompression(e.target.value)}
            className="w-full breeze-input text-xs py-1"
          >
            {COMPRESSION_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      )}

      {/* Download button */}
      <button
        onClick={handleDownload}
        disabled={downloading}
        className="w-full flex items-center justify-center gap-2 py-2 rounded bg-[var(--accent)] text-white text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-all"
      >
        {downloading ? (
          <><Loader2 size={14} className="animate-spin" /> Starting…</>
        ) : (
          <><Download size={14} /> Download {selFormat.toUpperCase()}</>
        )}
      </button>
    </div>
  );
}

export default function VideoPlayer({ video, user, onBack, onChannelSelect, coWatchUserId = null }) {
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const progressRef = useRef(null);
  const hideControlsTimer = useRef(null);

  const [availableHeights, setAvailableHeights] = useState([]);
  const [quality, setQuality] = useState(null);
  const [speed, setSpeed] = useState(1);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const apiDuration = useRef(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);

  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState('quality');
  const [showDownload, setShowDownload] = useState(false);
  const [draggingProgress, setDraggingProgress] = useState(false);
  const [formatsLoading, setFormatsLoading] = useState(true);

  // Subtitle state
  const [availableSubtitles, setAvailableSubtitles] = useState([]);
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(false);
  const [currentSubtitleLang, setCurrentSubtitleLang] = useState('en');
  const [subtitleCues, setSubtitleCues] = useState([]);
  const [currentCue, setCurrentCue] = useState(null);
  const [subtitleSize, setSubtitleSize] = useState(18);
  const [subtitlePos, setSubtitlePos] = useState('bottom');
  const [loadingSubtitles, setLoadingSubtitles] = useState(false);
  const [autoTranslate, setAutoTranslate] = useState(false);
  const [translateTo, setTranslateTo] = useState('en');

  // Chapters
  const [chapters, setChapters] = useState([]);
  const [hoverInfo, setHoverInfo] = useState(null); // { pct, time, chapter }

  // Description + Comments
  const [description, setDescription] = useState('');
  const [comments, setComments] = useState([]);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [showDescription, setShowDescription] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);

  // Subscribe
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [subscribeLoading, setSubscribeLoading] = useState(false);

  // Save
  const [isSaved, setIsSaved] = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);

  // Resume prompt
  const [resumeAt, setResumeAt] = useState(null);

  // Server busy state
  const [serverBusy, setServerBusy] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  // CSS-based fullscreen fallback (when native fullscreen is unavailable, e.g. in iframes)
  const [cssFull, setCssFull] = useState(false);

  // Share copied toast
  const [shareCopied, setShareCopied] = useState(false);

  // Skip indicator: { side: 'left'|'right', key: number }
  const [skipIndicator, setSkipIndicator] = useState(null);
  const skipIndicatorTimer = useRef(null);

  // Double-tap tracking for touch seek
  const lastTapRef = useRef({ time: 0, side: null });
  // Prevents onClick from firing after a touch event
  const touchJustHappenedRef = useRef(false);
  const touchJustHappenedTimer = useRef(null);
  // Ref mirror of currentTime to avoid stale closures in non-reactive event handlers
  const currentTimeRef = useRef(0);
  // Stable ref for position reporting (avoids stale closures in seekTo)
  const reportWatchingRef = useRef(null);

  // Chapters list panel
  const [showChapters, setShowChapters] = useState(false);

  // Proxy seeking — all seeking goes through proxySeekRef; no native seeking for proxy streams
  const [proxySeek, setProxySeek] = useState(0);
  const proxySeekRef = useRef(0);
  const seekReloadRef = useRef(false);
  const wasPlayingRef = useRef(false);

  // Refs that mirror state values for use in effects/callbacks without stale closures
  const speedRef = useRef(1);
  const qualityRef = useRef(null);
  const subtitlesEnabledRef = useRef(false);
  const selectedSubtitleRef = useRef('en');

  // Server busy info
  const [serverBusyInfo, setServerBusyInfo] = useState(null); // { current, max }

  // Define ALL callbacks first before using them in effects

  const showControls = useCallback(() => {
    setControlsVisible(true);
    clearTimeout(hideControlsTimer.current);
    if (playing) hideControlsTimer.current = setTimeout(() => setControlsVisible(false), 3000);
  }, [playing]);

  const showSkip = useCallback((side) => {
    clearTimeout(skipIndicatorTimer.current);
    setSkipIndicator({ side, key: Date.now() });
    skipIndicatorTimer.current = setTimeout(() => setSkipIndicator(null), 700);
  }, []);

  const seekTo = useCallback((targetTime) => {
    const v = videoRef.current;
    if (!v) return;

    const clamped = Math.max(0, Math.min(duration > 0 ? duration - 1 : 1e9, targetTime));
    wasPlayingRef.current = !v.paused;

    const currentProxyStart = proxySeekRef.current;

    // Compute the furthest absolute position the browser has buffered
    let bufEnd = currentProxyStart;
    for (let i = 0; i < v.buffered.length; i++) {
      bufEnd = Math.max(bufEnd, currentProxyStart + v.buffered.end(i));
    }

    // ── Backward seek fix ──────────────────────────────────────────────────
    // When seeking within the current proxy stream's range (clamped >= proxyStart),
    // always use native seeking. The browser will buffer any small gap automatically.
    // We only reload the proxy when seeking BEFORE the proxy start (can't go back
    // on a forward-only stream) or FAR ahead of the buffered end (large forward jump).
    const isBackward = clamped < currentTimeRef.current;
    const farAhead = !isBackward && clamped > bufEnd + 30;

    if (clamped >= currentProxyStart && !farAhead) {
      // Native seek within the current proxy stream — no restart
      v.currentTime = clamped - currentProxyStart;
      currentTimeRef.current = clamped;
      setCurrentTime(clamped);
      reportWatchingRef.current?.();
      return;
    }

    // Proxy reload needed: seeking before proxy start or large forward jump
    seekReloadRef.current = true;
    currentTimeRef.current = clamped;
    setCurrentTime(clamped);
    const newSeek = Math.floor(clamped);
    proxySeekRef.current = newSeek;
    setProxySeek(newSeek);
    reportWatchingRef.current?.();
  }, [duration]);

  const changeQuality = useCallback((q) => {
    const v = videoRef.current;
    if (!v || q === quality) return;
    const absoluteTime = Math.floor(proxySeekRef.current + (v.currentTime || 0));
    wasPlayingRef.current = !v.paused;
    // Set proxy to current position so new stream starts from here
    proxySeekRef.current = absoluteTime;
    setProxySeek(absoluteTime);
    seekReloadRef.current = true;
    setIsLoading(true);
    setQuality(q);
    setShowSettings(false);
  }, [quality]);

  const getProgressRatio = useCallback((e) => {
    const rect = progressRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, []);

  // Keep mirror refs in sync with their state counterparts
  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => { qualityRef.current = quality; }, [quality]);
  useEffect(() => { subtitlesEnabledRef.current = subtitlesEnabled; }, [subtitlesEnabled]);
  useEffect(() => { selectedSubtitleRef.current = currentSubtitleLang; }, [currentSubtitleLang]);

  // Now define effects that use the callbacks above

  useEffect(() => {
    setFormatsLoading(true);
    setAvailableHeights([]);
    setQuality(null);
    setDuration(0);
    apiDuration.current = 0;
    setSubtitlesEnabled(false);
    setSubtitleCues([]);
    setCurrentCue(null);
    setAvailableSubtitles([]);
    setDescription('');
    setComments([]);
    setShowDescription(false);
    setShowComments(false);
    setProxySeek(0);
    proxySeekRef.current = 0;
    seekReloadRef.current = false;
    wasPlayingRef.current = false;
    setServerBusy(false);
    setChapters([]);
    setHoverInfo(null);
    setShowChapters(false);

    // Pre-check: ask server if it can handle another stream before loading
    fetch('/api/stream/available')
      .then(r => r.json())
      .then(data => {
        if (!data.available) {
          setServerBusy(true);
          setServerBusyInfo({ current: data.current, max: data.max });
        }
      })
      .catch(() => {});

    // Formats — check sessionStorage first
    const cachedFormats = ssGet(`formats:${video.id}`);
    if (cachedFormats) {
      const heights = cachedFormats.availableHeights || [];
      setAvailableHeights(heights);
      const preferred = [720, 1080, 480, 360, 240, 144];
      const def = preferred.find(p => heights.includes(p)) || heights[0] || 360;
      setQuality(String(def));
      setFormatsLoading(false);
    } else {
      fetch(`/api/formats/${video.id}`)
        .then(r => r.json())
        .then(data => {
          const heights = data.availableHeights || [];
          setAvailableHeights(heights);
          const preferred = [720, 1080, 480, 360, 240, 144];
          const def = preferred.find(p => heights.includes(p)) || heights[0] || 360;
          setQuality(String(def));
          ssSet(`formats:${video.id}`, data);
        })
        .catch(() => { setAvailableHeights([360]); setQuality('360'); })
        .finally(() => setFormatsLoading(false));
    }

    // Info (duration + chapters) — check sessionStorage first
    const cachedInfo = ssGet(`info:${video.id}`);
    if (cachedInfo) {
      if (cachedInfo.duration) { apiDuration.current = cachedInfo.duration; setDuration(cachedInfo.duration); }
      if (cachedInfo.chapters?.length) setChapters(cachedInfo.chapters);
    } else {
      fetch(`/api/info/${video.id}`)
        .then(r => r.json())
        .then(data => {
          if (data.duration) { apiDuration.current = data.duration; setDuration(data.duration); }
          if (data.chapters?.length) setChapters(data.chapters);
          ssSet(`info:${video.id}`, data);
        })
        .catch(() => {});
    }

    // Subtitles list — check sessionStorage first
    const cachedSubs = ssGet(`subs:${video.id}`);
    if (cachedSubs) {
      if (cachedSubs.length > 0) {
        setAvailableSubtitles(cachedSubs);
        const enSub = cachedSubs.find(s => s.lang === 'en') || cachedSubs[0];
        setCurrentSubtitleLang(enSub.lang);
      }
    } else {
      fetch(`/api/subtitles/${video.id}/list`)
        .then(r => r.json())
        .then(data => {
          const subs = data.subtitles || [];
          if (subs.length > 0) {
            setAvailableSubtitles(subs);
            const enSub = subs.find(s => s.lang === 'en') || subs[0];
            setCurrentSubtitleLang(enSub.lang);
          }
          ssSet(`subs:${video.id}`, subs);
        })
        .catch(() => {});
    }

    setDetailsLoading(true);
    fetch(`/api/video/${video.id}/details`)
      .then(r => r.json())
      .then(data => { setDescription(data.description || ''); setComments(data.comments || []); })
      .catch(() => {})
      .finally(() => setDetailsLoading(false));

    if (video.channelId) {
      fetch(`/api/subscriptions/${video.channelId}/status`)
        .then(r => r.ok ? r.json() : { subscribed: false })
        .then(data => setIsSubscribed(data.subscribed || false))
        .catch(() => setIsSubscribed(false));
    }

    fetch(`/api/saved/${video.id}/status`)
      .then(r => r.ok ? r.json() : { saved: false })
      .then(data => setIsSaved(data.saved || false))
      .catch(() => setIsSaved(false));
  }, [video.id]);

  useEffect(() => {
    if (!subtitlesEnabled || !currentSubtitleLang || availableSubtitles.length === 0) {
      setSubtitleCues([]);
      setCurrentCue(null);
      return;
    }
    const sub = availableSubtitles.find(s => s.lang === currentSubtitleLang);
    if (!sub) return;

    setLoadingSubtitles(true);
    const autoFlag = sub.auto ? 'true' : 'false';
    const url = autoTranslate && translateTo
      ? `/api/subtitles/${video.id}/translate?lang=${currentSubtitleLang}&auto=${autoFlag}&to=${translateTo}`
      : `/api/subtitles/${video.id}?lang=${currentSubtitleLang}&auto=${autoFlag}`;

    fetch(url)
      .then(r => { if (!r.ok) throw new Error('Failed'); return r.text(); })
      .then(text => setSubtitleCues(parseVTT(text)))
      .catch(() => setSubtitleCues([]))
      .finally(() => setLoadingSubtitles(false));
  }, [subtitlesEnabled, currentSubtitleLang, availableSubtitles, video.id, autoTranslate, translateTo]);

  useEffect(() => {
    if (!subtitlesEnabled || subtitleCues.length === 0) { setCurrentCue(null); return; }
    const cue = subtitleCues.find(c => currentTime >= c.start && currentTime <= c.end) || null;
    setCurrentCue(cue);
  }, [currentTime, subtitleCues, subtitlesEnabled]);

  // Report position instantly when subtitles are toggled (for admin co-watch)
  useEffect(() => {
    reportWatchingRef.current?.();
  }, [subtitlesEnabled]);

  // Check for saved resume position when video changes
  useEffect(() => {
    const saved = ssGet(`pos:${video.id}`);
    if (saved && saved > 5) setResumeAt(saved);
    else setResumeAt(null);
  }, [video.id]);

  // Save playback position every 5 seconds
  useEffect(() => {
    const id = setInterval(() => {
      if (currentTime > 5 && duration > 0 && currentTime < duration - 5) {
        ssSet(`pos:${video.id}`, currentTime);
      }
    }, 5000);
    return () => clearInterval(id);
  }, [video.id, currentTime, duration]);

  // Record watch history when video loads (user is watching)
  useEffect(() => {
    if (!video?.id || !video?.title || !user) return;
    const timer = setTimeout(() => {
      fetch(`/api/watch/${video.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title: video.title,
          channel: video.channel || '',
          channelId: video.channelId || '',
          thumbnail: video.thumbnail || '',
        }),
      }).catch(() => {});
    }, 5000);
    return () => clearTimeout(timer);
  }, [video.id]);

  // Report current watching position to server every 10s (for admin co-watch)
  // Also callable immediately via reportWatchingRef for instant seek/subtitle updates
  useEffect(() => {
    if (!video?.id || !user) return;
    const report = () => {
      fetch('/api/watching', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          videoId: video.id,
          title: video.title || '',
          thumbnail: video.thumbnail || '',
          position: Math.floor(currentTimeRef.current),
          paused: videoRef.current?.paused ?? true,
          speed: speedRef.current,
          quality: qualityRef.current,
          subtitleLang: selectedSubtitleRef.current,
          subtitlesOn: subtitlesEnabledRef.current,
        }),
      }).catch(() => {});
    };
    reportWatchingRef.current = report;
    report();
    const id = setInterval(report, 10000);
    return () => { clearInterval(id); reportWatchingRef.current = null; };
  }, [video.id, user]);

  // Co-watch sync: if admin is watching with a user, poll their position and all states
  useEffect(() => {
    if (!coWatchUserId) return;
    const sync = async () => {
      try {
        const r = await fetch(`/api/admin/watching/${coWatchUserId}`, { credentials: 'include' });
        if (!r.ok) return;
        const data = await r.json();

        // Position sync (allow 4s tolerance — admin stream loads slower than user)
        const target = data.position || 0;
        if (Math.abs(currentTimeRef.current - target) > 4) {
          seekTo(target);
        }

        // Pause/play state — admin mirrors user's play state exactly
        const v = videoRef.current;
        if (v && data.paused !== undefined) {
          if (data.paused && !v.paused) v.pause();
          else if (!data.paused && v.paused) v.play().catch(() => {});
        }

        // Speed sync
        if (data.speed && data.speed !== speedRef.current) {
          setSpeed(data.speed);
        }

        // Quality sync (changeQuality handles the proxy reload)
        if (data.quality && data.quality !== qualityRef.current) {
          changeQuality(data.quality);
        }

        // Subtitle on/off sync
        if (data.subtitlesOn !== undefined && data.subtitlesOn !== subtitlesEnabledRef.current) {
          setSubtitlesEnabled(data.subtitlesOn);
        }

        // Subtitle language sync — only if we have cues loaded for that language
        if (data.subtitleLang && data.subtitleLang !== selectedSubtitleRef.current) {
          setCurrentSubtitleLang(data.subtitleLang);
        }
      } catch {}
    };
    sync();
    const id = setInterval(sync, 4000);
    return () => clearInterval(id);
  }, [coWatchUserId, seekTo, changeQuality]);

  const proxyUrl = quality ? `/api/proxy/${video.id}?quality=${quality}${proxySeek > 0 ? `&t=${proxySeek}` : ''}` : null;

  const toggleSubscribe = async () => {
    if (!video.channelId || subscribeLoading) return;
    setSubscribeLoading(true);
    try {
      const method = isSubscribed ? 'DELETE' : 'POST';
      const r = await fetch(`/api/subscriptions/${video.channelId}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelName: video.channel, channelAvatar: video.channelAvatar }),
      });
      if (r.ok) setIsSubscribed(s => !s);
    } catch {}
    setSubscribeLoading(false);
  };

  const toggleSave = async () => {
    if (saveLoading) return;
    setSaveLoading(true);
    try {
      const method = isSaved ? 'DELETE' : 'POST';
      const r = await fetch(`/api/saved/${video.id}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: video.title,
          thumbnail: video.thumbnail,
          channel: video.channel,
          channelId: video.channelId,
          channelAvatar: video.channelAvatar,
          duration: video.duration,
          views: video.views,
        }),
      });
      if (r.ok) setIsSaved(s => !s);
    } catch {}
    setSaveLoading(false);
  };

  // FIXED: Proper video event wiring
  // - onLoadStart does NOT change playing state (fixes wrong pause icon during loading)
  // - onCanPlay resumes play if was playing (for seek reloads and quality changes)
  // - All time tracking accounts for proxySeekRef offset
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    const onTimeUpdate = () => {
      const t = proxySeekRef.current + v.currentTime;
      currentTimeRef.current = t;
      setCurrentTime(t);
      if (v.buffered.length > 0) {
        setBufferedEnd(proxySeekRef.current + v.buffered.end(v.buffered.length - 1));
      }
    };

    const onDurationChange = () => {
      if (v.duration && isFinite(v.duration)) {
        const elementDuration = proxySeekRef.current + v.duration;
        const best = apiDuration.current > 0
          ? Math.max(apiDuration.current, elementDuration)
          : elementDuration;
        setDuration(prev => Math.max(prev, best));
      }
    };

    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onWaiting = () => setIsLoading(true);
    const onCanPlay = () => {
      setIsLoading(false);
      // Resume if we were playing before a seek/quality-change reload
      if (seekReloadRef.current || wasPlayingRef.current) {
        seekReloadRef.current = false;
        if (wasPlayingRef.current && v.paused) {
          v.play().catch(() => {});
        }
      }
    };

    // FIXED: Do NOT call setPlaying(false) on loadstart.
    // The video is loading, not paused. The isLoading state shows the spinner.
    const onLoadStart = () => { setIsLoading(true); };

    const onEnded = () => setPlaying(false);
    const onError = async () => {
      setIsLoading(false);
      // Check if the server returned a 503 (too busy)
      if (proxyUrl) {
        try {
          const r = await fetch(proxyUrl, { method: 'HEAD' });
          if (r.status === 503) { setServerBusy(true); return; }
        } catch {}
      }
    };

    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('durationchange', onDurationChange);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('canplay', onCanPlay);
    v.addEventListener('loadstart', onLoadStart);
    v.addEventListener('ended', onEnded);
    v.addEventListener('error', onError);

    return () => {
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('durationchange', onDurationChange);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('canplay', onCanPlay);
      v.removeEventListener('loadstart', onLoadStart);
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('error', onError);
    };
  }, [quality, proxySeek]);

  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = speed; }, [speed]);

  useEffect(() => {
    const onChange = () => {
      const isFs = !!document.fullscreenElement;
      setFullscreen(isFs);
      if (!isFs) setCssFull(false); // sync CSS fallback when native exits
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Keyboard: Escape exits CSS fullscreen; ArrowLeft/Right seek ±10 s
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && cssFull) { setCssFull(false); setFullscreen(false); return; }
      // Don't fire when focus is inside an input / textarea
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        seekTo(currentTime - 10);
        showSkip('left');
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        seekTo(currentTime + 10);
        showSkip('right');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cssFull, currentTime, seekTo, showSkip]);

  useEffect(() => {
    if (!playing) setControlsVisible(true);
    else hideControlsTimer.current = setTimeout(() => setControlsVisible(false), 3000);
    return () => clearTimeout(hideControlsTimer.current);
  }, [playing]);

  const onProgressMouseDown = (e) => {
    e.preventDefault();
    setDraggingProgress(true);
    const ratio = getProgressRatio(e);
    setCurrentTime(ratio * duration);
  };

  useEffect(() => {
    if (!draggingProgress) return;
    const onMove = (e) => setCurrentTime(getProgressRatio(e) * duration);
    const onUp = (e) => { seekTo(getProgressRatio(e) * duration); setDraggingProgress(false); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [draggingProgress, duration, seekTo, getProgressRatio]);

  const toggleMute = () => { const v = videoRef.current; v.muted = !muted; setMuted(!muted); };

  const setVolumeVal = (val) => {
    const v = videoRef.current;
    v.volume = val; v.muted = false;
    setVolume(val); setMuted(false);
  };

  const toggleFullscreen = () => {
    if (fullscreen || cssFull) {
      // Exit fullscreen
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else {
        setCssFull(false);
        setFullscreen(false);
      }
    } else {
      // Try native fullscreen first, fall back to CSS
      if (containerRef.current?.requestFullscreen) {
        containerRef.current.requestFullscreen().catch(() => {
          setCssFull(true);
          setFullscreen(true);
        });
      } else {
        setCssFull(true);
        setFullscreen(true);
      }
    }
  };

  // Touch controls: tap left third = skip -10s, tap right third = skip +10s, tap center = play/pause.
  // Uses non-passive listeners to call preventDefault() and block page scroll / synthetic clicks.
  const touchStartXRef = useRef(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleTouchStart = (e) => {
      if (e.target.closest('.video-controls-layer')) return;
      e.preventDefault();
      touchStartXRef.current = e.touches[0].clientX;
    };

    const handleTouchEnd = (e) => {
      if (e.target.closest('.video-controls-layer')) return;
      e.preventDefault();

      const touch = e.changedTouches[0];
      if (!touch) return;

      // Ignore if finger moved significantly (scroll attempt)
      const deltaX = Math.abs(touch.clientX - (touchStartXRef.current ?? touch.clientX));
      const deltaY = Math.abs(touch.clientY - (touchStartXRef.current ?? touch.clientY));
      if (deltaX > 20) return;

      const rect = container.getBoundingClientRect();
      const relX = touch.clientX - rect.left;
      const third = rect.width / 3;

      if (relX < third) {
        // Left third: skip back
        seekTo(currentTimeRef.current - 10);
        showSkip('left');
        showControls();
      } else if (relX > third * 2) {
        // Right third: skip forward
        seekTo(currentTimeRef.current + 10);
        showSkip('right');
        showControls();
      } else {
        // Center: toggle play/pause
        togglePlay();
        showControls();
      }
    };

    container.addEventListener('touchstart', handleTouchStart, { passive: false });
    container.addEventListener('touchend', handleTouchEnd, { passive: false });
    return () => {
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchend', handleTouchEnd);
    };
  }, [seekTo, showSkip, showControls, togglePlay]);

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPct = duration > 0 ? (bufferedEnd / duration) * 100 : 0;
  const noSubtitlesAvailable = availableSubtitles.length === 0;
  const currentChapter = chapters.length > 0 ? chapters.findLast(c => currentTime >= c.time) ?? null : null;

  return (
    <div className="max-w-5xl mx-auto">
      <button
        onClick={onBack}
        className="mb-4 flex items-center gap-2 hover:text-[var(--accent)] transition-colors text-sm"
      >
        <ArrowLeft size={16} />
        Back to results
      </button>

      {/* Resume prompt */}
      {resumeAt && (
        <div className="mb-3 flex items-center gap-3 px-4 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-sm">
          <span className="text-[var(--text-secondary)]">Resume from <strong className="text-[var(--text-primary)]">{formatTime(resumeAt)}</strong>?</span>
          <button
            className="px-3 py-1 rounded bg-[var(--accent)] text-white text-xs font-semibold hover:opacity-90"
            onClick={() => { seekTo(resumeAt); setResumeAt(null); }}
          >Resume</button>
          <button
            className="px-3 py-1 rounded bg-[var(--border)] text-[var(--text-secondary)] text-xs hover:bg-[var(--bg-primary)]"
            onClick={() => { sessionStorage.removeItem(`pos:${video.id}`); setResumeAt(null); }}
          >Start over</button>
        </div>
      )}

      {/* Video container */}
      <div
        ref={containerRef}
        className={`video-player-container${cssFull ? ' css-fullscreen' : ''}`}
        onMouseMove={showControls}
        onClick={() => { togglePlay(); showControls(); }}
        onDoubleClick={toggleFullscreen}
        onKeyDown={(e) => { if (e.key === 'Escape' && cssFull) { setCssFull(false); setFullscreen(false); } }}
        tabIndex={-1}
      >
        {proxyUrl && (
          <video
            key={`${video.id}-${quality}-${proxySeek}-${retryKey}`}
            ref={videoRef}
            src={proxyUrl}
            className="video-element"
            autoPlay
            playsInline
            preload="auto"
            crossOrigin="anonymous"
            onError={(e) => { console.error('Video error:', e.target.error); setIsLoading(false); }}
          />
        )}

        {subtitlesEnabled && (
          <>
            <SubtitleOverlay cue={currentCue} currentTime={currentTime} size={subtitleSize} pos={subtitlePos} />
            {noSubtitlesAvailable && (
              <div className="absolute bottom-16 left-1/2 -translate-x-1/2 pointer-events-none">
                <span className="px-3 py-1 rounded text-sm bg-black/80 text-gray-300">Subtitles unavailable</span>
              </div>
            )}
          </>
        )}

        {serverBusy ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/85 gap-4">
            <div className="text-center">
              <p className="text-white text-lg font-semibold">Server is busy</p>
              <p className="text-white/60 text-sm mt-1">Please try again later</p>
            </div>
            <button
              className="px-5 py-2 rounded-lg bg-[var(--accent)] text-white text-sm font-semibold hover:opacity-90"
              onClick={(e) => { e.stopPropagation(); setServerBusy(false); setIsLoading(true); setRetryKey(k => k + 1); }}
            >Retry</button>
          </div>
        ) : (isLoading || formatsLoading || !proxyUrl) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/75 pointer-events-none gap-4">
            <Loader2 size={56} className="text-[var(--accent)] animate-spin" />
            <div className="text-center">
              <p className="text-white text-base font-medium">
                {formatsLoading ? 'Preparing video…' : 'Loading video…'}
              </p>
              <p className="text-white/50 text-xs mt-1">This may take a moment</p>
            </div>
          </div>
        )}

        {/* Double-tap / arrow-key skip indicator */}
        {skipIndicator && (
          <div
            key={skipIndicator.key}
            className={`absolute inset-y-0 flex items-center justify-center pointer-events-none
              ${skipIndicator.side === 'left' ? 'left-0 w-1/3' : 'right-0 w-1/3'}`}
          >
            <div className="flex flex-col items-center gap-1 animate-skip-fade">
              <div className="rounded-full bg-white/20 backdrop-blur-sm p-4">
                {skipIndicator.side === 'left'
                  ? <svg width="32" height="32" viewBox="0 0 24 24" fill="white"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>
                  : <svg width="32" height="32" viewBox="0 0 24 24" fill="white"><path d="M6 18l8.5-6L6 6v12zm2-8.14L11.03 12 8 14.14V9.86zM16 6h2v12h-2z"/></svg>
                }
              </div>
              <span className="text-white text-sm font-semibold drop-shadow">
                {skipIndicator.side === 'left' ? '-10s' : '+10s'}
              </span>
            </div>
          </div>
        )}

        {/* Controls */}
        <div
          className={`video-controls-layer absolute inset-0 flex flex-col justify-end transition-opacity duration-200 ${controlsVisible || !playing ? 'opacity-100' : 'opacity-0'}`}
          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 40%)' }}
          onClick={e => e.stopPropagation()}
        >
          <div className="px-4 pb-1 pt-4">
            {/* Chapter markers + progress bar */}
            <div className="relative">
              {/* Chapter hover tooltip */}
              {hoverInfo && (
                <div
                  className="absolute bottom-full mb-2 pointer-events-none z-10 flex flex-col items-center"
                  style={{ left: `${hoverInfo.pct}%`, transform: 'translateX(-50%)' }}
                >
                  {hoverInfo.chapter && (
                    <div className="text-xs bg-black/90 text-white px-2 py-0.5 rounded mb-0.5 whitespace-nowrap max-w-[200px] truncate">
                      {hoverInfo.chapter.title}
                    </div>
                  )}
                  <div className="text-xs bg-black/90 text-white px-2 py-0.5 rounded whitespace-nowrap font-mono">
                    {formatTime(hoverInfo.time)}
                  </div>
                </div>
              )}
              <div
                ref={progressRef}
                className="relative h-1.5 rounded-full bg-white/25 cursor-pointer group/bar"
                style={{ touchAction: 'none' }}
                onMouseDown={onProgressMouseDown}
                onMouseMove={(e) => {
                  if (!duration || !progressRef.current) return;
                  const rect = progressRef.current.getBoundingClientRect();
                  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                  const time = pct * duration;
                  const chapter = chapters.length > 0 ? (chapters.findLast(c => time >= c.time) ?? null) : null;
                  setHoverInfo({ pct: pct * 100, time, chapter });
                }}
                onMouseLeave={() => setHoverInfo(null)}
              >
                <div className="absolute inset-y-0 left-0 rounded-full bg-white/30" style={{ width: `${bufferedPct}%` }} />
                <div className="absolute inset-y-0 left-0 rounded-full bg-[var(--accent)]" style={{ width: `${progressPct}%` }} />
                {/* Chapter dividers */}
                {chapters.length > 1 && duration > 0 && chapters.slice(1).map((ch) => (
                  <div
                    key={ch.time}
                    className="absolute top-0 bottom-0 w-px bg-black/60 z-10"
                    style={{ left: `${(ch.time / duration) * 100}%` }}
                  />
                ))}
                <div
                  className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full -ml-1.5 opacity-0 group-hover/bar:opacity-100 transition-opacity"
                  style={{ left: `${progressPct}%` }}
                />
              </div>
            </div>
          </div>

          <div className="px-4 pb-3 flex items-center gap-3 text-white">
            <button className="hover:text-[var(--accent)] transition-colors" onClick={togglePlay}>
              {playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
            </button>

            <span className="text-xs tabular-nums whitespace-nowrap">
              {formatTime(currentTime)} / {duration ? formatTime(duration) : '--:--'}
            </span>

            {currentChapter && (
              <span className="text-xs text-white/60 truncate max-w-[180px] hidden sm:block" title={currentChapter.title}>
                {currentChapter.title}
              </span>
            )}

            <div className="flex items-center gap-1.5 group/vol">
              <button onClick={toggleMute} className="hover:text-[var(--accent)] transition-colors">
                {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
              </button>
              <input
                type="range" min="0" max="1" step="0.05"
                value={muted ? 0 : volume}
                onChange={e => setVolumeVal(parseFloat(e.target.value))}
                className="w-0 group-hover/vol:w-20 transition-all duration-200 accent-[var(--accent)] cursor-pointer"
              />
            </div>

            <div className="flex-1" />

            {/* Subtitles */}
            <button
              className={`hover:text-[var(--accent)] transition-colors relative ${subtitlesEnabled ? 'text-[var(--accent)]' : ''}`}
              onClick={(e) => { e.stopPropagation(); setSubtitlesEnabled(s => !s); }}
              title={noSubtitlesAvailable ? 'Subtitles unavailable' : subtitlesEnabled ? 'Disable subtitles' : 'Enable subtitles'}
            >
              <Subtitles size={18} />
              {noSubtitlesAvailable && <span className="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full" />}
            </button>

            {/* Speed */}
            <button
              className="text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20 transition-colors"
              onClick={(e) => { e.stopPropagation(); setSettingsTab('speed'); setShowSettings(s => !s); setShowDownload(false); }}
            >
              {speed}x
            </button>

            {/* Settings */}
            <div className="relative">
              <button
                className="flex items-center gap-1 hover:text-[var(--accent)] transition-colors"
                onClick={(e) => { e.stopPropagation(); setShowSettings(s => !s); setShowDownload(false); }}
              >
                <Settings size={17} />
              </button>

              {showSettings && (
                <div
                  className="absolute bottom-full right-0 mb-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded min-w-[240px] z-50 text-[var(--text-primary)]"
                  style={{ boxShadow: '0 -4px 24px rgba(0,0,0,0.5)' }}
                  onClick={e => e.stopPropagation()}
                >
                  <div className="flex border-b border-[var(--border)]">
                    {['quality', 'speed', 'subtitles'].map(tab => (
                      <button
                        key={tab}
                        onClick={() => setSettingsTab(tab)}
                        className={`flex-1 text-xs py-2 font-medium capitalize transition-colors ${settingsTab === tab ? 'text-[var(--accent)] border-b-2 border-[var(--accent)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                      >
                        {tab}
                      </button>
                    ))}
                  </div>

                  <div className="p-3">
                    {settingsTab === 'quality' && (
                      formatsLoading ? (
                        <div className="text-xs text-[var(--text-secondary)]">Loading…</div>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {availableHeights.map(h => (
                            <button
                              key={h}
                              onClick={() => changeQuality(String(h))}
                              className={`text-xs py-1.5 px-2 rounded transition-colors text-left ${String(quality) === String(h) ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-primary)] hover:bg-[var(--border)]'}`}
                            >
                              {h}p{h >= 2160 ? ' (4K)' : h >= 1080 ? ' (HD)' : h >= 720 ? ' (HD)' : ''}
                            </button>
                          ))}
                        </div>
                      )
                    )}

                    {settingsTab === 'speed' && (
                      <div className="grid grid-cols-4 gap-1">
                        {SPEEDS.map(s => (
                          <button
                            key={s}
                            onClick={() => { setSpeed(s); if (videoRef.current) videoRef.current.playbackRate = s; }}
                            className={`text-xs py-1.5 rounded transition-colors ${speed === s ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-primary)] hover:bg-[var(--border)]'}`}
                          >
                            {s}x
                          </button>
                        ))}
                      </div>
                    )}

                    {settingsTab === 'subtitles' && (
                      <div className="flex flex-col gap-3">
                        {noSubtitlesAvailable ? (
                          <p className="text-xs text-[var(--text-secondary)] text-center py-2">Subtitles unavailable for this video</p>
                        ) : (
                          <>
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wide">Subtitles</span>
                              <button
                                onClick={() => setSubtitlesEnabled(s => !s)}
                                className={`w-10 h-5 rounded-full transition-colors relative ${subtitlesEnabled ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'}`}
                              >
                                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${subtitlesEnabled ? 'left-5' : 'left-0.5'}`} />
                              </button>
                            </div>

                            {availableSubtitles.length > 0 && (
                              <div>
                                <label className="block text-xs font-semibold mb-1 text-[var(--text-secondary)] uppercase tracking-wide">Language</label>
                                <select
                                  value={currentSubtitleLang}
                                  onChange={e => { setCurrentSubtitleLang(e.target.value); setSubtitlesEnabled(true); }}
                                  className="w-full breeze-input text-xs py-1"
                                >
                                  {availableSubtitles.map(sub => (
                                    <option key={sub.lang} value={sub.lang}>{sub.name} {sub.auto ? '(Auto)' : ''}</option>
                                  ))}
                                </select>
                              </div>
                            )}

                            <div className="border-t border-[var(--border)] pt-2">
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wide">Auto-translate</span>
                                <button
                                  onClick={() => setAutoTranslate(s => !s)}
                                  className={`w-10 h-5 rounded-full transition-colors relative ${autoTranslate ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'}`}
                                >
                                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${autoTranslate ? 'left-5' : 'left-0.5'}`} />
                                </button>
                              </div>
                              {autoTranslate && (
                                <select
                                  value={translateTo}
                                  onChange={e => setTranslateTo(e.target.value)}
                                  className="w-full breeze-input text-xs py-1"
                                >
                                  {[
                                    ['en','English'],['es','Spanish'],['fr','French'],['de','German'],
                                    ['it','Italian'],['pt','Portuguese'],['nl','Dutch'],['ru','Russian'],
                                    ['ja','Japanese'],['ko','Korean'],['zh-CN','Chinese (Simplified)'],
                                    ['ar','Arabic'],['hi','Hindi'],['tr','Turkish'],['pl','Polish'],
                                  ].map(([code, name]) => (
                                    <option key={code} value={code}>{name}</option>
                                  ))}
                                </select>
                              )}
                            </div>

                            <div>
                              <label className="block text-xs font-semibold mb-1 text-[var(--text-secondary)] uppercase tracking-wide">Size: {subtitleSize}px</label>
                              <input
                                type="range" min="12" max="36" step="2"
                                value={subtitleSize}
                                onChange={e => setSubtitleSize(Number(e.target.value))}
                                className="w-full accent-[var(--accent)]"
                              />
                            </div>

                            <div>
                              <label className="block text-xs font-semibold mb-1 text-[var(--text-secondary)] uppercase tracking-wide">Position</label>
                              <div className="flex gap-1">
                                {['top', 'center', 'bottom'].map(pos => (
                                  <button
                                    key={pos}
                                    onClick={() => setSubtitlePos(pos)}
                                    className={`flex-1 text-xs py-1.5 rounded capitalize transition-colors ${subtitlePos === pos ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-primary)] hover:bg-[var(--border)]'}`}
                                  >
                                    {pos}
                                  </button>
                                ))}
                              </div>
                            </div>

                            {loadingSubtitles && <p className="text-xs text-[var(--text-secondary)] text-center">Loading subtitles…</p>}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Download with settings panel */}
            <div className="relative">
              <button
                className="flex items-center gap-1 hover:text-[var(--accent)] transition-colors"
                onClick={(e) => { e.stopPropagation(); setShowDownload(d => !d); setShowSettings(false); }}
                title="Download"
              >
                <Download size={17} />
              </button>
              {showDownload && (
                <DownloadPanel
                  video={video}
                  quality={quality}
                  availableHeights={availableHeights}
                  onClose={() => setShowDownload(false)}
                />
              )}
            </div>

            <button className="hover:text-[var(--accent)] transition-colors" onClick={toggleFullscreen}>
              {fullscreen ? <Minimize size={17} /> : <Maximize size={17} />}
            </button>
          </div>
        </div>
      </div>

      {/* Video info card */}
      <div className="mt-3 breeze-card p-4">
        <h2 className="text-lg font-semibold mb-3 leading-snug">{video.title}</h2>
        <div className="flex items-center gap-3">
          {video.channelAvatar && (
            <img
              src={video.channelAvatar}
              alt={video.channel}
              className="w-10 h-10 rounded-full flex-shrink-0 cursor-pointer hover:ring-2 ring-[var(--accent)]"
              onClick={() => onChannelSelect && video.channelId && onChannelSelect(video.channelId)}
              onError={e => { e.target.style.display = 'none'; }}
            />
          )}
          <div className="flex-1 min-w-0">
            <p
              className="text-sm font-semibold cursor-pointer hover:text-[var(--accent)] transition-colors truncate"
              onClick={() => onChannelSelect && video.channelId && onChannelSelect(video.channelId)}
            >
              {video.channel}
            </p>
            <p className="text-xs text-[var(--text-secondary)]">{video.views}</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Share button */}
            <button
              onClick={() => {
                const url = `${window.location.origin}${window.location.pathname}?v=${video.id}`;
                navigator.clipboard.writeText(url).then(() => {
                  setShareCopied(true);
                  setTimeout(() => setShareCopied(false), 2000);
                }).catch(() => {});
              }}
              title="Copy link"
              className={`p-2 rounded-full transition-all ${shareCopied ? 'text-green-400 bg-green-400/10' : 'hover:bg-[var(--border)]'}`}
            >
              {shareCopied ? <Check size={18} /> : <Share2 size={18} />}
            </button>
            {/* Save button */}
            <button
              onClick={toggleSave}
              disabled={saveLoading}
              title={isSaved ? 'Remove from saved' : 'Save video'}
              className={`p-2 rounded-full transition-all ${isSaved ? 'text-[var(--accent)] bg-[var(--accent)]/10' : 'hover:bg-[var(--border)]'} ${saveLoading ? 'opacity-50' : ''}`}
            >
              {isSaved ? <BookmarkCheck size={18} /> : <Bookmark size={18} />}
            </button>
            {video.channelId && (
              <button
                onClick={toggleSubscribe}
                disabled={subscribeLoading}
                className={`px-4 py-2 rounded-full text-sm font-semibold transition-all ${
                  isSubscribed
                    ? 'bg-[var(--border)] text-[var(--text-secondary)] hover:bg-red-500/20 hover:text-red-400'
                    : 'bg-[var(--accent)] text-white hover:opacity-90'
                } ${subscribeLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {subscribeLoading ? '…' : isSubscribed ? 'Subscribed' : 'Subscribe'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Chapters list */}
      {chapters.length >= 2 && (
        <div className="mt-3 breeze-card">
          <button
            className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[var(--bg-primary)] transition-colors"
            onClick={() => setShowChapters(s => !s)}
          >
            <span className="font-medium text-sm flex items-center gap-2">
              <span className="text-[var(--accent)]">▶</span>
              Chapters <span className="text-[var(--text-secondary)] font-normal text-xs">({chapters.length})</span>
            </span>
            {showChapters ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          {showChapters && (
            <div className="px-2 pb-3 flex flex-col gap-0.5 max-h-72 overflow-y-auto">
              {chapters.map((ch, i) => {
                const isActive = currentChapter === ch;
                return (
                  <button
                    key={ch.time}
                    onClick={() => seekTo(ch.time)}
                    className={`flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors w-full ${
                      isActive
                        ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                        : 'hover:bg-[var(--bg-primary)] text-[var(--text-primary)]'
                    }`}
                  >
                    <span className={`text-xs font-mono tabular-nums flex-shrink-0 ${isActive ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'}`}>
                      {formatTime(ch.time)}
                    </span>
                    <span className={`text-sm truncate ${isActive ? 'font-semibold' : ''}`}>{ch.title}</span>
                    {isActive && <span className="ml-auto flex-shrink-0 w-1.5 h-1.5 bg-[var(--accent)] rounded-full" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Description */}
      <div className="mt-3 breeze-card">
        <button
          className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[var(--bg-primary)] transition-colors"
          onClick={() => setShowDescription(s => !s)}
        >
          <span className="font-medium text-sm">Description</span>
          {showDescription ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        {showDescription && (
          <div className="px-4 pb-4">
            {detailsLoading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 size={20} className="animate-spin text-[var(--accent)]" />
              </div>
            ) : description ? (
              <>
                <p className={`text-sm text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed ${!descExpanded ? 'line-clamp-5' : ''}`}>
                  {description}
                </p>
                {description.length > 300 && (
                  <button className="text-xs text-[var(--accent)] mt-2 hover:underline" onClick={() => setDescExpanded(s => !s)}>
                    {descExpanded ? 'Show less' : 'Show more'}
                  </button>
                )}
              </>
            ) : (
              <p className="text-sm text-[var(--text-secondary)]">No description available.</p>
            )}
          </div>
        )}
      </div>

      {/* Comments */}
      <div className="mt-3 breeze-card">
        <button
          className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[var(--bg-primary)] transition-colors"
          onClick={() => setShowComments(s => !s)}
        >
          <span className="font-medium text-sm flex items-center gap-2">
            <MessageSquare size={15} />
            Comments {comments.length > 0 ? `(${comments.length})` : ''}
          </span>
          {showComments ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        {showComments && (
          <div className="px-4 pb-4 flex flex-col gap-4">
            {detailsLoading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 size={20} className="animate-spin text-[var(--accent)]" />
              </div>
            ) : comments.length === 0 ? (
              <p className="text-sm text-[var(--text-secondary)]">No comments available.</p>
            ) : (
              comments.map(c => (
                <div key={c.id} className="flex gap-3">
                  {c.authorAvatar ? (
                    <img src={c.authorAvatar} alt={c.author} className="w-8 h-8 rounded-full flex-shrink-0" />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-[var(--border)] flex items-center justify-center text-xs font-bold flex-shrink-0">
                      {c.author?.[0]?.toUpperCase() || '?'}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-semibold">{c.author}</span>
                      {c.published && <span className="text-xs text-[var(--text-secondary)]">{c.published}</span>}
                    </div>
                    <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{c.text}</p>
                    {c.likes && c.likes !== '0' && (
                      <div className="flex items-center gap-1 mt-1 text-xs text-[var(--text-secondary)]">
                        <ThumbsUp size={11} />
                        {c.likes}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
