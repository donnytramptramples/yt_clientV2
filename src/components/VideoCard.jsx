import React from 'react';

function VideoCard({ video, onClick, onChannelClick }) {
  return (
    <div className="breeze-card cursor-pointer hover:shadow-md transition-shadow overflow-hidden">
      <div className="relative" onClick={onClick}>
        <img
          src={video.thumbnail}
          alt={video.title}
          className="w-full aspect-video object-cover"
        />
        <div className="absolute bottom-2 right-2 bg-black bg-opacity-80 text-white text-xs px-1.5 py-0.5">
          {video.duration}
        </div>
      </div>

      <div className="p-3">
        <div className="flex gap-3">
          {video.channelAvatar && (
            <img
              src={video.channelAvatar}
              alt={video.channel}
              className="w-9 h-9 rounded-full flex-shrink-0 cursor-pointer hover:ring-2 ring-[var(--accent)] transition-all"
              onClick={e => { e.stopPropagation(); if (onChannelClick && video.channelId) onChannelClick(video.channelId); }}
            />
          )}

          <div className="flex-1 min-w-0">
            <h3
              className="font-medium text-sm line-clamp-2 mb-1 cursor-pointer hover:text-[var(--accent)] transition-colors"
              onClick={onClick}
            >
              {video.title}
            </h3>
            <p
              className="text-xs text-[var(--text-secondary)] cursor-pointer hover:text-[var(--accent)] transition-colors"
              onClick={e => { e.stopPropagation(); if (onChannelClick && video.channelId) onChannelClick(video.channelId); }}
            >
              {video.channel}
            </p>
            <p className="text-xs text-[var(--text-secondary)]">
              {video.views}
              {video.published && <span className="ml-2">{video.published}</span>}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default VideoCard;
