import React from 'react';
import { useQuery } from '@tanstack/react-query';
import VideoCard from './VideoCard';

function VideoGrid({ searchQuery, onVideoSelect }) {
  const { data, isLoading } = useQuery({
    queryKey: ['videos', searchQuery],
    queryFn: async () => {
      if (!searchQuery) return { videos: [] };
      const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}`);
      return res.json();
    },
    enabled: !!searchQuery
  });

  if (!searchQuery) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-[var(--text-secondary)]">Search for videos to get started</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="icon-loader text-3xl text-[var(--accent)] animate-spin"></div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {data?.videos?.map((video) => (
        <VideoCard
          key={video.id}
          video={video}
          onClick={() => onVideoSelect(video)}
        />
      ))}
    </div>
  );
}

export default VideoGrid;