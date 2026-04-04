import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  ArrowLeft, Play, Pause, Volume2, VolumeX, Maximize, Minimize,
  Loader2, Settings, Download, Video, Music, Disc3, Headphones, FileAudio,
  Subtitles, ChevronDown, ChevronUp, MessageSquare, ThumbsUp, Bookmark, BookmarkCheck
} from 'lucide-react';

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

  const posStyle = {
    bottom: { bottom: '68px', top: 'auto' },
    center: { top: '50%', transform: 'translateX(-50%) translateY(-50%)', bottom: 'auto' },
    top: { top: '12px', bottom: 'auto' },
  }[pos] || { bottom: '68px' };

  return (
    <div
      className="absolute left-1/2 pointer-events-none text-center"
      style={{ left: '50%', transform: pos === 'center' ? 'translateX(-50%) translateY(-50%)' : 'translateX(-50%)', ...posStyle, maxWidth: '90%' }}
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
                {word.text}
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
  const [progress, setProgress] = useState(-1);

  const fmt = FORMAT_OPTIONS.find(f => f.value === selFormat);

  const handleDownload = async () => {
    setDownloading(true);
    setProgress(0);
    try {
      let url = `/api/download/${video.id}?format=${selFormat}&title=${encodeURIComponent(video.title || 'video')}`;
      if (fmt?.hasQuality) url += `&quality=${selQuality}`;
      if (fmt?.hasBitrate) url += `&bitrate=${selBitrate}`;
      if (fmt?.hasCompression) url += `&compression=${selCompression}`;

      const response = await fetch(url);
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: `Server error ${response.status}` }));
        throw new Error(err.error || `Server error ${response.status}`);
      }

      const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
      const cd = response.headers.get('content-disposition') || '';
      const nameMatch = cd.match(/filename="([^"]+)"/);
      const filename = nameMatch ? nameMatch[1] : `${(video.title || 'video').replace(/[<>:"/\\|?*]/g, '')}.${selFormat}`;

      const reader = response.body.getReader();
      const chunks = [];
      let received = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (contentLength > 0) {
          setProgress(Math.min(99, Math.round((received / contentLength) * 100)));
        } else {
          setProgress(101);
        }
      }

      setProgress(100);

      const mimeTypes = { mp4: 'video/mp4', mp3: 'audio/mpeg', flac: 'audio/flac', opus: 'audio/ogg', ogg: 'audio/ogg', m4a: 'audio/mp4' };
      const blob = new Blob(chunks, { type: mimeTypes[selFormat] || 'application/octet-stream' });
      if (blob.size === 0) throw new Error('Downloaded file is empty');

      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
      onClose();
    } catch (err) {
      alert(`Download failed: ${err.message}`);
    } finally {
      setDownloading(false);
      setTimeout(() => setProgress(-1), 2000);
    }
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
          progress === 101
            ? <><Loader2 size={14} className="animate-spin" /> Processing…</>
            : progress >= 0 && progress < 100
              ? <><Loader2 size={14} className="animate-spin" /> {progress}%</>
              : <Loader2 size={14} className="animate-spin" />
        ) : (
          <><Download size={14} /> Download {selFormat.toUpperCase()}</>
        )}
      </button>
    </div>
  );
}

