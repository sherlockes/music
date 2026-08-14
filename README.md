# 🎵 Music Cloud App (v1.4.29)

> **Buscador de Artistas y Discografía, Descargador de YouTube y Reproductor Cloud con Rclone & WireGuard VPN.**

Aplicación web autocontenida (Docker / PWA) diseñada para explorar discografías oficiales vía **Deezer**, escuchar preescuchas de 30s sin anuncios, descargar canciones y álbumes completos en alta calidad MP3 a través de **YouTube**, almacenar la música en la nube con **Rclone** y proteger todas las conexiones salientes mediante **WireGuard VPN**.

---

## ✨ Características Principales

### 🔍 1. Explorador Oficial de Artistas y Discografía (Deezer API)
* **Búsqueda por artista**: Encuentra cualquier artista musical con información de seguidores, álbumes y lanzamientos.
* **Pestañas organizadas**:
  * 🌟 **Top 50 Canciones Populares**: Las canciones más escuchadas del artista.
  * 💿 **Álbumes de Estudio**: Discografía oficial completa.
  * 💽 **Singles y EPs**: Lanzamientos individuales y ediciones especiales.
* **Visualizador de Álbumes**: Despliega el tracklist completo con duración de pistas y botón para **Descargar Álbum Completo** en 1 clic.

### 🎧 2. Preescucha Autónoma y Pausa Inteligente
* **Preescuchas de 30s aisladas**: Reproducción directa desde el navegador sin ensuciar la cola del reproductor principal ni consumir ancho de banda del servidor.
* **Pausa y reanudación automática**: Al abrir la ficha de una canción en el buscador, el reproductor principal se pausa automáticamente y reproduce la muestra; al cerrar la modal, la canción principal se reanuda en el punto exacto.

### 🚀 3. Descarga y Streaming Anti-Bloqueo (YouTube & yt-dlp)
* **Descarga a 320 kbps**: Extracción de audio en segundo plano optimizada con `--extractor-args "youtube:player_client=android,web"` y `--geo-bypass` para evitar bloqueos HTTP 403.
* **Etiquetado ID3 automático (`mutagen`)**: Inserta título oficial, artista, álbum, año y carátula HD (1000x1000) de Deezer directamente en los tags del archivo MP3.
* **Streaming nativo con HTTP Range (`206 Partial Content`)**: Adelanta o rebobina canciones al instante sin tiempos de espera.

### 📱 4. PWA (Progressive Web App) y Modo Offline
* **Instalable en móvil y escritorio**: Soporta modo pantalla completa y controles en la pantalla de bloqueo mediante **MediaSession API**.
* **Almacenamiento Offline IndexedDB**: Guarda canciones y carátulas en la memoria del dispositivo para reproducir sin conexión a internet.

### 👥 5. Gestión Multiusuario y Listas de Reproducción
* Selector de perfiles de usuario locales con persistencia de estado (volumen, posición de reproducción, cola activa).
* Creación, edición y ordenación de listas de reproducción personalizadas.
* Filtrado de la biblioteca por usuario o vista global.
* Herramientas para **exportar e importar copias de seguridad** de la biblioteca y listas en formato JSON.

### 🔒 6. Seguridad & Almacenamiento en la Nube
* **Túnel WireGuard VPN**: Todo el tráfico saliente del backend hacia YouTube, Deezer y servicios externos pasa obligatoriamente por un contenedor WireGuard (`service:vpn_tunnel`), ocultando la IP local del servidor.
* **Montaje Rclone VFS**: Almacena tu biblioteca directamente en Google Drive, OneDrive, Dropbox, SFTP o WebDAV con modo de caché completo (`--vfs-cache-mode full`).

---

## 🛠️ Arquitectura del Proyecto

