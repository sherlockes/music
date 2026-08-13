import os
import io
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple
from datetime import datetime
import logging

try:
    import mutagen
    from mutagen.mp3 import MP3
    from mutagen.id3 import ID3, APIC
    from mutagen.mp4 import MP4
    from mutagen.flac import FLAC
except ImportError:
    mutagen = None

from app.config import MUSIC_DIR, AUDIO_EXTENSIONS

logger = logging.getLogger("library_service")

def format_bytes(size: int) -> str:
    """Format bytes to readable string (e.g. 8.4 MB)."""
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size < 1024.0:
            return f"{size:.1f} {unit}"
        size /= 1024.0
    return f"{size:.1f} PB"

def format_duration(seconds: Optional[float]) -> str:
    """Format duration in seconds to mm:ss or hh:mm:ss."""
    if not seconds:
        return "00:00"
    secs = int(seconds)
    hours = secs // 3600
    minutes = (secs % 3600) // 60
    remaining_secs = secs % 60
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{remaining_secs:02d}"
    return f"{minutes:02d}:{remaining_secs:02d}"

def get_track_metadata(filepath: Path) -> Dict[str, Any]:
    """
    Extract metadata (title, artist, duration, cover) from an audio file.
    """
    filename = filepath.name
    stat = filepath.stat()
    size_bytes = stat.st_size
    mod_time = datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M")

    # Default fallback values
    title = filepath.stem
    artist = "Desconocido"
    album = ""
    duration = 0.0
    has_cover = False

    if mutagen:
        try:
            audio = mutagen.File(str(filepath))
            if audio is not None:
                if hasattr(audio, 'info') and hasattr(audio.info, 'length'):
                    duration = audio.info.length

                # Try parsing ID3 tags (MP3)
                if isinstance(audio, MP3) or (hasattr(audio, 'tags') and isinstance(audio.tags, ID3)):
                    tags = audio.tags
                    if tags:
                        if 'TIT2' in tags:
                            title = str(tags['TIT2'])
                        if 'TPE1' in tags:
                            artist = str(tags['TPE1'])
                        if 'TALB' in tags:
                            album = str(tags['TALB'])
                        for key in tags.keys():
                            if key.startswith('APIC'):
                                has_cover = True
                                break

                # Try parsing MP4 tags (M4A)
                elif isinstance(audio, MP4):
                    tags = audio.tags
                    if tags:
                        if '\xa9nam' in tags and tags['\xa9nam']:
                            title = tags['\xa9nam'][0]
                        if '\xa9ART' in tags and tags['\xa9ART']:
                            artist = tags['\xa9ART'][0]
                        if '\xa9alb' in tags and tags['\xa9alb']:
                            album = tags['\xa9alb'][0]
                        if 'covr' in tags and tags['covr']:
                            has_cover = True

                # Try parsing FLAC
                elif isinstance(audio, FLAC):
                    if audio.pictures:
                        has_cover = True
                    if 'title' in audio:
                        title = audio['title'][0]
                    if 'artist' in audio:
                        artist = audio['artist'][0]
                    if 'album' in audio:
                        album = audio['album'][0]
        except Exception as e:
            logger.debug(f"Metadata parsing skipped for {filename}: {e}")

    return {
        "filename": filename,
        "title": title,
        "artist": artist,
        "album": album,
        "duration": duration,
        "duration_string": format_duration(duration),
        "size_bytes": size_bytes,
        "size_formatted": format_bytes(size_bytes),
        "has_cover": has_cover,
        "modified_at": mod_time
    }

import time

_LIBRARY_CACHE = {"tracks": [], "last_scan": 0}
CACHE_TTL = 15  # 15 seconds cache TTL

def invalidate_library_cache():
    """Invalidate in-memory library track cache."""
    global _LIBRARY_CACHE
    _LIBRARY_CACHE["last_scan"] = 0

