# YouTube Client & Downloader

A high-performance YouTube client with proxied streaming, downloads, subtitles, user auth, subscriptions, and feed — styled with a KDE Breeze-inspired UI.

## Architecture

**Backend** (`server.js`) — Express on port 10000 (dev) / 8080 (prod):
- `youtubei.js` (TV_EMBEDDED client) for search, metadata, comments, channel data
- `yt-dlp` for format extraction with multi-client fallback (tv_embedded → android_vr → mweb → android → ios)
- `ffmpeg` for real-time muxing of separate video+audio streams
- SQLite via `better-sqlite3`:
  - `data/auth.db` — users + sessions (30-day cookie tokens, hashed passwords via bcryptjs)
  - `data/subscriptions.db` — channel subscriptions per user
- Custom cookie-based auth (no express-session needed)

**Frontend** (`src/`) — React + Vite + TailwindCSS on port 5000 (dev):
- Proxies `/api/*` to backend at port 10000

## Key Features

1. **Auth** — Login/signup on first visit, 30-day persistent sessions, stored in SQLite
2. **Search** — Video + channel search with Load More pagination
3. **Feed** — Subscription-based feed with composite algorithm: 65% recency (exponential decay 90d) + 20% log-scale popularity + 10% channel diversity + 5% random; parallel `fetchChannelVideos` per subscribed channel
4. **Subscriptions** — Subscribe/unsubscribe from channel pages
5. **Channel Pages** — Search for channels, view all videos, sort by newest/oldest/popular
6. **Video Playback** — Custom proxy player with quality switching, speed control
7. **Subtitles** — Custom VTT renderer with word-level karaoke highlighting (YouTube `<c>` tags); simple toggle button; size-adjustable (12–36px); position top/center/bottom; auto-translate via Google Translate unofficial API
8. **Description + Comments** — Expandable below the video player; comments via yt-dlp `--write-comments` (top sort)
9. **Downloads** — MP4, MP3, FLAC, Opus, Ogg; real-time progress % shown in button for muxed streams; `Processing…` shown for FFmpeg streams

## File Structure

```
server.js              # All backend logic
src/
  App.jsx              # Auth routing, navigation state
  main.jsx             # React entry
  index.css            # KDE Breeze theme variables
  components/
    AuthPage.jsx        # Login/signup form
    SearchBar.jsx       # Search input
    VideoGrid.jsx       # Search results + Load More + Channel tabs
    VideoCard.jsx       # Thumbnail card with channel click
    VideoPlayer.jsx     # Custom player + subtitles + description + comments
    ChannelPage.jsx     # Channel videos with subscribe button + sort
    FeedPage.jsx        # Subscription feed + channel avatars
data/
  auth.db              # Users and sessions (auto-created)
  subscriptions.db     # Subscriptions (auto-created)
```

## Development

```bash
bash start-dev.sh
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

- Node.js 20
- yt-dlp auto-downloaded to `$HOME/bin/yt-dlp` if missing
- ffmpeg from system PATH
