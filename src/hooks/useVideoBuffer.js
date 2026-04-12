import { useState, useRef, useEffect, useCallback } from 'react';

const EVICT_BEHIND_S = 30;  // always drop content this far behind playhead
const MAX_BUFFER_S   = 120; // cap total buffered seconds across all ranges (~60–180 MB depending on quality)

const FALLBACK_MIMES = [
  'video/mp4; codecs="avc1.640028,mp4a.40.2"',
  'video/mp4; codecs="avc1.4D401F,mp4a.40.2"',
  'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',
];

export function useVideoBuffer({ videoId, quality, videoRef }) {
  const [objectUrl, setObjectUrl] = useState(null);
  const [isReady,   setIsReady]   = useState(false);

  const msRef     = useRef(null);
  const sbRef     = useRef(null);
  const urlRef    = useRef(null);
  const fetchCtrl = useRef(null);
  const appendQ   = useRef([]);
  const busy      = useRef(false);

  const flush = useCallback(() => {
    const sb = sbRef.current;
    if (!sb || sb.updating || busy.current || !appendQ.current.length) return;
    const chunk = appendQ.current.shift();
    busy.current = true;
    try {
      sb.appendBuffer(chunk);
    } catch (e) {
      busy.current = false;
      if (e.name === 'QuotaExceededError') {
        const v = videoRef.current;
        if (v && sbRef.current && !sbRef.current.updating) {
          try { sbRef.current.remove(0, Math.max(0, v.currentTime - 5)); } catch {}
        }
      }
    }
  }, [videoRef]);

  const startFetch = useCallback(async (fromSec, ctrl) => {
    const url = `/api/proxy/${videoId}?quality=${quality}${fromSec > 0 ? `&t=${fromSec}` : ''}`;
    try {
      const resp = await fetch(url, { signal: ctrl.signal, credentials: 'include' });
      if (!resp.ok || !resp.body) return;
      const reader = resp.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done || ctrl.signal.aborted) break;
        appendQ.current.push(value);
        flush();
      }
    } catch (e) {
      if (e.name !== 'AbortError') console.warn('[MSE] fetch error:', e.message);
    }
  }, [videoId, quality, flush]);

  const initMSE = useCallback((mimeType) => {
    fetchCtrl.current?.abort();
    appendQ.current = [];
    busy.current = false;
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    msRef.current  = null;
    sbRef.current  = null;
    setIsReady(false);

    const ms  = new MediaSource();
    msRef.current = ms;
    const url = URL.createObjectURL(ms);
    urlRef.current = url;
    setObjectUrl(url);

    ms.addEventListener('sourceopen', () => {
      try {
        const sb = ms.addSourceBuffer(mimeType);
        sbRef.current = sb;
        sb.timestampOffset = 0;
        sb.addEventListener('updateend', () => { busy.current = false; flush(); });
        setIsReady(true);
        const ctrl = new AbortController();
        fetchCtrl.current = ctrl;
        startFetch(0, ctrl);
      } catch (e) {
        console.error('[MSE] SourceBuffer init failed:', e.message);
        setObjectUrl(null);
        setIsReady(false);
      }
    }, { once: true });
  }, [flush, startFetch]);

  useEffect(() => {
    if (!videoId || !quality || !window.MediaSource) return;
    let cancelled = false;

    (async () => {
      let mime = null;
      try {
        const r = await fetch(`/api/codec/${videoId}?quality=${quality}`, { credentials: 'include' });
        if (!r.ok || cancelled) return;
        const { mimeType } = await r.json();
        if (MediaSource.isTypeSupported(mimeType)) mime = mimeType;
      } catch {}
      if (!mime) mime = FALLBACK_MIMES.find(m => MediaSource.isTypeSupported(m)) ?? null;
      if (!mime || cancelled) {
        if (!cancelled) console.warn('[MSE] no supported codec, falling back to proxy URL');
        return;
      }
      if (!cancelled) initMSE(mime);
    })();

    return () => {
      cancelled = true;
      fetchCtrl.current?.abort();
      appendQ.current = [];
      if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
      setObjectUrl(null);
      setIsReady(false);
      msRef.current = null;
      sbRef.current = null;
    };
  }, [videoId, quality, initMSE]);

  const seekInBuffer = useCallback((targetSec) => {
    const v = videoRef.current;
    if (!v || !isReady) return false;
    const buf = v.buffered;
    for (let i = 0; i < buf.length; i++) {
      if (targetSec >= buf.start(i) - 0.1 && targetSec < buf.end(i) - 0.2) return true;
    }
    return false;
  }, [videoRef, isReady]);

  const restartFrom = useCallback(async (fromSec) => {
    const sb = sbRef.current;
    const ms = msRef.current;
    if (!sb || !ms || ms.readyState !== 'open') return;

    fetchCtrl.current?.abort();
    appendQ.current = [];
    busy.current = false;

    if (sb.updating) {
      await new Promise(r => sb.addEventListener('updateend', r, { once: true }));
    }
    try { sb.abort(); } catch {}

    // Decide how much of the existing buffer to keep.
    // Find where the current buffer ends so we know if there's a gap.
    const v = videoRef.current;
    let bufEnd = 0;
    if (v) {
      const buf = v.buffered;
      if (buf.length > 0) bufEnd = buf.end(buf.length - 1);
    }

    // If seeking forward with a significant gap (> 2 s beyond buffer end), clear
    // everything. Non-contiguous MSE ranges with a large hole can cause browsers to
    // never fire canplay at the new position, stalling playback indefinitely.
    // For backward seeks or small forward gaps, preserve data before the seek point
    // so that seeking back into the grey bar is still instant.
    const hasLargeGap = fromSec > bufEnd + 2;
    const clearFrom = hasLargeGap ? 0 : Math.max(0, fromSec - 1);

    try {
      sb.remove(clearFrom, Infinity);
      // IMPORTANT: only await updateend if remove actually started an operation.
      // If the removed range is empty (no buffered data in that range) some browsers
      // skip firing updateend entirely, which would cause this await to hang forever
      // and prevent startFetch from ever being called.
      if (sb.updating) {
        await new Promise(r => sb.addEventListener('updateend', r, { once: true }));
      }
    } catch {}

    // timestampOffset shifts the incoming server fragments (which start at t=0) to
    // land at the correct absolute position in the SourceBuffer.
    try { sb.timestampOffset = fromSec; } catch {}

    const ctrl = new AbortController();
    fetchCtrl.current = ctrl;
    startFetch(fromSec, ctrl);
  }, [startFetch, videoRef]);

  const evict = useCallback((currentSec) => {
    const sb = sbRef.current;
    const v  = videoRef.current;
    if (!sb || sb.updating) return;

    // 1. Always drop content more than EVICT_BEHIND_S seconds behind the playhead.
    const evictTo = Math.max(0, currentSec - EVICT_BEHIND_S);
    if (evictTo >= 2) {
      try { sb.remove(0, evictTo); } catch {}
      return; // let the updateend cycle finish before doing more
    }

    // 2. Cap total buffer to MAX_BUFFER_S to keep RAM bounded.
    //    If over the cap, trim the furthest-ahead content that is well past the playhead.
    if (!v) return;
    let totalBuffered = 0;
    const buf = v.buffered;
    for (let i = 0; i < buf.length; i++) {
      totalBuffered += buf.end(i) - buf.start(i);
    }
    if (totalBuffered > MAX_BUFFER_S && buf.length > 0) {
      const excess    = totalBuffered - MAX_BUFFER_S;
      const farEnd    = buf.end(buf.length - 1);
      const trimStart = Math.max(currentSec + EVICT_BEHIND_S, farEnd - excess);
      if (trimStart < farEnd) {
        try { sb.remove(trimStart, farEnd); } catch {}
      }
    }
  }, [videoRef]);

  return { objectUrl, isReady, seekInBuffer, restartFrom, evict };
}
