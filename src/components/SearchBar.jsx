import React, { useState } from 'react';
import { Search } from 'lucide-react';

function SearchBar({ onSearch }) {
  const [query, setQuery] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (query.trim()) onSearch(query.trim());
  };

  return (
    <form onSubmit={handleSubmit} className="flex-1 max-w-2xl flex gap-2">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search videos..."
        className="breeze-input flex-1"
      />
      <button type="submit" className="breeze-btn flex items-center gap-2">
        <Search size={16} />
        <span>Search</span>
      </button>
    </form>
  );
}

export default SearchBar;
