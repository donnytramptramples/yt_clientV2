FROM node:22-slim

# Install build tools and dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
    build-essential \        # <-- ADD THIS: includes make, gcc, g++
    && rm -rf /var/lib/apt/lists/*

RUN curl -sSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
    -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm ci --include=dev

COPY . .
RUN npm run build

RUN npm prune --production

EXPOSE 8080

ENV NODE_ENV=production

CMD ["node", "server.js"]
