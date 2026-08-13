import asyncio
import json
import logging
import time
import mimetypes
import urllib.parse
from pathlib import Path
import re
from datetime import datetime
from typing import Optional, List, Tuple, Dict, Any

from fastapi import FastAPI, Request, BackgroundTasks, HTTPException, Query
from fastapi.responses import HTMLResponse, StreamingResponse, Response, FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from app.config import BASE_DIR, MUSIC_DIR
from app.services.ytdlp_service import (
    search_youtube,
    get_trending_tracks,
    get_yt_stream_url,
    start_download_job,
    process_download_task,
    download_tasks
)
from app.services.library_service import (
    get_library_files,
    extract_cover_bytes,
    delete_track,
    enforce_cloud_storage_limit
)
from app.services.playlist_service import (
    get_all_playlists,
    create_playlist,
    add_track_to_playlist,
    remove_track_from_playlist,
    delete_playlist,
    update_playlist_tracks,
    record_track_listen,
    get_cloud_settings,
    save_cloud_settings
)
from app.services.rclone_service import (
    get_mount_status,
    trigger_mount,
    trigger_unmount,
    get_rclone_config_text,
    save_rclone_config_text,
    check_and_auto_remount
)
from app.services.auth_service import get_current_username
from app.services.playlist_service import (
    get_all_playlists,
    create_playlist,
    add_track_to_playlist,
    remove_track_from_playlist,
    delete_playlist,
    update_playlist_tracks
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("music_app")

app = FastAPI(
    title="Music Docker App",
    description="YouTube Audio Search, Download, Streaming & Rclone Cloud Manager",
    version="1.4.7"
)

# Startup event: Rclone mount watchdog background loop
@app.on_event("startup")
async def start_rclone_watchdog():
    async def watchdog_loop():
        logger.info("[Watchdog] Starting Rclone cloud mount watchdog...")
        while True:
            try:
                await asyncio.to_thread(check_and_auto_remount)
            except Exception as e:
                logger.error(f"[Watchdog] Error during mount health check: {e}")
            await asyncio.sleep(30) # Run health check every 30 seconds

    asyncio.create_task(watchdog_loop())

    async def prewarm_trending():
        try:
            logger.info("[Startup] Pre-warming LOS40 trending cache...")
            await get_trending_tracks(limit=40, region="los40", force_refresh=True)
            logger.info("[Startup] Pre-warmed LOS40 trending cache successfully.")
        except Exception as e:
            logger.error(f"[Startup] Error pre-warming LOS40 trending cache: {e}")

    asyncio.create_task(prewarm_trending())

# Static and Template mounts
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

# Pydantic Schemas
class DownloadRequest(BaseModel):
    url: str
    video_id: Optional[str] = None
    title: Optional[str] = None

class ImportTrackItem(BaseModel):
    filename: Optional[str] = None
    title: Optional[str] = None
    artist: Optional[str] = None
    url: Optional[str] = None
    video_id: Optional[str] = None

class ImportLibraryPayload(BaseModel):
    tracks: List[ImportTrackItem]

class PlaylistImportItem(BaseModel):
    id: Optional[str] = None
    name: str
    description: Optional[str] = ""
    created_by: Optional[str] = None
    tracks: Optional[List[Any]] = None

class ImportPlaylistsPayload(BaseModel):
    playlists: List[PlaylistImportItem]

class MountRequest(BaseModel):
    remote_name: str

class SaveConfigPayload(BaseModel):
    config_text: str

class CreatePlaylistRequest(BaseModel):
    name: str
    description: Optional[str] = ""

class AddTrackRequest(BaseModel):
    filename: str

class UpdatePlaylistTracksRequest(BaseModel):
    tracks: List[str]


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    """Serve the main SPA dashboard interface."""
    response = templates.TemplateResponse(request=request, name="index.html")
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    """Serve favicon.svg for browser tab icon."""
    favicon_path = Path(__file__).parent / "static" / "favicon.svg"
    if favicon_path.exists():
        return FileResponse(favicon_path, media_type="image/svg+xml")
    return Response(status_code=204)


@app.get("/api/user/me")
async def api_user_me(request: Request):
    """Return current logged in username detected from NPM Basic Auth."""
    username = get_current_username(request)
    return {"username": username}


@app.get("/api/logout")
async def api_logout():
    """Force browser to discard HTTP Basic Auth credentials and prompt for NPM login."""
    return Response(
        content="Authorization required",
        status_code=401,
        headers={"WWW-Authenticate": 'Basic realm="Authorization required"'}
    )


# ==========================================
# API ENDPOINTS: SEARCH & DOWNLOAD
# ==========================================

TEMP_YT_CACHE_DIR = Path("/tmp/music_yt_cache")
TEMP_YT_CACHE_DIR.mkdir(parents=True, exist_ok=True)

ACTIVE_YT_TASKS: Dict[str, asyncio.Task] = {}
ACTIVE_YT_LOCK = asyncio.Lock()

async def ensure_yt_cache_downloading(safe_id: str, video_url: str):
    """
    Ensure background downloading of video_url into /tmp/music_yt_cache/{safe_id}.m4a
    If already cached or currently downloading, returns immediately.
    """
    cache_file = TEMP_YT_CACHE_DIR / f"{safe_id}.m4a"
    tmp_file = TEMP_YT_CACHE_DIR / f"{safe_id}.m4a.tmp"

    if cache_file.exists() and cache_file.stat().st_size > 100000:
        return

    async with ACTIVE_YT_LOCK:
        if safe_id in ACTIVE_YT_TASKS and not ACTIVE_YT_TASKS[safe_id].done():
            return

        async def _download_job():
            cmd = [
                "yt-dlp",
                "--no-playlist",
                "--no-part",
                "-o", str(tmp_file),
                "-f", "bestaudio[ext=m4a]/bestaudio/best",
                "--extractor-args", "youtube:player_client=android,web",
                "--no-warnings",
                video_url
            ]
            try:
                logger.info(f"[YT Cache] Starting background pre-download for {safe_id}...")
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                await proc.communicate()
                if proc.returncode == 0 and tmp_file.exists() and tmp_file.stat().st_size > 100000:
                    tmp_file.replace(cache_file)
                    logger.info(f"[YT Cache] Stream cached successfully: {cache_file.name}")
                else:
                    logger.warning(f"[YT Cache] Download process for {safe_id} returned code {proc.returncode}")
            except Exception as e:
                logger.error(f"[YT Cache] Error downloading {safe_id}: {e}")
            finally:
                if tmp_file.exists() and not cache_file.exists():
                    try:
                        tmp_file.unlink()
                    except Exception:
                        pass
                async with ACTIVE_YT_LOCK:
                    ACTIVE_YT_TASKS.pop(safe_id, None)

        task = asyncio.create_task(_download_job())
        ACTIVE_YT_TASKS[safe_id] = task


def prewarm_yt_results(results: list, top_n: int = 3):
    """Start background stream caching for top_n YouTube tracks from search or trending."""
    count = 0
    for r in results:
        v_id = r.get("id") or r.get("video_id")
        if not v_id:
            continue
        safe_id = re.sub(r'[^a-zA-Z0-9_-]', '', v_id)
        cache_file = TEMP_YT_CACHE_DIR / f"{safe_id}.m4a"
        if not cache_file.exists():
            video_url = f"https://www.youtube.com/watch?v={safe_id}"
            asyncio.create_task(ensure_yt_cache_downloading(safe_id, video_url))
            count += 1
            if count >= top_n:
                break


@app.get("/api/search")
async def api_search(q: str = Query(..., min_length=1, description="Búsqueda de canción o artista")):
    """
    Search YouTube using yt-dlp flat-playlist json dump.
    Returns top interactive results and pre-warms top audio streams in background cache.
    """
    logger.info(f"Searching YouTube for: '{q}'")
    results = await search_youtube(q, limit=40)
    prewarm_yt_results(results, top_n=3)
    return {"query": q, "results": results}


@app.get("/api/trending")
async def api_trending(
    region: str = Query("es", pattern="^(es|global|los40|spotify_es|spotify_global)$"),
    limit: int = Query(40, ge=1, le=100),
    refresh: bool = Query(False)
):
    """Return top trending individual music singles and pre-warms top audio streams in background cache."""
    tracks = await get_trending_tracks(limit=limit, region=region, force_refresh=refresh)
    prewarm_yt_results(tracks, top_n=3)
    return {"region": region, "results": tracks}


@app.get("/api/preload_yt")
async def api_preload_yt(v: str = Query(..., description="YouTube Video ID o URL")):
    """Pre-warm YouTube track stream in background cache."""
    v_id = v.strip()
    if "youtube.com" in v_id or "youtu.be" in v_id:
        m = re.search(r'(?:v=|\/)([a-zA-Z0-9_-]{11})', v_id)
        if m:
            v_id = m.group(1)
    safe_id = re.sub(r'[^a-zA-Z0-9_-]', '', v_id)
    video_url = f"https://www.youtube.com/watch?v={v_id}" if len(v_id) == 11 else v
    cache_file = TEMP_YT_CACHE_DIR / f"{safe_id}.m4a"
    if cache_file.exists() and cache_file.stat().st_size > 100000:
        return {"status": "cached", "safe_id": safe_id}
    await ensure_yt_cache_downloading(safe_id, video_url)
    return {"status": "prewarming", "safe_id": safe_id}


@app.get("/api/stream_yt")
async def api_stream_yt(
    v: str = Query(..., description="YouTube Video ID o URL")
):
    """
    Stream live direct audio from YouTube using background worker + growing file stream.
    Caches stream to /tmp/music_yt_cache for instant subsequent playback and offline save requests.
    """
    v_id = v.strip()
    if "youtube.com" in v_id or "youtu.be" in v_id:
        m = re.search(r'(?:v=|\/)([a-zA-Z0-9_-]{11})', v_id)
        if m:
            v_id = m.group(1)

    video_url = f"https://www.youtube.com/watch?v={v_id}" if len(v_id) == 11 else v
    safe_id = re.sub(r'[^a-zA-Z0-9_-]', '', v_id)
    cache_file = TEMP_YT_CACHE_DIR / f"{safe_id}.m4a"
    tmp_file = TEMP_YT_CACHE_DIR / f"{safe_id}.m4a.tmp"

    # 1. If completed cached file exists, return FileResponse instantly with Range support!
    if cache_file.exists() and cache_file.stat().st_size > 100000:
        return FileResponse(
            path=cache_file,
            media_type="audio/mp4",
            headers={"Cache-Control": "public, max-age=86400"}
        )

    # 2. Ensure background download task is active
    await ensure_yt_cache_downloading(safe_id, video_url)

    # 3. Stream from growing file (or completed cache file if completed during wait)
    async def stream_generator():
        offset = 0
        start_time = time.time()

        # Wait up to 10s for tmp_file or cache_file to appear with initial bytes
        while not cache_file.exists() and not (tmp_file.exists() and tmp_file.stat().st_size > 0) and (time.time() - start_time) < 10.0:
            await asyncio.sleep(0.05)

        target_file = cache_file if cache_file.exists() else tmp_file

        while True:
            # If target_file switched to cache_file (download finished)
            if not target_file.exists() and cache_file.exists():
                target_file = cache_file

            if target_file.exists():
                try:
                    curr_size = target_file.stat().st_size
                    if curr_size > offset:
                        with open(target_file, "rb") as f:
                            f.seek(offset)
                            chunk = f.read(min(curr_size - offset, 128 * 1024))
                            if chunk:
                                offset += len(chunk)
                                yield chunk
                except Exception as e:
                    logger.debug(f"[Stream Generator] File read error: {e}")

            # Check if download job is complete
            task = ACTIVE_YT_TASKS.get(safe_id)
            is_active = task is not None and not task.done()

            # End stream if download is done and no more bytes to read
            if not is_active:
                final_file = cache_file if cache_file.exists() else target_file
                if final_file.exists():
                    try:
                        curr_size = final_file.stat().st_size
                        if curr_size > offset:
                            with open(final_file, "rb") as f:
                                f.seek(offset)
                                chunk = f.read()
                                if chunk:
                                    offset += len(chunk)
                                    yield chunk
                    except Exception:
                        pass
                break

            await asyncio.sleep(0.05)

    return StreamingResponse(
        stream_generator(),
        media_type="audio/mp4",
        headers={
            "Accept-Ranges": "none",
            "Content-Type": "audio/mp4",
            "Cache-Control": "no-cache"
        }
    )



@app.post("/api/download")
async def api_download(payload: DownloadRequest, request: Request, background_tasks: BackgroundTasks):
    """
    Queue an audio download job via yt-dlp.
    Extracts best audio (MP3 320kbps), embeds thumbnail and ID3 metadata.
    """
    if not payload.url:
        raise HTTPException(status_code=400, detail="URL de vídeo requerida")

    username = get_current_username(request)
    task_id = start_download_job(
        url=payload.url,
        title=payload.title,
        video_id=payload.video_id,
        username=username
    )

    # Launch worker in FastAPI BackgroundTasks
    background_tasks.add_task(process_download_task, task_id, payload.url, payload.title)

    return {
        "success": True,
        "message": "Descarga añadida a la cola",
        "task_id": task_id,
        "downloaded_by": username
    }


# ==========================================
# API ENDPOINTS: PLAYLISTS (LISTAS DE REPRODUCCIÓN)
# ==========================================

@app.get("/api/playlists")
async def api_get_playlists():
    """Get all playlists created across users."""
    playlists = get_all_playlists()
    return {"playlists": playlists}


@app.get("/api/playlists/export")
async def api_export_playlists():
    """Export all playlists with rich track metadata details as JSON file."""
    playlists = get_all_playlists()
    current_files = await asyncio.to_thread(get_library_files, True)
    files_map = {(f.get("filename") or ""): f for f in current_files}

    export_playlists = []
    for pl in playlists:
        exported_tracks = []
        for track_item in pl.get("tracks", []):
            if isinstance(track_item, str):
                fn = track_item
                meta = files_map.get(fn, {})
                m = re.search(r'\[([a-zA-Z0-9_-]{11})\]\.[a-zA-Z0-9]+$', fn)
                v_id = m.group(1) if m else ""
                exported_tracks.append({
                    "filename": fn,
                    "title": meta.get("title", fn),
                    "artist": meta.get("artist", ""),
                    "video_id": v_id,
                    "url": f"https://www.youtube.com/watch?v={v_id}" if v_id else ""
                })
            elif isinstance(track_item, dict):
                exported_tracks.append(track_item)

        export_playlists.append({
            "id": pl.get("id"),
            "name": pl.get("name"),
            "description": pl.get("description", ""),
            "created_by": pl.get("created_by", ""),
            "created_at": pl.get("created_at", ""),
            "tracks": exported_tracks
        })

    export_data = {
        "app": "MusicCloud",
        "version": "1.4.7",
        "type": "playlists",
        "exported_at": datetime.now().isoformat(),
        "total_playlists": len(export_playlists),
        "playlists": export_playlists
    }

    content = json.dumps(export_data, ensure_ascii=False, indent=2)
    filename = f"listas_reproduccion_{datetime.now().strftime('%Y-%m-%d')}.json"
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"'
    }
    return Response(content=content, media_type="application/json", headers=headers)


