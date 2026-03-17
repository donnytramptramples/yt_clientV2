import React, { useState } from 'react';

function PlayerControls({ quality, speed, audioOnly, onQualityChange, onSpeedChange, onAudioToggle }) {
  const [showMenu, setShowMenu] = useState(false);

  const qualities = ['144', '240', '360', '480', '720', '1080', '1440', '2160'];
  const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="breeze-btn flex items-center gap-2"
      >
        <div className="icon-settings text-lg"></div>
        Settings
      </button>
      
      {showMenu && (
        <div className="absolute bottom-full mb-2 breeze-card p-3 min-w-[200px] z-10">
          <div className="mb-3">
            <label className="block text-sm font-medium mb-2">Quality</label>
            <select
              value={quality}
              onChange={(e) => onQualityChange(e.target.value)}
              className="breeze-input w-full"
            >
              {qualities.map(q => (
                <option key={q} value={q}>{q}p</option>
              ))}
            </select>
          </div>
          
          <div className="mb-3">
            <label className="block text-sm font-medium mb-2">Speed</label>
            <select
              value={speed}
              onChange={(e) => onSpeedChange(parseFloat(e.target.value))}
              className="breeze-input w-full"
            >
              {speeds.map(s => (
                <option key={s} value={s}>{s}x</option>
              ))}
            </select>
          </div>
          
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={audioOnly}
              onChange={(e) => onAudioToggle(e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-sm">Audio Only</span>
          </label>
        </div>
      )}
    </div>
  );
}

export default PlayerControls;