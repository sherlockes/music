import asyncio
import json
import re
import uuid
import logging
from typing import Dict, Any, List, Optional, Tuple
from pathlib import Path
from app.config import MUSIC_DIR

logger = logging.getLogger("ytdlp_service")

# In-memory download task tracker
# task_id -> { id, title, url, progress, speed, eta, status, error, filename, created_at }
download_tasks: Dict[str, Dict[str, Any]] = {}

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

async def search_youtube(query: str, limit: int = 5) -> List[Dict[str, Any]]:
    """
    Search YouTube using yt-dlp flat-playlist json dump.
    Returns a list of top search results.
    """
    search_target = f"ytsearch{limit}:{query}"
    cmd = [
        "yt-dlp",
        search_target,
        "--dump-json",
        "--flat-playlist",
        "--skip-download",
        "--no-warnings"
    ]
    
    results = []
    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await process.communicate()

        if process.returncode != 0 and not stdout:
            err_msg = stderr.decode('utf-8', errors='ignore')
            logger.error(f"yt-dlp search error: {err_msg}")
            return []

        lines = stdout.decode('utf-8', errors='ignore').strip().split('\n')
        for line in lines:
            if not line.strip():
                continue
            try:
                data = json.loads(line)
                video_id = data.get("id", "")
                title = data.get("title", "Desconocido")
                channel = data.get("uploader") or data.get("channel") or data.get("uploader_id") or "Desconocido"
                duration = data.get("duration")
                # Reject tracks under 30s or over 600s (10 minutes)
                if duration is not None and (duration < 30 or duration > 600):
                    continue
                
                # Thumbnail fallback ladder
                thumbnails = data.get("thumbnails", [])
                thumbnail_url = ""
                if thumbnails:
                    thumbnail_url = thumbnails[-1].get("url", "")
                if not thumbnail_url and video_id:
                    thumbnail_url = f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"

                results.append({
                    "id": video_id,
                    "url": f"https://www.youtube.com/watch?v={video_id}" if video_id else data.get("url", ""),
                    "title": title,
                    "channel": channel,
                    "duration": duration,
                    "duration_string": format_duration(duration),
                    "thumbnail": thumbnail_url,
                    "view_count": data.get("view_count", 0)
                })
            except json.JSONDecodeError:
                continue

    except Exception as e:
        logger.error(f"Failed to execute yt-dlp search: {e}")
        return []

    return results

TRENDING_CACHE: Dict[str, Dict[str, Any]] = {
    "es": {"tracks": [], "last_fetched": 0},
    "global": {"tracks": [], "last_fetched": 0},
    "los40": {"tracks": [], "last_fetched": 0},
    "spotify_es": {"tracks": [], "last_fetched": 0},
    "spotify_global": {"tracks": [], "last_fetched": 0}
}

MIX_KEYWORDS = ["mix", "compilation", "recopilatorio", "sesion", "sesión", "enganchado", "completo", "horas", "top 50", "top 20", "top 100", "full album", "album", "áldum"]

async def fetch_los40_official_chart() -> List[Tuple[str, str]]:
    """Scrape official weekly chart directly from https://los40.com/lista40/."""
    import urllib.request
    import html
    url = "https://los40.com/lista40/"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
    try:
        loop = asyncio.get_event_loop()
        def _read_url():
            return urllib.request.urlopen(req, timeout=10).read().decode('utf-8')
        html_content = await loop.run_in_executor(None, _read_url)

        tracks_raw = re.findall(r'<h2>([^<]+)</h2>\s*<span>([^<]+)</span>', html_content)
        cleaned = []
        for song, artist in tracks_raw:
            s_clean = html.unescape(song.strip())
            a_clean = html.unescape(artist.strip())
            cleaned.append((a_clean, s_clean))
        return cleaned
    except Exception as e:
        logger.error(f"Error scraping https://los40.com/lista40/: {e}")
        return []

