import React, { useState, useEffect } from 'react';
import { Loader2, Rss } from 'lucide-react';
import VideoCard from './VideoCard';

export default function FeedPage({ user, onVideoSelect, onChannelSelect }) {
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [subscriptions, setSubscriptions] = useState([]);

  useEffect(() => {
    if (!user) return;
    setLoading(true);

    Promise.all([
      fetch('/api/feed', { credentials: 'include' }).then(r => r.json()),
      fetch('/api/subscriptions', { credentials: 'include' }).then(r => r.json()),
    ])
      .then(([feedData, subsData]) => {
        setVideos(feedData.videos || []);
        setSubscriptions(subsData.subscriptions || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [user]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={36} className="text-[var(--accent)] animate-spin" />
      </div>
    );
  }

  if (subscriptions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <Rss size={40} className="text-[var(--text-secondary)]" />
        <p className="text-[var(--text-secondary)] text-lg font-medium">No subscriptions yet</p>
        <p className="text-[var(--text-secondary)] text-sm">Search for a channel and subscribe to see their videos here.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3">Subscriptions</h2>
        <div className="flex gap-3 overflow-x-auto pb-2">
          {subscriptions.map(sub => (
            <button
              key={sub.channel_id}
              onClick={() => onChannelSelect(sub.channel_id)}
              className="flex flex-col items-center gap-1 flex-shrink-0 group"
            >
              {sub.channel_avatar ? (
                <img
                  src={sub.channel_avatar}
                  alt={sub.channel_name}
                  className="w-12 h-12 rounded-full group-hover:ring-2 ring-[var(--accent)] transition-all"
                />
              ) : (
                <div className="w-12 h-12 rounded-full bg-[var(--border)] flex items-center justify-center text-sm font-bold">
                  {sub.channel_name[0]?.toUpperCase()}
                </div>
              )}
              <span className="text-xs text-[var(--text-secondary)] max-w-[60px] truncate">{sub.channel_name}</span>
            </button>
          ))}
        </div>
      </div>

      {videos.length === 0 ? (
        <div className="flex items-center justify-center h-40">
          <p className="text-[var(--text-secondary)]">No recent videos from your subscriptions.</p>
        </div>
      ) : (
        <>
          <h2 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3">Latest Videos</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {videos.map(video => (
              <VideoCard key={`${video.id}-${video.channelId}`} video={video} onClick={() => onVideoSelect(video)} onChannelClick={onChannelSelect} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
