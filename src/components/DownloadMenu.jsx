import React, { useState, useRef, useEffect } from 'react';
import { Download, Loader2, Video, Music, Disc3, Headphones, FileAudio } from 'lucide-react';

function DownloadMenu({ videoId, quality }) {
  const [showMenu, setShowMenu] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const menuRef = useRef(null);
  const btnRef = useRef(null);

  const formats = [
    { value: 'mp4', label: 'MP4 (Video)', Icon: Video },
    { value: 'mp3', label: 'MP3 (320kbps)', Icon: Music },
    { value: 'flac', label: 'FLAC (Lossless)', Icon: Disc3 },
    { value: 'opus', label: 'Opus', Icon: Headphones },
    { value: 'ogg', label: 'Ogg Vorbis', Icon: FileAudio }
  ];

  useEffect(() => {
    function handleClickOutside(e) {
      if (menuRef.current && !menuRef.current.contains(e.target) &&
          btnRef.current && !btnRef.current.contains(e.target)) {
        setShowMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleDownload = (format) => {
    setDownloading(true);
    setShowMenu(false);
    const url = `/api/download/${videoId}?format=${format}&quality=${quality || '720'}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `video.${format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => setDownloading(false), 2000);
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={() => setShowMenu(!showMenu)}
        className="breeze-btn flex items-center gap-2"
        disabled={downloading}
      >
        {downloading
          ? <Loader2 size={16} className="animate-spin" />
          : <Download size={16} />
        }
        Download
      </button>

      {showMenu && (
        <div
          ref={menuRef}
          className="absolute bottom-full mb-2 left-0 breeze-card p-2 min-w-[200px] z-50"
          style={{ boxShadow: '0 -4px 20px rgba(0,0,0,0.4)' }}
        >
          {formats.map(({ value, label, Icon }) => (
            <button
              key={value}
              onClick={() => handleDownload(value)}
              className="w-full flex items-center gap-3 px-3 py-2 hover:bg-[var(--bg-primary)] rounded transition-colors text-left"
            >
              <Icon size={16} className="text-[var(--accent)] flex-shrink-0" />
              <span className="text-sm">{label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default DownloadMenu;
