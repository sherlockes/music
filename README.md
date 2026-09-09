# 🎵 Music Cloud App (v2.0.6)

> **Buscador de Artistas y Discografía, Descargador de YouTube y Reproductor Cloud con Rclone & WireGuard VPN.**

Aplicación web autocontenida (Docker / PWA) diseñada para explorar discografías oficiales vía **Deezer**, escuchar preescuchas de 30s sin anuncios, descargar canciones y álbumes completos en alta calidad MP3 a través de **YouTube**, almacenar la música en la nube con **Rclone** y proteger todas las conexiones salientes mediante **WireGuard VPN**.

---

## ✨ Novedades de la Versión 2.0 (v2.0.0 – v2.0.6)

* 🔋 **Reproducción Continua en Segundo Plano (Mobile PWA & Screen-Off Fix - v2.0.6)**:
  * **Solución definitiva al corte de ~0.5s**: Corregido el problema crítico por el cual al terminar una canción y auto-avanzar a la siguiente, la reproducción se detenía a los pocos instantes en dispositivos móviles con pantalla apagada o en segundo plano.
  * **Reanudación automática ante pausas involuntarias**: Distinción estricta entre pausas manuales del usuario y pausas forzadas por ahorro de batería del SO o micro-desconexiones de red, manteniendo siempre el estado de reproducción y reintentando la reproducción de forma transparente.
  * **Prioridad absoluta al streaming inicial**: La descarga en caché de la pista finalizada se pospone 12 segundos para no saturar el ancho de banda móvil mientras arranca el nuevo tema. Se evita además la descarga remota de análisis de silencios con la pantalla apagada.
  * **Web Audio optimizado para reproducción continua**: Inicialización del `AudioContext` con `latencyHint: 'playback'` y reconexión automática tras suspensión del sistema.
* 📊 **Ordenación Inteligente por Reproducciones Mensuales («Top mes»)**:
  * Botón interactivo de la estrella en la vista de pistas disponibles con **flechas dinámicas de dirección**:
    * **Flecha hacia abajo (↓)**: Ordena de **más a menos reproducciones** (orden descendente).
    * **Flecha hacia arriba (↑)**: Ordena de **menos a más reproducciones** (orden ascendente).
  * **Alternancia continua (2 estados)**: Cada clic conmuta entre ambas direcciones con retroalimentación inmediata (*toast* informativo).
  * **Ventana móvil estricta de 30 días**: La ordenación se basa exclusivamente en las reproducciones ocurridas en los últimos 30 días (umbral de escucha de 15 segundos o el 50% de la pista).
  * **Sincronización en tiempo real**: Registro cliente-servidor (`/api/track/listen` y `/api/tracks/play_stats`) y distintivo visual (*play badge*) con el número de reproducciones en cada canción.
  * **Reproducción ininterrumpida**: Al ordenar la lista, la pista activa mantiene su reproducción y el índice se recalcula al vuelo sin saltos.
* 🛡️ **Optimización de la Cola de Pistas Disponibles**:
  * Retirada del botón destructivo de vaciado masivo de la lista para evitar pérdidas accidentales de la cola de reproducción.
  * Mantenimiento de la eliminación individual segura pista a pista y botón para guardar la cola actual como lista personalizada.
* ⏱️ **Temporizador de Apagado (Sleep Timer)**:
  * Modal dedicado para programar el apagado automático de la música.
  * Modos flexibles: por minutos predefinidos (30 min, 60 min...), al finalizar la canción en curso (`track_end`) o al completarse la lista (`playlist_end`).
  * **Desvanecimiento progresivo (*soft fade out*)**: Reducción suave del volumen durante los últimos 6 segundos antes de pausar la reproducción.
  * Indicador visual con *badge* activo en la barra inferior del reproductor.
* 🎚️ **Ecualizador Gráfico Web Audio API & Normalización de Volumen**:
  * Procesamiento digital en tiempo real con ecualizador paramétrico y presets de audio (Rock, Pop, Jazz, Clásica, Graves / Bass Boost, Voces).
  * Normalización automática con nodos de dinámica y compresión (`DynamicsCompressorNode` y `GainNode`) para unificar el volumen entre diferentes fuentes de audio.
* 📶 **Modo Solo Caché (Ahorro Extremo de Datos)**:
  * Interruptor para reproducir exclusivamente las pistas almacenadas localmente en la caché del navegador (IndexedDB).
  * Salto inteligente automático que evita consumir datos móviles con pistas no cacheadas.
