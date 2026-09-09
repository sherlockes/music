FROM python:3.11-slim-bookworm

# Prevent python from writing pyc files & buffering stdout
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DEBIAN_FRONTEND=noninteractive \
    MUSIC_DIR=/mnt/cloud_music \
    RCLONE_CONFIG=/root/.config/rclone/rclone.conf

# Install system dependencies, ffmpeg, rclone, fuse3
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    fuse3 \
    rclone \
    git \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Install Navidrome (lightweight Subsonic/OpenSubsonic streaming music server)
ARG NAVIDROME_VERSION=0.63.2
RUN curl -sL "https://github.com/navidrome/navidrome/releases/download/v${NAVIDROME_VERSION}/navidrome_${NAVIDROME_VERSION}_linux_amd64.tar.gz" | \
    tar -xz -C /usr/local/bin navidrome && \
    chmod +x /usr/local/bin/navidrome

# Set working directory
WORKDIR /app

# Copy requirements and install Python dependencies
COPY requirements.txt /app/
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Always update yt-dlp to latest version to avoid YouTube API throttling/changes
RUN pip install --no-cache-dir --upgrade yt-dlp

# Create mount points, config directory, and Navidrome storage
RUN mkdir -p /mnt/cloud_music /root/.config/rclone /var/lib/navidrome/music /var/lib/navidrome/cache

# Copy application files
COPY . /app/

# Make entrypoint script executable
RUN chmod +x /app/entrypoint.sh

# Expose port 8000 for FastAPI web app and port 4533 for Navidrome Subsonic server
EXPOSE 8000 4533

ENTRYPOINT ["/app/entrypoint.sh"]
