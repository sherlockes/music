#!/bin/bash
set -e

echo "=== Starting Music App Container ==="

# Create mount directory if it doesn't exist
mkdir -p /mnt/cloud_music
mkdir -p /root/.config/rclone

# Determine remote to mount (use RCLONE_REMOTE if valid, or auto-detect first available remote in rclone.conf)
AVAILABLE_REMOTES=$(rclone listremotes 2>/dev/null | tr -d ' ' || true)
FIRST_REMOTE=$(echo "$AVAILABLE_REMOTES" | head -n 1)

REMOTE_TO_MOUNT=""
if [ -n "$RCLONE_REMOTE" ] && echo "$AVAILABLE_REMOTES" | grep -q "^${RCLONE_REMOTE%%:*}:"; then
    REMOTE_TO_MOUNT="${RCLONE_REMOTE%%:*}:"
elif [ -n "$FIRST_REMOTE" ]; then
    REMOTE_TO_MOUNT="$FIRST_REMOTE"
fi

echo "[Clean Startup] Ensuring /mnt/cloud_music is unmounted before local cleanup..."
fusermount -u -z /mnt/cloud_music 2>/dev/null || true
sleep 1

# Safety check: ONLY delete local files if UNMOUNTED to protect cloud data
if ! grep -E "/mnt/cloud_music (fuse|rclone)" /proc/mounts >/dev/null 2>&1; then
    echo "[Clean Startup] Wiping local files from /mnt/cloud_music to prevent local disk usage..."
    rm -rf /mnt/cloud_music/* 2>/dev/null || true
    echo "[Clean Startup] Local directory /mnt/cloud_music cleared successfully."
else
    echo "[WARNING] Directory /mnt/cloud_music is still mounted. Skipping local deletion for safety."
fi

# Auto-mount Rclone remote
if [ -n "$REMOTE_TO_MOUNT" ]; then
    REMOTE_NAME="${REMOTE_TO_MOUNT%%:*}"
    echo "[Rclone] Auto-mounting '${REMOTE_NAME}:' to /mnt/cloud_music..."
    nohup rclone mount "${REMOTE_NAME}:" /mnt/cloud_music \
        --vfs-cache-mode full \
        --vfs-cache-max-age 24h \
        --vfs-cache-poll-interval 1m \
        --vfs-read-ahead 128M \
        --buffer-size 32M \
        --timeout 30s \
        --contimeout 15s \
        --dir-cache-time 15m \
        --attr-timeout 1s \
        --allow-other \
        --allow-non-empty >/tmp/rclone.log 2>&1 &
    
    sleep 2
    if grep -E "/mnt/cloud_music (fuse|rclone)" /proc/mounts >/dev/null 2>&1; then
        echo "[Rclone] Successfully mounted '${REMOTE_NAME}:' on /mnt/cloud_music (Cloud VFS Active)."
    else
        echo "[Rclone] Mount process backgrounded. Check /tmp/rclone.log"
    fi
else
    echo "[Rclone] No remotes found in rclone.conf. Storage remains local until a remote is configured."
fi

# Sync library audio files to Navidrome music folder
echo "[Navidrome] Preparing library symlinks in /var/lib/navidrome/music..."
mkdir -p /var/lib/navidrome/music /var/lib/navidrome/cache
# Remove broken/dangling symlinks
find /var/lib/navidrome/music -xtype l -delete 2>/dev/null || true
# Create symlinks for audio files strictly in /mnt/cloud_music (excluding non-music folders)
for ext in mp3 m4a flac wav ogg opus aac; do
    for f in /mnt/cloud_music/*."$ext"; do
        if [ -f "$f" ]; then
            ln -sf "$f" /var/lib/navidrome/music/ 2>/dev/null || true
        fi
    done
done
SYNCED_COUNT=$(ls -1 /var/lib/navidrome/music 2>/dev/null | wc -l)
echo "[Navidrome] Ready: $SYNCED_COUNT library tracks linked for streaming."

# Launch Navidrome music server in background
if [ -x /usr/local/bin/navidrome ]; then
    echo "=== Launching Navidrome Server on 0.0.0.0:4533 ==="
    nohup /usr/local/bin/navidrome \
        --musicfolder /var/lib/navidrome/music \
        --datafolder /var/lib/navidrome \
        --cachefolder /var/lib/navidrome/cache \
        --port 4533 \
        --address 0.0.0.0 \
        --scaninterval 15m >/tmp/navidrome.log 2>&1 &
    sleep 1
    echo "[Navidrome] Process backgrounded. Check /tmp/navidrome.log"
fi

# Start FastAPI application with Uvicorn
echo "=== Launching FastAPI Server on 0.0.0.0:8000 ==="
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