@app.post("/api/playlists/import")
async def api_import_playlists(payload: ImportPlaylistsPayload, request: Request, background_tasks: BackgroundTasks):
    """
    Import playlists from JSON export.
    Creates missing playlists and queues downloads for missing tracks automatically.
    """
    username = get_current_username(request)
    current_playlists = get_all_playlists()
    existing_pl_names = {pl.get("name"): pl for pl in current_playlists if isinstance(pl, dict) and pl.get("name")}
    existing_pl_ids = {pl.get("id"): pl for pl in current_playlists if isinstance(pl, dict) and pl.get("id")}

    current_files = await asyncio.to_thread(get_library_files, True)
    existing_filenames = {(f.get("filename") or "").lower().strip() for f in current_files}
    existing_vids = set()
    existing_title_artists = set()

    for f in current_files:
        fn = f.get("filename") or ""
        m = re.search(r'\[([a-zA-Z0-9_-]{11})\]\.[a-zA-Z0-9]+$', fn)
        if m: existing_vids.add(m.group(1))
        t = (f.get("title") or "").lower().strip()
        a = (f.get("artist") or "").lower().strip()
        if t: existing_title_artists.add(f"{a}|||{t}")

    imported_count = 0
    queued_tracks_count = 0

    for pl_item in payload.playlists:
        target_pl = None
        if pl_item.id and pl_item.id in existing_pl_ids:
            target_pl = existing_pl_ids[pl_item.id]
        elif pl_item.name in existing_pl_names:
            target_pl = existing_pl_names[pl_item.name]

        if not target_pl:
            target_pl = create_playlist(pl_item.name.strip(), username, pl_item.description or "")
            existing_pl_ids[target_pl["id"]] = target_pl
            existing_pl_names[target_pl["name"]] = target_pl
            imported_count += 1
        else:
            imported_count += 1

        pl_id = target_pl["id"]
        current_pl_tracks = list(target_pl.get("tracks", []))

        if pl_item.tracks:
            for track_raw in pl_item.tracks:
                if isinstance(track_raw, str):
                    fn = track_raw
                    title, artist, url, v_id = fn, "", "", ""
                elif isinstance(track_raw, dict):
                    fn = track_raw.get("filename", "")
                    title = track_raw.get("title") or fn
                    artist = track_raw.get("artist", "")
                    url = track_raw.get("url", "")
                    v_id = track_raw.get("video_id", "")
                else:
                    continue

                fn_lower = fn.lower().strip()
                v_id_match = v_id
                if not v_id_match and url:
                    m = re.search(r'(?:v=|\/)([a-zA-Z0-9_-]{11})', url)
                    if m: v_id_match = m.group(1)
                if not v_id_match and fn:
                    m = re.search(r'\[([a-zA-Z0-9_-]{11})\]\.[a-zA-Z0-9]+$', fn)
                    if m: v_id_match = m.group(1)

                t_lower = title.lower().strip()
                a_lower = artist.lower().strip()

                # Check if track is already in library
                in_library = False
                found_filename = fn
                if fn_lower and fn_lower in existing_filenames:
                    in_library = True
                elif v_id_match and v_id_match in existing_vids:
                    in_library = True
                    for cf in current_files:
                        if v_id_match in (cf.get("filename") or ""):
                            found_filename = cf.get("filename")
                            break
                elif t_lower and f"{a_lower}|||{t_lower}" in existing_title_artists:
                    in_library = True
                    for cf in current_files:
                        if t_lower == (cf.get("title") or "").lower().strip():
                            found_filename = cf.get("filename")
                            break

                if in_library:
                    if found_filename and found_filename not in current_pl_tracks:
                        add_track_to_playlist(pl_id, found_filename, username)
                        current_pl_tracks.append(found_filename)
                else:
                    # Missing track: queue download and add to playlist!
                    target_url = url or ""
                    if not target_url and v_id_match:
                        target_url = f"https://www.youtube.com/watch?v={v_id_match}"
                    if not target_url:
                        q_str = f"{artist} {title}".strip()
                        if q_str: target_url = f"ytsearch1:{q_str} video oficial"

                    if target_url:
                        raw_title = title or fn or "Canción de lista importada"
                        if artist and artist not in raw_title:
                            raw_title = f"{artist} - {raw_title}"

                        task_id = start_download_job(
                            url=target_url,
                            title=raw_title,
                            video_id=v_id_match or None,
                            username=username
                        )
                        background_tasks.add_task(process_download_task, task_id, target_url, raw_title)
                        queued_tracks_count += 1

                        if fn and fn not in current_pl_tracks:
                            add_track_to_playlist(pl_id, fn, username)
                            current_pl_tracks.append(fn)

    return {
        "success": True,
        "playlists_imported": imported_count,
        "queued_downloads": queued_tracks_count
    }