* ✏️ **Edición de Metadatos de Canción (ID3)**:
  * Modal para modificar título y artista de cualquier pista de la biblioteca directamente desde la interfaz web.
  * Actualización física inmediata de las etiquetas ID3 del archivo MP3 mediante `mutagen` y sincronización en todas las listas de reproducción.
* 🔁 **Sustitución de Versión Alternativa (Replace Version)**:
  * Permite buscar en YouTube versiones alternativas (en directo, acústicas, remasterizadas) de cualquier tema existente.
  * Reemplaza el archivo de audio físico manteniendo las asociaciones en listas, metadatos y enlaces.
* 💾 **Gestión Inteligente de Cuota Cloud (LRU Purge)**:
  * Configuración de límite de almacenamiento en disco/nube (`/api/storage/cloud_settings`).
  * Mecanismo automático de limpieza por antigüedad y frecuencia de escucha (política LRU) para mantener el espacio dentro de la cuota fijada.
  * Opción de forzar la limpieza manual en cualquier momento (`/api/storage/clean_cloud`).

---

<details>
<summary><b>📦 Historial de Versiones Anteriores (v1.5.0)</b></summary>

* 🎛️ **Modal de Pistas Disponibles al 90%**: Visualización panorámica con desenfoque de fondo (`backdrop-blur-md`), carátulas y salto instantáneo de canción.
* 🖼️ **Acceso a Opciones desde la Portada**: Despliegue de la ficha de la canción pulsando en la portada del reproductor.
* 🔁 **Deduplicación Automática y Bucle Continuo**: Eliminación de duplicados previos al añadir pistas y avance en bucle infinito.
* 📱 **Diseño Móvil Ultra-Compacto con Carátula de 56px**: Portada ampliada (`w-14 h-14 rounded-xl`) y controles táctiles optimizados.
* ☁️ **Integración de Rclone en Almacenamiento**: Panel de configuración y sincronización en la nube integrado.
</details>

---

## 🚀 Características Principales

### 🔍 1. Explorador Oficial de Artistas y Discografía (Deezer API)
* **Búsqueda por artista**: Información de seguidores, álbumes y lanzamientos oficiales.
* **Pestañas organizadas**: Top 50 Canciones Populares, Álbumes de Estudio y Singles / EPs.
* **Descarga de Álbum Completo**: Descarga el tracklist completo con un solo clic.

### 🎧 2. Preescucha Autónoma y Pausa Inteligente
* **Muestras de 30s sin anuncios**: Preescucha directa en el navegador sin interferir en la cola principal ni consumir ancho de banda del servidor.
* **Pausa y reanudación automática**: Pausa la música activa al abrir la ficha de una canción y la reanuda en el punto exacto al cerrar la modal.

### ⚡ 3. Descarga y Streaming Anti-Bloqueo (YouTube & yt-dlp)
* **Extracción de audio en alta calidad (320 kbps)**: Descargas en segundo plano con `--extractor-args "youtube:player_client=android,web"` y bypass de restricciones para evitar bloqueos HTTP 403.
* **Etiquetado ID3 automático (`mutagen`)**: Inserta título oficial, artista, álbum, año y carátula HD (1000x1000) de Deezer directamente en los tags del archivo MP3.
* **Streaming nativo con HTTP Range (`206 Partial Content`)**: Adelanta o rebobina canciones al instante sin tiempos de espera ni cortes de socket.

### 🎛️ 4. Reproductor Avanzado con Ecualizador y Temporizador
* **Ecualizador paramétrico Web Audio API**: Presets de audio (Rock, Pop, Jazz, Bass Boost, etc.) y normalización automática de volumen integrada.
* **Temporizador de apagado programable (Sleep Timer)**: Por tiempo fijo o condicional (fin de canción / fin de lista) con *soft fade out*.
* **Ordenación mensual inteligente («Top mes»)**: Alternancia bidireccional continua (más a menos ↓ / menos a más ↑) basada en los últimos 30 días con badges numéricos de reproducción.

### 📱 5. PWA (Progressive Web App) y Modo Solo Caché
* **Instalable en móvil y escritorio**: Integración con pantalla de bloqueo y controles del sistema (**MediaSession API**).
* **Modo Offline & Modo Solo Caché**: Reproducción local mediante IndexedDB sin conexión o para evitar consumo de datos móviles con salto inteligente.

