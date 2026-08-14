import asyncio
import json
import logging
import urllib.request
import urllib.parse
from typing import Dict, Any, List, Optional, Tuple

logger = logging.getLogger("deezer_service")

DEEZER_BASE_URL = "https://api.deezer.com"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

def _format_duration(seconds: Optional[float]) -> str:
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

_DEEZER_JSON_CACHE: Dict[str, Tuple[float, Any]] = {}
DEEZER_CACHE_TTL = 900  # 15 minutes cache for Deezer metadata

async def _fetch_json(url: str, timeout: int = 10, ttl: int = DEEZER_CACHE_TTL) -> Optional[Dict[str, Any]]:
    """Helper to fetch and parse JSON from Deezer API asynchronously with in-memory TTL caching."""
    now = time.time()
    if url in _DEEZER_JSON_CACHE:
        cached_time, cached_data = _DEEZER_JSON_CACHE[url]
        if (now - cached_time) < ttl:
            return cached_data

    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    loop = asyncio.get_event_loop()
    def _do_fetch():
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if resp.status == 200:
                    raw = resp.read().decode('utf-8', errors='ignore')
                    return json.loads(raw)
        except Exception as e:
            logger.error(f"Deezer API request error for URL {url}: {e}")
        return None

    data = await loop.run_in_executor(None, _do_fetch)
    if data is not None:
        _DEEZER_JSON_CACHE[url] = (now, data)
        # Prevent unbound memory growth
        if len(_DEEZER_JSON_CACHE) > 500:
            oldest_keys = sorted(_DEEZER_JSON_CACHE.keys(), key=lambda k: _DEEZER_JSON_CACHE[k][0])[:100]
            for k in oldest_keys:
                _DEEZER_JSON_CACHE.pop(k, None)

    return data

async def search_artists(query: str, limit: int = 25) -> List[Dict[str, Any]]:
    """
    Search for musical artists matching the query.
    Returns clean artist profiles with avatars, album counts, and fan counts.
    """
    if not query or not query.strip():
        return []
    
    clean_q = query.strip()
    encoded_q = urllib.parse.quote(clean_q)
    url = f"{DEEZER_BASE_URL}/search/artist?q={encoded_q}&limit={limit}"
    data = await _fetch_json(url)
    if not data or "data" not in data:
        return []

    artists = []
    q_lower = clean_q.lower()
    for item in data.get("data", []):
        artist_id = item.get("id")
        if not artist_id:
            continue
        
        name = item.get("name", "Artista")
        picture_xl = item.get("picture_xl") or item.get("picture_big") or item.get("picture_medium") or ""
        picture_med = item.get("picture_medium") or item.get("picture_small") or ""
        
        artists.append({
            "id": artist_id,
            "name": name,
            "picture": picture_xl or picture_med,
            "picture_medium": picture_med,
            "picture_xl": picture_xl,
            "nb_album": item.get("nb_album", 0),
            "nb_fan": item.get("nb_fan", 0),
            "link": item.get("link", "")
        })

    def _rank_score(a: Dict[str, Any]):
        name_lower = a["name"].lower()
        exact = 2 if name_lower == q_lower else (1 if q_lower in name_lower else 0)
        return (exact, a.get("nb_fan", 0), a.get("nb_album", 0))

    artists.sort(key=_rank_score, reverse=True)
    return artists

