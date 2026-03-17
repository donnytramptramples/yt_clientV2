import React, { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import SearchBar from './components/SearchBar';
import VideoGrid from './components/VideoGrid';
import VideoPlayer from './components/VideoPlayer';

function App() {
  const [darkMode, setDarkMode] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedVideo, setSelectedVideo] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [darkMode]);

  return (
    <div className="min-h-screen flex">
      <Sidebar 
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
      />
      
      <div className="flex-1 flex flex-col">
        <header className="bg-[var(--bg-secondary)] border-b border-[var(--border)] px-6 py-4">
          <div className="flex items-center gap-4">
            <button onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>
              <div className="icon-menu text-xl"></div>
            </button>
            
            <SearchBar onSearch={setSearchQuery} />
            
            <button 
              onClick={() => setDarkMode(!darkMode)}
              className="ml-auto p-2 hover:bg-[var(--bg-primary)] rounded"
            >
              <div className={`icon-${darkMode ? 'sun' : 'moon'} text-xl`}></div>
            </button>
          </div>
        </header>
        
        <main className="flex-1 overflow-y-auto p-6">
          {selectedVideo ? (
            <VideoPlayer 
              video={selectedVideo}
              onBack={() => setSelectedVideo(null)}
            />
          ) : (
            <VideoGrid 
              searchQuery={searchQuery}
              onVideoSelect={setSelectedVideo}
            />
          )}
        </main>
      </div>
    </div>
  );
}

export default App;