```
music/
├── Dockerfile                  # Imagen basada en Python 3.11, ffmpeg, rclone y fuse3
├── docker-compose.yml          # Orquestación de WireGuard VPN (vpn_tunnel) y FastAPI (music_app)
├── entrypoint.sh               # Script de inicio, montaje VFS de Rclone y watchdog
├── requirements.txt            # Dependencias Python (FastAPI, uvicorn, yt-dlp, mutagen, etc.)
├── rclone/                     # Configuración de Rclone (rclone.conf)
├── wg_config/                  # Configuración de WireGuard VPN (wg0.conf)
└── app/
    ├── main.py                 # FastAPI API REST, endpoints de Deezer, Streaming y Rclone
    ├── config.py               # Configuración del entorno y rutas de almacenamiento
    ├── services/
    │   ├── deezer_service.py   # Cliente de la API de Deezer (búsqueda, top tracks, álbumes)
    │   ├── ytdlp_service.py    # Búsqueda, extracción y descargas en segundo plano con yt-dlp
    │   ├── library_service.py  # Indexación de archivos MP3 y metadatos ID3
    │   ├── playlist_service.py # Gestión multiusuario y listas de reproducción
    │   └── rclone_service.py   # Control de estado y montaje del volumen cloud
    ├── static/
    │   ├── css/style.css       # Estilos Dark Glassmorphic modernos
    │   ├── js/
    │   │   ├── app.js          # Controlador SPA, buscador Deezer, descargas y modales
    │   │   ├── player.js       # Motor de audio HTML5, cola inteligente y MediaSession
    │   │   └── rclone.js       # Interfaz de monitorización y gestión de Rclone
    │   ├── sw.js               # Service Worker para capacidades PWA y caché offline
    │   └── manifest.json       # Manifiesto PWA
    └── templates/
        └── index.html          # Interfaz de usuario SPA responsiva
```

---

## ⚙️ Despliegue con Docker Compose

### 1. Configuración de WireGuard (Opcional pero Recomendado)
Copia tu archivo de configuración de WireGuard (ej. `wg0.conf`) en la carpeta `wg_config/`:
```bash
cp /ruta/a/tu/wg0.conf ./wg_config/wg0.conf
```

### 2. Iniciar Contenedores
```bash
docker compose up -d --build
```

### 3. Configurar Proxy Inverso (Nginx Proxy Manager)
Para servir la aplicación con certificado SSL HTTPS:
- **Domain Name**: `musica.tu-dominio.com`
- **Scheme**: `http`
- **Forward Hostname / IP**: `wg_music_tunnel` (o la IP del contenedor VPN)
- **Forward Port**: `8000`
- **Websockets Support**: Activado

---

## 📡 Endpoints de la API REST

| Método | Endpoint | Descripción |
|---|---|---|
| `GET` | `/api/music/artists?q={query}` | Búsqueda de artistas en Deezer |
| `GET` | `/api/music/artist/{id}` | Ficha completa del artista (Top 50, álbumes, singles) |
| `GET` | `/api/music/album/{id}` | Tracklist y detalles de un álbum |
| `POST` | `/api/music/download_album` | Encola la descarga de todas las pistas de un álbum |
| `GET` | `/api/stream_yt?v={id_o_query}` | Streaming directo de YouTube mediante proxy por VPN |
| `POST` | `/api/download` | Encola la descarga de una canción individual a la biblioteca |
| `GET` | `/api/downloads` | Consulta el progreso de las tareas de descarga activas |
| `DELETE` | `/api/downloads/{id}` | Limpia o cancela una tarea de descarga |
| `GET` | `/api/library` | Lista las canciones descargadas en `/mnt/cloud_music` |
| `GET` | `/api/library/cover/{filename}`| Extrae la carátula incrustada en el archivo MP3 |
| `GET` | `/api/stream/{filename}` | Streaming con soporte HTTP Range (`206 Partial Content`) |
| `DELETE` | `/api/library/{filename}` | Elimina un archivo de la biblioteca |
| `GET` | `/api/trending` | Éxitos y listas de LOS40 y Spotify |
| `GET` | `/api/rclone/status` | Estado del punto de montaje y almacenamiento |
