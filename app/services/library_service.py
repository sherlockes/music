import os
import io
import re
import shutil
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple
from datetime import datetime
import logging

try:
    import mutagen
    from mutagen.mp3 import MP3
    from mutagen.id3 import ID3, APIC, TIT2, TPE1
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

import time

_FILE_META_CACHE: Dict[str, Tuple[float, int, Dict[str, Any]]] = {}
_COVER_CACHE: Dict[str, Tuple[float, Optional[Tuple[bytes, str]]]] = {}

def get_track_metadata(filepath: Path) -> Dict[str, Any]:
    """
    Extract metadata (title, artist, duration, cover) from an audio file with mtime/size caching.
    """
    filename = filepath.name
    stat = filepath.stat()
    size_bytes = stat.st_size
    mtime = stat.st_mtime
    mod_time = datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M")

    # Fast cache check based on (filename, mtime, size_bytes)
    if filename in _FILE_META_CACHE:
        cached_mtime, cached_size, cached_meta = _FILE_META_CACHE[filename]
        if cached_mtime == mtime and cached_size == size_bytes:
            return cached_meta

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

    from app.services.ytdlp_service import clean_song_metadata
    clean_title, clean_artist = clean_song_metadata(title, artist_raw=artist)

    meta = {
        "filename": filename,
        "title": clean_title,
        "artist": clean_artist,
        "album": album,
        "duration": duration,
        "duration_string": format_duration(duration),
        "size_bytes": size_bytes,
        "size_formatted": format_bytes(size_bytes),
        "has_cover": has_cover,
        "modified_at": mod_time
    }

    _FILE_META_CACHE[filename] = (mtime, size_bytes, meta)
    return meta

