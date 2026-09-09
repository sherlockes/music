import asyncio
import json
import re
import uuid
import logging
import time
import random
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional, Tuple
from pathlib import Path
from app.config import MUSIC_DIR

try:
    import mutagen
    from mutagen.mp3 import MP3
    from mutagen.id3 import ID3, TIT2, TPE1, TALB, TYER, APIC
except ImportError:
    mutagen = None

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

def clean_song_metadata(title_raw: str, artist_raw: str = "", channel_raw: str = "") -> Tuple[str, str]:
    """
    Intelligently extracts and cleans Song Title and Artist from YouTube video titles,
    ID3 tags, and channel names, correctly recognizing Song - Artist vs Artist - Song orders
    and discarding extraneous album/video tags after pipe '|' separators.
    Returns (clean_title, clean_artist).
    """
    title = (title_raw or "").strip()
    artist = (artist_raw or "").strip()
    channel = (channel_raw or "").strip()

    # 1. Strip file extensions and YouTube video ID in brackets
    title = re.sub(r'\.(mp3|m4a|flac|wav|webm|ogg)$', '', title, flags=re.IGNORECASE).strip()
    title = re.sub(r'\s*\[[a-zA-Z0-9_-]{11}\]$', '', title).strip()

    # 2. Strip leading ranking (e.g. "#1 ", "#01 - ", "1. ", "01 - ") but preserve numbers in titles (e.g. "20 de abril", "19 días...")
    title = re.sub(r'^(?:#\d+|\d+[\.\-:])\s*', '', title).strip()

    # 3. Clean noise suffixes / video tags
    noise_patterns = [
        r'\s*[\(\[\{]\s*(?:official\s+)?(?:music\s+)?video(?:clip)?(?:\s+oficial)?\s*[\)\]\}]',
        r'\s*[\(\[\{]\s*(?:video|audio|videoclip|clip)\s+oficial\s*[\)\]\}]',
        r'\s*[\(\[\{]\s*official\s+(?:audio|lyric\s+video|lyrics?|visualizer|video)\s*[\)\]\}]',
        r'\s*[\(\[\{]\s*(?:audio|visualizer|lyric\s+video|lyrics?|letra|letra\/lyric)\s*[\)\]\}]',
        r'\s*[\(\[\{]\s*(?:en\s+vivo|en\s+directo|live|remaster(?:ed)?(?:\s+\d+)?|4k|hd|hq|full\s+hd|mv)\s*[\)\]\}]',
        r'\s*[\(\[\{]\s*(?:oficial\s+concept|concept\s+lyrics?|concept\s+\d{4}|estreno\s+\d{4}|novedad(?:\s+\d{4})?)\s*[\)\]\}]',
        r'\s*\|\s*(?:concept\s+\d{4}|concept\s+lyrics?|estreno\s+\d{4}|letra|lyrics?|video\s+oficial|audio\s+oficial|oficial|official|hd|4k|mv|premiere\s+\d{4}).*$',
    ]
    for pat in noise_patterns:
        title = re.sub(pat, '', title, flags=re.IGNORECASE).strip()

    # 4. Clean channel name if generic
    generic_channels = {
        "los40 españa", "spotify top españa", "spotify top global",
        "pop rock español (1985-2000)", "pop rock español",
        "top hits", "youtube", "desconocido", "comunidad", 
        "various artists", "varios artistas"
    }
    clean_channel = channel.strip()
    if clean_channel.lower() in generic_channels:
        clean_channel = ""
    else:
        clean_channel = re.sub(r'\s*-\s*Topic$', '', clean_channel, flags=re.IGNORECASE).strip()
        clean_channel = re.sub(r'VEVO$', '', clean_channel, flags=re.IGNORECASE).strip()
        clean_channel = re.sub(r'\s+Official$', '', clean_channel, flags=re.IGNORECASE).strip()
        clean_channel = re.sub(r'\s+Oficial$', '', clean_channel, flags=re.IGNORECASE).strip()

    clean_artist = artist.strip() if (artist and artist.lower() not in generic_channels) else ""

    if clean_artist and title:
        # If title starts or ends with artist + separator, strip the redundant artist
        prefix_match = re.match(r'^(?:' + re.escape(clean_artist) + r')\s+[-–—]\s+', title, re.IGNORECASE)
        if prefix_match:
            title = title[prefix_match.end():].strip()
        else:
            suffix_match = re.search(r'\s+[-–—]\s+(?:' + re.escape(clean_artist) + r')$', title, re.IGNORECASE)
            if suffix_match:
                title = title[:suffix_match.start()].strip()
        parsed_title = title
        for pat in noise_patterns:
            parsed_title = re.sub(pat, '', parsed_title, flags=re.IGNORECASE).strip()
        parsed_title = re.sub(r'^["\'«](.*)["\'»]$', r'\1', parsed_title).strip()
        return parsed_title or "Canción", clean_artist

    # 5. Handle pipe separators '|' (e.g. 'LA GRACIOSA - Quevedo ft. Elvis Crespo | EL BAIFO' or 'DESPUES DE TI | Kapo, Feid')
    if ' | ' in title:
        pipe_parts = [p.strip() for p in title.split(' | ') if p.strip()]
        if len(pipe_parts) == 2:
            p0, p1 = pipe_parts[0], pipe_parts[1]
            if (' - ' in p0 or ' – ' in p0 or ' — ' in p0):
                title = p0  # Part before pipe contains the full 'Song - Artist' or 'Artist - Song'
            elif clean_channel and clean_channel.lower() in p1.lower():
                title = p0
                if not clean_artist:
                    clean_artist = p1
            elif any(feat in p1.lower() for feat in ['feat', 'ft.', '&', ' y ', ' x ', ',']):
                title = p0
                if not clean_artist:
                    clean_artist = p1
            else:
                title = p0

    # 6. Handle dash separator ' - '
    dash_match = re.search(r'\s+[-–—]\s+', title)
    if dash_match:
        parts = re.split(r'\s+[-–—]\s+', title, maxsplit=1)
        left = parts[0].strip()
        right = parts[1].strip()

        right = re.sub(r'^["\'«](.*)["\'»]$', r'\1', right).strip()
        for pat in noise_patterns:
            right = re.sub(pat, '', right, flags=re.IGNORECASE).strip()

        # Determine if Left is Artist and Right is Title, OR Left is Title and Right is Artist
        right_is_artist = False
        left_is_artist = False

        if clean_channel:
            c_low = clean_channel.lower()
            if c_low in right.lower() and c_low not in left.lower():
                right_is_artist = True
            elif c_low in left.lower() and c_low not in right.lower():
                left_is_artist = True

        if not right_is_artist and not left_is_artist:
            feat_re = r'\b(?:ft\.?|feat\.?|featuring)\b'
            has_feat_right = bool(re.search(feat_re, right, re.IGNORECASE))
            has_feat_left = bool(re.search(feat_re, left, re.IGNORECASE))
            if has_feat_right and not has_feat_left:
                right_is_artist = True
            elif has_feat_left and not has_feat_right:
                left_is_artist = True

        if right_is_artist:
            parsed_title = left
            parsed_artist = right
        else:
            parsed_title = right
            parsed_artist = left
    else:
        parsed_title = title
        parsed_artist = clean_artist or clean_channel or "Desconocido"

    if clean_artist:
        parsed_artist = clean_artist

    parsed_title = re.sub(r'^["\'«](.*)["\'»]$', r'\1', parsed_title).strip()
    return parsed_title or "Canción", parsed_artist or "Desconocido"

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
        "--no-warnings",
        "--geo-bypass",
        "--extractor-args", "youtube:player_client=android,web"
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
                raw_title = data.get("title", "Desconocido")
                raw_channel = data.get("uploader") or data.get("channel") or data.get("uploader_id") or "Desconocido"
                clean_title, clean_artist = clean_song_metadata(raw_title, channel_raw=raw_channel)
                duration = data.get("duration")
                # Reject playlists, livestreams, and tracks under 60s (1 min) or over 600s (10 minutes)
                if not duration or duration < 60 or duration > 600:
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
                    "title": clean_title,
                    "artist": clean_artist,
                    "channel": clean_artist,
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

