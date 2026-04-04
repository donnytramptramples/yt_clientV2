# YouTube Client & Downloader

A high-performance YouTube client with proxied streaming, downloads, subtitles, user auth, subscriptions, feed, and Shorts — styled with a KDE Breeze-inspired UI.

## Architecture

**Backend** (`server.js`) — Express on port 10000 (dev) / 8080 (prod):
- `youtubei.js` (TV_EMBEDDED client) for search, metadata, comments, channel data, trending
- `yt-dlp` for format extraction with multi-client fallback (tv_embedded → android_vr → mweb → android → ios)
- `ffmpeg` for real-time muxing of separate video+audio streams and audio format transcoding
- SQLite via `better-sqlite3`:
  - `data/auth.db` — users + sessions (30-day cookie tokens, hashed passwords via bcryptjs)
  - `data/subscriptions.db` — channel subscriptions per user
- Custom cookie-based auth (no express-session needed)

**Frontend** (`src/`) — React + Vite + TailwindCSS on port 5000 (dev):
- Proxies `/api/*` to backend at port 10000

## Key Features

1. **Auth** — Login/signup on first visit, 30-day persistent sessions, stored in SQLite
2. **Search** — Video + channel search with Load More pagination
3. **Feed (YT-like algorithm)** — Mixes subscription content (high weight, 65% recency + 20% popularity + 10% diversity + 5% random) with trending recommendations (lower weight). Falls back to full trending feed when no subscriptions.
4. **Subscriptions** — Subscribe/unsubscribe from channel pages
5. **Channel Pages** — Search for channels, view all videos, sort by newest/oldest/popular. Handles UC..., @handle, and plain handle formats.
6. **Video Playback** — Custom proxy player with quality switching, speed control
7. **Subtitles** — Custom VTT renderer with word-level karaoke highlighting (YouTube `<c>` tags); simple toggle button; size-adjustable (12–36px); position top/center/bottom; auto-translate via Google Translate unofficial API
8. **Description + Comments** — Expandable below the video player; comments via yt-dlp `--write-comments` (top sort)
9. **Downloads** — MP4, MP3, FLAC, Opus, Ogg; fixed FFmpeg pipeline for all audio formats; FLAC uses `compression_level 5` (no erroneous bitrate arg); Opus uses `libopus`; proper protocol whitelist and `-vn` flag
10. **Shorts** — Dedicated Shorts section with vertical thumbnail grid; fetches from YouTube Shorts page via yt-dlp, falls back to #shorts search
11. **Seeking** — Proxy seek (`?t=`) for muxed/adaptive streams; `proxySeekRef` tracks offset so currentTime display is always correct; quality changes reset proxy offset properly; duration stays accurate after seeks

## File Structure

```
server.js              # All backend logic
src/
  App.jsx              # Auth routing, navigation state (feed | shorts | search)
  main.jsx             # React entry
  index.css            # KDE Breeze theme variables
  components/
    AuthPage.jsx        # Login/signup form
    SearchBar.jsx       # Search input
    VideoGrid.jsx       # Search results + Load More + Channel tabs
    VideoCard.jsx       # Thumbnail card with channel click
    VideoPlayer.jsx     # Custom player + subtitles + description + comments
    ChannelPage.jsx     # Channel videos with subscribe button + sort
    FeedPage.jsx        # YT-algorithm feed (subscriptions + trending)
    ShortsPage.jsx      # YouTube Shorts section
data/
  auth.db              # Users and sessions (auto-created)
  subscriptions.db     # Subscriptions (auto-created)
```

## Development

```bash
bash start.sh
# Backend: PORT=10000 node server.js
# Frontend: npx vite --port 5000
```

## Production Deployment

- Build: `npm run build` (creates `dist/`)
- Run: `node server.js` (serves dist/ statically + API on PORT)

## Bot Detection Fixes

yt-dlp tries these clients in order until one works:
1. `tv_embedded` (best bypass)
2. `android_vr`
3. `mweb`
4. `android`
5. `ios`

All attempts include proper Origin/Referer headers.

## Environment

- Node.js 22
- yt-dlp auto-downloaded to `$HOME/bin/yt-dlp` if missing
- ffmpeg from system PATH
- Python 3 required (for better-sqlite3 native compilation)
- `better-sqlite3` compiled natively — if Node.js version changes, run `npm rebuild better-sqlite3`
