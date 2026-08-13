#!/bin/bash
set -e

echo "=== Starting Music App Container ==="

# Create mount directory if it doesn't exist
mkdir -p /mnt/cloud_music
mkdir -p /root/.config/rclone

# Determine remote to mount (default: cloud_music:)
REMOTE_TO_MOUNT="${RCLONE_REMOTE:-cloud_music:}"

if [ -n "$REMOTE_TO_MOUNT" ] && [[ "$REMOTE_TO_MOUNT" != *: ]]; then
    REMOTE_TO_MOUNT="${REMOTE_TO_MOUNT}:"
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
    echo "[Rclone] Checking if remote '${REMOTE_NAME}:' exists in rclone.conf..."
    if rclone listremotes 2>/dev/null | grep -q "^${REMOTE_NAME}:"; then
        echo "[Rclone] Mounting '${REMOTE_NAME}:' to /mnt/cloud_music..."
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
        echo "[Rclone] Remote '${REMOTE_NAME}:' not found in rclone.conf yet. Storage remains local until mounted."
    fi
fi

# Start FastAPI application with Uvicorn
echo "=== Launching FastAPI Server on 0.0.0.0:8000 ==="
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