async def search_tracks(query: str, limit: int = 30) -> List[Dict[str, Any]]:
    """
    Direct track search on Deezer.
    """
    if not query or not query.strip():
        return []

    encoded_q = urllib.parse.quote(query.strip())
    url = f"{DEEZER_BASE_URL}/search?q={encoded_q}&limit={limit}"
    data = await _fetch_json(url)
    if not data or "data" not in data:
        return []

    tracks = []
    for item in data.get("data", []):
        track_id = item.get("id")
        if not track_id:
            continue

        album = item.get("album", {})
        artist = item.get("artist", {})
        duration = item.get("duration", 0)

        cover_xl = album.get("cover_xl") or album.get("cover_big") or album.get("cover_medium") or ""
        cover_med = album.get("cover_medium") or album.get("cover_small") or ""

        tracks.append({
            "id": track_id,
            "title": item.get("title", "Canción"),
            "title_short": item.get("title_short", item.get("title", "Canción")),
            "artist": artist.get("name", "Artista"),
            "artist_id": artist.get("id"),
            "album": album.get("title", ""),
            "album_id": album.get("id"),
            "duration": duration,
            "duration_string": _format_duration(duration),
            "preview": item.get("preview", ""),
            "cover": cover_xl or cover_med,
            "cover_medium": cover_med,
            "cover_xl": cover_xl,
            "explicit_lyrics": item.get("explicit_lyrics", False),
            "rank": item.get("rank", 0)
        })

    return tracks

async def get_artist_details(artist_id: int) -> Optional[Dict[str, Any]]:
    """Get complete profile details for an artist."""
    url = f"{DEEZER_BASE_URL}/artist/{artist_id}"
    data = await _fetch_json(url)
    if not data or "id" not in data or data.get("error"):
        return None

    return {
        "id": data.get("id"),
        "name": data.get("name", "Artista"),
        "picture": data.get("picture_xl") or data.get("picture_big") or data.get("picture_medium") or "",
        "picture_medium": data.get("picture_medium", ""),
        "picture_xl": data.get("picture_xl", ""),
        "nb_album": data.get("nb_album", 0),
        "nb_fan": data.get("nb_fan", 0),
        "link": data.get("link", "")
    }

async def get_artist_top_tracks(artist_id: int, limit: int = 50) -> List[Dict[str, Any]]:
    """
    Get most popular / top tracks for an artist.
    Includes 30s preview URL, album info, and HD cover.
    """
    url = f"{DEEZER_BASE_URL}/artist/{artist_id}/top?limit={limit}"
    data = await _fetch_json(url)
    if not data or "data" not in data:
        return []

    tracks = []
    for rank_idx, item in enumerate(data.get("data", [])):
        track_id = item.get("id")
        if not track_id:
            continue

        album = item.get("album", {})
        artist = item.get("artist", {})
        duration = item.get("duration", 0)

        cover_xl = album.get("cover_xl") or album.get("cover_big") or album.get("cover_medium") or ""
        cover_med = album.get("cover_medium") or album.get("cover_small") or ""

        tracks.append({
            "id": track_id,
            "title": item.get("title", "Canción"),
            "title_short": item.get("title_short", item.get("title", "Canción")),
            "artist_id": artist.get("id", artist_id),
            "artist": artist.get("name", "Artista"),
            "album_id": album.get("id"),
            "album": album.get("title", ""),
            "duration": duration,
            "duration_string": _format_duration(duration),
            "preview": item.get("preview", ""),
            "cover": cover_xl or cover_med,
            "cover_medium": cover_med,
            "cover_xl": cover_xl,
            "rank": rank_idx + 1,
            "explicit_lyrics": item.get("explicit_lyrics", False),
            "deezer_rank": item.get("rank", 0)
        })

    return tracks

async def get_artist_albums(artist_id: int, limit: int = 100) -> List[Dict[str, Any]]:
    """
    Get all albums, EPs, and singles for an artist, sorted with newest releases first.
    """
    url = f"{DEEZER_BASE_URL}/artist/{artist_id}/albums?limit={limit}"
    data = await _fetch_json(url)
    if not data or "data" not in data:
        return []

    albums = []
    seen_ids = set()
    for item in data.get("data", []):
        alb_id = item.get("id")
        if not alb_id or alb_id in seen_ids:
            continue
        seen_ids.add(alb_id)

        cover_xl = item.get("cover_xl") or item.get("cover_big") or item.get("cover_medium") or ""
        cover_med = item.get("cover_medium") or item.get("cover_small") or ""
        release_date = item.get("release_date", "")
        year = release_date[:4] if (release_date and len(release_date) >= 4) else ""
        record_type = item.get("record_type", "album").lower()

        albums.append({
            "id": alb_id,
            "title": item.get("title", "Álbum"),
            "cover": cover_xl or cover_med,
            "cover_medium": cover_med,
            "cover_xl": cover_xl,
            "release_date": release_date,
            "year": year,
            "record_type": record_type,
            "genre_id": item.get("genre_id", 0),
            "fans": item.get("fans", 0)
        })

    # Sort albums by release_date descending (newest first)
    albums.sort(key=lambda a: a.get("release_date") or "0000-00-00", reverse=True)
    return albums

