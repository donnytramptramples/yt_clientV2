import React, { useState, useEffect } from 'react';
import { Sun, Moon, Rss, Search, LogOut, User } from 'lucide-react';
import SearchBar from './components/SearchBar';
import VideoGrid from './components/VideoGrid';
import VideoPlayer from './components/VideoPlayer';
import AuthPage from './components/AuthPage';
import ChannelPage from './components/ChannelPage';
import FeedPage from './components/FeedPage';

function App() {
  const [darkMode, setDarkMode] = useState(true);
  const [user, setUser] = useState(undefined); // undefined = loading
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedVideo, setSelectedVideo] = useState(null);
  const [selectedChannel, setSelectedChannel] = useState(null);
  const [view, setView] = useState('feed'); // feed | search
  const [channelRefreshKey, setChannelRefreshKey] = useState(0);

  useEffect(() => {
    if (darkMode) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, [darkMode]);

  // Check auth on mount
  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => setUser(data?.user || null))
      .catch(() => setUser(null));
  }, []);

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    setUser(null);
    setSelectedVideo(null);
    setSelectedChannel(null);
    setView('search');
    setSearchQuery('');
  };

  const handleVideoSelect = (video) => {
    setSelectedVideo(video);
    setSelectedChannel(null);
  };

  const handleChannelSelect = (channelId) => {
    setSelectedChannel(channelId);
    setSelectedVideo(null);
  };

  const handleBack = () => {
    if (selectedVideo) {
      setSelectedVideo(null);
    } else if (selectedChannel) {
      setSelectedChannel(null);
    }
  };

  // Show loading state while checking auth
  if (user === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg-primary)]">
        <div className="text-[var(--accent)] text-lg">Loading…</div>
      </div>
    );
  }

  // Show auth page if not logged in
  if (user === null) {
    return (
      <div className={darkMode ? 'dark' : ''}>
        <div className="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)]">
          <div className="absolute top-4 right-4">
            <button
              onClick={() => setDarkMode(!darkMode)}
              className="p-2 hover:bg-[var(--bg-secondary)] rounded transition-colors"
            >
              {darkMode ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </div>
          <AuthPage onAuth={setUser} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <header className="bg-[var(--bg-secondary)] border-b border-[var(--border)] px-4 py-3 flex-shrink-0">
        <div className="flex items-center gap-3 max-w-6xl mx-auto w-full">
          {/* Feed tab */}
          <button
            onClick={() => { setView('feed'); setSelectedVideo(null); setSelectedChannel(null); }}
            className={`p-2 rounded transition-colors flex-shrink-0 ${view === 'feed' && !selectedVideo && !selectedChannel ? 'text-[var(--accent)] bg-[var(--bg-primary)]' : 'hover:bg-[var(--bg-primary)]'}`}
            title="Feed"
          >
            <Rss size={18} />
          </button>

          {/* Search bar — always visible; submitting switches to search view */}
          {!selectedVideo && !selectedChannel && (
            <div className="flex-1">
              <SearchBar
                onSearch={q => {
                  setSearchQuery(q);
                  setView('search');
                  setSelectedVideo(null);
                  setSelectedChannel(null);
                }}
              />
            </div>
          )}

          {(selectedVideo || selectedChannel) && <div className="flex-1" />}

          <div className="flex items-center gap-2 ml-auto flex-shrink-0">
            <span className="text-xs text-[var(--text-secondary)] hidden sm:block">
              <User size={12} className="inline mr-1" />
              {user.username}
            </span>
            <button
              onClick={handleLogout}
              className="p-2 hover:bg-[var(--bg-primary)] rounded transition-colors"
              title="Logout"
            >
              <LogOut size={16} />
            </button>
            <button
              onClick={() => setDarkMode(!darkMode)}
              className="p-2 hover:bg-[var(--bg-primary)] rounded transition-colors"
            >
              {darkMode ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="max-w-6xl mx-auto">
          {selectedVideo ? (
            <VideoPlayer
              video={selectedVideo}
              onBack={handleBack}
              onChannelSelect={handleChannelSelect}
            />
          ) : selectedChannel ? (
            <ChannelPage
              channelId={selectedChannel}
              onBack={handleBack}
              onVideoSelect={handleVideoSelect}
              user={user}
              onSubscribeChange={() => setChannelRefreshKey(k => k + 1)}
            />
          ) : view === 'feed' ? (
            <FeedPage
              key={channelRefreshKey}
              user={user}
              onVideoSelect={handleVideoSelect}
              onChannelSelect={handleChannelSelect}
            />
          ) : (
            <VideoGrid
              searchQuery={searchQuery}
              onVideoSelect={handleVideoSelect}
              onChannelSelect={handleChannelSelect}
            />
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