@app.post("/api/playlists")
async def api_create_playlist(payload: CreatePlaylistRequest, request: Request):
    """Create a new playlist owned by the logged-in user."""
    if not payload.name.strip():
        raise HTTPException(status_code=400, detail="El nombre de la lista es obligatorio")
    username = get_current_username(request)
    pl = create_playlist(payload.name.strip(), username, payload.description or "")
    return {"success": True, "playlist": pl}


@app.post("/api/playlists/{playlist_id}/tracks")
async def api_add_track_to_playlist(playlist_id: str, payload: AddTrackRequest, request: Request):
    """Add a track to a playlist."""
    username = get_current_username(request)
    success = add_track_to_playlist(playlist_id, payload.filename, username)
    if success:
        return {"success": True}
    raise HTTPException(status_code=403, detail="No tienes permisos para modificar esta lista")


@app.delete("/api/playlists/{playlist_id}/tracks/{filename}")
async def api_remove_track_from_playlist(playlist_id: str, filename: str, request: Request):
    """Remove a track from a playlist."""
    username = get_current_username(request)
    success = remove_track_from_playlist(playlist_id, filename, username)
    if success:
        return {"success": True}
    raise HTTPException(status_code=403, detail="No tienes permisos para modificar esta lista")


@app.put("/api/playlists/{playlist_id}/tracks")
async def api_update_playlist_tracks(playlist_id: str, payload: UpdatePlaylistTracksRequest, request: Request):
    """Update complete tracks list for a playlist (reorder/batch delete)."""
    username = get_current_username(request)
    success = update_playlist_tracks(playlist_id, payload.tracks, username)
    if success:
        return {"success": True}
    raise HTTPException(status_code=403, detail="No tienes permisos para modificar esta lista")


