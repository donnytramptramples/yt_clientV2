# Use Node.js 20
FROM node:20

# Install Python and FFmpeg (Crucial for yt-dlp and audio)
RUN apt-get update && apt-get install -y python3 ffmpeg curl

# Install the latest yt-dlp nightly to bypass 403 blocks
RUN curl -L https://github.com -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

# Set the working directory
WORKDIR /app

# Copy all your uploaded files (including components, src, etc.)
COPY . .

# Install your Node.js dependencies
RUN npm install

# Hugging Face MUST use port 7860
ENV PORT=7860
EXPOSE 7860

# Start your app (Using server.js as the main file)
CMD ["node", "server.js"]
