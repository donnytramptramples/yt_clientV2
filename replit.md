# YouTube Client & Downloader

A self-hosted YouTube web client with a KDE Breeze-inspired dark/light theme. Lets users search, stream, and download YouTube videos via a true proxy architecture.

## Architecture

- **Frontend**: React 18 + Vite + TailwindCSS, served on port 5000 (dev)
- **Backend**: Node.js (Express) API server
  - Dev: port 10000 (set via `PORT=10000` in `start-dev.sh`)
  - Production (Render): uses `process.env.PORT` (set by the platform)
- **Vite proxy**: All `/api/*` requests are proxied from port 5000 → port 10000 in dev

## How Video Streaming Works (Piped-style proxy)

The app does NOT hand raw `googlevideo.com` URLs to the browser. Instead:
1. **Innertube extraction** (`youtubei.js`) fetches video metadata + stream URLs server-side
2. **True proxy** (`/api/proxy/:videoId`): the server fetches the video data from Google and pipes it directly to the browser, so Google only ever sees the server's IP (fixing IP-mismatch 403s)
3. **Muxed format priority**: `streaming_data.formats` (combined audio+video) are preferred over adaptive streams so the browser `<video>` element always gets audio

### Format Selection Logic
- `selectBestFormat` uses `has_audio` / `has_video` properties from youtubei.js Format objects
- Muxed formats (both audio+video) from `streaming_data.formats` are tried first at the requested quality
- Falls back to the best available muxed format if quality not available
- Only falls back to video-only adaptive streams as a last resort (logs a warning)

## Key Files

- `server.js` — Express backend: search, info, proxy, stream, download endpoints
- `src/components/VideoPlayer.jsx` — Video player UI, uses `/api/proxy/:videoId?quality=N`
- `vite.config.js` — Dev server config (port 5000, proxy to 10000, allowedHosts: true)
- `start-dev.sh` — Dev startup script (starts backend on PORT=10000, then Vite on 5000)

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/search?q=...` | Search YouTube videos |
| `GET /api/info/:videoId` | Get video duration/title |
| `GET /api/proxy/:videoId?quality=720` | Stream video through server proxy |
| `GET /api/download/:videoId?format=mp4&quality=720` | Download video/audio |
| `GET /api/formats/:videoId` | Debug: list available formats |

## Deployment

Deployed on Render (VM target). The `PORT` environment variable is set by Render automatically. Build command: `npm run build`. Run command: `node server.js`. The production server serves the built `dist/` folder as static files.