@app.delete("/api/playlists/{playlist_id}")
async def api_delete_playlist(playlist_id: str, request: Request):
    """Delete a playlist if creator or admin."""
    username = get_current_username(request)
    success = delete_playlist(playlist_id, username)
    if success:
        return {"success": True}
    raise HTTPException(status_code=403, detail="No tienes permisos para eliminar esta lista")


@app.get("/api/downloads")
async def api_get_downloads():
    """Get active and completed download tasks."""
    return {"tasks": list(download_tasks.values())}


@app.delete("/api/downloads/{task_id}")
async def api_clear_download(task_id: str):
    """Clear completed/failed task from history."""
    if task_id in download_tasks:
        del download_tasks[task_id]
        return {"success": True}
    raise HTTPException(status_code=404, detail="Tarea no encontrada")


# ==========================================
# API ENDPOINTS: LIBRARY & STREAMING
# ==========================================

@app.get("/api/library")
async def api_library(refresh: bool = Query(False)):
    """List all audio files downloaded in /mnt/cloud_music."""
    files = await asyncio.to_thread(get_library_files, refresh)
    return {"tracks": files, "count": len(files)}


@app.get("/api/library/export")
async def api_export_library():
    """Export current library catalog as a downloadable JSON file."""
    files = await asyncio.to_thread(get_library_files, True)
    export_tracks = []
    for t in files:
        fn = t.get("filename", "")
        m = re.search(r'\[([a-zA-Z0-9_-]{11})\]\.[a-zA-Z0-9]+$', fn)
        v_id = m.group(1) if m else ""
        export_tracks.append({
            "filename": fn,
            "title": t.get("title", ""),
            "artist": t.get("artist", ""),
            "album": t.get("album", ""),
            "duration": t.get("duration", 0),
            "duration_string": t.get("duration_string", ""),
            "size_bytes": t.get("size_bytes", 0),
            "video_id": v_id,
            "url": f"https://www.youtube.com/watch?v={v_id}" if v_id else ""
        })

    export_data = {
        "app": "MusicCloud",
        "version": "1.4.7",
        "exported_at": datetime.now().isoformat(),
        "total_tracks": len(export_tracks),
        "tracks": export_tracks
    }

    content = json.dumps(export_data, ensure_ascii=False, indent=2)
    filename = f"biblioteca_musica_{datetime.now().strftime('%Y-%m-%d')}.json"
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"'
    }
    return Response(content=content, media_type="application/json", headers=headers)