export default function VideoPlayer({ video, onBack, onChannelSelect }) {
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

  // Proxy seeking — all seeking goes through proxySeekRef; no native seeking for proxy streams
  const [proxySeek, setProxySeek] = useState(0);
  const proxySeekRef = useRef(0);
  const seekReloadRef = useRef(false);
  const wasPlayingRef = useRef(false);

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

    fetch(`/api/formats/${video.id}`)
      .then(r => r.json())
      .then(data => {
        const heights = data.availableHeights || [];
        setAvailableHeights(heights);
        const preferred = [720, 1080, 480, 360, 240, 144];
        const def = preferred.find(p => heights.includes(p)) || heights[0] || 360;
        setQuality(String(def));
      })
      .catch(() => { setAvailableHeights([360]); setQuality('360'); })
      .finally(() => setFormatsLoading(false));

    fetch(`/api/info/${video.id}`)
      .then(r => r.json())
      .then(data => {
        if (data.duration) { apiDuration.current = data.duration; setDuration(data.duration); }
      })
      .catch(() => {});

    fetch(`/api/subtitles/${video.id}/list`)
      .then(r => r.json())
      .then(data => {
        if (data.subtitles && data.subtitles.length > 0) {
          setAvailableSubtitles(data.subtitles);
          const enSub = data.subtitles.find(s => s.lang === 'en') || data.subtitles[0];
          setCurrentSubtitleLang(enSub.lang);
        }
      })
      .catch(() => {});

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
      setCurrentTime(proxySeekRef.current + v.currentTime);
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
    const onError = () => { setIsLoading(false); };

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
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    clearTimeout(hideControlsTimer.current);
    if (playing) hideControlsTimer.current = setTimeout(() => setControlsVisible(false), 3000);
  }, [playing]);

  useEffect(() => {
    if (!playing) setControlsVisible(true);
    else hideControlsTimer.current = setTimeout(() => setControlsVisible(false), 3000);
    return () => clearTimeout(hideControlsTimer.current);
  }, [playing]);

  // FIXED: seekTo uses proxy seek exclusively. Only falls back to native seek
  // if the target is within the already-buffered range (instant, no reload).
  const seekTo = useCallback((targetTime) => {
    const v = videoRef.current;
    if (!v) return;

    const clamped = Math.max(0, Math.min(duration > 0 ? duration - 1 : 1e9, targetTime));
    wasPlayingRef.current = !v.paused;

    // Check if target is already buffered (no need to reload)
    const currentProxyStart = proxySeekRef.current;
    const bufferedMax = v.buffered.length > 0
      ? currentProxyStart + v.buffered.end(v.buffered.length - 1)
      : currentProxyStart;

    if (clamped >= currentProxyStart && clamped <= bufferedMax) {
      // Native seek within buffered range — fast and no reload
      v.currentTime = clamped - currentProxyStart;
      setCurrentTime(clamped);
      return;
    }

    // Outside buffered range — reload stream at new position
    seekReloadRef.current = true;
    setCurrentTime(clamped);
    const newSeek = Math.floor(clamped);
    proxySeekRef.current = newSeek;
    setProxySeek(newSeek);
  }, [duration]);

  // FIXED: changeQuality sets proxySeek directly to current absolute position
  // so the new stream starts from exactly where we are — no native seek needed.
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

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };

  const toggleMute = () => { const v = videoRef.current; v.muted = !muted; setMuted(!muted); };

  const setVolumeVal = (val) => {
    const v = videoRef.current;
    v.volume = val; v.muted = false;
    setVolume(val); setMuted(false);
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) containerRef.current.requestFullscreen();
    else document.exitFullscreen();
  };

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPct = duration > 0 ? (bufferedEnd / duration) * 100 : 0;
  const noSubtitlesAvailable = availableSubtitles.length === 0;

  return (
    <div className="max-w-5xl mx-auto">
      <button
        onClick={onBack}
        className="mb-4 flex items-center gap-2 hover:text-[var(--accent)] transition-colors text-sm"
      >
        <ArrowLeft size={16} />
        Back to results
      </button>

      {/* Video container */}
      <div
        ref={containerRef}
        className="video-player-container"
        onMouseMove={showControls}
        onClick={() => { togglePlay(); showControls(); }}
        onDoubleClick={toggleFullscreen}
      >
        {proxyUrl && (
          <video
            key={`${video.id}-${quality}-${proxySeek}`}
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

        {(isLoading || formatsLoading || !proxyUrl) && (
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

        {/* Controls */}
        <div
          className={`absolute inset-0 flex flex-col justify-end transition-opacity duration-200 ${controlsVisible || !playing ? 'opacity-100' : 'opacity-0'}`}
          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 40%)' }}
          onClick={e => e.stopPropagation()}
        >
          <div className="px-4 pb-1 pt-4">
            <div
              ref={progressRef}
              className="relative h-1.5 rounded-full bg-white/25 cursor-pointer group/bar"
              style={{ touchAction: 'none' }}
              onMouseDown={onProgressMouseDown}
            >
              <div className="absolute inset-y-0 left-0 rounded-full bg-white/30" style={{ width: `${bufferedPct}%` }} />
              <div className="absolute inset-y-0 left-0 rounded-full bg-[var(--accent)]" style={{ width: `${progressPct}%` }} />
              <div
                className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full -ml-1.5 opacity-0 group-hover/bar:opacity-100 transition-opacity"
                style={{ left: `${progressPct}%` }}
              />
            </div>
          </div>

          <div className="px-4 pb-3 flex items-center gap-3 text-white">
            <button className="hover:text-[var(--accent)] transition-colors" onClick={togglePlay}>
              {playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
            </button>

            <span className="text-xs tabular-nums whitespace-nowrap">
              {formatTime(currentTime)} / {duration ? formatTime(duration) : '--:--'}
            </span>

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