async def fetch_spotify_chart(chart_type: str = "es") -> List[Tuple[str, str]]:
    """Scrape official daily Spotify Top Chart from Kworb/Spotify Charts."""
    import urllib.request
    import html
    url = "https://kworb.net/spotify/country/es_daily.html" if chart_type == "es" else "https://kworb.net/spotify/country/global_daily.html"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
    try:
        loop = asyncio.get_event_loop()
        def _read_url():
            return urllib.request.urlopen(req, timeout=10).read().decode('utf-8', errors='ignore')
        html_doc = await loop.run_in_executor(None, _read_url)

        rows = re.findall(r'<td class=\"text mp\">(.*?)</td>', html_doc, re.DOTALL)
        results = []
        for r in rows:
            m = re.search(r'<a href=\"[^\"]*artist[^\"]*\">(.*?)</a>\s*-\s*<a href=\"[^\"]*track[^\"]*\">(.*?)</a>', r, re.DOTALL)
            if m:
                artist = html.unescape(re.sub(r'<[^>]+>', '', m.group(1)).strip())
                song = html.unescape(re.sub(r'<[^>]+>', '', m.group(2)).strip())
                results.append((artist, song))
        return results
    except Exception as e:
        logger.error(f"Error scraping Spotify chart ({chart_type}): {e}")
        return []

async def fetch_single_yt_track(artist: str, song: str, rank: int, sem: Optional[asyncio.Semaphore] = None, custom_channel: str = "LOS40 España") -> Optional[Dict[str, Any]]:
    query = f"{artist} {song} video oficial"
    search_target = f"ytsearch1:{query}"
    cmd = ["yt-dlp", search_target, "--dump-json", "--flat-playlist", "--skip-download", "--no-warnings"]
    
    async def _do_fetch():
        try:
            proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            stdout, _ = await proc.communicate()
            if stdout:
                for line in stdout.decode("utf-8", errors="ignore").strip().split("\n"):
                    if line.strip():
                        try:
                            data = json.loads(line)
                            v_id = data.get("id", "")
                            duration = data.get("duration")
                            if duration and (duration < 30 or duration > 600):
                                continue
                            return {
                                "id": v_id,
                                "url": f"https://www.youtube.com/watch?v={v_id}" if v_id else data.get("url", ""),
                                "title": f"#{rank} {artist} - {song}",
                                "channel": custom_channel,
                                "duration": duration,
                                "duration_string": format_duration(duration),
                                "thumbnail": f"https://i.ytimg.com/vi/{v_id}/hqdefault.jpg" if v_id else ""
                            }
                        except json.JSONDecodeError:
                            pass
        except Exception as e:
            logger.error(f"Error searching track {artist} - {song}: {e}")
        return None

    if sem:
        async with sem:
            return await _do_fetch()
    return await _do_fetch()

async def get_yt_stream_url(video_url: str) -> Optional[str]:
    """Get direct audio stream URL from YouTube using yt-dlp flat extraction."""
    cmd = ["yt-dlp", "-g", "-f", "bestaudio[ext=m4a]/bestaudio", video_url]
    try:
        proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, _ = await proc.communicate()
        if stdout:
            lines = stdout.decode('utf-8', errors='ignore').strip().split('\n')
            for line in lines:
                if line.startswith("http://") or line.startswith("https://"):
                    return line
    except Exception as e:
        logger.error(f"Failed to get direct stream URL for {video_url}: {e}")
    return None

