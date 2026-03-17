import React, { useState } from 'react';

function DownloadMenu({ videoId }) {
  const [showMenu, setShowMenu] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const formats = [
    { value: 'mp4', label: 'MP4 (Video)', icon: 'icon-video' },
    { value: 'mp3', label: 'MP3 (320kbps)', icon: 'icon-music' },
    { value: 'flac', label: 'FLAC (Lossless)', icon: 'icon-disc' },
    { value: 'opus', label: 'Opus', icon: 'icon-headphones' },
    { value: 'ogg', label: 'Ogg Vorbis', icon: 'icon-file-audio' }
  ];

  const handleDownload = async (format) => {
    setDownloading(true);
    try {
      const url = `/api/download/${videoId}?format=${format}&quality=720`;
      const a = document.createElement('a');
      a.href = url;
      a.download = `video.${format}`;
      a.click();
    } catch (error) {
      console.error('Download failed:', error);
    } finally {
      setDownloading(false);
      setShowMenu(false);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="breeze-btn flex items-center gap-2"
        disabled={downloading}
      >
        <div className={`${downloading ? 'icon-loader animate-spin' : 'icon-download'} text-lg`}></div>
        Download
      </button>
      
      {showMenu && (
        <div className="absolute bottom-full mb-2 breeze-card p-2 min-w-[200px] z-10">
          {formats.map(format => (
            <button
              key={format.value}
              onClick={() => handleDownload(format.value)}
              className="w-full flex items-center gap-3 px-3 py-2 hover:bg-[var(--bg-primary)] rounded"
            >
              <div className={`${format.icon} text-lg text-[var(--accent)]`}></div>
              <span className="text-sm">{format.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default DownloadMenu;