### ✏️ 6. Edición ID3 y Sustitución de Versiones
* **Editor de metadatos**: Modificación directa de título y artista con actualización física en las etiquetas ID3 del archivo MP3.
* **Reemplazo de versión**: Búsqueda y sustitución directa por versiones alternativas en YouTube sin perder enlaces en listas.

### 👥 7. Gestión Multiusuario y Listas de Reproducción
* Perfiles de usuario independientes con persistencia automática de sesión (cola, posición de reproducción, modos aleatorio/repetición y orden).
* Creación, edición, importación y exportación de listas de reproducción en formato JSON.

### 🔒 8. Seguridad & Almacenamiento en la Nube con Purga LRU
* **Túnel WireGuard VPN**: Todo el tráfico saliente hacia YouTube y servicios externos pasa obligatoriamente por un contenedor WireGuard (`service:vpn_tunnel`), ocultando la IP local.
* **Montaje Rclone VFS & Cuota Inteligente**: Conexión con Google Drive, OneDrive, Dropbox, SFTP o WebDAV con caché completa y purga automática de espacio por política LRU.

---

## 🛠️ Arquitectura del Proyecto

```
music/
├── Dockerfile                  # Imagen basada en Python 3.11, ffmpeg, rclone y fuse3
├── docker-compose.yml          # Orquestación de WireGuard VPN (vpn_tunnel) y FastAPI (music_app)
├── entrypoint.sh               # Script de inicio, montaje VFS de Rclone y auto-montaje
├── requirements.txt            # Dependencias Python (FastAPI, uvicorn, yt-dlp, mutagen, etc.)
├── rclone/                     # Configuración de Rclone (rclone.conf)
├── wg_config/                  # Configuración de WireGuard VPN (wg0.conf)
└── app/
    ├── main.py                 # FastAPI API REST, endpoints de Deezer, Streaming y Rclone
    ├── config.py               # Configuración del entorno y rutas de almacenamiento
    ├── services/
    │   ├── deezer_service.py   # Cliente de la API de Deezer (búsqueda, top tracks, álbumes)
    │   ├── ytdlp_service.py    # Búsqueda, extracción y descargas en segundo plano con yt-dlp
    │   ├── library_service.py  # Indexación de archivos MP3, metadatos ID3 y tags físicos
    │   ├── playlist_service.py # Listas de reproducción, usuarios, histórico y cuota cloud
    │   └── rclone_service.py   # Control de estado y montaje del volumen cloud
    ├── static/
    │   ├── css/style.css       # Estilos Dark Glassmorphic modernos
    │   ├── js/
    │   │   ├── app.js          # Controlador SPA, buscador, edición ID3 y modales
    │   │   ├── player.js       # Motor de audio Web Audio API, EQ, temporizador y cola inteligente
    │   │   └── rclone.js       # Monitorización y gestión de Rclone
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
| `PUT` | `/api/library/{filename}` | Actualiza metadatos ID3 (título y artista) de un archivo MP3 |
| `DELETE` | `/api/library/{filename}` | Elimina un archivo de la biblioteca |
| `GET` | `/api/trending` | Éxitos y listas de LOS40 y Spotify |
| `POST` | `/api/track/listen` | Registra una reproducción de una pista para el ranking mensual |
| `GET` | `/api/tracks/play_stats` | Consulta el conteo de reproducciones de los últimos 30 días |
| `GET` | `/api/storage/cloud_settings` | Consulta la cuota máxima de almacenamiento y uso actual |
| `POST` | `/api/storage/cloud_settings` | Guarda la cuota de almacenamiento y aplica purga LRU si es necesario |
| `POST` | `/api/storage/clean_cloud` | Fuerza la limpieza manual de almacenamiento bajo la política LRU |
| `GET` | `/api/rclone/status` | Estado del punto de montaje y almacenamiento cloud |
| `POST` | `/api/rclone/config` | Guarda configuración de `rclone.conf` |
| `POST` | `/api/rclone/mount` | Monta el volumen de Rclone en `/mnt/cloud_music` |
| `POST` | `/api/rclone/unmount` | Desmonta el volumen de Rclone |
| `GET` | `/api/user/state` | Recupera el estado guardado del usuario |
| `POST` | `/api/user/state` | Guarda el estado actual del reproductor y sesión |