@app.post("/api/library/import")
async def api_import_library(payload: ImportLibraryPayload, request: Request, background_tasks: BackgroundTasks):
    """
    Import tracks from exported JSON catalog.
    Checks existing library items and queues missing tracks for download.
    """
    current_files = await asyncio.to_thread(get_library_files, True)
    existing_filenames = {(f.get("filename") or "").lower().strip() for f in current_files}
    existing_vids = set()
    existing_title_artists = set()

    for f in current_files:
        fn = f.get("filename") or ""
        m = re.search(r'\[([a-zA-Z0-9_-]{11})\]\.[a-zA-Z0-9]+$', fn)
        if m: existing_vids.add(m.group(1))
        
        t = (f.get("title") or "").lower().strip()
        a = (f.get("artist") or "").lower().strip()
        if t: existing_title_artists.add(f"{a}|||{t}")

    username = get_current_username(request)
    queued_tracks = []

    for item in payload.tracks:
        fn = (item.filename or "").lower().strip()
        if fn and fn in existing_filenames:
            continue

        v_id = item.video_id or ""
        if not v_id and item.url:
            m = re.search(r'(?:v=|\/)([a-zA-Z0-9_-]{11})', item.url)
            if m: v_id = m.group(1)
        if not v_id and item.filename:
            m = re.search(r'\[([a-zA-Z0-9_-]{11})\]\.[a-zA-Z0-9]+$', item.filename)
            if m: v_id = m.group(1)

        if v_id and v_id in existing_vids:
            continue

        title = (item.title or "").lower().strip()
        artist = (item.artist or "").lower().strip()
        if title and f"{artist}|||{title}" in existing_title_artists:
            continue

        # Missing track! Construct download target
        target_url = item.url or ""
        if not target_url and v_id:
            target_url = f"https://www.youtube.com/watch?v={v_id}"
        if not target_url:
            q_title = item.title or item.filename or ""
            q_artist = item.artist or ""
            query_str = f"{q_artist} {q_title}".strip()
            if query_str:
                target_url = f"ytsearch1:{query_str} video oficial"

        if target_url:
            raw_title = item.title or item.filename or "Canción importada"
            if item.artist and item.title and item.artist not in raw_title:
                raw_title = f"{item.artist} - {raw_title}"

            task_id = start_download_job(
                url=target_url,
                title=raw_title,
                video_id=v_id or None,
                username=username
            )
            background_tasks.add_task(process_download_task, task_id, target_url, raw_title)
            queued_tracks.append({"title": raw_title, "task_id": task_id})

    return {
        "success": True,
        "total_imported": len(payload.tracks),
        "queued_count": len(queued_tracks),
        "already_present_count": len(payload.tracks) - len(queued_tracks),
        "queued_tracks": queued_tracks
    }