async def get_trending_tracks(limit: int = 40, region: str = "es", force_refresh: bool = False) -> List[Dict[str, Any]]:
    """
    Fetch current trending individual music singles on YouTube.
    Regions: 'es' (España), 'global' (Internacional), 'los40' (LOS40 Principales España).
    """
    import time
    now = time.time()
    region_lower = (region or "es").lower()

    if region_lower in ["los40", "40", "los_40"]:
        clean_region = "los40"
    elif region_lower in ["spotify_es", "spotify-es"]:
        clean_region = "spotify_es"
    elif region_lower in ["spotify_global", "spotify-global", "spotify"]:
        clean_region = "spotify_global"
    elif region_lower == "global":
        clean_region = "global"
    else:
        clean_region = "es"

    cache_entry = TRENDING_CACHE.get(clean_region, {"tracks": [], "last_fetched": 0})

    if not force_refresh and cache_entry["tracks"] and (now - cache_entry["last_fetched"]) < 3600:
        return cache_entry["tracks"]

    if clean_region == "los40":
        chart = await fetch_los40_official_chart()
        if chart:
            items_to_search = chart[:limit]
            sem = asyncio.Semaphore(10)
            tasks = [fetch_single_yt_track(a, s, i + 1, sem=sem, custom_channel="LOS40 España") for i, (a, s) in enumerate(items_to_search)]
            search_results = await asyncio.gather(*tasks, return_exceptions=True)
            los40_results = [r for r in search_results if isinstance(r, dict) and r]
            if los40_results:
                TRENDING_CACHE["los40"] = {
                    "tracks": los40_results,
                    "last_fetched": now
                }
                return los40_results
        
        if cache_entry["tracks"]:
            logger.warning("LOS40 fresh chart fetch failed or was empty; returning stale cached tracks.")
            return cache_entry["tracks"]

    if clean_region in ["spotify_es", "spotify_global"]:
        chart_type = "es" if clean_region == "spotify_es" else "global"
        channel_label = "Spotify Top España" if clean_region == "spotify_es" else "Spotify Top Global"
        chart = await fetch_spotify_chart(chart_type)
        if chart:
            items_to_search = chart[:limit]
            sem = asyncio.Semaphore(10)
            tasks = [fetch_single_yt_track(a, s, i + 1, sem=sem, custom_channel=channel_label) for i, (a, s) in enumerate(items_to_search)]
            search_results = await asyncio.gather(*tasks, return_exceptions=True)
            spotify_results = [r for r in search_results if isinstance(r, dict) and r]
            if spotify_results:
                TRENDING_CACHE[clean_region] = {
                    "tracks": spotify_results,
                    "last_fetched": now
                }
                return spotify_results

        if cache_entry["tracks"]:
            logger.warning(f"Spotify {clean_region} fresh chart fetch failed; returning cached tracks.")
            return cache_entry["tracks"]

    # Region-specific search target for general search
    if clean_region == "global":
        query = "official music video 2026 hits singles global trending"
    else:
        query = "canciones top españa 2026 exitos novedades video oficial"

    raw_results = await search_youtube(query, limit=40)
    
    filtered_results = []
    for track in raw_results:
        duration = track.get("duration") or 0
        title_lower = (track.get("title") or "").lower()

        # Filter out tracks under 30s or over 600s (10 minutes)
        if duration > 0 and (duration < 30 or duration > 600):
            continue

        # Filter out mix keywords
        if any(kw in title_lower for kw in MIX_KEYWORDS):
            continue

        filtered_results.append(track)
        if len(filtered_results) >= limit:
            break

    final_results = filtered_results if filtered_results else raw_results[:limit]

    if final_results:
        TRENDING_CACHE[clean_region] = {
            "tracks": final_results,
            "last_fetched": now
        }
    return final_results

