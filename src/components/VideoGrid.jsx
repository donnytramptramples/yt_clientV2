import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import VideoCard from './VideoCard';

function VideoGrid({ searchQuery, onVideoSelect }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['videos', searchQuery],
    queryFn: async () => {
      if (!searchQuery) return { videos: [] };
      const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}`);
      if (!res.ok) throw new Error('Search failed');
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
        <Loader2 size={36} className="text-[var(--accent)] animate-spin" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-red-400">Search failed. The API may still be initialising — try again in a moment.</p>
      </div>
    );
  }

  if (!data?.videos?.length) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-[var(--text-secondary)]">No results found.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {data.videos.map((video) => (
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
