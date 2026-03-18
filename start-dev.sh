#!/bin/bash
export PATH="$HOME/.local/bin:$PATH"

# Start backend on port 10000 (matches Vite proxy config)
PORT=10000 node server.js &
BACKEND_PID=$!

# Start Vite dev server on port 5000
npx vite --port 5000 --host 0.0.0.0

# If vite exits, kill the backend
kill $BACKEND_PID 2>/dev/null
