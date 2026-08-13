# Music App Docker - YouTube Music Search, Downloader & Rclone Player

Aplicación web autocontenida para Docker diseñada como buscador, reproductor y gestor de descargas de música desde YouTube, integrada con almacenamiento en la nube montado mediante **Rclone** y enrutamiento de red mediante **WireGuard VPN** (esquema equivalente a *Sherlocaster*).

## 🚀 Características Principales

1. **Buscador interactivo de YouTube**: Integra `yt-dlp` en modo flat-playlist JSON para buscar canciones y artistas sin descargar los vídeos enteros.
2. **Descarga de Audio MP3 a la Nube**:
   - Extrae el audio con la máxima calidad (`--extract-audio --audio-format mp3 --audio-quality 0`).
   - Incrusta metadatos ID3 y carátulas originales (`--embed-thumbnail --add-metadata`).
   - Guarda directamente en `/mnt/cloud_music` (volumen VFS de Rclone).
3. **Reproductor y Streaming con Range Requests**:
   - Endpoint GET `/api/stream/{filename}` con soporte para **HTTP Range Requests** (`206 Partial Content`), permitiendo adelantar/rebobinar sin buffering.
   - Extrae y sirve las carátulas MP3 incrustadas (`APIC` / `covr`) dinámicamente.
   - Reproductor flotante inferior SPA con cola de reproducción, modo aleatorio, repetición y controles de volumen.
4. **Integración con Rclone & Web GUI**:
   - Montaje automático con `--vfs-cache-mode full` para evitar bloqueos de I/O y streaming.
   - Integración con el panel Web GUI oficial de Rclone en el puerto `5572`.
5. **Red & VPN (Anti-Bloqueo IP)**:
   - Configurado con `network_mode: "service:vpn_tunnel"` para redirigir todo el tráfico de salida a través del contenedor WireGuard VPN.
   - Integrado en la red externa `proxy` para servir la app mediante **Nginx Proxy Manager** (ej: `music.example.com`).

---

## 🛠️ Arquitectura de Archivos

```
music/
├── Dockerfile                  # Imagen basada en Python 3.11, ffmpeg, rclone y fuse3
├── docker-compose.yml          # Definición de vpn_tunnel y music_app
├── entrypoint.sh               # Inicio de Rclone Web GUI, montaje VFS y FastAPI
├── requirements.txt            # Dependencias de Python (FastAPI, uvicorn, yt-dlp, mutagen)
├── rclone/                     # Configuración de Rclone (rclone.conf)
├── wg_config/                  # Configuración de WireGuard VPN
└── app/
    ├── main.py                 # FastAPI endpoints (Search, Download, Library, Stream, Rclone)
    ├── config.py               # Variables de entorno y rutas
    ├── services/
    │   ├── ytdlp_service.py    # Búsqueda y tareas en segundo plano de yt-dlp
    │   ├── library_service.py  # Escaneo de archivos y metadatos ID3
    │   └── rclone_service.py   # Control de estado de almacenamiento y remotos
    ├── static/
    │   ├── css/style.css       # Tema oscuro Glassmorphic
    │   └── js/
    │       ├── app.js          # SPA Controller & Búsqueda
    │       ├── player.js       # Reproductor HTML5 & Audio Controller
    │       └── rclone.js       # Gestor de almacenamiento Rclone
    └── templates/
        └── index.html          # Interfaz principal SPA
```

---

## ⚙️ Configuración y Despliegue

### 1. Configurar WireGuard VPN (Opcional pero Recomendado)
Coloca tu archivo de configuración de WireGuard (por ejemplo `wg0.conf`) en la carpeta:
```bash
music/wg_config/wg0.conf
```

### 2. Iniciar el servicio con Docker Compose
```bash
cd /path/to/music
docker compose up -d --build
```

### 3. Configurar Nginx Proxy Manager (NPM)
En tu panel de Nginx Proxy Manager:
- **Domain Name**: `music.example.com`
- **Scheme**: `http`
- **Forward Hostname / IP**: `wg_music_tunnel` (o IP del contenedor `vpn_tunnel`)
- **Forward Port**: `8000`
- Configurar certificado SSL (Let's Encrypt).

---

## 📡 Endpoints de la API REST

| Método | Endpoint | Descripción |
|---|---|---|
| `GET` | `/` | Interfaz Web SPA |
| `GET` | `/api/search?q={query}` | Búsqueda rápida en YouTube (top 5 resultados) |
| `POST` | `/api/download` | Encola la descarga y conversión a MP3 en segundo plano |
| `GET` | `/api/downloads` | Lista las tareas de descarga activas e historial |
| `DELETE` | `/api/downloads/{task_id}` | Limpia una tarea completada |
| `GET` | `/api/library` | Lista las canciones descargadas en `/mnt/cloud_music` |
| `GET` | `/api/library/cover/{filename}`| Extrae la portada ID3 incrustada del MP3 |
| `GET` | `/api/stream/{filename}` | Streaming con soporte HTTP Range (`206 Partial Content`) |
| `DELETE` | `/api/library/{filename}` | Elimina una canción |
| `GET` | `/api/rclone/status` | Estado del punto de montaje y uso de disco |
| `POST` | `/api/rclone/mount` | Monta un remoto de Rclone |
