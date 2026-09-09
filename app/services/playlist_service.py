import json
import uuid
from pathlib import Path
from typing import Dict, Any, List, Optional
from datetime import datetime
import logging

import shutil
from app.config import BASE_DIR, MUSIC_DIR

logger = logging.getLogger("playlist_service")

DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
DATA_FILE = DATA_DIR / ".app_data.json"

def migrate_legacy_data_file():
    """Migrate legacy .app_data.json from cloud mount or app root to local persistent data directory, merging any existing playlists/tracks."""
    current_data = {"tracks": {}, "playlists": [], "cloud_settings": {"storage_limit_bytes": 0}}
    if DATA_FILE.exists():
        try:
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                current_data = json.load(f)
        except Exception as e:
            logger.error(f"Error loading existing DATA_FILE: {e}")

    existing_playlist_ids = {pl.get("id") for pl in current_data.get("playlists", []) if isinstance(pl, dict) and pl.get("id")}
    existing_playlist_names = {pl.get("name") for pl in current_data.get("playlists", []) if isinstance(pl, dict) and pl.get("name")}
    
    legacy_files = [
        MUSIC_DIR / ".app_data.json",
        BASE_DIR / ".app_data.json",
        BASE_DIR.parent / "data" / "cloud_music" / ".app_data.json"
    ]
    modified = False

    for legacy_path in legacy_files:
        if legacy_path.exists():
            try:
                with open(legacy_path, "r", encoding="utf-8") as f:
                    legacy_data = json.load(f)
                
                # Merge playlists
                for pl in legacy_data.get("playlists", []):
                    if not isinstance(pl, dict):
                        continue
                    pl_id = pl.get("id")
                    pl_name = pl.get("name")
                    if (pl_id and pl_id not in existing_playlist_ids) and (pl_name not in existing_playlist_names):
                        current_data.setdefault("playlists", []).append(pl)
                        if pl_id: existing_playlist_ids.add(pl_id)
                        if pl_name: existing_playlist_names.add(pl_name)
                        modified = True
                
                # Merge tracks metadata if missing
                for track_key, track_meta in legacy_data.get("tracks", {}).items():
                    if track_key not in current_data.setdefault("tracks", {}):
                        current_data["tracks"][track_key] = track_meta
                        modified = True

            except Exception as e:
                logger.error(f"Error checking legacy data file {legacy_path}: {e}")

    if modified or not DATA_FILE.exists():
        try:
            with open(DATA_FILE, "w", encoding="utf-8") as f:
                json.dump(current_data, f, ensure_ascii=False, indent=2)
            logger.info("Migrated/merged legacy .app_data.json into local DATA_DIR")
        except Exception as e:
            logger.error(f"Failed writing merged .app_data.json: {e}")

migrate_legacy_data_file()

def load_data() -> Dict[str, Any]:
    """Load JSON store for metadata and playlists."""
    if not DATA_FILE.exists():
        return {"tracks": {}, "playlists": [], "cloud_settings": {"storage_limit_bytes": 0}}

    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            if "tracks" not in data: data["tracks"] = {}
            if "playlists" not in data: data["playlists"] = []
            if "cloud_settings" not in data: data["cloud_settings"] = {"storage_limit_bytes": 0}
            return data
    except Exception as e:
        logger.error(f"Error reading app data file: {e}")
        return {"tracks": {}, "playlists": [], "cloud_settings": {"storage_limit_bytes": 0}}

