import React from 'react';

function VideoCard({ video, onClick }) {
  return (
    <div
      onClick={onClick}
      className="breeze-card cursor-pointer hover:shadow-md transition-shadow"
    >
      <div className="relative">
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
              className="w-9 h-9 rounded-full"
            />
          )}
          
          <div className="flex-1 min-w-0">
            <h3 className="font-medium text-sm line-clamp-2 mb-1">
              {video.title}
            </h3>
            <p className="text-xs text-[var(--text-secondary)]">
              {video.channel}
            </p>
            <p className="text-xs text-[var(--text-secondary)]">
              {video.views}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default VideoCard;