import React, { useState, useEffect } from 'react';
import { ArrowLeft, Loader2, Users, SortAsc, ChevronDown } from 'lucide-react';
import VideoCard from './VideoCard';

const PAGE_SIZE = 12;

export default function ChannelPage({ channelId, onBack, onVideoSelect, user, onSubscribeChange }) {
  const [channel, setChannel] = useState(null);
  const [allVideos, setAllVideos] = useState([]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sort, setSort] = useState('newest');
  const [subscribed, setSubscribed] = useState(false);
  const [subLoading, setSubLoading] = useState(false);

  useEffect(() => {
    if (!channelId) return;
    setLoading(true);
    setError('');
    setVisibleCount(PAGE_SIZE);
    fetch(`/api/channel/${channelId}/videos?sort=${sort}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) { setError(data.error); return; }
        setChannel(data.channel || null);
        setAllVideos(data.videos || []);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [channelId, sort]);

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
    } catch { } finally {
      setSubLoading(false);
    }
  };

  const videos = allVideos.slice(0, visibleCount);
  const hasMore = visibleCount < allVideos.length;

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
        <div className="flex items-center justify-center h-40">
          <p className="text-red-400 text-sm">{error}</p>
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

          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">{allVideos.length} Videos</h2>
            <div className="flex items-center gap-2">
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

          {videos.length === 0 ? (
            <div className="flex items-center justify-center h-40">
              <p className="text-[var(--text-secondary)]">No videos found for this channel.</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {videos.map(video => (
                  <VideoCard key={video.id} video={video} onClick={() => onVideoSelect(video)} onChannelClick={() => {}} />
                ))}
              </div>

              {hasMore && (
                <div className="flex justify-center mt-8">
                  <button
                    onClick={() => setVisibleCount(c => c + PAGE_SIZE)}
                    className="flex items-center gap-2 px-6 py-2.5 rounded-full bg-[var(--bg-secondary)] border border-[var(--border)] hover:bg-[var(--border)] transition-colors text-sm font-medium"
                  >
                    <ChevronDown size={16} />
                    Load More ({allVideos.length - visibleCount} remaining)
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
