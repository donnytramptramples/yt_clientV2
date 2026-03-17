import React, { useState } from 'react';

function SearchBar({ onSearch }) {
  const [query, setQuery] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (query.trim()) {
      onSearch(query);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex-1 max-w-2xl">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search videos..."
          className="flex-1 breeze-input focus:outline-none focus:border-[var(--accent)]"
        />
        <button type="submit" className="breeze-btn">
          <div className="icon-search text-lg"></div>
        </button>
      </div>
    </form>
  );
}

export default SearchBar;