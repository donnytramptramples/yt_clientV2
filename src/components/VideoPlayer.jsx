import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  ArrowLeft, Play, Pause, Volume2, VolumeX, Maximize, Minimize,
  Loader2, Settings, Download, Video, Music, Disc3, Headphones, FileAudio
} from 'lucide-react';

function formatTime(secs) {
  const s = Math.floor(secs || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

const QUALITIES = ['144', '240', '360', '480', '720', '1080', '1440', '2160'];
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const FORMATS = [
  { value: 'mp4', label: 'MP4 (Video)', Icon: Video },
  { value: 'mp3', label: 'MP3 (Audio)', Icon: Music },
  { value: 'flac', label: 'FLAC (Lossless)', Icon: Disc3 },
  { value: 'opus', label: 'Opus', Icon: Headphones },
  { value: 'ogg', label: 'Ogg Vorbis', Icon: FileAudio },
];

export default function VideoPlayer({ video, onBack }) {
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const progressRef = useRef(null);
  const hideControlsTimer = useRef(null);

  const [quality, setQuality] = useState('720');
  const [speed, setSpeed] = useState(1);
  const [streamKey, setStreamKey] = useState(0);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);

  const [showSettings, setShowSettings] = useState(false);
  const [showDownload, setShowDownload] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [draggingProgress, setDraggingProgress] = useState(false);
  const [embedFallback, setEmbedFallback] = useState(false);

  // Use proxy endpoint: supports HTTP range requests so browser can seek and cache natively
  const proxyUrl = `/api/proxy/${video.id}?quality=${quality}`;

  // Reset fallback when video changes
  useEffect(() => {
    setEmbedFallback(false);
  }, [video.id]);

  // Fetch video duration from info endpoint
  useEffect(() => {
    setDuration(0);
    fetch(`/api/info/${video.id}`)
      .then(r => r.json())
      .then(data => { if (data.duration) setDuration(data.duration); })
      .catch(() => {});
  }, [video.id]);

  // Video event wiring
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTimeUpdate = () => {
      setCurrentTime(v.currentTime);
      if (v.buffered.length > 0) {
        setBufferedEnd(v.buffered.end(v.buffered.length - 1));
      }
    };
    const onDurationChange = () => {
      if (v.duration && isFinite(v.duration)) setDuration(v.duration);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onWaiting = () => setIsLoading(true);
    const onCanPlay = () => setIsLoading(false);
    const onLoadStart = () => { setIsLoading(true); setPlaying(false); };
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('durationchange', onDurationChange);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('canplay', onCanPlay);
    v.addEventListener('loadstart', onLoadStart);
    return () => {
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('durationchange', onDurationChange);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('canplay', onCanPlay);
      v.removeEventListener('loadstart', onLoadStart);
    };
  }, [streamKey]);

  // Apply playback speed
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed, streamKey]);

  // Fullscreen change listener
  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Auto-hide controls
  const showControls = useCallback(() => {
    setControlsVisible(true);
    clearTimeout(hideControlsTimer.current);
    if (playing) {
      hideControlsTimer.current = setTimeout(() => setControlsVisible(false), 3000);
    }
  }, [playing]);

  useEffect(() => {
    if (!playing) setControlsVisible(true);
    else {
      hideControlsTimer.current = setTimeout(() => setControlsVisible(false), 3000);
    }
    return () => clearTimeout(hideControlsTimer.current);
  }, [playing]);

  // Native seek — the proxy endpoint handles range requests so the browser can seek freely
  const seekTo = useCallback((targetTime) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = targetTime;
  }, []);

  // Progress bar interaction
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
    const onMove = (e) => {
      const ratio = getProgressRatio(e);
      setCurrentTime(ratio * duration);
    };
    const onUp = (e) => {
      const ratio = getProgressRatio(e);
      seekTo(ratio * duration);
      setDraggingProgress(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [draggingProgress, duration, seekTo, getProgressRatio]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };

  const toggleMute = () => {
    const v = videoRef.current;
    v.muted = !muted;
    setMuted(!muted);
  };

  const setVolumeVal = (val) => {
    const v = videoRef.current;
    v.volume = val;
    v.muted = false;
    setVolume(val);
    setMuted(false);
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) containerRef.current.requestFullscreen();
    else document.exitFullscreen();
  };

  const changeQuality = (q) => {
    const savedTime = videoRef.current?.currentTime || 0;
    setQuality(q);
    setIsLoading(true);
    setStreamKey(k => k + 1);
    setShowSettings(false);
    // Restore position after quality change
    setTimeout(() => {
      if (videoRef.current) videoRef.current.currentTime = savedTime;
    }, 500);
  };

  // Download via fetch+blob so it works reliably across all browsers/proxies
  const handleDownload = async (format) => {
    setDownloading(true);
    setShowDownload(false);
    try {
      const url = `/api/download/${video.id}?format=${format}&quality=${quality}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${video.title || 'video'}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    } catch (err) {
      console.error('Download failed:', err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setDownloading(false);
    }
  };

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPct = duration > 0 ? (bufferedEnd / duration) * 100 : 0;

  return (
    <div className="max-w-5xl mx-auto">
      <button
        onClick={onBack}
        className="mb-4 flex items-center gap-2 hover:text-[var(--accent)] transition-colors text-sm"
      >
        <ArrowLeft size={16} />
        Back to results
      </button>

      {/* Player container */}
      <div
        ref={containerRef}
        className="relative bg-black select-none"
        style={{ borderRadius: 4 }}
        onMouseMove={showControls}
        onClick={() => { togglePlay(); showControls(); }}
        onDoubleClick={toggleFullscreen}
      >
        {/* Video — key on streamKey+quality so it reloads when quality changes */}
        {embedFallback ? (
          <iframe
            key={video.id}
            src={`https://www.youtube.com/embed/${video.id}?autoplay=1`}
            className="w-full aspect-video block"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            title={video.title}
          />
        ) : (
          <video
            key={`${streamKey}-${quality}`}
            ref={videoRef}
            src={proxyUrl}
            className="w-full aspect-video block"
            autoPlay
            playsInline
            preload="auto"
            onError={(e) => {
              console.warn('Proxy stream failed, switching to YouTube embed:', e.target.error);
              setIsLoading(false);
              setEmbedFallback(true);
            }}
          />
        )}

        {/* Loading spinner */}
        {isLoading && !embedFallback && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 pointer-events-none">
            <Loader2 size={48} className="text-[var(--accent)] animate-spin" />
          </div>
        )}

        {/* Controls overlay — hidden when using YouTube embed fallback */}
        <div
          className={`absolute inset-0 flex flex-col justify-end transition-opacity duration-200 ${embedFallback ? 'hidden' : ''} ${controlsVisible || !playing ? 'opacity-100' : 'opacity-0'}`}
          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 40%)' }}
          onClick={e => e.stopPropagation()}
        >
          {/* Progress bar */}
          <div className="px-4 pb-1 pt-4">
            <div
              ref={progressRef}
              className="relative h-1.5 rounded-full bg-white/25 cursor-pointer group/bar"
              style={{ touchAction: 'none' }}
              onMouseDown={onProgressMouseDown}
            >
              {/* Buffered */}
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-white/30"
                style={{ width: `${bufferedPct}%` }}
              />
              {/* Played */}
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-[var(--accent)]"
                style={{ width: `${progressPct}%` }}
              />
              {/* Thumb */}
              <div
                className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full -ml-1.5 opacity-0 group-hover/bar:opacity-100 transition-opacity"
                style={{ left: `${progressPct}%` }}
              />
            </div>
          </div>

          {/* Controls row */}
          <div className="px-4 pb-3 flex items-center gap-3 text-white">
            {/* Play/Pause */}
            <button
              className="hover:text-[var(--accent)] transition-colors"
              onClick={togglePlay}
            >
              {playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
            </button>

            {/* Time */}
            <span className="text-xs tabular-nums whitespace-nowrap">
              {formatTime(currentTime)} / {duration ? formatTime(duration) : '--:--'}
            </span>

            {/* Volume */}
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

            {/* Speed indicator */}
            <button
              className="text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20 hover:text-[var(--accent)] transition-colors"
              onClick={(e) => { e.stopPropagation(); setShowSettings(s => !s); setShowDownload(false); }}
            >
              {speed}x
            </button>

            {/* Settings (quality + speed) */}
            <div className="relative">
              <button
                className="flex items-center gap-1 hover:text-[var(--accent)] transition-colors"
                onClick={(e) => { e.stopPropagation(); setShowSettings(s => !s); setShowDownload(false); }}
              >
                <Settings size={17} />
              </button>
              {showSettings && (
                <div
                  className="absolute bottom-full right-0 mb-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded p-3 min-w-[200px] z-50 text-[var(--text-primary)]"
                  style={{ boxShadow: '0 -4px 24px rgba(0,0,0,0.5)' }}
                  onClick={e => e.stopPropagation()}
                >
                  <div className="mb-3">
                    <label className="block text-xs font-semibold mb-1.5 text-[var(--text-secondary)] uppercase tracking-wide">Quality</label>
                    <div className="grid grid-cols-4 gap-1">
                      {QUALITIES.map(q => (
                        <button
                          key={q}
                          onClick={() => changeQuality(q)}
                          className={`text-xs py-1 rounded transition-colors ${quality === q ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-primary)] hover:bg-[var(--border)]'}`}
                        >
                          {q}p
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold mb-1.5 text-[var(--text-secondary)] uppercase tracking-wide">Speed</label>
                    <div className="grid grid-cols-4 gap-1">
                      {SPEEDS.map(s => (
                        <button
                          key={s}
                          onClick={() => { setSpeed(s); if (videoRef.current) videoRef.current.playbackRate = s; }}
                          className={`text-xs py-1 rounded transition-colors ${speed === s ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-primary)] hover:bg-[var(--border)]'}`}
                        >
                          {s}x
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Download */}
            <div className="relative">
              <button
                className="flex items-center gap-1 hover:text-[var(--accent)] transition-colors"
                onClick={(e) => { e.stopPropagation(); setShowDownload(d => !d); setShowSettings(false); }}
                disabled={downloading}
              >
                {downloading ? <Loader2 size={17} className="animate-spin" /> : <Download size={17} />}
              </button>
              {showDownload && (
                <div
                  className="absolute bottom-full right-0 mb-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded p-1.5 min-w-[180px] z-50 text-[var(--text-primary)]"
                  style={{ boxShadow: '0 -4px 24px rgba(0,0,0,0.5)' }}
                  onClick={e => e.stopPropagation()}
                >
                  {FORMATS.map(({ value, label, Icon }) => (
                    <button
                      key={value}
                      onClick={() => handleDownload(value)}
                      className="w-full flex items-center gap-3 px-3 py-2 rounded hover:bg-[var(--bg-primary)] transition-colors text-sm"
                    >
                      <Icon size={15} className="text-[var(--accent)] flex-shrink-0" />
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Fullscreen */}
            <button
              className="hover:text-[var(--accent)] transition-colors"
              onClick={toggleFullscreen}
            >
              {fullscreen ? <Minimize size={17} /> : <Maximize size={17} />}
            </button>
          </div>
        </div>
      </div>

      {/* Video info below player */}
      <div className="mt-3 breeze-card p-4">
        <h2 className="text-lg font-semibold mb-2 leading-snug">{video.title}</h2>
        <div className="flex items-center gap-3">
          {video.channelAvatar && (
            <img
              src={video.channelAvatar}
              alt={video.channel}
              className="w-8 h-8 rounded-full flex-shrink-0"
              onError={e => { e.target.style.display = 'none'; }}
            />
          )}
          <div>
            <p className="text-sm font-medium">{video.channel}</p>
            <p className="text-xs text-[var(--text-secondary)]">{video.views}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