async def process_download_task(task_id: str, url: str, title: Optional[str] = None):
    """
    Background worker to execute yt-dlp audio extraction with metadata & artwork embedding.
    Downloads locally to /tmp/music_downloads first, then moves the finished .mp3 to /mnt/cloud_music
    to prevent FUSE rclone lockups or temp file sync context cancellation errors.
    """
    import shutil

    if task_id not in download_tasks:
        return

    download_tasks[task_id]["status"] = "downloading"
    download_tasks[task_id]["progress"] = 0

    temp_dir = Path("/tmp/music_downloads")
    temp_dir.mkdir(parents=True, exist_ok=True)

    # Local output template: /tmp/music_downloads/%(title)s [%(id)s].%(ext)s
    output_template = str(temp_dir / "%(title)s [%(id)s].%(ext)s")

    cmd = [
        "yt-dlp",
        "--extract-audio",
        "--audio-format", "mp3",
        "--audio-quality", "0",
        "--embed-thumbnail",
        "--add-metadata",
        "--no-playlist",
        "--newline",
        "--output", output_template,
        url
    ]

    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )

        progress_regex = re.compile(r'\[download\]\s+(\d+\.?\d*)%\s+of\s+([^\s]+)\s+at\s+([^\s]+)\s+ETA\s+([^\s]+)')
        destination_regex = re.compile(r'\[ExtractAudio\] Destination: (.*)')

        resulting_temp_filepath = None

        while True:
            line = await process.stdout.readline()
            if not line:
                break
            line_str = line.decode('utf-8', errors='ignore').strip()
            
            # Progress line match
            match = progress_regex.search(line_str)
            if match:
                percent = float(match.group(1))
                speed = match.group(3)
                eta = match.group(4)
                download_tasks[task_id]["progress"] = min(percent, 85.0) # Reserve last 15% for cloud move
                download_tasks[task_id]["speed"] = speed
                download_tasks[task_id]["eta"] = eta

            # Audio extraction destination match
            dest_match = destination_regex.search(line_str)
            if dest_match:
                resulting_temp_filepath = Path(dest_match.group(1).strip())
                download_tasks[task_id]["status"] = "converting"

        await process.wait()

        if process.returncode == 0:
            # Locate resulting .mp3 in temp_dir if missing exact path
            if not resulting_temp_filepath or not resulting_temp_filepath.exists():
                mp3s = list(temp_dir.glob("*.mp3"))
                if mp3s:
                    mp3s.sort(key=lambda p: p.stat().st_mtime, reverse=True)
                    resulting_temp_filepath = mp3s[0]

            if resulting_temp_filepath and resulting_temp_filepath.exists():
                filename = resulting_temp_filepath.name
                target_filepath = MUSIC_DIR / filename

                download_tasks[task_id]["status"] = "uploading"
                download_tasks[task_id]["progress"] = 92.0

                # Move fully prepared .mp3 file to cloud storage
                shutil.move(str(resulting_temp_filepath), str(target_filepath))

                download_tasks[task_id]["status"] = "completed"
                download_tasks[task_id]["progress"] = 100.0
                download_tasks[task_id]["speed"] = "0KiB/s"
                download_tasks[task_id]["eta"] = "00:00"
                download_tasks[task_id]["filename"] = filename

                # Invalidate library cache so the track displays instantly
                try:
                    from app.services.library_service import invalidate_library_cache
                    invalidate_library_cache()
                except Exception:
                    pass

                # Record track owner in app metadata
                try:
                    from app.services.playlist_service import set_track_owner
                    username = download_tasks[task_id].get("downloaded_by", "invitado")
                    set_track_owner(filename, username)
                except Exception as ex:
                    logger.error(f"Error setting track owner: {ex}")
            else:
                download_tasks[task_id]["status"] = "failed"
                download_tasks[task_id]["error"] = "No se pudo localizar el archivo MP3 procesado"
        else:
            stderr_out = await process.stderr.read()
            err_msg = stderr_out.decode('utf-8', errors='ignore')
            logger.error(f"Download failed for {task_id}: {err_msg}")
            download_tasks[task_id]["status"] = "failed"
            download_tasks[task_id]["error"] = err_msg or "yt-dlp exited with error"

    except Exception as e:
        logger.error(f"Exception during download task {task_id}: {e}")
        download_tasks[task_id]["status"] = "failed"
        download_tasks[task_id]["error"] = str(e)
    finally:
        # Cleanup any leftover temporary files in temp_dir
        try:
            for item in temp_dir.glob("*"):
                if item.is_file():
                    item.unlink(missing_ok=True)
        except Exception:
            pass

def start_download_job(url: str, title: Optional[str] = None, video_id: Optional[str] = None, username: str = "invitado") -> str:
    """
    Registers and launches an async download task with owner username. Returns unique task_id.
    """
    task_id = str(uuid.uuid4())
    download_tasks[task_id] = {
        "task_id": task_id,
        "video_id": video_id or "",
        "url": url,
        "title": title or "Audio YouTube",
        "progress": 0.0,
        "speed": "--",
        "eta": "--",
        "status": "queued",
        "error": None,
        "filename": None,
        "downloaded_by": username
    }
    return task_id
