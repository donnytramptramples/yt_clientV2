#!/bin/bash
export PATH="$HOME/.local/bin:$PATH"

# Start the backend API on port 3000
node server.js &
BACKEND_PID=$!

# Start the Vite dev server on port 5000
npx vite --port 5000 --host 0.0.0.0

# If vite exits, kill the backend too
kill $BACKEND_PID 2>/dev/null
