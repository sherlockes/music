import os
from pathlib import Path

# Base Paths
BASE_DIR = Path(__file__).resolve().parent
MUSIC_DIR = Path(os.getenv("MUSIC_DIR", "/mnt/cloud_music"))
RCLONE_CONFIG = Path(os.getenv("RCLONE_CONFIG", "/root/.config/rclone/rclone.conf"))
RCLONE_REMOTE = os.getenv("RCLONE_REMOTE", "")

# Ensure music directory exists safely
try:
    MUSIC_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    pass

# Supported audio extensions
AUDIO_EXTENSIONS = {".mp3", ".m4a", ".flac", ".wav", ".ogg", ".opus", ".aac"}