@app.get("/api/library/cover/{filename}")
async def api_library_cover(filename: str):
    """Extract embedded ID3/MP4 album cover image from audio file."""
    cover_data = extract_cover_bytes(filename)
    if cover_data:
        image_bytes, mime_type = cover_data
        return Response(content=image_bytes, media_type=mime_type)

    # Default SVG cover placeholder fallback
    svg_placeholder = """<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2" fill="#1e1b4b"/><circle cx="12" cy="12" r="4"/><polygon points="10 10 15 12 10 14 10 10"/></svg>"""
    return Response(content=svg_placeholder, media_type="image/svg+xml")


def make_safe_disposition(filename: str) -> str:
    """Format filename safely for HTTP Content-Disposition headers (RFC 5987)."""
    ascii_filename = filename.encode("ascii", errors="ignore").decode("ascii").replace('"', '')
    if not ascii_filename.strip():
        ascii_filename = "audio.mp3"
    quoted_filename = urllib.parse.quote(filename)
    return f'inline; filename="{ascii_filename}"; filename*=UTF-8\'\'{quoted_filename}'


@app.get("/api/stream/{filename}")
async def api_stream_audio(filename: str, request: Request):
    """
    Stream audio file with full HTTP Range Requests support (206 Partial Content).
    Enables seeking and scrub bar navigation in HTML5 audio player.
    """
    # Record last listened timestamp for LRU cloud retention
    try:
        record_track_listen(filename)
    except Exception:
        pass
    filepath = MUSIC_DIR / filename
    if not filepath.exists() or not filepath.is_file():
        raise HTTPException(status_code=404, detail="Archivo de audio no encontrado")

    file_size = filepath.stat().st_size
    mime_type, _ = mimetypes.guess_type(str(filepath))
    if not mime_type:
        mime_type = "audio/mpeg"

    disposition_header = make_safe_disposition(filename)

    range_header = request.headers.get("range")
    if not range_header:
        # Standard full file stream response
        def iterfile():
            with open(filepath, mode="rb") as f:
                yield from f
        return StreamingResponse(
            iterfile(),
            media_type=mime_type,
            headers={
                "Accept-Ranges": "bytes",
                "Content-Length": str(file_size),
                "Content-Disposition": disposition_header
            }
        )

    # Parse HTTP Range Header
    try:
        unit, range_str = range_header.strip().split("=")
        if unit != "bytes":
            raise HTTPException(status_code=416, detail="Unidad de rango inválida")

        parts = range_str.split("-")
        start = int(parts[0]) if parts[0] else 0
        end = int(parts[1]) if parts[1] else file_size - 1

        if start >= file_size or end >= file_size or start > end:
            return Response(
                "Rango solicitado no disponible",
                status_code=416,
                headers={"Content-Range": f"bytes */{file_size}"}
            )

        chunk_size = (end - start) + 1

        def iter_chunk(start_pos: int, bytes_to_read: int):
            with open(filepath, mode="rb") as f:
                f.seek(start_pos)
                remaining = bytes_to_read
                block_size = 64 * 1024  # 64 KB buffer
                while remaining > 0:
                    read_count = min(block_size, remaining)
                    data = f.read(read_count)
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        headers = {
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(chunk_size),
            "Content-Type": mime_type,
            "Content-Disposition": disposition_header
        }
        return StreamingResponse(iter_chunk(start, chunk_size), status_code=206, headers=headers)

    except ValueError:
        raise HTTPException(status_code=400, detail="Formato de rango no válido")


