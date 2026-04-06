import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ArrowLeft, Loader2, Users, SortAsc, ChevronDown, Search, X } from 'lucide-react';
import VideoCard from './VideoCard';

const SERVER_PAGE_SIZE = 60;

export default function ChannelPage({ channelId, onBack, onVideoSelect, user, onSubscribeChange }) {
  const [channel, setChannel] = useState(null);
  const [allVideos, setAllVideos] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [sort, setSort] = useState('newest');
  const [subscribed, setSubscribed] = useState(false);
  const [subLoading, setSubLoading] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');

  const fetchPage = useCallback(async (channelId, sort, page) => {
    const r = await fetch(`/api/channel/${channelId}/videos?sort=${sort}&page=${page}&pageSize=${SERVER_PAGE_SIZE}`);
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(text.startsWith('<') ? `Server error ${r.status}` : text || `Server error ${r.status}`);
    }
    return r.json();
  }, []);

  // Initial load: reset everything and fetch page 1
  useEffect(() => {
    if (!channelId) return;
    setLoading(true);
    setError('');
    setAllVideos([]);
    setCurrentPage(1);
    setHasMore(false);
    setSearchQuery('');

    fetchPage(channelId, sort, 1)
      .then(data => {
        if (data.error) { setError(data.error); return; }
        setChannel(data.channel || null);
        setAllVideos(data.videos || []);
        setHasMore(data.hasMore ?? false);
        setCurrentPage(1);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [channelId, sort, retryKey]);

  const handleLoadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const nextPage = currentPage + 1;
      const data = await fetchPage(channelId, sort, nextPage);
      if (data.videos?.length > 0) {
        setAllVideos(prev => {
          const existingIds = new Set(prev.map(v => v.id));
          const newVids = data.videos.filter(v => !existingIds.has(v.id));
          return [...prev, ...newVids];
        });
        setCurrentPage(nextPage);
        setHasMore(data.hasMore ?? false);
      } else {
        setHasMore(false);
      }
    } catch (e) {
      console.error('Load more error:', e.message);
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    if (!user || !channelId) return;
    fetch(`/api/subscriptions/${channelId}/status`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : { subscribed: false })
      .then(data => setSubscribed(data.subscribed || false))
      .catch(() => {});
  }, [user, channelId]);

  const handleSubscribe = async () => {
    if (!user) return;
    setSubLoading(true);
    try {
      if (subscribed) {
        await fetch(`/api/subscriptions/${channelId}`, { method: 'DELETE', credentials: 'include' });
        setSubscribed(false);
      } else {
        await fetch('/api/subscriptions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            channelId,
            channelName: channel?.name || channelId,
            channelAvatar: channel?.avatar || '',
          }),
        });
        setSubscribed(true);
      }
      if (onSubscribeChange) onSubscribeChange();
    } catch { }
    finally { setSubLoading(false); }
  };

  // Client-side filter for in-channel search (over already-fetched videos)
  const filteredVideos = useMemo(() => {
    if (!searchQuery.trim()) return allVideos;
    const q = searchQuery.trim().toLowerCase();
    return allVideos.filter(v => v.title?.toLowerCase().includes(q));
  }, [allVideos, searchQuery]);

  const countLabel = searchQuery
    ? `${filteredVideos.length} results`
    : `${allVideos.length}${hasMore ? '+' : ''} Videos`;

  return (
    <div className="max-w-6xl mx-auto">
      <button
        onClick={onBack}
        className="mb-4 flex items-center gap-2 hover:text-[var(--accent)] transition-colors text-sm"
      >
        <ArrowLeft size={16} />
        Back
      </button>

      {loading ? (
        <div className="flex flex-col items-center justify-center h-64 gap-4">
          <Loader2 size={40} className="text-[var(--accent)] animate-spin" />
          <p className="text-[var(--text-secondary)] text-sm">Loading channel videos…</p>
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center h-40 gap-3">
          <p className="text-red-400 text-sm text-center max-w-sm">{error}</p>
          <button className="breeze-btn text-sm" onClick={() => setRetryKey(k => k + 1)}>Retry</button>
        </div>
      ) : (
        <>
          {channel && (
            <div className="breeze-card p-6 mb-6 flex items-start gap-4">
              {channel.avatar && (
                <img src={channel.avatar} alt={channel.name} className="w-20 h-20 rounded-full flex-shrink-0"
                  onError={e => { e.target.style.display = 'none'; }} />
              )}
              <div className="flex-1 min-w-0">
                <h1 className="text-2xl font-bold mb-1">{channel.name || channelId}</h1>
                {channel.subscribers && (
                  <p className="text-sm text-[var(--text-secondary)] flex items-center gap-1 mb-2">
                    <Users size={14} />
                    {channel.subscribers} subscribers
                  </p>
                )}
                {channel.description && (
                  <p className="text-sm text-[var(--text-secondary)] line-clamp-2">{channel.description}</p>
                )}
              </div>
              {user && (
                <button
                  onClick={handleSubscribe}
                  disabled={subLoading}
                  className={`flex-shrink-0 px-5 py-2 rounded-full text-sm font-semibold transition-all ${
                    subscribed
                      ? 'bg-[var(--border)] text-[var(--text-secondary)] hover:bg-red-500/20 hover:text-red-400'
                      : 'bg-[var(--accent)] text-white hover:opacity-90'
                  } ${subLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {subLoading ? <Loader2 size={14} className="animate-spin inline" /> : subscribed ? 'Subscribed' : 'Subscribe'}
                </button>
              )}
            </div>
          )}

          {/* Controls row: count + search + sort */}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <h2 className="text-lg font-semibold flex-shrink-0">{countLabel}</h2>

            {/* Video search within channel */}
            <div className="flex-1 min-w-[180px] max-w-xs relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-secondary)] pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search videos…"
                className="w-full breeze-input pl-8 pr-8 text-sm py-1.5"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  <X size={13} />
                </button>
              )}
            </div>

            <div className="flex items-center gap-2 ml-auto flex-shrink-0">
              <SortAsc size={16} className="text-[var(--text-secondary)]" />
              <select
                value={sort}
                onChange={e => setSort(e.target.value)}
                className="breeze-input text-sm py-1"
              >
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="popular">Most Popular</option>
              </select>
            </div>
          </div>

          {filteredVideos.length === 0 ? (
            <div className="flex items-center justify-center h-40">
              <p className="text-[var(--text-secondary)]">
                {searchQuery ? `No videos match "${searchQuery}"` : 'No videos found for this channel.'}
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {filteredVideos.map(video => (
                  <VideoCard key={video.id} video={video} onClick={() => onVideoSelect(video)} onChannelClick={() => {}} />
                ))}
              </div>

              {/* Load more — only show when not searching (search filters already-fetched videos) */}
              {!searchQuery && hasMore && (
                <div className="flex justify-center mt-8">
                  <button
                    onClick={handleLoadMore}
                    disabled={loadingMore}
                    className="flex items-center gap-2 px-6 py-2.5 rounded-full bg-[var(--bg-secondary)] border border-[var(--border)] hover:bg-[var(--border)] transition-colors text-sm font-medium disabled:opacity-60"
                  >
                    {loadingMore ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <ChevronDown size={16} />
                    )}
                    {loadingMore ? 'Loading…' : `Load More Videos`}
                  </button>
                </div>
              )}

              {!searchQuery && !hasMore && allVideos.length > 0 && (
                <p className="text-center text-[var(--text-secondary)] text-sm mt-8">
                  All {allVideos.length} videos loaded
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
