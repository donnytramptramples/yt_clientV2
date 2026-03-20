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

## Critical Implementation Notes

### youtubei.js version & Platform.shim.eval (v17+)
- The library is **v17.0.1** (upgraded from v12.2.0 which had broken signature extraction patterns)
- In v17, `Format.decipher()` is **async** — always `await` it
- In v17, `Platform.shim.eval` is called with `(data, env)` where `data` is an object from `JsExtractor.buildScript()`. The `data.output` field is a self-contained compiled script that returns the deciphered result. The correct shim is:
  ```js
  Platform.shim.eval = (data, _env) => new Function(data.output)();
  ```
- The old v12 shim `(code, env) => new Function(...Object.keys(env), code)(...Object.values(env))` does NOT work in v17

### PoToken (BG / bgutils-js)
- A "cold start" PoToken is generated on session init via `BG.PoToken.generateColdStartToken(visitorData)`
- Required on Innertube session to pass YouTube's bot detection

### Session Initialization
- `generate_session_locally: false` + `retrieve_player: true` causes youtubei.js to fetch the real YouTube player JS and extract the n-parameter / signature decipher algorithms
- Without this, signature extraction fails → all stream URLs return 403

## Replit Setup

- **Workflow**: "Start application" runs `bash start-dev.sh` — starts backend on PORT=10000 then Vite on port 5000
- **Bug fix**: Moved `infoCache` declaration before `await initYouTube()` call to prevent "Cannot access before initialization" error
- **Deployment config**: autoscale target, build=`npm run build`, run=`node server.js` (server serves `dist/` + handles API)
- The production server uses `process.env.PORT` (defaults to 8080) and serves the built `dist/` folder as static files