def get_library_files(force_refresh: bool = False) -> List[Dict[str, Any]]:
    """Scan MUSIC_DIR and return metadata for all audio files with in-memory caching."""
    global _LIBRARY_CACHE
    now = time.time()

    if not force_refresh and _LIBRARY_CACHE["tracks"] and (now - _LIBRARY_CACHE["last_scan"]) < CACHE_TTL:
        return _LIBRARY_CACHE["tracks"]

    if not MUSIC_DIR.exists():
        return []

    try:
        from app.services.playlist_service import get_track_owners
        owners = get_track_owners()
    except Exception:
        owners = {}

    files = []
    try:
        for filepath in MUSIC_DIR.glob("*"):
            if filepath.is_file() and filepath.suffix.lower() in AUDIO_EXTENSIONS:
                try:
                    meta = get_track_metadata(filepath)
                    filename = meta["filename"]
                    owner_info = owners.get(filename, {})
                    user_owner = owner_info.get("downloaded_by")
                    if not user_owner or user_owner in ["Comunidad", "invitado"]:
                        user_owner = "admin"
                    meta["downloaded_by"] = user_owner
                    files.append(meta)
                except Exception as e:
                    logger.error(f"Error scanning track {filepath}: {e}")
    except Exception as e:
        logger.error(f"Error reading MUSIC_DIR: {e}")
        return _LIBRARY_CACHE.get("tracks", [])

    # Sort files by modification date (newest first)
    files.sort(key=lambda x: x.get("modified_at", ""), reverse=True)
    _LIBRARY_CACHE = {"tracks": files, "last_scan": now}
    return files

def extract_cover_bytes(filename: str) -> Optional[Tuple[bytes, str]]:
    """
    Extract embedded cover image from an audio file.
    Returns (image_bytes, mime_type) or None if no cover image found.
    """
    filepath = MUSIC_DIR / filename
    if not filepath.exists() or not mutagen:
        return None

    try:
        audio = mutagen.File(str(filepath))
        if audio is None:
            return None

        # MP3 ID3 APIC frame
        if hasattr(audio, 'tags') and isinstance(audio.tags, ID3):
            for key in audio.tags.keys():
                if key.startswith('APIC'):
                    apic = audio.tags[key]
                    return apic.data, apic.mime

        # M4A covr frame
        elif isinstance(audio, MP4) and audio.tags:
            covr = audio.tags.get('covr')
            if covr and len(covr) > 0:
                image_data = covr[0]
                mime = "image/png" if image_data.startswith(b'\x89PNG') else "image/jpeg"
                return bytes(image_data), mime

        # FLAC pictures
        elif isinstance(audio, FLAC) and audio.pictures:
            pic = audio.pictures[0]
            return pic.data, pic.mime

    except Exception as e:
        logger.error(f"Failed to extract cover image from {filename}: {e}")

    return None

def delete_track(filename: str) -> bool:
    """Delete a track from MUSIC_DIR."""
    filepath = MUSIC_DIR / filename
    if filepath.exists() and filepath.is_file():
        filepath.unlink()
        return True
    return False

def enforce_cloud_storage_limit(limit_bytes: Optional[int] = None) -> Dict[str, Any]:
    """
    Enforce cloud storage limit by removing oldest unlistened tracks (LRU)
    from MUSIC_DIR if total size exceeds limit_bytes.
    """
    if not MUSIC_DIR.exists():
        return {"deleted_count": 0, "freed_bytes": 0, "total_size_bytes": 0, "storage_limit_bytes": limit_bytes or 0}

    from app.services.playlist_service import get_cloud_settings, get_track_owners
    if limit_bytes is None:
        settings = get_cloud_settings()
        limit_bytes = settings.get("storage_limit_bytes", 0)

    owners = get_track_owners()
    track_list = []
    total_size = 0

    for filepath in MUSIC_DIR.glob("*"):
        if filepath.is_file() and filepath.suffix.lower() in AUDIO_EXTENSIONS:
            try:
                stat = filepath.stat()
                size = stat.st_size
                total_size += size
                fn = filepath.name
                owner_info = owners.get(fn, {})
                last_listened = owner_info.get("last_listened_at", stat.st_mtime)
                track_list.append({
                    "path": filepath,
                    "filename": fn,
                    "size": size,
                    "last_listened_at": last_listened
                })
            except Exception as e:
                logger.error(f"Error reading file stat for {filepath}: {e}")

    deleted_count = 0
    freed_bytes = 0

    if limit_bytes > 0 and total_size > limit_bytes:
        # Sort tracks by last_listened_at ascending (oldest listened first)
        track_list.sort(key=lambda t: t["last_listened_at"])
        for track in track_list:
            if total_size <= limit_bytes:
                break
            try:
                track["path"].unlink()
                total_size -= track["size"]
                freed_bytes += track["size"]
                deleted_count += 1
                logger.info(f"[Cloud Prune] Removed LRU track {track['filename']} ({track['size']} bytes)")
            except Exception as err:
                logger.error(f"Error removing track {track['filename']}: {err}")

    return {
        "deleted_count": deleted_count,
        "freed_bytes": freed_bytes,
        "total_size_bytes": total_size,
        "storage_limit_bytes": limit_bytes
    }