def save_data(data: Dict[str, Any]):
    """Save JSON store safely."""
    try:
        with open(DATA_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logger.error(f"Error saving app data file: {e}")

# Track ownership & listen tracking functions
def set_track_owner(filename: str, username: str):
    data = load_data()
    if filename not in data["tracks"]:
        data["tracks"][filename] = {}
    data["tracks"][filename]["downloaded_by"] = username
    data["tracks"][filename]["downloaded_at"] = datetime.now().strftime("%Y-%m-%d %H:%M")
    data["tracks"][filename]["last_listened_at"] = datetime.now().timestamp()
    save_data(data)

def record_track_listen(filename: str, extra_keys: Optional[List[str]] = None):
    data = load_data()
    now = datetime.now().timestamp()
    keys = [filename] if filename else []
    if extra_keys:
        for k in extra_keys:
            if k and k not in keys:
                keys.append(k)
    
    cutoff = now - (35 * 86400)  # Keep ~35 days
    for key in keys:
        if key not in data["tracks"]:
            data["tracks"][key] = {}
        data["tracks"][key]["last_listened_at"] = now
        listens = data["tracks"][key].get("listens", [])
        if not isinstance(listens, list):
            listens = []
        listens = [ts for ts in listens if isinstance(ts, (int, float)) and ts >= cutoff]
        listens.append(now)
        data["tracks"][key]["listens"] = listens
    save_data(data)

def get_track_listen_counts_last_month(days: int = 30) -> Dict[str, int]:
    data = load_data()
    now = datetime.now().timestamp()
    cutoff = now - (days * 86400)
    counts = {}
    for key, info in data.get("tracks", {}).items():
        if isinstance(info, dict):
            listens = info.get("listens", [])
            if isinstance(listens, list):
                c = sum(1 for ts in listens if isinstance(ts, (int, float)) and ts >= cutoff)
                if c > 0:
                    counts[key] = c
    return counts

def get_track_owners() -> Dict[str, Dict[str, Any]]:
    data = load_data()
    return data.get("tracks", {})

def get_cloud_settings() -> Dict[str, Any]:
    data = load_data()
    return data.get("cloud_settings", {
        "storage_limit_bytes": 0  # 0 means unlimited
    })

def save_cloud_settings(settings: Dict[str, Any]):
    data = load_data()
    data["cloud_settings"] = settings
    save_data(data)

# Playlist functions
def get_all_playlists() -> List[Dict[str, Any]]:
    data = load_data()
    return data.get("playlists", [])

def create_playlist(name: str, username: str, description: str = "") -> Dict[str, Any]:
    data = load_data()
    new_playlist = {
        "id": str(uuid.uuid4()),
        "name": name,
        "description": description,
        "created_by": username,
        "created_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "tracks": []
    }
    data["playlists"].append(new_playlist)
    save_data(data)
    return new_playlist

def is_playlist_owner(playlist: dict, username: str) -> bool:
    creator = playlist.get("created_by", "invitado")
    if creator == username or username == "admin":
        return True
    if creator in ["invitado", "", None]:
        return True
    return False

def add_track_to_playlist(playlist_id: str, filename: str, username: str = "invitado") -> bool:
    data = load_data()
    for pl in data["playlists"]:
        if pl["id"] == playlist_id:
            if not is_playlist_owner(pl, username):
                return False
            if filename not in pl["tracks"]:
                pl["tracks"].append(filename)
                save_data(data)
            return True
    return False

def remove_track_from_playlist(playlist_id: str, filename: str, username: str = "invitado") -> bool:
    data = load_data()
    for pl in data["playlists"]:
        if pl["id"] == playlist_id:
            if not is_playlist_owner(pl, username):
                return False
            if filename in pl["tracks"]:
                pl["tracks"].remove(filename)
                save_data(data)
            return True
    return False

def delete_playlist(playlist_id: str, username: str) -> bool:
    data = load_data()
    initial_len = len(data["playlists"])
    data["playlists"] = [
        pl for pl in data["playlists"]
        if not (pl["id"] == playlist_id and is_playlist_owner(pl, username))
    ]
    if len(data["playlists"]) < initial_len:
        save_data(data)
        return True
    return False

def update_playlist_tracks(playlist_id: str, tracks: List[str], username: str = "invitado") -> bool:
    data = load_data()
    for pl in data["playlists"]:
        if pl["id"] == playlist_id:
            if not is_playlist_owner(pl, username):
                return False
            pl["tracks"] = tracks
            save_data(data)
            return True
    return False

def update_track_filename_in_playlists_and_records(old_filename: str, new_filename: str, new_title: str = "", new_artist: str = "") -> bool:
    """
    Update occurrences of old_filename to new_filename across all playlists
    and metadata records.
    """
    data = load_data()
    modified = False

    # 1. Update in playlists
    for pl in data.get("playlists", []):
        tracks = pl.get("tracks", [])
        if isinstance(tracks, list):
            new_tracks = []
            for item in tracks:
                if isinstance(item, str):
                    if item == old_filename:
                        new_tracks.append(new_filename)
                        modified = True
                    else:
                        new_tracks.append(item)
                elif isinstance(item, dict):
                    if item.get("filename") == old_filename:
                        item["filename"] = new_filename
                        if new_title: item["title"] = new_title
                        if new_artist: item["artist"] = new_artist
                        new_tracks.append(item)
                        modified = True
                    else:
                        new_tracks.append(item)
                else:
                    new_tracks.append(item)
            pl["tracks"] = new_tracks

    # 2. Update in data["tracks"] (ownership, stats)
    if "tracks" in data and isinstance(data["tracks"], dict):
        if old_filename in data["tracks"]:
            track_data = data["tracks"].pop(old_filename)
            data["tracks"][new_filename] = track_data
            modified = True

    if modified:
        save_data(data)
    return True


