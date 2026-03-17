import React from 'react';

const menuItems = [
  { icon: 'icon-house', label: 'Home' },
  { icon: 'icon-flame', label: 'Trending' },
  { icon: 'icon-users', label: 'Subscriptions' },
  { icon: 'icon-clock', label: 'History' },
  { icon: 'icon-bookmark', label: 'Watch Later' },
  { icon: 'icon-thumbs-up', label: 'Liked Videos' }
];

function Sidebar({ collapsed, onToggle }) {
  return (
    <aside className={`bg-[var(--bg-secondary)] border-r border-[var(--border)] transition-all ${collapsed ? 'w-16' : 'w-64'}`}>
      <div className="p-4">
        <div className="flex items-center gap-3 mb-6">
          {!collapsed && (
            <h1 className="text-xl font-bold text-[var(--accent)]">YouTube</h1>
          )}
        </div>
        
        <nav className="space-y-1">
          {menuItems.map((item, index) => (
            <button
              key={index}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded hover:bg-[var(--bg-primary)] transition-colors"
            >
              <div className={`${item.icon} text-lg`}></div>
              {!collapsed && <span>{item.label}</span>}
            </button>
          ))}
        </nav>
      </div>
    </aside>
  );
}

export default Sidebar;