_LIBRARY_CACHE = {"tracks": [], "last_scan": 0}
CACHE_TTL = 3600  # 1 hour cache TTL; invalidated on track changes

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
                    if not user_owner or user_owner in ["Comunidad", "invitado", "admin"]:
                        user_owner = "sherlockes"
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
    Extract embedded cover image from an audio file with in-memory caching.
    Returns (image_bytes, mime_type) or None if no cover image found.
    """
    filepath = MUSIC_DIR / filename
    if not filepath.exists() or not mutagen:
        return None

    try:
        mtime = filepath.stat().st_mtime
    except Exception:
        mtime = 0.0

    if filename in _COVER_CACHE:
        cached_mtime, cached_res = _COVER_CACHE[filename]
        if cached_mtime == mtime:
            return cached_res

    res = None
    try:
        audio = mutagen.File(str(filepath))
        if audio is not None:
            # MP3 ID3 APIC frame
            if hasattr(audio, 'tags') and isinstance(audio.tags, ID3):
                for key in audio.tags.keys():
                    if key.startswith('APIC'):
                        apic = audio.tags[key]
                        res = (apic.data, apic.mime)
                        break

            # M4A covr frame
            elif isinstance(audio, MP4) and audio.tags:
                covr = audio.tags.get('covr')
                if covr and len(covr) > 0:
                    image_data = covr[0]
                    mime = "image/png" if image_data.startswith(b'\x89PNG') else "image/jpeg"
                    res = (bytes(image_data), mime)

            # FLAC pictures
            elif isinstance(audio, FLAC) and audio.pictures:
                pic = audio.pictures[0]
                res = (pic.data, pic.mime)

    except Exception as e:
        logger.error(f"Failed to extract cover image from {filename}: {e}")

    _COVER_CACHE[filename] = (mtime, res)
    return res

def delete_track(filename: str) -> bool:
    """Delete a track from MUSIC_DIR and clear caches."""
    filepath = MUSIC_DIR / filename
    _FILE_META_CACHE.pop(filename, None)
    _COVER_CACHE.pop(filename, None)
    invalidate_library_cache()
    if filepath.exists() and filepath.is_file():
        filepath.unlink()
        return True
    return False

def update_track_metadata_and_rename(old_filename: str, new_title: str, new_artist: str) -> Dict[str, Any]:
    """
    Update track ID3/MP4/FLAC tags (title and artist) and rename the file on disk.
    Updates all playlists and cache stores accordingly.
    """
    clean_title = new_title.strip()
    clean_artist = new_artist.strip()
    if not clean_title or not clean_artist:
        raise ValueError("El título y el artista no pueden estar vacíos")

    old_filepath = MUSIC_DIR / old_filename
    if not old_filepath.exists() or not old_filepath.is_file():
        # Fallback: Locate file by YouTube video ID if it was already renamed on disk
        m_fallback = re.search(r'\[([a-zA-Z0-9_-]{11})\]\.[a-zA-Z0-9]+$', old_filename)
        v_id_fallback = m_fallback.group(1) if m_fallback else ""
        found_path = None
        if v_id_fallback:
            for p in MUSIC_DIR.glob(f"*{v_id_fallback}*"):
                if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS:
                    found_path = p
                    break
        if found_path and found_path.exists():
            old_filepath = found_path
            old_filename = found_path.name
        else:
            raise FileNotFoundError(f"Archivo '{old_filename}' no encontrado en la biblioteca")

    # 1. Update tags with Mutagen
    ext = old_filepath.suffix.lower()
    if mutagen:
        try:
            if ext == ".mp3":
                audio = MP3(str(old_filepath), ID3=ID3)
                try:
                    audio.add_tags()
                except Exception:
                    pass
                audio.tags.delall("TIT2")
                audio.tags.delall("TPE1")
                audio.tags.add(TIT2(encoding=3, text=clean_title))
                audio.tags.add(TPE1(encoding=3, text=clean_artist))
                audio.save()
            elif ext in [".m4a", ".mp4"]:
                audio = MP4(str(old_filepath))
                if audio.tags is None:
                    audio.add_tags()
                audio.tags['\xa9nam'] = [clean_title]
                audio.tags['\xa9ART'] = [clean_artist]
                audio.save()
            elif ext == ".flac":
                audio = FLAC(str(old_filepath))
                audio['title'] = [clean_title]
                audio['artist'] = [clean_artist]
                audio.save()
            else:
                try:
                    audio = mutagen.File(str(old_filepath))
                    if audio is not None and hasattr(audio, 'tags') and audio.tags is not None:
                        audio.tags['title'] = [clean_title]
                        audio.tags['artist'] = [clean_artist]
                        audio.save()
                except Exception:
                    pass
        except Exception as e:
            logger.error(f"Error tagging audio file {old_filename}: {e}")

    # 2. Build clean new filename
    safe_artist = re.sub(r'[\\/*?:"<>|]', "", clean_artist).strip()
    safe_title = re.sub(r'[\\/*?:"<>|]', "", clean_title).strip()
    m = re.search(r'\[([a-zA-Z0-9_-]{11})\]\.[a-zA-Z0-9]+$', old_filename)
    v_id = m.group(1) if m else ""
    suffix_id = f" [{v_id}]" if v_id else ""
    new_filename = f"{safe_artist} - {safe_title}{suffix_id}{ext}"

    final_filename = old_filename
    final_filepath = old_filepath

    if new_filename != old_filename:
        target_path = MUSIC_DIR / new_filename
        if target_path.exists() and target_path != old_filepath:
            # If target has same video ID or is the same file, adopt target path
            if v_id and f"[{v_id}]" in target_path.name:
                logger.info(f"Target '{new_filename}' with same video ID already exists. Adopting target file.")
                final_filename = new_filename
                final_filepath = target_path
                if old_filepath.exists() and old_filepath != target_path:
                    try:
                        old_filepath.unlink()
                    except Exception:
                        pass
            else:
                logger.warning(f"Target filename {new_filename} already exists. Retaining original filename.")
        else:
            try:
                shutil.move(str(old_filepath), str(target_path))
                final_filename = new_filename
                final_filepath = target_path
                logger.info(f"Renamed '{old_filename}' to '{new_filename}'")
            except Exception as err:
                logger.error(f"Failed to rename '{old_filename}' to '{new_filename}': {err}")

    # 3. Update all playlists and app data
    from app.services.playlist_service import update_track_filename_in_playlists_and_records, get_track_owners
    update_track_filename_in_playlists_and_records(old_filename, final_filename, clean_title, clean_artist)

    # 4. Extract and return updated metadata
    meta = get_track_metadata(final_filepath)
    meta["title"] = clean_title
    meta["artist"] = clean_artist
    meta["filename"] = final_filename

    try:
        owners = get_track_owners()
        owner_info = owners.get(final_filename, {}) or owners.get(old_filename, {})
        user_owner = owner_info.get("downloaded_by")
        if not user_owner or user_owner in ["Comunidad", "invitado", "admin"]:
            user_owner = "sherlockes"
        meta["downloaded_by"] = user_owner
    except Exception:
        meta["downloaded_by"] = "sherlockes"

    # 5. Invalidate and update in-memory caches
    _FILE_META_CACHE.pop(old_filename, None)
    try:
        st = final_filepath.stat()
        _FILE_META_CACHE[final_filename] = (st.st_mtime, st.st_size, meta)
    except Exception:
        pass

    cover_data = _COVER_CACHE.pop(old_filename, None)
    if cover_data:
        _COVER_CACHE[final_filename] = cover_data

    # Directly update _LIBRARY_CACHE so get_library_files immediately returns it without rclone dir-cache delays
    global _LIBRARY_CACHE
    if _LIBRARY_CACHE.get("tracks"):
        updated_tracks = []
        found = False
        for t in _LIBRARY_CACHE["tracks"]:
            if t.get("filename") == old_filename or t.get("filename") == final_filename:
                updated_tracks.append(meta)
                found = True
            else:
                updated_tracks.append(t)
        if not found:
            updated_tracks.insert(0, meta)
        _LIBRARY_CACHE["tracks"] = updated_tracks
        _LIBRARY_CACHE["last_scan"] = time.time()
    else:
        invalidate_library_cache()

    return {
        "success": True,
        "old_filename": old_filename,
        "filename": final_filename,
        "title": clean_title,
        "artist": clean_artist,
        "track": meta
    }

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