async def get_album_details(album_id: int) -> Optional[Dict[str, Any]]:
    """
    Get full album details including tracklist and release information.
    """
    url = f"{DEEZER_BASE_URL}/album/{album_id}"
    data = await _fetch_json(url)
    if not data or "id" not in data or data.get("error"):
        return None

    artist_data = data.get("artist", {})
    cover_xl = data.get("cover_xl") or data.get("cover_big") or data.get("cover_medium") or ""
    cover_med = data.get("cover_medium") or data.get("cover_small") or ""
    release_date = data.get("release_date", "")
    year = release_date[:4] if (release_date and len(release_date) >= 4) else ""

    raw_tracks = data.get("tracks", {}).get("data", [])
    tracks = []
    for item in raw_tracks:
        duration = item.get("duration", 0)
        item_artist = item.get("artist", {})
        track_artist_name = item_artist.get("name") if item_artist else artist_data.get("name", "Artista")

        tracks.append({
            "id": item.get("id"),
            "title": item.get("title", "Canción"),
            "title_short": item.get("title_short", item.get("title", "Canción")),
            "artist": track_artist_name,
            "artist_id": item_artist.get("id") if item_artist else artist_data.get("id"),
            "album": data.get("title", ""),
            "album_id": data.get("id"),
            "duration": duration,
            "duration_string": _format_duration(duration),
            "track_position": item.get("track_position", len(tracks) + 1),
            "disk_number": item.get("disk_number", 1),
            "preview": item.get("preview", ""),
            "cover": cover_xl or cover_med,
            "cover_medium": cover_med,
            "cover_xl": cover_xl,
            "explicit_lyrics": item.get("explicit_lyrics", False),
            "year": year
        })

    genres = [g.get("name") for g in data.get("genres", {}).get("data", [])] if "genres" in data else []

    return {
        "id": data.get("id"),
        "title": data.get("title", "Álbum"),
        "artist": artist_data.get("name", "Artista"),
        "artist_id": artist_data.get("id"),
        "cover": cover_xl or cover_med,
        "cover_medium": cover_med,
        "cover_xl": cover_xl,
        "release_date": release_date,
        "year": year,
        "record_type": data.get("record_type", "album"),
        "label": data.get("label", ""),
        "nb_tracks": data.get("nb_tracks", len(tracks)),
        "duration": data.get("duration", 0),
        "duration_string": _format_duration(data.get("duration", 0)),
        "genres": genres,
        "tracks": tracks
    }

async def get_artist_full_view(artist_id: int) -> Optional[Dict[str, Any]]:
    """
    Convenience method: fetches artist info, top tracks, and albums concurrently.
    """
    artist_task = get_artist_details(artist_id)
    top_tracks_task = get_artist_top_tracks(artist_id, limit=50)
    albums_task = get_artist_albums(artist_id, limit=100)

    artist, top_tracks, albums = await asyncio.gather(artist_task, top_tracks_task, albums_task)
    if not artist:
        return None

    # Separate studio albums and singles/EPs
    studio_albums = [a for a in albums if a.get("record_type") == "album"]
    singles_eps = [a for a in albums if a.get("record_type") in ("single", "ep", "compile")]

    return {
        "artist": artist,
        "top_tracks": top_tracks,
        "albums": studio_albums,
        "singles_eps": singles_eps,
        "all_albums": albums
    }