TRENDING_CACHE_FILE = Path(__file__).resolve().parent.parent / "data" / "trending_cache.json"

def load_trending_cache() -> Dict[str, Dict[str, Any]]:
    default_cache = {
        "es": {"tracks": [], "last_fetched": 0},
        "global": {"tracks": [], "last_fetched": 0},
        "los40": {"tracks": [], "last_fetched": 0},
        "spotify_es": {"tracks": [], "last_fetched": 0},
        "spotify_global": {"tracks": [], "last_fetched": 0},
        "pop_rock_es": {"tracks": [], "last_fetched": 0}
    }
    if TRENDING_CACHE_FILE.exists():
        try:
            with open(TRENDING_CACHE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                for k, v in data.items():
                    if k in default_cache and isinstance(v, dict):
                        default_cache[k] = v
        except Exception as e:
            logger.error(f"Error loading trending_cache.json: {e}")
    return default_cache

def save_trending_cache():
    try:
        TRENDING_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(TRENDING_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(TRENDING_CACHE, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logger.error(f"Error saving trending_cache.json: {e}")

TRENDING_CACHE: Dict[str, Dict[str, Any]] = load_trending_cache()

def is_trending_cache_expired(last_fetched: float) -> bool:
    """
    Trending lists are updated weekly on Mondays.
    Check if the cached list is older than 7 days or has crossed into the next Monday.
    """
    if not last_fetched or last_fetched <= 0:
        return True
    now = time.time()
    # If older than 7 days (1 week), it has expired
    if (now - last_fetched) >= 7 * 86400:
        return True
    
    try:
        fetched_dt = datetime.fromtimestamp(last_fetched)
        now_dt = datetime.fromtimestamp(now)
        
        # Days ahead to reach next Monday 00:00:00 (Monday is 0, Sunday is 6)
        days_ahead = 7 - fetched_dt.weekday()
        if days_ahead <= 0:
            days_ahead = 7
        next_monday = (fetched_dt + timedelta(days=days_ahead)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        if now_dt >= next_monday:
            return True
    except Exception:
        pass
        
    return False

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

POP_ROCK_ES_CLASSICS_POOL: List[Tuple[str, str]] = [
    # --- 1985 - 1989 ---
    ("Hombres G", "Devuélveme a mi chica"),
    ("Hombres G", "Marta tiene un marcapasos"),
    ("Hombres G", "Voy a pasármelo bien"),
    ("Hombres G", "Venezia"),
    ("Hombres G", "Te quiero"),
    ("Duncan Dhu", "En algún lugar"),
    ("Duncan Dhu", "Cien gaviotas"),
    ("Duncan Dhu", "Jardín de rosas"),
    ("Duncan Dhu", "Una calle de París"),
    ("El Último de la Fila", "Insurrección"),
    ("El Último de la Fila", "Querida Milagros"),
    ("El Último de la Fila", "Ya no danzo al son de los tambores"),
    ("El Último de la Fila", "Aviones plateados"),
    ("Mecano", "Hijo de la luna"),
    ("Mecano", "Mujer contra mujer"),
    ("Mecano", "Me cuesta tanto olvidarte"),
    ("Mecano", "La fuerza del destino"),
    ("Mecano", "No hay marcha en Nueva York"),
    ("Mecano", "Cruz de navajas"),
    ("Mecano", "Ay qué pesado"),
    ("Nacha Pop", "Lucha de gigantes"),
    ("Nacha Pop", "Desordenada habitación"),
    ("Nacha Pop", "No se acaban las calles"),
    ("Radio Futura", "Escuela de calor"),
    ("Radio Futura", "A cara o cruz"),
    ("Radio Futura", "Paseo con la negra flor"),
    ("Radio Futura", "37 grados"),
    ("Gabinete Caligari", "Camino Soria"),
    ("Gabinete Caligari", "La sangre de tu tristeza"),
    ("Gabinete Caligari", "Suite nupcial"),
    ("Gabinete Caligari", "Al calor del amor en un bar"),
    ("Danza Invisible", "Sabor de amor"),
    ("Danza Invisible", "Reina del Caribe"),
    ("Danza Invisible", "Sin aliento"),
    ("La Guardia", "Mil calles llevan hacia ti"),
    ("La Guardia", "El blues de la nacional II"),
    ("Los Ronaldos", "No puedo vivir sin ti"),
    ("Los Ronaldos", "Adiós papá"),
    ("Los Ronaldos", "Si os vais..."),
    ("Los Rebeldes", "Mediterráneo"),
    ("Los Rebeldes", "Bajo la luz de la luna"),
    ("Los Rebeldes", "Mescalina"),
    ("Los Secretos", "No me imagino"),
    ("Los Secretos", "Quiero beber hasta perder el control"),
    ("Los Secretos", "Buena chica"),
    ("La Unión", "Sildavia"),
    ("La Unión", "Más y más"),
    ("La Unión", "Maracaibo"),
    ("Modestia Aparte", "Ojos de hielo"),
    ("Modestia Aparte", "Chirimoya"),
    ("Los Refrescos", "Aquí no hay playa"),
    ("Los Toreros Muertos", "Mi agüita amarilla"),
    ("Los Toreros Muertos", "Yo no me llamo Javier"),
    ("Rosendo", "Agradecido"),
    ("Rosendo", "Loco por incordiar"),
    ("Rosendo", "Flojos de pantalón"),
    ("Alaska y Dinarama", "A quién le importa"),
    ("Alaska y Dinarama", "Ni tú ni nadie"),
    ("Tam Tam Go!", "Manuel Raquel"),
    ("Tam Tam Go!", "Spanish Shuffle"),
    ("Cómplices", "Es por ti"),
    ("Un Pingüino en mi Ascensor", "Espiando a mi vecina"),
    ("Loquillo y Los Trogloditas", "Cadillac solitario"),
    ("Loquillo y Los Trogloditas", "El rompeolas"),
    ("Loquillo y Los Trogloditas", "Besos robados"),
    ("Loquillo y Los Trogloditas", "La mataré"),
    ("Barricada", "No hay tregua"),
    ("Barricada", "Barrio conflictivo"),
    ("Barricada", "Pasión por el ruido"),
    # --- 1990 - 2000 ---
    ("Héroes del Silencio", "Entre dos tierras"),
    ("Héroes del Silencio", "Maldito duende"),
    ("Héroes del Silencio", "La chispa adecuada"),
    ("Héroes del Silencio", "Sirena varada"),
    ("Héroes del Silencio", "Nuestros nombres"),
    ("Héroes del Silencio", "Con nombre de guerra"),
    ("Héroes del Silencio", "Deshacer el mundo"),
    ("Héroes del Silencio", "La herida"),
    ("Los Rodríguez", "Sin documentos"),
    ("Los Rodríguez", "Dulce condena"),
    ("Los Rodríguez", "Mucho mejor"),
    ("Los Rodríguez", "Milonga del marinero y el capitán"),
    ("Los Rodríguez", "Para no olvidar"),
    ("Los Rodríguez", "Me estás atrapando otra vez"),
    ("Los Rodríguez", "Mi enfermedad"),
    ("Los Secretos", "Pero a tu lado"),
    ("Los Secretos", "Ojos de gata"),
    ("Los Secretos", "Mi amiga del corazón"),
    ("Los Secretos", "Y no amanece"),
    ("Radio Futura", "Veneno en la piel"),
    ("Radio Futura", "Corazón de tiza"),
    ("Gabinete Caligari", "La culpa fue del cha-cha-chá"),
    ("Gabinete Caligari", "Sólo se vive una vez"),
    ("La Guardia", "Cuando brille el sol"),
    ("La Guardia", "Donde nace el río"),
    ("Celtas Cortos", "20 de abril"),
    ("Celtas Cortos", "Cuéntame un cuento"),
    ("Celtas Cortos", "La senda del tiempo"),
    ("Celtas Cortos", "Tranquilo majete"),
    ("Celtas Cortos", "Haz turismo"),
    ("Jarabe de Palo", "La flaca"),
    ("Jarabe de Palo", "Depende"),
    ("Jarabe de Palo", "Grita"),
    ("Jarabe de Palo", "El lado oscuro"),
    ("Jarabe de Palo", "Agua"),
    ("Seguridad Social", "Chiquilla"),
    ("Seguridad Social", "Quiero tener tu presencia"),
    ("Seguridad Social", "Mi rumba tarumba"),
    ("Seguridad Social", "Comerranas"),
    ("Andrés Calamaro", "Flaca"),
    ("Andrés Calamaro", "Loco"),
    ("Andrés Calamaro", "Te quiero igual"),
    ("Andrés Calamaro", "Crímenes perfectos"),
    ("Andrés Calamaro", "Paloma"),
    ("Andrés Calamaro", "Alta suciedad"),
    ("M-Clan", "Llamando a la Tierra"),
    ("M-Clan", "Quédate a dormir"),
    ("M-Clan", "Carolina"),
    ("Fito & Fitipaldis", "Rojitas las orejas"),
    ("Fito & Fitipaldis", "Trozos de cristal"),
    ("Fito & Fitipaldis", "Mirando al cielo"),
    ("Platero y Tú", "El roce de tu cuerpo"),
    ("Platero y Tú", "Hay poco rock & roll"),
    ("Platero y Tú", "Mari Madalenas"),
    ("Platero y Tú", "Juliette"),
    ("Platero y Tú", "Alucinante"),
    ("Extremoduro", "So payaso"),
    ("Extremoduro", "Salir"),
    ("Extremoduro", "Sucede"),
    ("Extremoduro", "Jesucristo García"),
    ("Extremoduro", "Golfa"),
    ("Extremoduro", "Deltoya"),
    ("Los Piratas", "Años 80"),
    ("Los Piratas", "Promesas que no valen nada"),
    ("Los Piratas", "Mi coco"),
    ("Los Piratas", "El mundo de Wayne"),
    ("Joaquín Sabina", "19 días y 500 noches"),
    ("Joaquín Sabina", "Y nos dieron las diez"),
    ("Joaquín Sabina", "Contigo"),
    ("Joaquín Sabina", "Nos sobran los motivos"),
    ("Joaquín Sabina", "La del pirata cojo"),
    ("Antonio Vega", "El sitio de mi recreo"),
    ("Antonio Vega", "Se dejaba llevar por ti"),
    ("Antonio Vega", "Esperando nada"),
    ("Mikel Erentxun", "A un minuto de ti"),
    ("Mikel Erentxun", "Jugando con el tiempo"),
    ("Revólver", "El roce de tu piel"),
    ("Revólver", "Si es tan solo amor"),
    ("Revólver", "Dentro de ti"),
    ("Revólver", "No va más"),
    ("Tam Tam Go!", "Atrapados en la red"),
    ("Tam Tam Go!", "Espaldas mojadas"),
    ("Modestia Aparte", "Cosas de la edad"),
    ("Modestia Aparte", "Trapos sucios, platos rotos y ternura"),
    ("Barricada", "En blanco y negro"),
    ("Barricada", "Animal caliente"),
    ("Barricada", "Oveja negra"),
    ("La Oreja de Van Gogh", "Cuéntame al oído"),
    ("La Oreja de Van Gogh", "El 28"),
    ("La Oreja de Van Gogh", "Soñaré"),
    ("La Oreja de Van Gogh", "La playa"),
    ("La Oreja de Van Gogh", "Dile al sol"),
    ("Amaral", "Cómo hablar"),
    ("Amaral", "Rosita"),
    ("Amaral", "No sé qué hacer con mi vida"),
    ("Dover", "Serenade"),
    ("Dover", "Devil Came to Me"),
    ("Dover", "King George"),
    ("Presuntos Implicados", "Cómo hemos cambiado"),
    ("Los Enemigos", "Septiembre"),
    ("Los Enemigos", "Desde el jergón"),
    ("Los Enemigos", "La cuenta atrás"),
    ("El Último de la Fila", "Como un burro amarrado en la puerta del baile"),
    ("El Último de la Fila", "Mar antiguo"),
    ("El Último de la Fila", "Canta por mí"),
    ("Tahúres Zurdos", "Tocaré"),
    ("Tahúres Zurdos", "Ella"),
    ("Los DelTonos", "Escucha"),
    ("Ella Baila Sola", "Lo echamos a suertes"),
    ("Ella Baila Sola", "Amores de barra"),
    ("Ella Baila Sola", "Cuando los sapos bailen flamenco"),
    ("La Unión", "Ella es un volcán"),
    ("Seguridad Social", "Me siento bien")
]

def get_weekly_pop_rock_classics(limit: int = 40) -> List[Tuple[str, str]]:
    """
    Deterministically rotates and selects classic songs each week (based on year and ISO week number).
    This guarantees:
    1. During the same week, the exact same curated 40 songs are provided.
    2. When a new week starts (Monday), a fresh 40-song selection is picked automatically from the master catalog.
    """
    now = datetime.now()
    year, week, _ = now.isocalendar()
    seed = f"pop_rock_es_{year}_{week}"
    
    rng = random.Random(seed)
    pool = list(POP_ROCK_ES_CLASSICS_POOL)
    rng.shuffle(pool)
    return pool[:limit]

async def fetch_single_yt_track(artist: str, song: str, rank: int, sem: Optional[asyncio.Semaphore] = None, custom_channel: str = "LOS40 España") -> Optional[Dict[str, Any]]:
    query = f"{artist} {song} video oficial"
    search_target = f"ytsearch1:{query}"
    cmd = ["yt-dlp", search_target, "--dump-json", "--flat-playlist", "--skip-download", "--no-warnings", "--geo-bypass", "--extractor-args", "youtube:player_client=android,web"]
    
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
                            if not duration or duration < 60 or duration > 600:
                                continue
                            clean_title, clean_artist = clean_song_metadata(song, artist_raw=artist)
                            return {
                                "id": v_id,
                                "url": f"https://www.youtube.com/watch?v={v_id}" if v_id else data.get("url", ""),
                                "title": clean_title,
                                "artist": clean_artist,
                                "channel": clean_artist,
                                "rank": rank,
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
    """Fetch current trending individual music singles on YouTube."""
    tracks, _, _ = await get_trending_tracks_with_meta(limit=limit, region=region, force_refresh=force_refresh)
    return tracks

async def get_trending_tracks_with_meta(limit: int = 40, region: str = "es", force_refresh: bool = False) -> Tuple[List[Dict[str, Any]], float, bool]:
    """
    Fetch trending tracks with Monday weekly caching and persistence.
    Returns (tracks, last_fetched_timestamp, can_refresh_bool).
    """
    now = time.time()
    region_lower = (region or "es").lower()

    if region_lower in ["los40", "40", "los_40"]:
        clean_region = "los40"
    elif region_lower in ["spotify_es", "spotify-es"]:
        clean_region = "spotify_es"
    elif region_lower in ["spotify_global", "spotify-global", "spotify"]:
        clean_region = "spotify_global"
    elif region_lower in ["pop_rock_es", "pop-rock-es", "poprock", "pop_rock", "pop_rock_espana", "pop_rock_español"]:
        clean_region = "pop_rock_es"
    elif region_lower == "global":
        clean_region = "global"
    else:
        clean_region = "es"

    cache_entry = TRENDING_CACHE.get(clean_region, {"tracks": [], "last_fetched": 0})
    last_fetched = cache_entry.get("last_fetched", 0)
    is_expired = is_trending_cache_expired(last_fetched)

    # If cached tracks exist and cache is NOT expired, return cached immediately
    if cache_entry["tracks"] and not is_expired and not force_refresh:
        return cache_entry["tracks"], last_fetched, False

    if clean_region == "pop_rock_es":
        items_to_search = get_weekly_pop_rock_classics(limit=limit)
        sem = asyncio.Semaphore(10)
        tasks = [fetch_single_yt_track(a, s, i + 1, sem=sem, custom_channel="Pop Rock Español (1985-2000)") for i, (a, s) in enumerate(items_to_search)]
        search_results = await asyncio.gather(*tasks, return_exceptions=True)
        pop_rock_results = [r for r in search_results if isinstance(r, dict) and r]
        if pop_rock_results:
            TRENDING_CACHE["pop_rock_es"] = {
                "tracks": pop_rock_results,
                "last_fetched": now
            }
            save_trending_cache()
            return pop_rock_results, now, False

        if cache_entry["tracks"]:
            logger.warning("Pop Rock Español list search failed; returning cached tracks.")
            return cache_entry["tracks"], last_fetched, is_expired

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
                save_trending_cache()
                return los40_results, now, False
        
        if cache_entry["tracks"]:
            logger.warning("LOS40 fresh chart fetch failed or was empty; returning stale cached tracks.")
            return cache_entry["tracks"], last_fetched, is_expired

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
                save_trending_cache()
                return spotify_results, now, False

        if cache_entry["tracks"]:
            logger.warning(f"Spotify {clean_region} fresh chart fetch failed; returning cached tracks.")
            return cache_entry["tracks"], last_fetched, is_expired

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

        # Reject playlists, livestreams, and tracks under 60s (1 min) or over 600s (10 minutes)
        if not duration or duration < 60 or duration > 600:
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
        save_trending_cache()
        return final_results, now, False

    return cache_entry.get("tracks", []), last_fetched, is_expired

async def process_download_task(task_id: str, url: str, title: Optional[str] = None):
    """
    Background worker to execute yt-dlp audio extraction with metadata & artwork embedding.
    Supports resolving YouTube videos from clean metadata (Artist, Title) and embedding high-res ID3 tags.
    Downloads locally to /tmp/music_downloads first, then moves the finished .mp3 to /mnt/cloud_music.
    """
    import shutil
    import urllib.request

    if task_id not in download_tasks:
        return

    task_info = download_tasks[task_id]
    task_info["status"] = "downloading"
    task_info["progress"] = 0

    artist_meta = task_info.get("artist") or ""
    title_meta = task_info.get("title") or title or ""
    album_meta = task_info.get("album") or ""
    cover_meta = task_info.get("cover_url") or ""
    year_meta = task_info.get("year") or ""
    v_id = task_info.get("video_id") or ""

    # If url is not a valid http url, resolve it via YouTube search
    if not url or not (url.startswith("http://") or url.startswith("https://")):
        task_info["status"] = "searching"
        search_query = f"{artist_meta} {title_meta}".strip()
        logger.info(f"Resolving YouTube video for track: '{search_query}'")
        
        # Try targeted search
        match = await fetch_single_yt_track(artist_meta, title_meta, 1)
        if match and match.get("url"):
            url = match["url"]
            v_id = match.get("id") or ""
            task_info["url"] = url
            task_info["video_id"] = v_id
        else:
            raw_res = await search_youtube(f"{search_query} audio oficial", limit=1)
            if not raw_res:
                raw_res = await search_youtube(search_query, limit=1)
            if raw_res and raw_res[0].get("url"):
                url = raw_res[0]["url"]
                v_id = raw_res[0].get("id") or ""
                task_info["url"] = url
                task_info["video_id"] = v_id
            else:
                task_info["status"] = "failed"
                task_info["error"] = f"No se encontró el audio en YouTube para '{search_query}'"
                return

    task_info["status"] = "downloading"
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
        "--geo-bypass",
        "--extractor-args", "youtube:player_client=android,web",
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
                task_info["progress"] = min(percent, 85.0) # Reserve last 15% for cloud move
                task_info["speed"] = speed
                task_info["eta"] = eta

            # Audio extraction destination match
            dest_match = destination_regex.search(line_str)
            if dest_match:
                resulting_temp_filepath = Path(dest_match.group(1).strip())
                task_info["status"] = "converting"

        await process.wait()

        if process.returncode == 0:
            # Locate resulting .mp3 in temp_dir if missing exact path
            if not resulting_temp_filepath or not resulting_temp_filepath.exists():
                mp3s = list(temp_dir.glob("*.mp3"))
                if mp3s:
                    mp3s.sort(key=lambda p: p.stat().st_mtime, reverse=True)
                    resulting_temp_filepath = mp3s[0]

            if resulting_temp_filepath and resulting_temp_filepath.exists():
                # Apply custom Deezer ID3 tags and high-res cover art if available
                if mutagen:
                    try:
                        audio = MP3(str(resulting_temp_filepath), ID3=ID3)
                        try:
                            audio.add_tags()
                        except Exception:
                            pass

                        if title_meta:
                            audio.tags.add(TIT2(encoding=3, text=title_meta))
                        if artist_meta:
                            audio.tags.add(TPE1(encoding=3, text=artist_meta))
                        if album_meta:
                            audio.tags.add(TALB(encoding=3, text=album_meta))
                        if year_meta:
                            audio.tags.add(TYER(encoding=3, text=str(year_meta)))

                        if cover_meta:
                            try:
                                img_req = urllib.request.Request(cover_meta, headers={"User-Agent": "Mozilla/5.0"})
                                with urllib.request.urlopen(img_req, timeout=10) as img_resp:
                                    img_bytes = img_resp.read()
                                    if img_bytes:
                                        audio.tags.delall('APIC')
                                        audio.tags.add(APIC(
                                            encoding=3,
                                            mime='image/jpeg',
                                            type=3,
                                            desc='Cover',
                                            data=img_bytes
                                        ))
                            except Exception as e:
                                logger.warning(f"Failed to embed high-res cover image from {cover_meta}: {e}")

                        audio.save()
                    except Exception as e:
                        logger.error(f"Error embedding ID3 metadata: {e}")

                # Rename cleanly if clean artist and title were provided
                if artist_meta and title_meta:
                    safe_artist = re.sub(r'[\\/*?:"<>|]', "", artist_meta).strip()
                    safe_title = re.sub(r'[\\/*?:"<>|]', "", title_meta).strip()
                    # Extract yt id if present in filename
                    if not v_id:
                        m = re.search(r'\[([a-zA-Z0-9_-]{11})\]\.mp3$', resulting_temp_filepath.name)
                        if m:
                            v_id = m.group(1)
                    suffix_id = f" [{v_id}]" if v_id else ""
                    clean_filename = f"{safe_artist} - {safe_title}{suffix_id}.mp3"
                    clean_dest = resulting_temp_filepath.parent / clean_filename
                    try:
                        resulting_temp_filepath.rename(clean_dest)
                        resulting_temp_filepath = clean_dest
                    except Exception:
                        pass

                filename = resulting_temp_filepath.name
                target_filepath = MUSIC_DIR / filename

                task_info["status"] = "uploading"
                task_info["progress"] = 92.0

                # Move fully prepared .mp3 file to cloud storage
                shutil.move(str(resulting_temp_filepath), str(target_filepath))

                task_info["status"] = "completed"
                task_info["progress"] = 100.0
                task_info["speed"] = "0KiB/s"
                task_info["eta"] = "00:00"
                task_info["filename"] = filename
                try:
                    task_info["size_bytes"] = target_filepath.stat().st_size
                except Exception:
                    task_info["size_bytes"] = 5000000

                # Invalidate library cache so the track displays instantly
                try:
                    from app.services.library_service import invalidate_library_cache
                    invalidate_library_cache()
                except Exception:
                    pass

                # Record track owner in app metadata
                try:
                    from app.services.playlist_service import set_track_owner
                    username = task_info.get("downloaded_by", "invitado")
                    set_track_owner(filename, username)
                except Exception as ex:
                    logger.error(f"Error setting track owner: {ex}")
            else:
                task_info["status"] = "failed"
                task_info["error"] = "No se pudo localizar el archivo MP3 procesado"
        else:
            stderr_out = await process.stderr.read()
            err_msg = stderr_out.decode('utf-8', errors='ignore')
            logger.error(f"Download failed for {task_id}: {err_msg}")
            task_info["status"] = "failed"
            task_info["error"] = err_msg or "yt-dlp exited with error"

    except Exception as e:
        logger.error(f"Exception during download task {task_id}: {e}")
        task_info["status"] = "failed"
        task_info["error"] = str(e)
    finally:
        # Cleanup any leftover temporary files in temp_dir
        try:
            for item in temp_dir.glob("*"):
                if item.is_file():
                    item.unlink(missing_ok=True)
        except Exception:
            pass

def start_download_job(
    url: str,
    title: Optional[str] = None,
    video_id: Optional[str] = None,
    username: str = "invitado",
    artist: Optional[str] = None,
    album: Optional[str] = None,
    cover_url: Optional[str] = None,
    year: Optional[str] = None
) -> str:
    """
    Registers and launches an async download task with owner username and rich metadata tags.
    Returns unique task_id.
    """
    task_id = str(uuid.uuid4())
    download_tasks[task_id] = {
        "task_id": task_id,
        "video_id": video_id or "",
        "url": url,
        "title": title or "Audio YouTube",
        "artist": artist or "",
        "album": album or "",
        "cover_url": cover_url or "",
        "year": year or "",
        "progress": 0.0,
        "speed": "--",
        "eta": "--",
        "status": "queued",
        "error": None,
        "filename": None,
        "downloaded_by": username
    }
    return task_id