@app.delete("/api/library/{filename}")
async def api_delete_track(filename: str):
    """Delete audio track from /mnt/cloud_music."""
    success = delete_track(filename)
    if success:
        return {"success": True, "message": f"Pista '{filename}' eliminada correctamente"}
    raise HTTPException(status_code=404, detail="Archivo no encontrado o error al eliminar")


# ==========================================
# API ENDPOINTS: RCLONE & SYSTEM CONFIG
# ==========================================

@app.get("/api/rclone/status")
async def api_rclone_status():
    """Get current storage usage and Rclone mount status."""
    return get_mount_status()


@app.get("/api/rclone/config")
async def api_get_rclone_config():
    """Get raw text of rclone.conf."""
    return {"config_text": get_rclone_config_text()}


@app.post("/api/rclone/config")
async def api_save_rclone_config(payload: SaveConfigPayload):
    """Save raw text to rclone.conf."""
    success = save_rclone_config_text(payload.config_text)
    if success:
        status = get_mount_status()
        return {"success": True, "message": "Configuración rclone.conf guardada correctamente", "status": status}
    raise HTTPException(status_code=500, detail="Error al guardar el archivo rclone.conf")


@app.post("/api/rclone/mount")
async def api_rclone_mount(payload: MountRequest):
    """Trigger manual Rclone mount for a remote."""
    result = trigger_mount(payload.remote_name)
    return result


@app.post("/api/rclone/unmount")
async def api_rclone_unmount():
    """Unmount active Rclone remote."""
    result = trigger_unmount()
    return result


# ==========================================
# API ENDPOINTS: USER STATE PERSISTENCE
# ==========================================

USER_STATES_FILE = BASE_DIR / "user_states.json"

def load_user_states() -> dict:
    if USER_STATES_FILE.exists():
        try:
            return json.loads(USER_STATES_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}

def save_user_states(data: dict):
    try:
        USER_STATES_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        logger.error(f"Failed to save user states: {e}")

class UserStatePayload(BaseModel):
    last_tab: Optional[str] = "playlists"
    last_player_state: Optional[dict] = None
    last_search_query: Optional[str] = ""
    last_search_results: Optional[list] = []
    last_trending_region: Optional[str] = "los40"
    last_trending_results: Optional[list] = []
    updated_at: Optional[float] = 0.0

@app.get("/api/user/state")
async def api_get_user_state(username: str = Query("invitado")):
    states = load_user_states()
    return states.get(username, {})

@app.post("/api/user/state")
async def api_save_user_state(payload: UserStatePayload, username: str = Query("invitado")):
    states = load_user_states()
    data = payload.dict()
    if not data.get("updated_at") or data.get("updated_at") == 0:
        data["updated_at"] = time.time() * 1000
    states[username] = data
    save_user_states(states)
    return {"status": "ok", "updated_at": data["updated_at"]}

# ==========================================
# PWA SPECIFIC ROUTES
# ==========================================

@app.get("/manifest.json")
async def get_manifest():
    return FileResponse(
        BASE_DIR / "static" / "manifest.json",
        media_type="application/manifest+json",
        headers={"Cache-Control": "no-cache"}
    )

@app.get("/sw.js")
async def get_service_worker():
    return FileResponse(
        BASE_DIR / "static" / "sw.js",
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"}
    )

# ==========================================
# STORAGE & NETWORK DATA SETTINGS ROUTES
# ==========================================

class CloudSettingsRequest(BaseModel):
    storage_limit_bytes: int

class ListenEventRequest(BaseModel):
    filename: str

@app.post("/api/track/listen")
async def api_record_listen(payload: ListenEventRequest):
    """Record that a track has been listened to, updating last_listened_at."""
    if payload.filename:
        record_track_listen(payload.filename)
    return {"status": "ok"}

@app.get("/api/storage/cloud_settings")
async def api_get_cloud_settings():
    """Get current cloud storage limit settings and current disk usage."""
    settings = get_cloud_settings()
    stats = enforce_cloud_storage_limit()
    return {
        "storage_limit_bytes": settings.get("storage_limit_bytes", 0),
        "total_size_bytes": stats.get("total_size_bytes", 0)
    }

@app.post("/api/storage/cloud_settings")
async def api_save_cloud_settings(payload: CloudSettingsRequest):
    """Save cloud storage limit setting and enforce it immediately."""
    limit = max(0, payload.storage_limit_bytes)
    save_cloud_settings({"storage_limit_bytes": limit})
    stats = enforce_cloud_storage_limit(limit)
    return {
        "success": True,
        "storage_limit_bytes": limit,
        "deleted_count": stats.get("deleted_count", 0),
        "freed_bytes": stats.get("freed_bytes", 0),
        "total_size_bytes": stats.get("total_size_bytes", 0)
    }

@app.post("/api/storage/clean_cloud")
async def api_clean_cloud_storage():
    """Force an immediate check and cleanup of cloud storage based on configured limit."""
    stats = enforce_cloud_storage_limit()
    return {
        "success": True,
        "deleted_count": stats.get("deleted_count", 0),
        "freed_bytes": stats.get("freed_bytes", 0),
        "total_size_bytes": stats.get("total_size_bytes", 0)
    }
