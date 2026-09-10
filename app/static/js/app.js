/**
 * Main Application Controller for Music App SPA (Mobile Responsive Header & Read-only NPM Identity with Re-auth)
 */
class MusicApp {
    constructor() {
        this.currentTab = 'playlists';
        this.libraryTracks = [];
        this.playlists = [];
        this.currentUser = 'invitado';
        this.userFilter = 'all';
        this.librarySort = localStorage.getItem('music_app_library_sort') || 'recent';
        if (!['recent', 'artist', 'title'].includes(this.librarySort)) {
            this.librarySort = 'recent';
        }
        this.trendingRegion = 'los40';
        this.selectedTrackForPlaylist = null;
        this.editingPlaylistId = null;
        this.editingTracks = [];
        this.selectedEditTrackIndex = null;
        this.selectedModalTrack = null;
        this.selectedModalTrackRank = null;
        this.selectedModalTrackContext = null;
        this.currentArtistData = null;
        this.currentArtistTab = 'top';
        this.currentAlbumData = null;
        this.standalonePreview = new Audio();
        this.wasMainPlayerPlayingBeforeModal = false;
        this.modalPreviewEnabled = localStorage.getItem('music_app_modal_preview') !== 'false';
        this.deezerPreviewCache = {};
        this._modalPreviewSeq = 0;
        this.pollInterval = null;
        this.artistCache = new Map();
        this.albumCache = new Map();
        this.searchCache = new Map();
        this.storageManager = new StorageManager(this);
        this.countedTasks = new Set();
        this.isInitialDownloadPoll = true;
        this.init();
    }

    setStartupStatus(message, percent) {
        const textEl = document.getElementById('startup-status-text');
        const barEl = document.getElementById('startup-progress-bar');
        if (textEl) textEl.textContent = message;
        if (barEl) barEl.style.width = `${percent}%`;
    }

    hideStartupOverlay() {
        const overlay = document.getElementById('app-startup-overlay');
        if (overlay) {
            this.setStartupStatus('¡Todo listo!', 100);
            setTimeout(() => {
                overlay.classList.add('opacity-0', 'pointer-events-none');
                setTimeout(() => overlay.remove(), 400);
            }, 300);
        }
    }

    async init() {
        this.bindNavigation();
        this.bindSearch();
        this.initLibrarySort();
        this.initPwa();

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeSongModal();
            }
        });

        const withTimeout = (promise, ms) => Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout de inicio')), ms))
        ]).catch(err => console.warn('Paso de inicio omitido/agotado:', err));

        try {
            this.setStartupStatus('Conectando con el servidor VPS (NPM)...', 20);
            await withTimeout(this.fetchUserMe(), 4000);

            // Restore user state from local cache instantly to prevent delay/duplicate network calls
            this.loadLocalUserState();

            this.setStartupStatus('Cargando tu biblioteca de música...', 50);
            await withTimeout(this.loadLibrary(), 15000);

            this.setStartupStatus('Cargando tus listas de reproducción...', 75);
            await withTimeout(this.loadPlaylists(), 10000);
            await withTimeout(this.loadSettingsView(), 4000);

            this.startDownloadPolling();

            // Always ensure the active tab view has its data displayed
            if (this.currentTab === 'trending') {
                if (!this.currentTrendingResults || this.currentTrendingResults.length === 0) {
                    this.loadTrending();
                } else {
                    this.renderTrendingResults(this.currentTrendingResults);
                }
            } else if (this.currentTab === 'playlists') {
                this.renderPlaylistsGrid();
            } else if (this.currentTab === 'library') {
                this.applyLibraryFilters();
            }

            this.setStartupStatus('Restaurando tu sesión de reproducción...', 90);
            await withTimeout(this.loadUserState(), 4000);

            this.startAutoStateSave();
            if (window.player && window.player.isSortByMonthlyPlays && window.player.playlist && window.player.playlist.length > 1) {
                window.player.sortByMonthlyPlays(false);
            }
        } catch (err) {
            console.error("Error during app startup init:", err);
        } finally {
            this.hideStartupOverlay();
        }
    }

    initPwa() {
        // Forcefully purge any cached PWA install button from the DOM
        const purgeInstallButtons = () => {
            const btnMob = document.getElementById('pwa-install-btn-mobile');
            if (btnMob) btnMob.remove();
            const btnDesk = document.getElementById('pwa-install-btn-desktop');
            if (btnDesk) btnDesk.remove();
            document.querySelectorAll('button').forEach(btn => {
                if (btn.textContent && btn.textContent.includes('Instalar App')) {
                    btn.remove();
                }
            });
        };
        purgeInstallButtons();
        document.addEventListener('DOMContentLoaded', purgeInstallButtons);

        if ('serviceWorker' in navigator) {
            let refreshing = false;
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                if (refreshing) return;
                // If user is currently playing music, do not abruptly interrupt playback
                if (window.app && window.app.player && window.app.player.isPlaying) {
                    console.log('[PWA] Service Worker updated while playing music; reload deferred until idle.');
                    return;
                }
                refreshing = true;
                console.log('[PWA] Service Worker controller changed, reloading to apply latest update...');
                window.location.reload();
            });

            navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(reg => {
                console.log('PWA Service Worker registered on scope /');
                reg.update().catch(() => {});
            }).catch(err => {
                console.debug('Service worker registration error/skipped:', err);
            });
        }
    }

    showPwaInstallButton() {
        const btnMob = document.getElementById('pwa-install-btn-mobile');
        if (btnMob) btnMob.remove();
        const btnDesk = document.getElementById('pwa-install-btn-desktop');
        if (btnDesk) btnDesk.remove();
    }

    hidePwaInstallButton() {
        const btnMob = document.getElementById('pwa-install-btn-mobile');
        if (btnMob) btnMob.remove();
        const btnDesk = document.getElementById('pwa-install-btn-desktop');
        if (btnDesk) btnDesk.remove();
    }

    async installPwa() {
        if (this.deferredPwaPrompt) {
            this.deferredPwaPrompt.prompt();
            const { outcome } = await this.deferredPwaPrompt.userChoice;
            if (outcome === 'accepted') {
                this.showToast('¡Gracias por instalar MusicApp!');
            }
            this.deferredPwaPrompt = null;
        } else {
            const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
            if (isStandalone) {
                this.showToast('¡La aplicación ya está instalada!');
            } else {
                const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
                if (isIOS) {
                    alert("Para instalar en tu iPhone/iPad:\n\n1. Toca el botón 'Compartir' (icono de flecha hacia arriba ⎋) en Safari.\n2. Selecciona 'Añadir a la pantalla de inicio' ➕.");
                } else {
                    alert("Para instalar en tu dispositivo:\n\n1. Abre el menú del navegador (los 3 puntos ⋮ arriba a la derecha).\n2. Toca en 'Instalar aplicación' o 'Añadir a pantalla de inicio'.");
                }
            }
        }
    }

    getLibraryTrackForItem(item) {
        if (!item) return null;
        if (item.filename && this.libraryTracks) {
            const found = this.libraryTracks.find(t => t && t.filename === item.filename);
            if (found) return found;
        }
        if (!this.libraryTracks || this.libraryTracks.length === 0) return null;

        const itemId = String(item.id || '');
        const itemTitleRaw = String(item.title || '');
        const itemTitleClean = itemTitleRaw.toLowerCase().replace(/[^a-z0-9áéíóúñ]/gi, '');

        return this.libraryTracks.find(track => {
            if (!track) return false;
            const fn = String(track.filename || '');
            const trackTitleRaw = String(track.title || fn.replace(/\.(mp3|m4a|flac|wav|webm)$/i, ''));
            const trackTitleClean = trackTitleRaw.toLowerCase().replace(/[^a-z0-9áéíóúñ]/gi, '');

            // 1. Match by YouTube Video ID in filename (e.g. "... [videoId].mp3")
            if (itemId && itemId.length >= 5 && fn.includes(itemId)) {
                return true;
            }

            // 2. Exact or clean title match
            if (itemTitleClean.length >= 4 && trackTitleClean.length >= 4) {
                if (itemTitleClean === trackTitleClean) {
                    return true;
                }
                // Check string containment for longer titles (> 8 chars)
                if (itemTitleClean.length > 8 && trackTitleClean.length > 8) {
                    if (itemTitleClean.includes(trackTitleClean) || trackTitleClean.includes(itemTitleClean)) {
                        return true;
                    }
                }
            }

            return false;
        }) || null;
    }

    isItemInLibrary(item) {
        if (item && item.filename) return true;
        return !!this.getLibraryTrackForItem(item);
    }

    getTrackCoverUrl(track) {
        if (!track) return 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="%238b5cf6" stroke-width="1.5"><rect width="18" height="18" x="3" y="3" rx="2" fill="%231e1b4b"/><circle cx="12" cy="12" r="4"/><polygon points="10 10 15 12 10 14 10 10"/></svg>';
        if (track.thumbnail) return track.thumbnail;
        if (track.has_cover && track.filename) return `/api/library/cover/${encodeURIComponent(track.filename)}`;
        if (track.filename) return `/api/library/cover/${encodeURIComponent(track.filename)}`;
        return 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300';
    }

    parseSongInfo(item) {
        if (!item) return { title: 'Canción desconocida', artist: 'Desconocido' };

        let rawTitle = item.title || item.filename || '';
        let rawArtist = item.artist || '';
        let rawChannel = item.channel || '';

        // 1. Remove file extensions and YouTube video ID in brackets
        let cleanTitle = rawTitle.replace(/\.(mp3|m4a|flac|wav|webm|ogg)$/i, '').trim();
        cleanTitle = cleanTitle.replace(/\s*\[[a-zA-Z0-9_-]{11}\]$/, '').trim();

        // 2. Remove leading rank numbers (#1, 1. , 01 - , etc.) but preserve numbers in titles (20 de abril, 19 días...)
        cleanTitle = cleanTitle.replace(/^(?:#\d+|\d+[\.\-:])\s*/, '').trim();

        // 3. Remove noise video/audio tags
        const noiseRegex = /\s*[\(\[\{]\s*(?:official\s+)?(?:music\s+)?video(?:clip)?(?:\s+oficial)?\s*[\)\]\}]|\s*[\(\[\{]\s*(?:video|audio|videoclip|clip)\s+oficial\s*[\)\]\}]|\s*[\(\[\{]\s*official\s+(?:audio|lyric\s+video|lyrics?|visualizer|video)\s*[\)\]\}]|\s*[\(\[\{]\s*(?:audio|visualizer|lyric\s+video|lyrics?|letra|letra\/lyric)\s*[\)\]\}]|\s*[\(\[\{]\s*(?:en\s+vivo|en\s+directo|live|remaster(?:ed)?(?:\s+\d+)?|4k|hd|hq|full\s+hd|mv)\s*[\)\]\}]|\s*[\(\[\{]\s*(?:oficial\s+concept|concept\s+lyrics?|concept\s+\d{4}|estreno\s+\d{4}|novedad(?:\s+\d{4})?)\s*[\)\]\}]|\s*\|\s*(?:concept\s+\d{4}|concept\s+lyrics?|estreno\s+\d{4}|letra|lyrics?|video\s+oficial|audio\s+oficial|oficial|official|hd|4k|mv|premiere\s+\d{4}).*$/gi;
        cleanTitle = cleanTitle.replace(noiseRegex, '').trim();

        // 4. Clean channel name if generic
        const genericSet = new Set(['los40 españa', 'spotify top españa', 'spotify top global', 'pop rock español (1985-2000)', 'pop rock español', 'top hits', 'youtube', 'desconocido', 'comunidad', 'various artists', 'varios artistas']);
        let cleanChannel = rawChannel.trim();
        if (genericSet.has(cleanChannel.toLowerCase())) {
            cleanChannel = '';
        } else {
            cleanChannel = cleanChannel.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/\s+Official$/i, '').replace(/\s+Oficial$/i, '').trim();
        }

        let cleanArtist = rawArtist.trim();
        if (genericSet.has(cleanArtist.toLowerCase())) {
            cleanArtist = '';
        }

        // 5. Handle pipe separators '|' (e.g. 'LA GRACIOSA - Quevedo ft. Elvis Crespo | EL BAIFO' or 'DESPUES DE TI | Kapo, Feid')
        if (cleanTitle.includes(' | ')) {
            const pipeParts = cleanTitle.split(' | ').map(p => p.trim()).filter(Boolean);
            if (pipeParts.length === 2) {
                const p0 = pipeParts[0];
                const p1 = pipeParts[1];
                if (p0.includes(' - ') || p0.includes(' – ') || p0.includes(' — ')) {
                    cleanTitle = p0; // Tag/album after pipe discarded
                } else if (cleanChannel && p1.toLowerCase().includes(cleanChannel.toLowerCase())) {
                    cleanTitle = p0;
                    if (!cleanArtist) cleanArtist = p1;
                } else if (/feat|ft\.|&|\by\b|\bx\b|,/i.test(p1)) {
                    cleanTitle = p0;
                    if (!cleanArtist) cleanArtist = p1;
                } else {
                    cleanTitle = p0;
                }
            }
        }

        let parsedTitle = cleanTitle;
        let parsedArtist = cleanArtist;

        // 6. Detect separator "Artist - Title" vs "Title - Artist"
        const sepMatch = cleanTitle.match(/\s+[-–—]\s+/);
        if (sepMatch) {
            const parts = cleanTitle.split(/\s+[-–—]\s+/);
            const left = parts[0].trim();
            let right = parts.slice(1).join(' - ').trim();

            right = right.replace(/^["'«](.*)["'»]$/, '$1').trim();
            right = right.replace(noiseRegex, '').trim();

            // Determine if right is artist or left is artist
            let rightIsArtist = false;
            let leftIsArtist = false;

            if (cleanChannel) {
                const cLow = cleanChannel.toLowerCase();
                if (right.toLowerCase().includes(cLow) && !left.toLowerCase().includes(cLow)) {
                    rightIsArtist = true;
                } else if (left.toLowerCase().includes(cLow) && !right.toLowerCase().includes(cLow)) {
                    leftIsArtist = true;
                }
            }

            if (!rightIsArtist && !leftIsArtist) {
                const featRegex = /\b(?:ft\.?|feat\.?|featuring)\b/i;
                const featRight = featRegex.test(right);
                const featLeft = featRegex.test(left);
                if (featRight && !featLeft) {
                    rightIsArtist = true;
                } else if (featLeft && !featRight) {
                    leftIsArtist = true;
                }
            }

            if (rightIsArtist) {
                parsedTitle = left;
                parsedArtist = right;
            } else {
                parsedTitle = right;
                parsedArtist = left;
            }
        } else {
            parsedTitle = cleanTitle;
            parsedArtist = cleanArtist || cleanChannel || 'Desconocido';
        }

        if (cleanArtist) {
            parsedArtist = cleanArtist;
        }

        parsedTitle = parsedTitle.replace(/^["'«](.*)["'»]$/, '$1').trim();

        return {
            title: parsedTitle || 'Canción',
            artist: parsedArtist || 'Desconocido'
        };
    }

    toStandardPlayerTrack(track) {
        if (!track) return null;
        const libTrack = this.getLibraryTrackForItem(track);
        const t = libTrack || track;
        const { title, artist } = this.parseSongInfo(t);

        if (libTrack || track.filename) {
            return {
                filename: t.filename,
                title: title,
                artist: artist,
                has_cover: t.has_cover,
                thumbnail: t.has_cover ? `/api/library/cover/${encodeURIComponent(t.filename)}` : (t.thumbnail || null),
                duration_string: t.duration_string || '',
                size_bytes: t.size_bytes || 0,
                size_formatted: t.size_formatted || '',
                downloaded_by: t.downloaded_by || ''
            };
        } else {
            const ytQuery = `${artist} ${title}`.trim();
            const rawId = track.video_id || track.id || (track.url && track.url.match(/[?&]v=([^&]+)/) ? track.url.match(/[?&]v=([^&]+)/)[1] : '') || ytQuery;
            return {
                id: rawId,
                title: title,
                artist: artist,
                channel: artist,
                album: track.album || '',
                thumbnail: track.cover_xl || track.cover || track.cover_medium || track.thumbnail || '',
                duration_string: track.duration_string || '',
                url: track.url || (rawId && rawId.length === 11 ? `https://youtube.com/watch?v=${rawId}` : ''),
                is_yt: true,
                is_trending: !!track.is_trending,
                trending_source: track.trending_source || ''
            };
        }
    }

    // Helper fetch to send same-origin credentials for NPM authentication with optional timeout
    async customFetch(url, options = {}, timeoutMs = 25000) {
        options.credentials = 'same-origin';
        if (timeoutMs > 0 && !options.signal) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            options.signal = controller.signal;
            try {
                const res = await fetch(url, options);
                clearTimeout(timer);
                return res;
            } catch (err) {
                clearTimeout(timer);
                throw err;
            }
        }
        return fetch(url, options);
    }

    async fetchUserMe() {
        try {
            const res = await this.customFetch('/api/user/me');
            if (res.ok) {
                const data = await res.json();
                this.currentUser = data.username || 'invitado';
                const elBadge = document.getElementById('user-badge-name');
                if (elBadge) elBadge.innerText = this.currentUser;
            }
        } catch (err) {
            console.debug("Error fetching user identity:", err);
        }
    }

    // Force browser to flush HTTP Basic Auth cache & request new NPM login credentials
    logoutAndSwitchUser() {
        if (confirm(`¿Deseas cambiar de usuario en la lista de acceso de NPM?\n\n(Usuario actual: ${this.currentUser})`)) {
            const xhr = new XMLHttpRequest();
            xhr.open("GET", "/api/logout", true, "logout", "logout");
            xhr.send();
            xhr.onreadystatechange = () => {
                if (xhr.readyState === 4) {
                    window.location.reload();
                }
            };
        }
    }

    bindNavigation() {
        const tabs = document.querySelectorAll('[data-tab]');
        tabs.forEach(tab => {
            tab.addEventListener('click', (e) => {
                const targetTab = tab.getAttribute('data-tab');
                if (targetTab) this.switchTab(targetTab);
            });
        });
    }

    toggleMobileMenu() {
        const dropdown = document.getElementById('mobile-menu-dropdown');
        if (dropdown) {
            dropdown.classList.toggle('hidden');
        }
    }

    selectMobileTab(tabName) {
        this.switchTab(tabName);
        const dropdown = document.getElementById('mobile-menu-dropdown');
        if (dropdown) {
            dropdown.classList.add('hidden');
        }
    }

    switchTab(tabName, triggerLoad = true) {
        if (tabName === 'rclone' || tabName === 'storage') {
            tabName = 'settings';
        }
        this.currentTab = tabName;

        // Update desktop & mobile active tab styling
        document.querySelectorAll('[data-tab]').forEach(tab => {
            const attr = tab.getAttribute('data-tab');
            const isActive = attr === tabName || (tabName === 'settings' && attr === 'storage');
            if (tab.classList.contains('nav-tab')) {
                tab.classList.toggle('active', isActive);
            } else if (tab.classList.contains('mobile-nav-item')) {
                tab.classList.toggle('bg-purple-950/80', isActive);
                tab.classList.toggle('text-purple-300', isActive);
            }
        });

        document.querySelectorAll('.tab-view').forEach(view => {
            view.classList.add('hidden');
        });

        const targetView = document.getElementById(`view-${tabName}`) || document.getElementById('view-settings');
        if (targetView) targetView.classList.remove('hidden');

        if (triggerLoad) {
            if (tabName === 'library') {
                this.loadLibrary();
            } else if (tabName === 'trending') {
                this.loadTrending();
            } else if (tabName === 'playlists') {
                this.loadPlaylists();
            } else if (tabName === 'downloads') {
                this.pollDownloads();
            } else if (tabName === 'settings') {
                this.loadSettingsView();
                if (window.rcloneMgr) {
                    window.rcloneMgr.fetchStatus();
                }
            }
        }

        this.saveUserState();
    }

    getLocalUserState() {
        try {
            const key = `music_app_user_state_${this.currentUser || 'invitado'}`;
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (e) {
            console.debug("Error reading local user state:", e);
            return null;
        }
    }

    setLocalUserState(state) {
        try {
            const key = `music_app_user_state_${this.currentUser || 'invitado'}`;
            localStorage.setItem(key, JSON.stringify(state));
        } catch (e) {
            console.debug("Error writing local user state:", e);
        }
    }

    applyStateToUI(state) {
        if (!state || typeof state !== 'object') return;

        // Restore Search tab state
        if (state.last_search_query) {
            this.lastSearchQuery = state.last_search_query;
            const searchInput = document.getElementById('search-input');
            if (searchInput) searchInput.value = this.lastSearchQuery;
        }
        if (state.last_artist_data) {
            this.currentArtistData = state.last_artist_data;
            if (this.currentTab === 'search') {
                const artistsContainer = document.getElementById('search-artists-container');
                const profileContainer = document.getElementById('artist-profile-view');
                if (artistsContainer) artistsContainer.classList.add('hidden');
                if (profileContainer) profileContainer.classList.remove('hidden');
                this.renderArtistProfile(this.currentArtistData);
            }
        } else if (state.last_search_results && Array.isArray(state.last_search_results) && state.last_search_results.length > 0) {
            this.lastSearchResults = state.last_search_results;
            if (this.currentTab === 'search') {
                this.renderArtistSearchResults(this.lastSearchResults);
            }
        }

        // Restore Trending tab state
        if (state.last_trending_region) {
            this.trendingRegion = state.last_trending_region;
            const selectEl = document.getElementById('trending-region-select');
            if (selectEl) selectEl.value = this.trendingRegion;
        }
        if (state.last_trending_results && Array.isArray(state.last_trending_results) && state.last_trending_results.length > 0) {
            this.currentTrendingResults = state.last_trending_results;
            if (this.currentTab === 'trending') {
                this.renderTrendingResults(this.currentTrendingResults);
            }
        }

        // Restore Player state
        if (state.last_player_state && window.player) {
            window.player.restoreState(state.last_player_state);
        }

        // Restore active Tab
        if (state.last_tab) {
            this.switchTab(state.last_tab, false);
        } else {
            this.switchTab('playlists', false);
        }
    }

    loadLocalUserState() {
        const localState = this.getLocalUserState();
        if (localState) {
            console.log("[StateSync] Restoring state instantly from local cache timestamp:", localState.updated_at);
            this.applyStateToUI(localState);
        }
    }

    async loadUserState() {
        const localState = this.getLocalUserState();

        // 1. Instantly apply local cache if present
        if (localState) {
            this.applyStateToUI(localState);
        }

        // 2. Fetch server state to compare timestamps for multi-device sync
        try {
            const res = await this.customFetch(`/api/user/state?username=${encodeURIComponent(this.currentUser)}`);
            if (!res.ok) return;
            const serverState = await res.json();
            if (!serverState || Object.keys(serverState).length === 0) {
                if (localState) {
                    this.syncStateToServer(localState);
                }
                return;
            }

            const serverTime = typeof serverState.updated_at === 'number' ? serverState.updated_at : 0;
            const localTime = (localState && typeof localState.updated_at === 'number') ? localState.updated_at : 0;

            if (serverTime > localTime) {
                console.log(`[StateSync] Server state is newer (${serverTime} > ${localTime}). Updating UI and local cache.`);
                this.applyStateToUI(serverState);
                this.setLocalUserState(serverState);
            } else if (localTime > serverTime) {
                console.log(`[StateSync] Local state is newer (${localTime} > ${serverTime}). Uploading local state to server.`);
                this.syncStateToServer(localState);
            } else if (!localState) {
                console.log("[StateSync] Applying server state for new session.");
                this.applyStateToUI(serverState);
                this.setLocalUserState(serverState);
            }
        } catch (err) {
            console.debug("[StateSync] Server state fetch failed/offline, using local state:", err);
        }
    }

    saveUserState(forceServer = false) {
        try {
            const payload = {
                last_tab: this.currentTab || 'playlists',
                last_player_state: window.player ? window.player.getState() : null,
                last_search_query: this.lastSearchQuery || '',
                last_search_results: this.lastSearchResults || [],
                last_artist_id: this.currentArtistData && this.currentArtistData.artist ? this.currentArtistData.artist.id : null,
                last_artist_data: this.currentArtistData || null,
                last_trending_region: this.trendingRegion || 'los40',
                last_trending_results: this.currentTrendingResults || [],
                updated_at: Date.now()
            };

            // "Es importante que lo último en guardarse sea la info en la caché para que siempre sea la más reciente."
            this.setLocalUserState(payload);

            if (this._saveStateTimer) clearTimeout(this._saveStateTimer);

            if (forceServer) {
                this.syncStateToServer(payload);
            } else {
                this._saveStateTimer = setTimeout(() => {
                    this.syncStateToServer(payload);
                }, 1000);
            }
        } catch (err) {
            console.debug("Error saving user state:", err);
        }
    }

    async syncStateToServer(payload, force = false) {
        if (document.hidden && !force) return;
        try {
            await this.customFetch(`/api/user/state?username=${encodeURIComponent(this.currentUser)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        } catch (err) {
            console.debug("Error syncing user state to server:", err);
        }
    }

    startAutoStateSave() {
        window.addEventListener('beforeunload', () => this.saveUserState(true));
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                this.saveUserState(true);
            } else if (document.visibilityState === 'visible') {
                this.pollDownloads();
            }
        });
        setInterval(() => {
            if (document.hidden) return;
            this.saveUserState();
        }, 10000);
    }

    setTrendingRegion(regionVal) {
        this.trendingRegion = regionVal;
        this.loadTrending(false, true);
    }

    async loadTrending(forceRefresh = false, regionChanged = false) {
        // If saved results exist and user didn't ask for force refresh or region change, display saved
        if (!forceRefresh && !regionChanged && this.currentTrendingResults && this.currentTrendingResults.length > 0) {
            this.renderTrendingResults(this.currentTrendingResults);
            return;
        }

        const container = document.getElementById('trending-tracks');
        if (!container) return;

        container.innerHTML = `
            <div class="glass-card p-10 sm:p-14 text-center flex flex-col items-center justify-center space-y-4 my-2">
                <div class="relative w-14 h-14 sm:w-16 sm:h-16 flex items-center justify-center">
                    <div class="absolute inset-0 rounded-full border-4 border-orange-500/20 border-t-orange-500 border-r-amber-500 animate-spin"></div>
                    <span class="text-xl animate-bounce">🔥</span>
                </div>
                <div>
                    <p class="text-sm sm:text-base font-semibold text-orange-200">Buscando éxitos en tendencia...</p>
                    <p class="text-xs text-slate-400 mt-1">Obteniendo los sencillos más escuchados</p>
                </div>
            </div>
        `;

        const playBtn = document.getElementById('trending-play-all-btn');
        if (playBtn) {
            playBtn.disabled = true;
            playBtn.classList.add('opacity-40', 'cursor-not-allowed');
        }

        try {
            const res = await this.customFetch(`/api/trending?region=${this.trendingRegion}&limit=40&refresh=${forceRefresh ? 'true' : 'false'}`, {}, 45000);
            if (!res.ok) throw new Error("Error cargando tendencias");
            const data = await res.json();
            
            // Update refresh button visibility (only show if list is > 1 week old / expired on Monday)
            const refreshBtn = document.getElementById('trending-refresh-btn');
            if (refreshBtn) {
                if (data.can_refresh) {
                    refreshBtn.classList.remove('hidden');
                    refreshBtn.classList.add('flex');
                } else {
                    refreshBtn.classList.add('hidden');
                    refreshBtn.classList.remove('flex');
                }
            }

            let results = data.results || [];

            // Filter out playlists (00:00 / no duration), clips under 60s (1 minute) or over 600s (10 minutes)
            results = results.filter(item => item.duration && item.duration >= 60 && item.duration <= 600);

            // Exception: For official chart lists (LOS40, Spotify Top & Pop Rock Español), show all tracks but disable download button for library tracks
            if (!['los40', 'spotify_es', 'spotify_global', 'pop_rock_es'].includes(this.trendingRegion)) {
                results = results.filter(item => !this.isItemInLibrary(item));
            }

            // Store current trending results for Reproducir Todas
            this.currentTrendingResults = results;
            this.renderTrendingResults(results);
            this.saveUserState();
        } catch (err) {
            console.error("Failed to load trending:", err);
            container.innerHTML = `
                <div class="glass-card p-6 text-center text-red-400">
                    <p class="font-medium">Ocurrió un error al obtener canciones en tendencia.</p>
                </div>
            `;
        }
    }

    renderTrendingResults(results) {
        const container = document.getElementById('trending-tracks');
        if (!container) return;

        if (!results || results.length === 0) {
            container.innerHTML = `
                <div class="glass-card p-8 text-center text-gray-400">
                    <p class="text-lg font-medium">No hay canciones nuevas en tendencias.</p>
                    <p class="text-xs text-slate-500 mt-1">Las canciones en tendencia encontradas ya están en tu biblioteca.</p>
                </div>
            `;
            return;
        }

        container.innerHTML = results.map((item, idx) => {
            const { title, artist } = this.parseSongInfo(item);
            const coverUrl = item.thumbnail || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300';
            return `
            <div class="glass-card p-3 flex items-center gap-3.5 group hover:border-orange-500/40 hover:bg-white/[0.04] transition duration-200 cursor-pointer active:scale-[0.99]"
                 onclick="window.app.openSongModalByContext('trending', ${idx})"
                 onmouseenter="window.app.preloadYtTrack('${item.id}')"
                 ontouchstart="window.app.preloadYtTrack('${item.id}')">
                <!-- Rank Badge & Thumbnail -->
                <div class="relative w-14 h-14 sm:w-16 sm:h-16 rounded-xl overflow-hidden flex-shrink-0 bg-slate-950 shadow-md border border-white/5">
                    <img src="${coverUrl}" 
                         alt="${this.escapeHtml(title)}" 
                         class="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                         loading="lazy" />
                    <span class="absolute top-1 left-1 px-1.5 py-0.5 bg-orange-600/90 backdrop-blur-xs text-white text-[10px] font-extrabold rounded shadow">
                        #${idx + 1}
                    </span>
                    <span class="absolute bottom-0.5 right-0.5 px-1 py-0.2 bg-black/80 text-[9px] font-mono text-white/90 rounded">
                        ${item.duration_string || ''}
                    </span>
                </div>

                <!-- Right Title & Artist (1 line each) -->
                <div class="flex-1 min-w-0 pr-1">
                    <h3 class="font-semibold text-white text-sm sm:text-base leading-snug truncate group-hover:text-orange-300 transition">
                        ${this.escapeHtml(title)}
                    </h3>
                    <p class="text-xs sm:text-sm text-gray-400 mt-0.5 truncate font-normal">
                        ${this.escapeHtml(artist)}
                    </p>
                </div>
            </div>
            `;
        }).join('');
    }

    bindSearch() {
        const searchInput = document.getElementById('search-input');
        const searchBtn = document.getElementById('search-btn');

        if (searchBtn && searchInput) {
            const executeSearch = () => {
                const query = searchInput.value.trim();
                if (query.length > 0) {
                    this.performSearch(query);
                }
            };

            searchBtn.addEventListener('click', executeSearch);
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') executeSearch();
            });
        }
    }

    formatFanCount(num) {
        if (!num) return '0';
        if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
        return num.toString();
    }

    async performSearch(query) {
        const artistsContainer = document.getElementById('search-artists-container');
        const resultsContainer = document.getElementById('search-results');
        const profileContainer = document.getElementById('artist-profile-view');
        
        if (profileContainer) profileContainer.classList.add('hidden');
        if (artistsContainer) artistsContainer.classList.remove('hidden');
        if (!resultsContainer) return;

        const cleanQ = query.toLowerCase().trim();
        if (this.searchCache && this.searchCache.has(cleanQ)) {
            const artists = this.searchCache.get(cleanQ);
            this.lastSearchQuery = query;
            this.lastSearchResults = artists;
            this.renderArtistSearchResults(artists);
            this.saveUserState();
            return;
        }

        resultsContainer.innerHTML = `
            <div class="glass-card p-10 sm:p-14 text-center flex flex-col items-center justify-center space-y-4 my-2">
                <div class="relative w-14 h-14 sm:w-16 sm:h-16 flex items-center justify-center">
                    <div class="absolute inset-0 rounded-full border-4 border-purple-500/20 border-t-purple-500 border-r-pink-500 animate-spin"></div>
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6 text-purple-400 animate-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                </div>
                <div>
                    <p class="text-sm sm:text-base font-semibold text-purple-200">Buscando artistas en Deezer...</p>
                    <p class="text-xs text-slate-400 mt-1">Explorando catálogo oficial y discografías</p>
                </div>
            </div>
        `;

        try {
            console.log("[MusicApp] Searching artists for query:", query);
            const response = await this.customFetch(`/api/music/artists?q=${encodeURIComponent(query)}`, {}, 15000);
            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errText}`);
            }
            const data = await response.json();
            const artists = data.results || [];
            console.log("[MusicApp] Found artists:", artists.length);

            if (this.searchCache) this.searchCache.set(cleanQ, artists);
            this.lastSearchQuery = query;
            this.lastSearchResults = artists;
            this.renderArtistSearchResults(artists);
            this.saveUserState();
        } catch (err) {
            console.error("Search failed:", err);
            resultsContainer.innerHTML = `
                <div class="glass-card p-6 text-center text-red-400 space-y-2">
                    <p class="font-medium">Ocurrió un error al buscar artistas.</p>
                    <p class="text-xs text-gray-400">${this.escapeHtml(err.message || 'Verifica la conexión a internet e inténtalo de nuevo.')}</p>
                    <button onclick="window.app.performSearch(document.getElementById('search-input') ? document.getElementById('search-input').value : '')" class="btn-secondary text-xs py-1.5 px-3 mt-2">Reintentar</button>
                </div>
            `;
        }
    }

    renderSearchResults(results) {
        return this.renderArtistSearchResults(results);
    }

    renderArtistSearchResults(artists) {
        const container = document.getElementById('search-results');
        if (!container) return;

        if (!artists || artists.length === 0) {
            container.innerHTML = `
                <div class="glass-card p-8 text-center text-gray-400">
                    <p class="text-lg font-medium">No se encontraron artistas para "${this.escapeHtml(this.lastSearchQuery || '')}".</p>
                    <p class="text-sm mt-1 text-gray-500">Prueba a buscar con otro nombre o término.</p>
                </div>
            `;
            return;
        }

        container.innerHTML = `
            <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 sm:gap-4">
                ${artists.map((artist, idx) => {
                    const pic = artist.picture || artist.picture_medium || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300';
                    return `
                    <div class="glass-card p-3 sm:p-4 flex flex-col items-center text-center group hover:border-purple-500/50 hover:bg-white/[0.05] transition duration-300 cursor-pointer active:scale-[0.98]"
                         onclick="window.app.openArtistView(${artist.id})">
                        <!-- Round Avatar -->
                        <div class="relative w-24 h-24 sm:w-28 sm:h-28 rounded-full overflow-hidden mb-3 shadow-xl border-2 border-white/10 group-hover:border-purple-400/60 group-hover:scale-105 transition duration-300 bg-slate-950 flex-shrink-0">
                            <img src="${pic}" 
                                 alt="${this.escapeHtml(artist.name)}" 
                                 class="w-full h-full object-cover" 
                                 loading="lazy" />
                        </div>

                        <!-- Artist Info -->
                        <h4 class="font-bold text-white text-sm sm:text-base leading-tight truncate w-full group-hover:text-purple-300 transition">
                            ${this.escapeHtml(artist.name)}
                        </h4>
                        <div class="flex items-center gap-1.5 text-[11px] text-slate-400 mt-1 font-medium">
                            <span>${artist.nb_album || 0} álbumes</span>
                            <span>&bull;</span>
                            <span>${this.formatFanCount(artist.nb_fan)} fans</span>
                        </div>
                    </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    async openArtistView(artistId, activeTab = 'top') {
        const artistsContainer = document.getElementById('search-artists-container');
        const profileContainer = document.getElementById('artist-profile-view');
        if (!profileContainer) return;

        if (artistsContainer) artistsContainer.classList.add('hidden');
        profileContainer.classList.remove('hidden');

        if (this.artistCache && this.artistCache.has(artistId)) {
            const data = this.artistCache.get(artistId);
            this.currentArtistData = data;
            this.currentArtistTab = activeTab;
            this.renderArtistProfile(data);
            this.saveUserState();
            return;
        }

        profileContainer.innerHTML = `
            <div class="glass-card p-10 sm:p-14 text-center flex flex-col items-center justify-center space-y-4 my-2">
                <div class="relative w-14 h-14 sm:w-16 sm:h-16 flex items-center justify-center">
                    <div class="absolute inset-0 rounded-full border-4 border-purple-500/20 border-t-purple-500 border-r-pink-500 animate-spin"></div>
                </div>
                <p class="text-sm font-semibold text-purple-200">Cargando discografía del artista...</p>
            </div>
        `;

        try {
            const res = await this.customFetch(`/api/music/artist/${artistId}`, {}, 15000);
            if (!res.ok) throw new Error("Error al obtener datos del artista");
            const data = await res.json();
            if (this.artistCache) this.artistCache.set(artistId, data);
            this.currentArtistData = data;
            this.currentArtistTab = activeTab;
            this.renderArtistProfile(data);
            this.saveUserState();
        } catch (err) {
            console.error("Failed to load artist view:", err);
            profileContainer.innerHTML = `
                <div class="glass-card p-6 text-center text-red-400 space-y-3">
                    <p class="font-medium">No se pudo cargar la discografía del artista.</p>
                    <button onclick="window.app.backToArtistSearch()" class="btn-secondary text-xs py-1.5 px-3">Volver a resultados</button>
                </div>
            `;
        }
    }

    backToArtistSearch() {
        const artistsContainer = document.getElementById('search-artists-container');
        const profileContainer = document.getElementById('artist-profile-view');
        if (profileContainer) profileContainer.classList.add('hidden');
        if (artistsContainer) artistsContainer.classList.remove('hidden');
        this.currentArtistData = null;
        this.saveUserState();
    }

    setArtistTab(tab) {
        this.currentArtistTab = tab;
        if (this.currentArtistData) {
            this.renderArtistProfile(this.currentArtistData);
        }
    }

    renderArtistProfile(data) {
        const container = document.getElementById('artist-profile-view');
        if (!container || !data || !data.artist) return;

        const artist = data.artist;
        const topTracks = data.top_tracks || [];
        const albums = data.albums || [];
        const singlesEps = data.singles_eps || [];
        const currentTab = this.currentArtistTab || 'top';
        const artistPic = artist.picture_xl || artist.picture || artist.picture_medium || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300';

        let tabContentHtml = '';

        if (currentTab === 'top') {
            if (topTracks.length === 0) {
                tabContentHtml = `
                    <div class="glass-card p-8 text-center text-slate-400">
                        <p class="font-medium">No hay temas destacados disponibles.</p>
                    </div>
                `;
            } else {
                tabContentHtml = `
                    <div class="space-y-2">
                        <div class="flex items-center justify-between px-2 py-1">
                            <span class="text-xs font-semibold text-slate-400 uppercase tracking-wider">Top ${topTracks.length} Canciones Populares</span>
                        </div>
                        <div class="space-y-2">
                            ${topTracks.map((track, idx) => {
                                const cover = track.cover || track.cover_medium || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300';
                                return `
                                <div class="glass-card p-2.5 sm:p-3 flex items-center justify-between gap-3 group hover:border-purple-500/40 hover:bg-white/[0.04] transition duration-200 cursor-pointer active:scale-[0.99]"
                                     onclick="window.app.openDeezerSongModal(${idx})">
                                    <!-- Left: Rank + Cover + Info -->
                                    <div class="flex items-center gap-2.5 sm:gap-3 min-w-0 flex-1">
                                        <span class="text-xs font-mono font-bold text-slate-500 w-5 text-center flex-shrink-0">${idx + 1}</span>
                                        <div class="relative w-11 h-11 sm:w-12 sm:h-12 rounded-xl overflow-hidden flex-shrink-0 bg-slate-950 shadow border border-white/5">
                                            <img src="${cover}" alt="${this.escapeHtml(track.title)}" class="w-full h-full object-cover group-hover:scale-105 transition duration-300" loading="lazy" />
                                        </div>
                                        <div class="min-w-0 flex-1">
                                            <h4 class="font-semibold text-white text-xs sm:text-sm leading-snug truncate group-hover:text-purple-300 transition">
                                                ${this.escapeHtml(track.title)}
                                            </h4>
                                            <p class="text-[11px] text-slate-400 truncate mt-0.5">
                                                ${this.escapeHtml(track.album || artist.name)}
                                            </p>
                                        </div>
                                    </div>

                                    <!-- Right: Duration & Chevron -->
                                    <div class="flex items-center gap-2 flex-shrink-0 text-slate-400">
                                        <span class="text-[11px] font-mono">${track.duration_string || ''}</span>
                                        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-slate-500 group-hover:text-purple-400 transition" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <polyline points="9 18 15 12 9 6"/>
                                        </svg>
                                    </div>
                                </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                `;
            }
        } else if (currentTab === 'albums') {
            if (albums.length === 0) {
                tabContentHtml = `
                    <div class="glass-card p-8 text-center text-slate-400">
                        <p class="font-medium">No se encontraron álbumes de estudio.</p>
                    </div>
                `;
            } else {
                tabContentHtml = `
                    <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 sm:gap-4">
                        ${albums.map((album) => {
                            const cover = album.cover_xl || album.cover || album.cover_medium || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300';
                            return `
                            <div class="glass-card p-3 sm:p-3.5 flex flex-col group hover:border-purple-500/50 hover:bg-white/[0.05] transition duration-300 cursor-pointer active:scale-[0.98]"
                                 onclick="window.app.openAlbumModal(${album.id})">
                                <div class="relative aspect-square w-full rounded-xl overflow-hidden mb-2.5 shadow-lg border border-white/10 group-hover:scale-102 transition duration-300 bg-slate-950">
                                    <img src="${cover}" alt="${this.escapeHtml(album.title)}" class="w-full h-full object-cover" loading="lazy" />
                                    ${album.year ? `<span class="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/80 text-[10px] font-mono text-white/90">${album.year}</span>` : ''}
                                </div>
                                <h4 class="font-bold text-white text-xs sm:text-sm leading-snug truncate group-hover:text-purple-300 transition">
                                    ${this.escapeHtml(album.title)}
                                </h4>
                                <div class="flex items-center justify-between text-[11px] text-slate-400 mt-1">
                                    <span class="capitalize text-purple-300/80 font-medium">Álbum</span>
                                    <span>${album.year || ''}</span>
                                </div>
                            </div>
                            `;
                        }).join('')}
                    </div>
                `;
            }
        } else if (currentTab === 'singles') {
            if (singlesEps.length === 0) {
                tabContentHtml = `
                    <div class="glass-card p-8 text-center text-slate-400">
                        <p class="font-medium">No se encontraron singles o EPs.</p>
                    </div>
                `;
            } else {
                tabContentHtml = `
                    <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 sm:gap-4">
                        ${singlesEps.map((item) => {
                            const cover = item.cover_xl || item.cover || item.cover_medium || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300';
                            return `
                            <div class="glass-card p-3 sm:p-3.5 flex flex-col group hover:border-purple-500/50 hover:bg-white/[0.05] transition duration-300 cursor-pointer active:scale-[0.98]"
                                 onclick="window.app.openAlbumModal(${item.id})">
                                <div class="relative aspect-square w-full rounded-xl overflow-hidden mb-2.5 shadow-lg border border-white/10 group-hover:scale-102 transition duration-300 bg-slate-950">
                                    <img src="${cover}" alt="${this.escapeHtml(item.title)}" class="w-full h-full object-cover" loading="lazy" />
                                    ${item.year ? `<span class="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/80 text-[10px] font-mono text-white/90">${item.year}</span>` : ''}
                                </div>
                                <h4 class="font-bold text-white text-xs sm:text-sm leading-snug truncate group-hover:text-purple-300 transition">
                                    ${this.escapeHtml(item.title)}
                                </h4>
                                <div class="flex items-center justify-between text-[11px] text-slate-400 mt-1">
                                    <span class="uppercase text-purple-300/80 font-medium">${item.record_type || 'Single'}</span>
                                    <span>${item.year || ''}</span>
                                </div>
                            </div>
                            `;
                        }).join('')}
                    </div>
                `;
            }
        }

        container.innerHTML = `
            <!-- Top Hero Banner with Back Button -->
            <div class="glass-card p-4 sm:p-6 relative overflow-hidden flex flex-col sm:flex-row items-center sm:items-start gap-4 sm:gap-6 border-purple-500/20">
                <!-- Back Button -->
                <button onclick="window.app.backToArtistSearch()" class="absolute top-3 left-3 sm:top-4 sm:left-4 z-10 btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5">
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="15 18 9 12 15 6"/>
                    </svg>
                    <span>Artistas</span>
                </button>

                <!-- Artist Avatar -->
                <div class="relative w-24 h-24 sm:w-28 sm:h-28 rounded-full overflow-hidden shadow-2xl border-2 border-purple-400/50 flex-shrink-0 mt-8 sm:mt-0 bg-slate-950">
                    <img src="${artistPic}" alt="${this.escapeHtml(artist.name)}" class="w-full h-full object-cover" />
                </div>

                <!-- Artist Details -->
                <div class="flex-1 text-center sm:text-left min-w-0 space-y-1">
                    <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-purple-500/20 text-purple-300 border border-purple-500/30 inline-block">Artista Oficial</span>
                    <h2 class="text-xl sm:text-3xl font-extrabold text-white leading-tight truncate">${this.escapeHtml(artist.name)}</h2>
                    <div class="flex flex-wrap items-center justify-center sm:justify-start gap-2 pt-1 text-xs text-slate-300">
                        <span class="px-2.5 py-0.5 rounded-full bg-slate-800/80 border border-white/5 font-medium">${artist.nb_album || 0} lanzamientos</span>
                        <span class="px-2.5 py-0.5 rounded-full bg-slate-800/80 border border-white/5 font-medium">${this.formatFanCount(artist.nb_fan)} fans</span>
                    </div>
                </div>
            </div>

            <!-- Sub-Navigation Tabs Bar -->
            <div class="flex items-center gap-2 border-b border-white/10 pb-2 overflow-x-auto custom-scrollbar">
                <button onclick="window.app.setArtistTab('top')" 
                        class="px-3.5 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition ${currentTab === 'top' ? 'bg-purple-600 text-white shadow-lg' : 'bg-slate-900/80 text-slate-400 hover:text-white'}">
                    <span>🔥 Éxitos (${topTracks.length})</span>
                </button>
                <button onclick="window.app.setArtistTab('albums')" 
                        class="px-3.5 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition ${currentTab === 'albums' ? 'bg-purple-600 text-white shadow-lg' : 'bg-slate-900/80 text-slate-400 hover:text-white'}">
                    <span>💿 Álbumes (${albums.length})</span>
                </button>
                <button onclick="window.app.setArtistTab('singles')" 
                        class="px-3.5 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition ${currentTab === 'singles' ? 'bg-purple-600 text-white shadow-lg' : 'bg-slate-900/80 text-slate-400 hover:text-white'}">
                    <span>🎵 Singles y EPs (${singlesEps.length})</span>
                </button>
            </div>

            <!-- Tab Dynamic Content -->
            <div>
                ${tabContentHtml}
            </div>
        `;
    }

    async openAlbumModal(albumId) {
        const modal = document.getElementById('modal-album-detail');
        const tracklistContainer = document.getElementById('album-modal-tracklist');
        if (!modal || !tracklistContainer) return;

        modal.classList.remove('hidden');

        if (this.albumCache && this.albumCache.has(albumId)) {
            const data = this.albumCache.get(albumId);
            this.currentAlbumData = data;
            this.renderAlbumModalContent(data);
            return;
        }

        tracklistContainer.innerHTML = `
            <div class="p-8 text-center flex flex-col items-center justify-center space-y-3">
                <div class="w-10 h-10 rounded-full border-2 border-purple-500/20 border-t-purple-500 animate-spin"></div>
                <p class="text-xs text-purple-200">Cargando canciones del álbum...</p>
            </div>
        `;

        try {
            const res = await this.customFetch(`/api/music/album/${albumId}`, {}, 15000);
            if (!res.ok) throw new Error("Error al obtener detalles del álbum");
            const data = await res.json();
            if (this.albumCache) this.albumCache.set(albumId, data);
            this.currentAlbumData = data;
            this.renderAlbumModalContent(data);
        } catch (err) {
            console.error("Failed to open album modal:", err);
            tracklistContainer.innerHTML = `
                <div class="p-6 text-center text-red-400 text-xs">
                    Error al cargar las pistas del álbum.
                </div>
            `;
        }
    }

    renderAlbumModalContent(data) {
        const tracklistContainer = document.getElementById('album-modal-tracklist');
        if (!tracklistContainer) return;

        // Populate header elements
        const coverEl = document.getElementById('album-modal-cover');
        const titleEl = document.getElementById('album-modal-title');
        const artistEl = document.getElementById('album-modal-artist');
        const metaEl = document.getElementById('album-modal-meta');
        const badgeEl = document.getElementById('album-modal-badge');

        if (coverEl) coverEl.src = data.cover_xl || data.cover || data.cover_medium || '';
        if (titleEl) titleEl.textContent = data.title || 'Álbum';
        if (artistEl) artistEl.textContent = data.artist || '';
        if (badgeEl) badgeEl.textContent = data.record_type || 'Álbum';
        if (metaEl) {
            metaEl.textContent = `${data.year || ''} • ${data.nb_tracks || (data.tracks ? data.tracks.length : 0)} canciones • ${data.duration_string || ''} ${data.label ? '• ' + data.label : ''}`;
        }

        // Populate tracklist
        const tracks = data.tracks || [];
        if (tracks.length === 0) {
            tracklistContainer.innerHTML = `
                <div class="p-6 text-center text-slate-400 text-xs">
                    No se encontraron pistas para este álbum.
                </div>
            `;
            return;
        }

        tracklistContainer.innerHTML = tracks.map((track, idx) => {
            return `
            <div class="glass-card p-2.5 sm:p-3 flex items-center justify-between gap-3 group hover:border-purple-500/40 hover:bg-white/[0.04] transition duration-200 cursor-pointer active:scale-[0.99]"
                 onclick="window.app.openDeezerAlbumSongModal(${idx})">
                <div class="flex items-center gap-2.5 min-w-0 flex-1">
                    <span class="text-xs font-mono font-bold text-slate-500 w-5 text-center flex-shrink-0">${track.track_position || (idx + 1)}</span>
                    <div class="min-w-0 flex-1">
                        <h4 class="font-semibold text-white text-xs sm:text-sm leading-snug truncate group-hover:text-purple-300 transition">
                            ${this.escapeHtml(track.title)}
                        </h4>
                        <p class="text-[11px] text-slate-400 truncate mt-0.5">
                            ${this.escapeHtml(track.artist || data.artist)}
                        </p>
                    </div>
                </div>

                <div class="flex items-center gap-2 flex-shrink-0 text-slate-400">
                    <span class="text-[11px] font-mono">${track.duration_string || ''}</span>
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5 text-slate-500 group-hover:text-purple-400 transition" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="9 18 15 12 9 6"/>
                    </svg>
                </div>
            </div>
            `;
        }).join('');
    }

    closeAlbumModal() {
        const modal = document.getElementById('modal-album-detail');
        if (modal) modal.classList.add('hidden');
    }

    async downloadDeezerTrack(track, btnElement = null) {
        if (!track) return;
        const origHtml = btnElement ? btnElement.innerHTML : null;
        if (btnElement) {
            btnElement.disabled = true;
            btnElement.innerHTML = `
                <div class="w-3 h-3 rounded-full border-2 border-white/30 border-t-white animate-spin"></div>
                <span class="text-[11px] font-medium">Encolando...</span>
            `;
            btnElement.classList.add('opacity-80');
        }

        try {
            const payload = {
                title: track.title,
                artist: track.artist,
                album: track.album || '',
                cover_url: track.cover_xl || track.cover || track.cover_medium || '',
                year: track.year || ''
            };
            const res = await this.customFetch('/api/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!res.ok) throw new Error("Error al iniciar descarga");
            this.showToast(`Descarga añadida: ${track.artist} - ${track.title}`, 'success');

            if (btnElement) {
                btnElement.innerHTML = `
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5 text-emerald-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="20 6 9 17 4 12"/>
                    </svg>
                    <span class="text-[11px] font-medium text-emerald-300">En cola</span>
                `;
                setTimeout(() => {
                    if (btnElement) {
                        btnElement.disabled = false;
                        btnElement.classList.remove('opacity-80');
                        btnElement.innerHTML = origHtml;
                    }
                }, 3000);
            }

            // Immediately poll downloads so badges and lists update in real-time
            this.pollDownloads();
        } catch (err) {
            console.error("Download track failed:", err);
            this.showToast(`Error al descargar: ${track.title}`, 'error');
            if (btnElement) {
                btnElement.disabled = false;
                btnElement.classList.remove('opacity-80');
                btnElement.innerHTML = origHtml;
            }
        }
    }

    downloadDeezerTrackFromTop(idx, btnElement = null) {
        if (!this.currentArtistData || !this.currentArtistData.top_tracks) return;
        const track = this.currentArtistData.top_tracks[idx];
        if (track) {
            this.downloadDeezerTrack(track, btnElement);
        }
    }

    downloadDeezerTrackFromAlbum(idx, btnElement = null) {
        if (!this.currentAlbumData || !this.currentAlbumData.tracks) return;
        const track = this.currentAlbumData.tracks[idx];
        if (track) {
            this.downloadDeezerTrack({
                ...track,
                artist: track.artist || this.currentAlbumData.artist,
                album: this.currentAlbumData.title,
                cover_xl: this.currentAlbumData.cover_xl || this.currentAlbumData.cover,
                year: this.currentAlbumData.year
            }, btnElement);
        }
    }

    async downloadCurrentModalAlbum() {
        if (!this.currentAlbumData) return;
        const album = this.currentAlbumData;
        try {
            const res = await this.customFetch('/api/music/download_album', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ album_id: album.id })
            });
            if (!res.ok) throw new Error("Error al iniciar descarga del álbum");
            const data = await res.json();
            this.showToast(data.message || `Descargando álbum: ${album.title}`, 'success');
            this.closeAlbumModal();
        } catch (err) {
            console.error("Download album failed:", err);
            this.showToast(`Error al descargar álbum: ${album.title}`, 'error');
        }
    }

    playDeezerPreview(idx) {
        this.openDeezerSongModal(idx);
    }

    playAlbumTrackPreview(idx) {
        this.openDeezerAlbumSongModal(idx);
    }

    openDeezerSongModal(idx) {
        if (!this.currentArtistData || !this.currentArtistData.top_tracks) return;
        const track = this.currentArtistData.top_tracks[idx];
        if (track) {
            this.selectedModalTrack = track;
            this.selectedModalTrackRank = idx + 1;
            this.selectedModalTrackContext = 'deezer_top';
            this.openSongModal(track, 'deezer_top');
        }
    }

    openDeezerAlbumSongModal(idx) {
        if (!this.currentAlbumData || !this.currentAlbumData.tracks) return;
        const track = this.currentAlbumData.tracks[idx];
        if (track) {
            this.selectedModalTrack = {
                ...track,
                artist: track.artist || this.currentAlbumData.artist,
                album: this.currentAlbumData.title,
                cover: this.currentAlbumData.cover_xl || this.currentAlbumData.cover,
                cover_xl: this.currentAlbumData.cover_xl || this.currentAlbumData.cover,
                year: this.currentAlbumData.year
            };
            this.selectedModalTrackRank = idx + 1;
            this.selectedModalTrackContext = 'deezer_album';
            this.openSongModal(this.selectedModalTrack, 'deezer_album');
        }
    }

    async triggerDownload(url, title, videoId, btnElement) {
        if (btnElement) {
            btnElement.disabled = true;
            btnElement.innerHTML = `
                <svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                En cola...
            `;
        }

        try {
            const res = await this.customFetch('/api/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: url, title: title, video_id: videoId })
            });

            const data = await res.json();
            if (data.success) {
                this.showNotification(`Añadido a la cola por ${data.downloaded_by || this.currentUser}`, 'success');
            } else {
                this.showNotification(`Error al iniciar descarga`, 'error');
            }
        } catch (err) {
            this.showNotification(`Error de conexión con el servidor`, 'error');
        } finally {
            if (btnElement) {
                btnElement.disabled = false;
                btnElement.innerHTML = `
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    Descargar MP3
                `;
            }
        }
    }

    startDownloadPolling() {
        this.pollDownloads();
        this.pollInterval = setInterval(() => {
            if (document.hidden) return; // Do not poll while screen is locked/background to protect audio streaming bandwidth
            this.pollDownloads();
        }, 2500);
    }

    addOptimisticDownloadTask(task) {
        if (!this._optimisticTasks) this._optimisticTasks = [];
        this._optimisticTasks.unshift({
            ...task,
            _created: Date.now()
        });
        const merged = this.getMergedDownloadTasks(this._lastServerTasks || []);
        this.renderDownloadsList(merged);
        this.updateDownloadsBadge(merged);
    }

    getMergedDownloadTasks(serverTasks) {
        this._lastServerTasks = serverTasks;
        if (!this._optimisticTasks || this._optimisticTasks.length === 0) return serverTasks;

        const now = Date.now();
        // Keep optimistic tasks younger than 15s that are not yet reported by serverTasks
        this._optimisticTasks = this._optimisticTasks.filter(opt => {
            if (now - opt._created > 15000) return false;
            const matched = serverTasks.some(st => {
                if (st.task_id === opt.task_id) return true;
                if (opt.url && st.url && st.url === opt.url) return true;
                if (opt.video_id && (st.video_id === opt.video_id || (st.url && st.url.includes(opt.video_id)))) return true;
                if (opt.title && st.title && (st.title === opt.title || (opt.artist && st.title.includes(opt.artist)))) return true;
                return false;
            });
            return !matched;
        });

        return [...this._optimisticTasks, ...serverTasks];
    }

    updateDownloadsBadge(tasks) {
        const activeCount = (tasks || []).filter(t => t.status === 'downloading' || t.status === 'queued' || t.status === 'converting').length;
        const badgeEls = document.querySelectorAll('.downloads-active-badge');
        badgeEls.forEach(badgeEl => {
            if (activeCount > 0) {
                badgeEl.innerText = activeCount;
                badgeEl.classList.remove('hidden');
            } else {
                badgeEl.classList.add('hidden');
            }
        });
    }

    async pollDownloads() {
        try {
            const res = await this.customFetch('/api/downloads');
            if (!res.ok) return;
            const data = await res.json();
            const serverTasks = data.tasks || [];
            const mergedTasks = this.getMergedDownloadTasks(serverTasks);

            this.renderDownloadsList(mergedTasks);
            this.updateDownloadsBadge(mergedTasks);

            if (this.isInitialDownloadPoll) {
                this.isInitialDownloadPoll = false;
                serverTasks.forEach(t => {
                    if (t.status === 'completed') {
                        this.countedTasks.add(t.task_id);
                        t._refreshed = true;
                    }
                });
            } else {
                const hasNewlyCompleted = serverTasks.some(t => t.status === 'completed' && !this.countedTasks.has(t.task_id));
                if (hasNewlyCompleted) {
                    serverTasks.forEach(t => {
                        if (t.status === 'completed' && !this.countedTasks.has(t.task_id)) {
                            this.countedTasks.add(t.task_id);
                            t._refreshed = true;
                            if (this.storageManager) {
                                const approxSize = t.size_bytes || 5000000;
                                this.storageManager.recordNetworkUsage(approxSize);
                            }
                        }
                    });
                    this.loadLibrary();
                }
            }
        } catch (err) {
            console.debug("Error polling downloads:", err);
        }
    }

    renderDownloadsList(tasks) {
        const container = document.getElementById('downloads-list');
        if (!container) return;

        if (tasks.length === 0) {
            container.innerHTML = `
                <div class="glass-card p-8 text-center text-gray-400">
                    <p class="text-base font-medium">No hay descargas activas o recientes.</p>
                    <p class="text-xs text-gray-500 mt-1">Usa el buscador para añadir música a tu almacenamiento en la nube.</p>
                </div>
            `;
            return;
        }

        container.innerHTML = tasks.map(t => {
            let statusBadgeClass = "badge-queued";
            let statusLabel = "En cola";
            if (t.status === 'downloading') { statusBadgeClass = "badge-downloading"; statusLabel = `Descargando (${t.progress.toFixed(1)}%)`; }
            else if (t.status === 'converting') { statusBadgeClass = "badge-converting"; statusLabel = "Convirtiendo a MP3"; }
            else if (t.status === 'completed') { statusBadgeClass = "badge-completed"; statusLabel = "Completado"; }
            else if (t.status === 'failed') { statusBadgeClass = "badge-failed"; statusLabel = "Error"; }

            return `
                <div class="glass-card p-4 space-y-3">
                    <div class="flex items-center justify-between gap-4">
                        <div class="min-w-0 flex-1">
                            <h4 class="font-medium text-white text-sm truncate">${this.escapeHtml(t.title)}</h4>
                            <p class="text-xs text-gray-400 font-mono mt-0.5 truncate">${t.url}</p>
                            <span class="inline-block mt-1 text-[10px] px-2 py-0.5 rounded bg-purple-950/60 text-purple-300 font-mono border border-purple-800/30">👤 ${t.downloaded_by || 'invitado'}</span>
                        </div>
                        <span class="px-2.5 py-1 rounded-full text-xs font-semibold flex-shrink-0 ${statusBadgeClass}">
                            ${statusLabel}
                        </span>
                        <button onclick="window.app.clearDownloadTask('${t.task_id}')" class="text-gray-500 hover:text-red-400 transition p-1">
                            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                            </svg>
                        </button>
                    </div>

                    <div class="w-full bg-slate-900 rounded-full h-2 overflow-hidden border border-slate-800">
                        <div class="bg-gradient-to-r from-purple-500 to-indigo-500 h-full transition-all duration-300" style="width: ${t.progress || 0}%"></div>
                    </div>

                    <div class="flex justify-between items-center text-[11px] font-mono text-gray-500">
                        <span>Velocidad: ${t.speed || '--'}</span>
                        <span>ETA: ${t.eta || '--'}</span>
                        ${t.status === 'completed' && t.filename ? `
                            <button onclick="window.app.openAddToPlaylistModal('${this.escapeJs(t.filename)}')" 
                                    class="ml-auto px-2.5 py-1 rounded-lg text-xs font-semibold bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 border border-purple-500/30 transition flex items-center gap-1">
                                <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                                </svg>
                                Añadir a Lista
                            </button>
                        ` : ''}
                    </div>

                    ${t.error ? `<p class="text-xs text-red-400 bg-red-950/40 p-2 rounded border border-red-800/30">${this.escapeHtml(t.error)}</p>` : ''}
                </div>
            `;
        }).join('');
    }

    async clearDownloadTask(taskId) {
        try {
            await this.customFetch(`/api/downloads/${taskId}`, { method: 'DELETE' });
            this.pollDownloads();
        } catch (err) {
            console.error("Error clearing task:", err);
        }
    }

    getLocalLibraryTracks() {
        try {
            const raw = localStorage.getItem('music_app_library_tracks');
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (e) {
            return null;
        }
    }

    setLocalLibraryTracks(tracks) {
        try {
            if (Array.isArray(tracks)) {
                localStorage.setItem('music_app_library_tracks', JSON.stringify(tracks));
            }
        } catch (e) {}
    }

    async loadLibrary(forceRefresh = false) {
        // 1. Immediately render cached library if in-memory list is empty
        if (!forceRefresh && (!this.libraryTracks || this.libraryTracks.length === 0)) {
            const cached = this.getLocalLibraryTracks();
            if (cached && Array.isArray(cached) && cached.length > 0) {
                this.libraryTracks = cached;
                this.updateUserFilterOptions();
                this.applyLibraryFilters();
                this.updateLibraryTrackCountBadge();
            }
        }

        // 2. Fetch fresh library from server
        try {
            const url = forceRefresh ? `/api/library?refresh=true&_t=${Date.now()}` : '/api/library';
            const res = await this.customFetch(url, {}, 25000);
            if (!res.ok) return;
            const data = await res.json();
            this.libraryTracks = data.tracks || [];
            this.setLocalLibraryTracks(this.libraryTracks);

            this.updateUserFilterOptions();
            this.applyLibraryFilters();
            this.updateLibraryTrackCountBadge();
        } catch (err) {
            console.error("Failed to load library:", err);
            // If fetch failed or timed out, ensure cached tracks are displayed
            if (!this.libraryTracks || this.libraryTracks.length === 0) {
                const cached = this.getLocalLibraryTracks();
                if (cached && Array.isArray(cached) && cached.length > 0) {
                    this.libraryTracks = cached;
                    this.updateUserFilterOptions();
                    this.applyLibraryFilters();
                    this.updateLibraryTrackCountBadge();
                }
            }
        }
    }

    updateLibraryTrackCountBadge(count = null) {
        const elTrackCount = document.getElementById('library-track-count');
        if (!elTrackCount) return;

        const total = (count !== null && count !== undefined) ? count : (this.currentFilteredLibraryTracks ? this.currentFilteredLibraryTracks.length : this.libraryTracks.length);
        elTrackCount.innerText = total;
    }

    playFilteredLibrary() {
        const tracks = this.currentFilteredLibraryTracks || this.libraryTracks || [];
        if (tracks.length === 0) {
            this.showToast("No hay canciones disponibles en la biblioteca");
            return;
        }

        if (window.player) {
            window.player.setPlaylist(tracks, 0);
            this.showToast(`Reproduciendo biblioteca (${tracks.length} canciones)`);
        }
    }

    exportLibrary() {
        if (!this.libraryTracks || this.libraryTracks.length === 0) {
            this.showToast("La biblioteca está vacía, no hay canciones para exportar", "warning");
            return;
        }

        const exportData = {
            app: "MusicCloud",
            version: "1.5.0",
            exported_at: new Date().toISOString(),
            total_tracks: this.libraryTracks.length,
            tracks: this.libraryTracks.map(t => {
                let videoId = "";
                const fn = t.filename || "";
                const m = fn.match(/\[([a-zA-Z0-9_-]{11})\]\.[a-zA-Z0-9]+$/);
                if (m) videoId = m[1];

                return {
                    filename: fn,
                    title: t.title || "",
                    artist: t.artist || "",
                    album: t.album || "",
                    duration: t.duration || 0,
                    duration_string: t.duration_string || "",
                    size_bytes: t.size_bytes || 0,
                    video_id: videoId,
                    url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : ""
                };
            })
        };

        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportData, null, 2));
        const downloadAnchor = document.createElement('a');
        const dateStr = new Date().toISOString().slice(0, 10);
        downloadAnchor.setAttribute("href", dataStr);
        downloadAnchor.setAttribute("download", `biblioteca_musica_${dateStr}.json`);
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        downloadAnchor.remove();

        this.showToast(`Biblioteca exportada con éxito (${this.libraryTracks.length} canciones)`, "success");
    }

    triggerImportLibrary() {
        const fileInput = document.getElementById('library-import-file');
        if (fileInput) {
            fileInput.value = '';
            fileInput.click();
        }
    }

    async importLibrary(event) {
        const file = event.target && event.target.files && event.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            const data = JSON.parse(text);

            const importedTracks = data.tracks || (Array.isArray(data) ? data : null);
            if (!importedTracks || !Array.isArray(importedTracks) || importedTracks.length === 0) {
                this.showToast("El archivo seleccionado no contiene canciones válidas.", "error");
                return;
            }

            // Ensure current library is loaded
            await this.loadLibrary();

            const res = await this.customFetch('/api/library/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tracks: importedTracks.map(t => ({
                        filename: t.filename || "",
                        title: t.title || "",
                        artist: t.artist || "",
                        url: t.url || "",
                        video_id: t.video_id || ""
                    }))
                })
            }, 60000);

            if (!res.ok) {
                throw new Error("Error en la respuesta del servidor al importar");
            }

            const result = await res.json();
            const queuedCount = result.queued_count || 0;
            const alreadyPresent = result.already_present_count || 0;

            if (queuedCount === 0) {
                this.showToast("Todas las canciones del archivo ya están en tu biblioteca.", "info");
            } else {
                this.showToast(`Se han añadido ${queuedCount} canciones a la cola de descarga (${alreadyPresent} ya existían).`, "success");
                if (typeof this.startDownloadPolling === 'function') {
                    this.startDownloadPolling();
                }
            }
        } catch (err) {
            console.error("Error al importar la biblioteca:", err);
            this.showToast("Ocurrió un error al importar el archivo JSON.", "error");
        }
    }

    updateUserFilterOptions() {
        const selectEl = document.getElementById('library-user-filter');
        if (!selectEl) return;

        const uniqueUsers = Array.from(new Set(this.libraryTracks.map(t => t.downloaded_by || 'Comunidad'))).filter(Boolean);

        let optionsHtml = `
            <option value="all">Todos los temas</option>
            <option value="my">Mis descargas (${this.currentUser})</option>
        `;

        uniqueUsers.forEach(u => {
            if (u !== this.currentUser) {
                optionsHtml += `<option value="${u}">Temas de ${u}</option>`;
            }
        });

        selectEl.innerHTML = optionsHtml;
        selectEl.value = this.userFilter;
    }

    initLibrarySort() {
        const select = document.getElementById('library-sort-select');
        if (select) {
            select.value = this.librarySort || 'recent';
        }
    }

    setLibrarySort(sortVal) {
        this.librarySort = sortVal || 'recent';
        localStorage.setItem('music_app_library_sort', this.librarySort);
        const sortSelect = document.getElementById('library-sort-select');
        if (sortSelect && sortSelect.value !== this.librarySort) {
            sortSelect.value = this.librarySort;
        }
        this.applyLibraryFilters();
    }

    filterLibraryByUser(filterVal) {
        this.userFilter = filterVal;
        this.applyLibraryFilters();
    }

    getTrackArtist(track) {
        if (!track) return 'Desconocido';
        if (track.artist && track.artist !== 'Desconocido' && track.artist !== 'Desconocida' && track.artist.trim() !== '') {
            return track.artist.trim();
        }
        const parsed = this.parseSongInfo(track);
        return (parsed && parsed.artist) ? parsed.artist.trim() : (track.artist || 'Desconocido');
    }

    getTrackTitle(track) {
        if (!track) return 'Canción';
        if (track.title && track.title !== 'Canción desconocida' && track.title.trim() !== '') {
            return track.title.trim();
        }
        const parsed = this.parseSongInfo(track);
        return (parsed && parsed.title) ? parsed.title.trim() : (track.title || track.filename || 'Canción');
    }

    sortTracks(tracks) {
        if (!tracks || tracks.length <= 1) return tracks ? [...tracks] : [];
        const sorted = [...tracks];

        if (this.librarySort === 'artist') {
            sorted.sort((a, b) => {
                const artistA = this.getTrackArtist(a);
                const artistB = this.getTrackArtist(b);
                const isUnknownA = !artistA || artistA.toLowerCase() === 'desconocido' || artistA.toLowerCase() === 'desconocida';
                const isUnknownB = !artistB || artistB.toLowerCase() === 'desconocido' || artistB.toLowerCase() === 'desconocida';
                if (isUnknownA && !isUnknownB) return 1;
                if (!isUnknownA && isUnknownB) return -1;

                let cmp = artistA.localeCompare(artistB, 'es', { sensitivity: 'base', numeric: true });
                if (cmp === 0) {
                    cmp = artistA.localeCompare(artistB, 'es', { numeric: true });
                }
                if (cmp !== 0) return cmp;

                // Secondary sort: Title (A-Z)
                const titleA = this.getTrackTitle(a);
                const titleB = this.getTrackTitle(b);
                let cmpTitle = titleA.localeCompare(titleB, 'es', { sensitivity: 'base', numeric: true });
                if (cmpTitle === 0) {
                    cmpTitle = titleA.localeCompare(titleB, 'es', { numeric: true });
                }
                if (cmpTitle !== 0) return cmpTitle;

                // Tertiary sort: Most recent
                const mtimeA = (typeof a.mtime === 'number') ? a.mtime : 0;
                const mtimeB = (typeof b.mtime === 'number') ? b.mtime : 0;
                if (mtimeA && mtimeB && mtimeA !== mtimeB) return mtimeB - mtimeA;
                return (b.modified_at || '').localeCompare(a.modified_at || '');
            });
        } else if (this.librarySort === 'title') {
            sorted.sort((a, b) => {
                const titleA = this.getTrackTitle(a);
                const titleB = this.getTrackTitle(b);
                let cmp = titleA.localeCompare(titleB, 'es', { sensitivity: 'base', numeric: true });
                if (cmp === 0) {
                    cmp = titleA.localeCompare(titleB, 'es', { numeric: true });
                }
                if (cmp !== 0) return cmp;

                // Secondary sort: Artist (A-Z)
                const artistA = this.getTrackArtist(a);
                const artistB = this.getTrackArtist(b);
                return artistA.localeCompare(artistB, 'es', { sensitivity: 'base', numeric: true });
            });
        } else {
            // Default: 'recent' - Más recientes primero (orden de adición)
            sorted.sort((a, b) => {
                const mtimeA = (typeof a.mtime === 'number') ? a.mtime : 0;
                const mtimeB = (typeof b.mtime === 'number') ? b.mtime : 0;
                if (mtimeA && mtimeB && mtimeA !== mtimeB) {
                    return mtimeB - mtimeA;
                }
                const modA = a.modified_at || '';
                const modB = b.modified_at || '';
                if (modA !== modB) {
                    return modB.localeCompare(modA);
                }
                // Fallback: title
                const titleA = this.getTrackTitle(a);
                const titleB = this.getTrackTitle(b);
                return titleA.localeCompare(titleB, 'es', { sensitivity: 'base', numeric: true });
            });
        }

        return sorted;
    }

    filterTracks(tracks) {
        if (!tracks) return [];
        let result = [...tracks];
        if (this.userFilter === 'my') {
            result = result.filter(t => t.downloaded_by === this.currentUser);
        } else if (this.userFilter && this.userFilter !== 'all') {
            result = result.filter(t => t.downloaded_by === this.userFilter);
        }

        const searchInput = document.querySelector('#view-library input[type="text"]');
        if (searchInput && searchInput.value.trim()) {
            const q = searchInput.value.trim().toLowerCase();
            result = result.filter(t => 
                (t.title && t.title.toLowerCase().includes(q)) || 
                (t.artist && t.artist.toLowerCase().includes(q)) || 
                (t.filename && t.filename.toLowerCase().includes(q))
            );
        }
        return this.sortTracks(result);
    }

    applyLibraryFilters() {
        const sortSelect = document.getElementById('library-sort-select');
        if (sortSelect && sortSelect.value !== this.librarySort) {
            sortSelect.value = this.librarySort;
        }
        const tracks = this.filterTracks(this.libraryTracks);
        this.currentFilteredLibraryTracks = tracks;
        this.updateLibraryTrackCountBadge(tracks.length);
        this.renderLibraryView(tracks);
    }

    filterLibrary(query) {
        this.applyLibraryFilters();
    }

    async renderLibraryView(tracks) {
        const container = document.getElementById('library-tracks');
        const playBtn = document.getElementById('library-play-all-btn');
        if (!container) return;

        if (tracks.length === 0) {
            if (playBtn) {
                playBtn.disabled = true;
                playBtn.classList.add('opacity-40', 'cursor-not-allowed');
            }
            container.innerHTML = `
                <div class="glass-card p-12 text-center text-gray-400 col-span-full">
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-16 h-16 mx-auto text-purple-400/40 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                    </svg>
                    <p class="text-lg font-medium text-white">No se encontraron canciones.</p>
                    <p class="text-sm text-gray-500 mt-1">Intenta cambiar el filtro de usuario o busca nuevas canciones en YouTube.</p>
                </div>
            `;
            return;
        }

        if (playBtn) {
            playBtn.disabled = false;
            playBtn.classList.remove('opacity-40', 'cursor-not-allowed');
        }

        container.innerHTML = tracks.map((track, idx) => {
            const { title, artist } = this.parseSongInfo(track);
            const coverUrl = track.has_cover 
                ? `/api/library/cover/${encodeURIComponent(track.filename)}` 
                : 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="%238b5cf6" stroke-width="1.5"><rect width="18" height="18" x="3" y="3" rx="2" fill="%231e1b4b"/><circle cx="12" cy="12" r="4"/><polygon points="10 10 15 12 10 14 10 10"/></svg>';
            const isCached = this.storageManager ? this.storageManager.isTrackCached(track) : false;

            return `
            <div class="glass-card p-3 flex items-center gap-3.5 group hover:border-purple-500/40 hover:bg-white/[0.04] transition duration-200 cursor-pointer active:scale-[0.99]"
                 onclick="window.app.openSongModalByContext('library', ${idx})">
                <!-- Thumbnail -->
                <div class="relative w-14 h-14 sm:w-16 sm:h-16 rounded-xl overflow-hidden flex-shrink-0 bg-slate-900 shadow-md border border-white/5">
                    <img src="${coverUrl}" 
                         alt="${this.escapeHtml(title)}" 
                         class="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                         loading="lazy" />
                    ${isCached ? `
                        <span class="absolute top-1 right-1 p-0.5 bg-purple-600/90 rounded-full text-white shadow" title="Guardada en caché local">
                            <svg xmlns="http://www.w3.org/2000/svg" class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                                <polyline points="20 6 9 17 4 12"/>
                            </svg>
                        </span>
                    ` : ''}
                    <span class="absolute bottom-0.5 right-0.5 px-1 py-0.2 bg-black/80 text-[9px] font-mono text-white/90 rounded">
                        ${track.duration_string || ''}
                    </span>
                </div>

                <!-- Right Title & Artist (1 line each) -->
                <div class="flex-1 min-w-0 pr-1">
                    <h3 class="font-semibold text-white text-sm sm:text-base leading-snug truncate group-hover:text-purple-300 transition">
                        ${this.escapeHtml(title)}
                    </h3>
                    <p class="text-xs sm:text-sm text-gray-400 mt-0.5 truncate font-normal">
                        ${this.escapeHtml(artist)}
                    </p>
                </div>
            </div>
            `;
        }).join('');
    }

    async toggleOfflineTrack(filename) {
        if (!this.storageManager) return;
        const track = this.libraryTracks.find(t => t.filename === filename);
        if (!track) return;

        const existing = await this.storageManager.getOfflineTrack(filename);
        if (existing) {
            await this.storageManager.deleteOfflineTrack(filename);
            this.showToast('Canción eliminada de la caché offline local');
        } else {
            this.showToast('Guardando canción en la caché offline del móvil...');
            try {
                const streamUrl = `/api/stream/${encodeURIComponent(filename)}`;
                const res = await this.customFetch(streamUrl, {}, 60000);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const blob = await res.blob();
                if (blob && blob.size > 10000) {
                    await this.storageManager.saveOfflineTrack(filename, blob, track);
                    this.storageManager.recordNetworkUsage(blob.size);
                    this.showToast('¡Canción guardada en caché offline para reproducir sin datos!', 'success');
                } else {
                    throw new Error('Archivo de audio incompleto o vacío');
                }
            } catch (err) {
                console.error("Error saving track offline:", err);
                this.showToast('Error al guardar canción en la caché del móvil', 'error');
            }
        }
        this.applyLibraryFilters();
        if (this.currentTab === 'settings' || this.currentTab === 'storage') {
            this.loadSettingsView();
        }
    }

    playLibraryTrack(index) {
        const tracks = this.currentFilteredLibraryTracks || this.libraryTracks;
        if (window.player && tracks && tracks[index]) {
            window.player.setPlaylist(tracks, index);
        }
    }

    async deleteTrack(filename) {
        if (!confirm(`¿Deseas eliminar '${filename}' de la biblioteca?`)) return;

        try {
            const res = await this.customFetch(`/api/library/${encodeURIComponent(filename)}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                this.showNotification(`Canción eliminada`, 'success');
                this.loadLibrary();
            } else {
                this.showNotification(`Error al eliminar`, 'error');
            }
        } catch (err) {
            this.showNotification(`Error de conexión`, 'error');
        }
    }

    // ==========================================
    // STANDALONE PREVIEW PLAYER (All Modals with Deezer Meta Lookup)
    // ==========================================

    attachStandalonePreviewListeners() {
        if (!this.standalonePreview) return;

        this.standalonePreview.onplay = () => {
            // Pause main player only when preview actually starts emitting sound
            if (window.player && window.player.audio && (!window.player.audio.paused || window.player.isPlaying) && window.player.playlist && window.player.playlist.length > 0 && window.player.currentIndex !== -1) {
                this.wasMainPlayerPausedByPreview = true;
                window.player.audio.pause();
                window.player.isPlaying = false;
                if (window.player.updatePlayButton) window.player.updatePlayButton();
            }
            this.updateModalPreviewUI('playing');
        };

        this.standalonePreview.onpause = () => {
            if (this.standalonePreview && this.standalonePreview.src) {
                this.updateModalPreviewUI('paused');
            }
        };

        this.standalonePreview.onended = () => {
            this.updateModalPreviewUI('paused');
            this.resumeMainPlayerIfPausedByModal();
        };
    }

    playStandalonePreview(previewUrl) {
        if (!previewUrl) {
            this.updateModalPreviewUI('none');
            return;
        }
        if (!this.standalonePreview) {
            this.standalonePreview = new Audio();
        }
        
        try {
            this.standalonePreview.pause();
            this.standalonePreview.src = previewUrl;
            this.standalonePreview.currentTime = 0;
            this.standalonePreview.volume = 1.0;

            this.attachStandalonePreviewListeners();
            this.standalonePreview.play().catch(err => {
                console.debug("Standalone preview autoplay prevented / not available:", err);
                this.updateModalPreviewUI('paused');
            });
        } catch (e) {
            console.debug("Error starting preview:", e);
            this.updateModalPreviewUI('none');
        }
    }

    stopStandalonePreview() {
        if (this.standalonePreview) {
            try {
                this.standalonePreview.onplay = null;
                this.standalonePreview.onpause = null;
                this.standalonePreview.onended = null;
                this.standalonePreview.pause();
                this.standalonePreview.removeAttribute('src');
                this.standalonePreview.load();
            } catch (e) {}
        }
        this.updateModalPreviewUI('none');
    }

    resumeMainPlayerIfPausedByModal() {
        if (this.wasMainPlayerPausedByPreview || this.mainPlayerWasPlayingOnModalOpen) {
            this.wasMainPlayerPausedByPreview = false;
            this.mainPlayerWasPlayingOnModalOpen = false;
            if (window.player && window.player.audio && window.player.playlist && window.player.playlist.length > 0 && window.player.currentIndex !== -1) {
                if (window.player.audio.paused) {
                    window.player.audio.play().then(() => {
                        window.player.isPlaying = true;
                        if (window.player.updatePlayButton) window.player.updatePlayButton();
                    }).catch(e => console.debug("Resume main player error:", e));
                }
            }
        }
    }

    toggleModalPreview() {
        this.toggleModalPreviewFromCover();
    }

    toggleModalPreviewFromCover(event) {
        if (event) {
            event.stopPropagation();
        }
        const track = this.selectedModalTrack;
        if (!track) return;

        // 1. If standalone preview is currently playing -> pause it (and resume main player if applicable)
        if (this.standalonePreview && !this.standalonePreview.paused && this.standalonePreview.src && this.standalonePreview.src !== window.location.href) {
            this.standalonePreview.pause();
            this.updateModalPreviewUI('paused');
            this.resumeMainPlayerIfPausedByModal();
            return;
        }

        // 2. If standalone preview already has a valid source and is paused -> resume playing
        if (this.standalonePreview && this.standalonePreview.src && this.standalonePreview.src !== window.location.href && this.standalonePreview.paused) {
            this.attachStandalonePreviewListeners();
            this.standalonePreview.play().catch(() => {});
            return;
        }

        // 3. If track has a resolved preview URL -> play it
        const directPreview = track.preview || track.preview_url;
        if (directPreview) {
            this.playStandalonePreview(directPreview);
            return;
        }

        // 4. If cached preview exists -> play it
        const { title, artist } = this.parseSongInfo(track);
        const cacheKey = `${artist} - ${title}`.toLowerCase().trim();
        const cachedPreview = this.deezerPreviewCache ? this.deezerPreviewCache[cacheKey] : undefined;

        if (cachedPreview) {
            track.preview = cachedPreview;
            this.playStandalonePreview(cachedPreview);
            return;
        }

        // 5. If no preview was found, do nothing on click (silent ignore, no error/loading)
    }

    updateModalPreviewUI(state) {
        const coverContainer = document.getElementById('song-modal-cover-container');
        const coverBadge = document.getElementById('song-modal-cover-badge');
        const iconPlay = document.getElementById('song-modal-cover-icon-play');
        const iconPause = document.getElementById('song-modal-cover-icon-pause');
        const iconLoading = document.getElementById('song-modal-cover-icon-loading');

        const hasActivePreview = (state === 'ready' || state === 'playing' || state === 'paused' || state === true);

        // Update cover container interactivity
        if (coverContainer) {
            if (hasActivePreview) {
                coverContainer.classList.add('cursor-pointer');
                coverContainer.classList.remove('cursor-default');
                coverContainer.setAttribute('title', 'Toca la imagen para reproducir o pausar la preescucha');
            } else {
                coverContainer.classList.remove('cursor-pointer');
                coverContainer.classList.add('cursor-default');
                coverContainer.removeAttribute('title');
            }
        }

        // Update cover badge icon states (only draw when a valid preview exists)
        if (coverBadge) {
            if (iconPlay) iconPlay.classList.add('hidden');
            if (iconPause) iconPause.classList.add('hidden');
            if (iconLoading) iconLoading.classList.add('hidden');

            if (state === 'none') {
                // No preview found -> keep cover badge completely hidden
                coverBadge.classList.add('hidden');
            } else if (state === 'loading') {
                if (this.modalPreviewEnabled) {
                    coverBadge.classList.add('hidden');
                } else {
                    coverBadge.classList.remove('hidden');
                    if (iconLoading) iconLoading.classList.remove('hidden');
                }
            } else if (state === 'playing' || state === true) {
                coverBadge.classList.remove('hidden');
                if (iconPause) iconPause.classList.remove('hidden');
            } else if (state === 'ready' || state === 'paused') {
                // Preview exists and is ready to play: draw the play symbol!
                coverBadge.classList.remove('hidden');
                if (iconPlay) iconPlay.classList.remove('hidden');
            }
        }
    }

    // ==========================================
    // SONG DETAIL MODAL & ACTIONS
    // ==========================================

    async openSongModal(track, context = 'library') {
        if (!track) return;
        this.selectedModalTrack = track;
        this.selectedModalTrackContext = context;
        this._modalPreviewSeq = (this._modalPreviewSeq || 0) + 1;
        const currentSeq = this._modalPreviewSeq;

        // Remember if main player was playing when modal opened
        const isMainPlayerActive = window.player && window.player.audio && (!window.player.audio.paused || window.player.isPlaying) && window.player.playlist && window.player.playlist.length > 0 && window.player.currentIndex !== -1;
        this.mainPlayerWasPlayingOnModalOpen = isMainPlayerActive;
        this.wasMainPlayerPausedByPreview = false;

        const { title, artist } = this.parseSongInfo(track);

        // Standalone Preview Management across search, trending, library, and player contexts
        this.stopStandalonePreview();
        this.updateModalPreviewUI('none'); // Initially hidden until preview availability is confirmed

        const directPreview = track.preview || track.preview_url;
        if (directPreview) {
            track.preview = directPreview;
            if (this.modalPreviewEnabled) {
                this.playStandalonePreview(directPreview);
            } else {
                this.updateModalPreviewUI('ready'); // Valid preview -> draw the play icon
            }
        } else {
            const cacheKey = `${artist} - ${title}`.toLowerCase().trim();
            const cachedPreview = this.deezerPreviewCache ? this.deezerPreviewCache[cacheKey] : undefined;

            if (cachedPreview !== undefined) {
                if (cachedPreview) {
                    track.preview = cachedPreview;
                    if (this.modalPreviewEnabled) {
                        this.playStandalonePreview(cachedPreview);
                    } else {
                        this.updateModalPreviewUI('ready'); // Cached preview -> draw the play icon
                    }
                } else {
                    this.updateModalPreviewUI('none'); // Definitively not found -> do NOT draw play icon
                }
            } else {
                if (this.modalPreviewEnabled) {
                    this.updateModalPreviewUI('loading');
                } else {
                    this.updateModalPreviewUI('none'); // Silent background query, no button until found
                }
                // Query Deezer preview by metadata asynchronously without stopping main player
                this.fetchDeezerPreviewForTrack(artist, title, cacheKey, currentSeq, track, false);
            }
        }

        const modal = document.getElementById('modal-song-detail');
        if (!modal) return;

        const coverEl = document.getElementById('song-modal-cover');
        const titleEl = document.getElementById('song-modal-title');
        const artistEl = document.getElementById('song-modal-artist');

        if (titleEl) titleEl.textContent = title;
        if (artistEl) artistEl.textContent = artist;

        const coverUrl = this.getTrackCoverUrl(track);
        if (coverEl) {
            coverEl.src = coverUrl;
            coverEl.alt = title;
        }

        await this.updateSongModalButtonsState();
        modal.classList.remove('hidden');
    }

    async fetchDeezerPreviewForTrack(artist, title, cacheKey, seq, track, forcePlay = false) {
        try {
            const query = `${artist} ${title}`.trim();
            const res = await this.customFetch(`/api/music/preview?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}&q=${encodeURIComponent(query)}`, {}, 6000);
            if (!res.ok) throw new Error("Preview fetch failed");
            const data = await res.json();
            let previewUrl = data.preview || null;

            // Fallback for local library tracks if not found on Deezer catalog
            if (!previewUrl) {
                const libTrack = this.getLibraryTrackForItem(track);
                if (libTrack && libTrack.filename) {
                    previewUrl = `/api/stream/${encodeURIComponent(libTrack.filename)}`;
                } else if (track.filename) {
                    previewUrl = `/api/stream/${encodeURIComponent(track.filename)}`;
                }
            }

            if (!this.deezerPreviewCache) this.deezerPreviewCache = {};
            this.deezerPreviewCache[cacheKey] = previewUrl;

            // Only update if this modal request is still current
            if (this._modalPreviewSeq === seq && this.selectedModalTrack === track) {
                if (previewUrl) {
                    track.preview = previewUrl;
                    if (this.modalPreviewEnabled || forcePlay) {
                        this.playStandalonePreview(previewUrl);
                    } else {
                        // Preview verified and found: draw the play icon on the cover!
                        this.updateModalPreviewUI('ready');
                    }
                } else {
                    // No preview found -> keep icon hidden so user is not misled
                    this.updateModalPreviewUI('none');
                    if (forcePlay) this.showToast('No se encontró preescucha disponible', 'info');
                }
            }
        } catch (err) {
            console.debug("Failed to fetch Deezer preview for modal:", err);
            if (this._modalPreviewSeq === seq && this.selectedModalTrack === track) {
                this.updateModalPreviewUI('none');
                if (forcePlay) this.showToast('Error al obtener preescucha', 'error');
            }
        }
    }

    openSongModalByContext(context, index) {
        if (context === 'trending') {
            const item = this.currentTrendingResults ? this.currentTrendingResults[index] : null;
            if (item) this.openSongModal(item, 'trending');
        } else if (context === 'search') {
            const item = this.lastSearchResults ? this.lastSearchResults[index] : null;
            if (item) this.openSongModal(item, 'search');
        } else if (context === 'library') {
            const tracks = this.currentFilteredLibraryTracks || this.libraryTracks;
            const item = tracks ? tracks[index] : null;
            if (item) this.openSongModal(item, 'library');
        }
    }

    openCurrentPlayerSongModal() {
        if (!window.player || !window.player.playlist || window.player.playlist.length === 0 || window.player.currentIndex === -1) {
            return;
        }
        const currentTrack = window.player.playlist[window.player.currentIndex];
        if (!currentTrack) return;

        // Enrich with library metadata if already downloaded in local library
        const libTrack = this.getLibraryTrackForItem(currentTrack);
        const modalTrack = libTrack ? { ...currentTrack, ...libTrack } : currentTrack;

        this.openSongModal(modalTrack, 'player');
    }

    deleteCurrentPlayingTrack() {
        if (window.player && typeof window.player.deleteCurrentTrack === 'function') {
            window.player.deleteCurrentTrack();
        }
    }

    closeSongModal() {
        this.stopStandalonePreview();
        this.resumeMainPlayerIfPausedByModal();

        const modal = document.getElementById('modal-song-detail');
        if (modal) modal.classList.add('hidden');
        this.closeEditSongModal();
        this.selectedModalTrack = null;
        this.selectedModalTrackContext = null;
    }

    closeQueueModal() {
        if (window.player && typeof window.player.closeQueueModal === 'function') {
            window.player.closeQueueModal();
        } else {
            const modal = document.getElementById('queue-drawer');
            if (modal) modal.classList.add('hidden');
        }
    }

    openSleepTimerModal() {
        if (window.player && typeof window.player.openSleepTimerModal === 'function') {
            window.player.openSleepTimerModal();
        } else {
            const modal = document.getElementById('modal-sleep-timer');
            if (modal) modal.classList.remove('hidden');
        }
    }

    openEqualizerModal() {
        if (window.player && typeof window.player.openEqualizerModal === 'function') {
            window.player.openEqualizerModal();
        } else {
            const modal = document.getElementById('modal-equalizer');
            if (modal) modal.classList.remove('hidden');
        }
    }

    closeEqualizerModal() {
        if (window.player && typeof window.player.closeEqualizerModal === 'function') {
            window.player.closeEqualizerModal();
        } else {
            const modal = document.getElementById('modal-equalizer');
            if (modal) modal.classList.add('hidden');
        }
    }

    closeSleepTimerModal() {
        if (window.player && typeof window.player.closeSleepTimerModal === 'function') {
            window.player.closeSleepTimerModal();
        } else {
            const modal = document.getElementById('modal-sleep-timer');
            if (modal) modal.classList.add('hidden');
        }
    }

    preloadYtTrack(videoId) {
        if (!videoId) return;
        const cleanId = String(videoId).trim();
        if (!cleanId) return;

        if (!this._preloadedYtTracks) {
            this._preloadedYtTracks = new Set();
        }
        if (this._preloadedYtTracks.has(cleanId)) return;
        this._preloadedYtTracks.add(cleanId);
        if (this._preloadedYtTracks.size > 50) {
            const first = this._preloadedYtTracks.values().next().value;
            this._preloadedYtTracks.delete(first);
        }

        const url = `/api/preload_yt?v=${encodeURIComponent(cleanId)}`;
        const fetcher = this.customFetch ? this.customFetch.bind(this) : fetch;
        fetcher(url).then(res => res.json()).then(data => {
            console.log(`[PreloadYT] Prewarmed track '${cleanId}':`, data);
        }).catch(err => {
            console.debug(`[PreloadYT] Prewarm failed for '${cleanId}':`, err);
        });
    }

    async updateSongModalButtonsState() {
        const track = this.selectedModalTrack;
        if (!track) return;

        const btnAddPlaylist = document.getElementById('song-modal-btn-add-playlist');
        const btnLib = document.getElementById('song-modal-btn-library-action');
        const iconLib = document.getElementById('song-modal-lib-icon');
        const textLib = document.getElementById('song-modal-lib-text');

        const libTrack = this.getLibraryTrackForItem(track);
        const inLibrary = !!libTrack || !!track.filename;

        // "Añadir a lista" button: Always enabled for all tracks
        if (btnAddPlaylist) {
            btnAddPlaylist.disabled = false;
            btnAddPlaylist.classList.remove('opacity-40', 'cursor-not-allowed', 'pointer-events-none');
            btnAddPlaylist.className = 'btn-secondary text-[11px] sm:text-xs py-2 px-1 sm:px-2 flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 font-medium text-purple-200 hover:text-white border-purple-500/30 hover:border-purple-400 min-h-[42px] transition';
            btnAddPlaylist.title = 'Añadir canción a una de tus listas';
        }

        // Single Dynamic Download / Delete button
        if (btnLib && iconLib && textLib) {
            if (inLibrary) {
                // Show "Eliminar" with red accent and trash icon
                btnLib.className = 'btn-secondary text-[11px] sm:text-xs py-2 px-1 sm:px-2 flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 font-medium text-red-400 border-red-500/30 hover:bg-red-950/40 hover:border-red-500/50 min-h-[42px] transition';
                btnLib.title = 'Eliminar canción permanentemente de la biblioteca';
                iconLib.innerHTML = `
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-red-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                `;
                textLib.textContent = 'Eliminar';
            } else {
                // Show "Descargar" with amber accent and download icon
                btnLib.className = 'btn-secondary text-[11px] sm:text-xs py-2 px-1 sm:px-2 flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 font-medium text-amber-300 hover:text-white border-amber-500/30 hover:border-amber-400 min-h-[42px] transition';
                btnLib.title = 'Descargar canción a la biblioteca';
                iconLib.innerHTML = `
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-amber-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                `;
                textLib.textContent = 'Descargar';
            }
        }

        // Symmetrical Replace Version Badge (active if cached or in library)
        const replaceBadge = document.getElementById('song-modal-replace-badge');
        const isCached = this.storageManager ? this.storageManager.isTrackCached(track) : false;
        const isCachedOrInLibrary = inLibrary || isCached;

        if (replaceBadge) {
            if (isCachedOrInLibrary) {
                replaceBadge.classList.remove('hidden');
                replaceBadge.classList.add('flex');
            } else {
                replaceBadge.classList.add('hidden');
                replaceBadge.classList.remove('flex');
            }
        }

        // Top-Right Edit Title & Artist Badge (active if cached or in library)
        const editBadge = document.getElementById('song-modal-edit-badge');
        if (editBadge) {
            if (isCachedOrInLibrary) {
                editBadge.classList.remove('hidden');
                editBadge.classList.add('flex');
            } else {
                editBadge.classList.add('hidden');
                editBadge.classList.remove('flex');
            }
        }
    }

    // ==========================================
    // EDIT SONG (TITLE & ARTIST) MODAL
    // ==========================================

    openEditSongModal() {
        const track = this.selectedModalTrack;
        if (!track) return;

        const libTrack = this.getLibraryTrackForItem(track);
        const filename = (libTrack ? libTrack.filename : null) || track.filename;

        if (!filename) {
            this.showToast('Esta canción debe estar en la biblioteca para editarla', 'info');
            return;
        }

        // Extract clean title and artist
        const { title, artist } = this.parseSongInfo(libTrack || track);

        const titleInput = document.getElementById('edit-song-title-input');
        const artistInput = document.getElementById('edit-song-artist-input');
        const modal = document.getElementById('modal-edit-song');

        if (titleInput) titleInput.value = title || '';
        if (artistInput) artistInput.value = artist || '';

        if (modal) modal.classList.remove('hidden');
        if (titleInput) {
            setTimeout(() => {
                titleInput.focus();
                titleInput.select();
            }, 50);
        }
    }

    closeEditSongModal() {
        const modal = document.getElementById('modal-edit-song');
        if (modal) modal.classList.add('hidden');
    }

    async saveEditedSong() {
        const track = this.selectedModalTrack;
        if (!track) return;

        const libTrack = this.getLibraryTrackForItem(track);
        const oldFilename = (libTrack ? libTrack.filename : null) || track.filename;

        if (!oldFilename) {
            this.showToast('No se encontró el archivo de la canción en la biblioteca', 'error');
            return;
        }

        const titleInput = document.getElementById('edit-song-title-input');
        const artistInput = document.getElementById('edit-song-artist-input');
        const submitBtn = document.getElementById('edit-song-submit-btn');

        const newTitle = titleInput ? titleInput.value.trim() : '';
        const newArtist = artistInput ? artistInput.value.trim() : '';

        if (!newTitle || !newArtist) {
            this.showToast('El título y el artista no pueden estar vacíos', 'warning');
            return;
        }

        const originalBtnHtml = submitBtn ? submitBtn.innerHTML : '';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = `
                <svg class="animate-spin w-4 h-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                </svg>
                <span>Guardando...</span>
            `;
        }

        try {
            const res = await this.customFetch(`/api/library/${encodeURIComponent(oldFilename)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: newTitle, artist: newArtist })
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.detail || 'Error al actualizar la canción');
            }

            const data = await res.json();
            const finalFilename = data.filename || oldFilename;
            const updatedTrack = data.track || {};

            // 1. Update selectedModalTrack in place
            if (this.selectedModalTrack) {
                this.selectedModalTrack.title = newTitle;
                this.selectedModalTrack.artist = newArtist;
                this.selectedModalTrack.filename = finalFilename;
                if (updatedTrack.has_cover !== undefined) {
                    this.selectedModalTrack.has_cover = updatedTrack.has_cover;
                }
            }

            // 2. Update library tracks in-place immediately
            if (Array.isArray(this.libraryTracks)) {
                this.libraryTracks.forEach(t => {
                    if (!t) return;
                    if (t.filename === oldFilename || t.filename === finalFilename || (track.id && t.id === track.id)) {
                        t.title = newTitle;
                        t.artist = newArtist;
                        t.filename = finalFilename;
                        if (updatedTrack.has_cover !== undefined) {
                            t.has_cover = updatedTrack.has_cover;
                        }
                    }
                });
            }

            // 3. Update all playlists in-place immediately
            if (Array.isArray(this.playlists)) {
                this.playlists.forEach(pl => {
                    if (Array.isArray(pl.tracks)) {
                        pl.tracks.forEach(t => {
                            if (!t) return;
                            if (t.filename === oldFilename || t.filename === finalFilename || (track.id && t.id === track.id)) {
                                t.title = newTitle;
                                t.artist = newArtist;
                                t.filename = finalFilename;
                                if (updatedTrack.has_cover !== undefined) {
                                    t.has_cover = updatedTrack.has_cover;
                                }
                            }
                        });
                    }
                });
                this.setLocalPlaylists(this.playlists);
            }

            // 4. Update lastSearchResults and currentTrendingResults if present
            if (Array.isArray(this.lastSearchResults)) {
                this.lastSearchResults.forEach(t => {
                    if (t && (t.filename === oldFilename || (track.id && t.id === track.id))) {
                        t.title = newTitle;
                        t.artist = newArtist;
                        t.filename = finalFilename;
                    }
                });
            }
            if (Array.isArray(this.currentTrendingResults)) {
                this.currentTrendingResults.forEach(t => {
                    if (t && (t.filename === oldFilename || (track.id && t.id === track.id))) {
                        t.title = newTitle;
                        t.artist = newArtist;
                        t.filename = finalFilename;
                    }
                });
            }

            // 5. Migrate offline cache if track was cached under old filename
            if (this.storageManager) {
                try {
                    const cached = await this.storageManager.getOfflineTrack(oldFilename);
                    if (cached && cached.blob) {
                        await this.storageManager.saveOfflineTrack(finalFilename, cached.blob, {
                            ...(cached.metadata || {}),
                            title: newTitle,
                            artist: newArtist,
                            filename: finalFilename
                        });
                        if (oldFilename !== finalFilename) {
                            await this.storageManager.deleteOfflineTrack(oldFilename);
                        }
                        await this.storageManager.refreshCacheKeys();
                    }
                } catch (e) {
                    console.debug("[EditSong] Cache migration skipped:", e);
                }
            }

            // 6. Update active player queue and player bar if currently loaded
            if (window.player && window.player.playlist && window.player.playlist.length > 0) {
                let currentPlayingUpdated = false;
                for (let i = 0; i < window.player.playlist.length; i++) {
                    const pTrack = window.player.playlist[i];
                    if (!pTrack) continue;
                    const matches = (pTrack.filename && (pTrack.filename === oldFilename || pTrack.filename === finalFilename)) ||
                                    (track.id && pTrack.id === track.id) ||
                                    (track.filename && pTrack.filename === track.filename);
                    if (matches) {
                        pTrack.filename = finalFilename;
                        pTrack.title = newTitle;
                        pTrack.artist = newArtist;
                        if (pTrack.has_cover || updatedTrack.has_cover) {
                            pTrack.has_cover = true;
                            pTrack.thumbnail = `/api/library/cover/${encodeURIComponent(finalFilename)}`;
                        }
                        if (i === window.player.currentIndex) {
                            currentPlayingUpdated = true;
                        }
                    }
                }
                if (currentPlayingUpdated) {
                    if (window.player.elTitle) window.player.elTitle.innerText = newTitle;
                    if (window.player.elArtist) window.player.elArtist.innerText = newArtist;
                    if (typeof window.player.updateTextMarquees === 'function') {
                        window.player.updateTextMarquees();
                    }
                    if (typeof window.player.updateMediaSession === 'function') {
                        window.player.updateMediaSession(window.player.playlist[window.player.currentIndex]);
                    }
                }
                if (typeof window.player.renderQueue === 'function') {
                    window.player.renderQueue();
                }
                if (typeof window.player.triggerSaveUserState === 'function') {
                    window.player.triggerSaveUserState();
                }
            }

            // 7. Update UI views immediately on screen
            this.setLocalLibraryTracks(this.libraryTracks);
            this.applyLibraryFilters();
            this.renderPlaylistsGrid();
            if (this.editingPlaylistId) {
                const curPl = this.playlists.find(p => p.id === this.editingPlaylistId);
                if (curPl) this.editingTracks = [...(curPl.tracks || [])];
                this.renderEditPlaylistTracks();
            }

            // 8. Close modal completely (closes detail modal & edit modal, stops preview)
            this.closeSongModal();
            this.showToast(`Canción actualizada: '${newTitle}'`, 'success');

            // 9. Background synchronization with backend (instant from in-memory cache)
            Promise.all([
                this.loadLibrary(false),
                this.loadPlaylists(false)
            ]).catch(err => console.debug("[saveEditedSong] Background sync error:", err));

        } catch (err) {
            console.error("Error saving edited song:", err);
            this.showToast(err.message || 'Error al guardar cambios', 'error');
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalBtnHtml;
            }
        }
    }

    // ==========================================
    // REPLACE SONG VERSION MODAL (YOUTUBE)
    // ==========================================

    openReplaceVersionModal() {
        const track = this.selectedModalTrack;
        if (!track) return;

        this.stopStandalonePreview();
        const { title, artist } = this.parseSongInfo(track);
        
        const titleEl = document.getElementById('replace-version-current-title');
        const inputEl = document.getElementById('replace-version-search-input');
        const modal = document.getElementById('modal-replace-version');

        if (titleEl) titleEl.textContent = `${artist} - ${title}`;
        if (inputEl) inputEl.value = `${artist} ${title}`.trim();

        if (modal) modal.classList.remove('hidden');

        this._activeReplacingTrack = track;
        this.replaceVersionTargetTrack = track;
        this.replaceVersionResults = [];
        this.searchYouTubeVersions();
    }

    closeReplaceVersionModal() {
        this.stopStandalonePreview();
        const modal = document.getElementById('modal-replace-version');
        if (modal) modal.classList.add('hidden');
        this.replaceVersionTargetTrack = null;
        this.replaceVersionResults = [];
    }

    async searchYouTubeVersions() {
        const inputEl = document.getElementById('replace-version-search-input');
        const query = inputEl ? inputEl.value.trim() : '';
        if (!query) return;

        const loadingEl = document.getElementById('replace-version-loading');
        const resultsEl = document.getElementById('replace-version-results');

        if (loadingEl) loadingEl.classList.remove('hidden');
        if (resultsEl) resultsEl.innerHTML = '';

        try {
            const res = await this.customFetch(`/api/search?q=${encodeURIComponent(query)}`, {}, 15000);
            if (!res.ok) throw new Error("Search failed");
            const data = await res.json();
            this.replaceVersionResults = data.results || [];
            this.renderReplaceVersionResults(this.replaceVersionResults);
        } catch (err) {
            console.error("Error searching YouTube versions:", err);
            if (resultsEl) {
                resultsEl.innerHTML = `
                    <div class="p-6 text-center text-red-400 text-xs">
                        Error al buscar versiones en YouTube. Inténtalo de nuevo.
                    </div>
                `;
            }
        } finally {
            if (loadingEl) loadingEl.classList.add('hidden');
        }
    }

    renderReplaceVersionResults(results) {
        const container = document.getElementById('replace-version-results');
        if (!container) return;
        container.innerHTML = '';
        this._currentReplaceResults = results || [];

        if (!results || results.length === 0) {
            container.innerHTML = `
                <div class="p-8 text-center text-slate-400 text-xs">
                    No se encontraron versiones en YouTube. Prueba con otra búsqueda.
                </div>
            `;
            return;
        }

        const targetTrackToReplace = this._activeReplacingTrack || this.replaceVersionTargetTrack || this.selectedModalTrack;

        results.forEach((item, index) => {
            const card = document.createElement('div');
            card.className = 'flex items-center justify-between gap-2.5 p-2.5 rounded-xl bg-slate-900/80 hover:bg-slate-800/90 border border-white/10 transition group';
            
            const thumb = item.thumbnail || `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="%238b5cf6" stroke-width="1.5"><rect width="18" height="18" x="3" y="3" rx="2" fill="%231e1b4b"/><circle cx="12" cy="12" r="4"/></svg>`;
            const duration = item.duration || (item.duration_string || '');
            const channel = item.channel || item.artist || 'YouTube';
            const safeTitle = this.escapeHtml(item.title || '');
            const safeChannel = this.escapeHtml(channel);

            card.innerHTML = `
                <div class="flex items-center gap-2.5 min-w-0 flex-1">
                    <div class="relative w-12 h-12 rounded-lg overflow-hidden flex-shrink-0 bg-slate-950 border border-white/10 group-hover:border-purple-500/50 transition">
                        <img src="${thumb}" alt="${safeTitle}" class="w-full h-full object-cover">
                        <!-- Quick Preview Play Button on Thumbnail -->
                        <button type="button" class="btn-replace-preview absolute inset-0 bg-black/60 hover:bg-purple-900/80 flex items-center justify-center opacity-0 group-hover:opacity-100 transition cursor-pointer text-white" 
                                title="Escuchar versión">
                            <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 fill-current ml-0.5" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                        </button>
                    </div>
                    <div class="min-w-0 flex-1 pr-1">
                        <h4 class="text-xs sm:text-sm font-semibold text-white truncate leading-tight group-hover:text-purple-300 transition" title="${safeTitle}">${safeTitle}</h4>
                        <div class="flex items-center gap-2 text-[11px] text-slate-400 mt-1">
                            <span class="truncate max-w-[110px] sm:max-w-[160px]">${safeChannel}</span>
                            ${duration ? `<span class="font-mono text-purple-300 bg-purple-950/60 px-1.5 py-0.5 rounded border border-purple-500/20 text-[10px]">${duration}</span>` : ''}
                        </div>
                    </div>
                </div>
                <button type="button" onclick="event.stopPropagation(); window.app.selectReplaceVersion(${index})" 
                        class="btn-replace-choose btn-primary text-xs py-1.5 px-3 flex-shrink-0 font-medium flex items-center gap-1 cursor-pointer shadow-md"
                        title="Reemplazar versión actual por esta">
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
                    <span>Elegir</span>
                </button>
            `;

            const btnPreview = card.querySelector('.btn-replace-preview');
            if (btnPreview) {
                btnPreview.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    this.previewReplaceItem(item.id, btnPreview);
                });
            }

            container.appendChild(card);
        });
    }

    previewReplaceItem(videoId, btnEl) {
        if (!videoId) return;
        const streamUrl = `/api/stream_yt?v=${encodeURIComponent(videoId)}`;
        if (this.standaloneAudio && !this.standaloneAudio.paused && this._currentPreviewUrl === streamUrl) {
            this.stopStandalonePreview();
        } else {
            this._currentPreviewUrl = streamUrl;
            this.playStandalonePreview(streamUrl);
        }
    }

    selectReplaceVersion(index) {
        console.log("[ReplaceVersion] selectReplaceVersion called for index:", index);
        const results = this._currentReplaceResults || this.replaceVersionResults || [];
        const item = results[index];
        const targetTrack = this._activeReplacingTrack || this.replaceVersionTargetTrack || this.selectedModalTrack;
        console.log("[ReplaceVersion] item:", item, "targetTrack:", targetTrack);
        if (item) {
            this.executeReplaceTrackVersionWithItem(item, targetTrack);
        } else {
            console.error("[ReplaceVersion] Item not found at index:", index, results);
            this.showToast("No se pudo seleccionar la versión", "error");
        }
    }

    executeReplaceTrackVersion(resultIndex, btnElement = null) {
        this.selectReplaceVersion(resultIndex);
    }

    async executeReplaceTrackVersionWithItem(newYtItem, oldTrack) {
        console.log("[ReplaceVersion] Executing replacement with item:", { newYtItem, oldTrack });

        if (!newYtItem) {
            this.showToast("No se pudo identificar la versión seleccionada", "error");
            return;
        }

        const currentModalTrack = this._activeReplacingTrack || this.replaceVersionTargetTrack || this.selectedModalTrack;
        const targetTrack = oldTrack || currentModalTrack;

        const videoId = String(newYtItem.id || newYtItem.video_id || '');
        const ytUrl = newYtItem.url || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : '');
        const songName = String(newYtItem.title || (targetTrack ? targetTrack.title : 'Nueva versión'));
        const artistName = String(newYtItem.artist || newYtItem.channel || (targetTrack ? targetTrack.artist : 'Artista'));
        const coverUrl = String(newYtItem.thumbnail || (targetTrack ? (targetTrack.thumbnail || targetTrack.cover_xl || targetTrack.cover || '') : ''));

        // 1. Optimistic task in Downloads tab (0ms instant display)
        this.addOptimisticDownloadTask({
            task_id: 'opt-' + Date.now(),
            video_id: videoId,
            title: songName,
            url: ytUrl,
            status: 'queued',
            progress: 0.0,
            speed: '--',
            eta: '--',
            downloaded_by: this.currentUser || 'invitado'
        });

        // 2. Close modals & switch to downloads tab for instant feedback
        try {
            this.stopStandalonePreview();
            this.closeReplaceVersionModal();
            this.closeSongModal();
            this.switchTab('downloads', false);
        } catch (uiErr) {
            console.warn("[ReplaceVersion] UI error:", uiErr);
        }

        // 3. Send download request IMMEDIATELY (Priority #1)
        const downloadPayload = {
            url: ytUrl,
            video_id: videoId,
            title: songName,
            artist: artistName,
            cover_url: coverUrl
        };
        console.log(`[ReplaceVersion] Queuing download with payload:`, downloadPayload);

        fetch('/api/download', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(downloadPayload)
        })
        .then(async (dlRes) => {
            console.log(`[ReplaceVersion] Download response status:`, dlRes.status);
            if (dlRes && dlRes.ok) {
                const data = await dlRes.json().catch(() => ({}));
                console.log("[ReplaceVersion] Download queued successfully:", data);
                this.showToast(`Descarga iniciada: '${songName}'`, 'success');
            } else {
                const errData = await dlRes.json().catch(() => ({}));
                console.warn("[ReplaceVersion] Download response error:", dlRes.status, errData);
                this.showToast(errData.detail || 'Error al iniciar descarga', 'error');
            }
            this.pollDownloads();
        })
        .catch(dlErr => {
            console.error("[ReplaceVersion] Download network error:", dlErr);
            this.showToast('Error de red al encolar la descarga', 'error');
        });

        // Fast sync bursts to update progress seamlessly
        setTimeout(() => this.pollDownloads(), 400);
        setTimeout(() => this.pollDownloads(), 1000);
        setTimeout(() => this.pollDownloads(), 2000);

        // 4. Delete old version from library & offline cache
        let oldFilename = null;
        try {
            if (targetTrack) {
                if (targetTrack.filename) {
                    oldFilename = targetTrack.filename;
                } else {
                    const libTrack = this.getLibraryTrackForItem(targetTrack);
                    if (libTrack && libTrack.filename) {
                        oldFilename = libTrack.filename;
                    }
                }
            }

            if (oldFilename) {
                console.log(`[ReplaceVersion] Deleting old library file: ${oldFilename}`);
                fetch(`/api/library/${encodeURIComponent(oldFilename)}`, {
                    method: 'DELETE',
                    credentials: 'same-origin'
                })
                .then(res => {
                    console.log(`[ReplaceVersion] Delete response status:`, res.status);
                    this.loadLibrary();
                })
                .catch(delErr => console.warn("[ReplaceVersion] Error deleting old file:", delErr));
            }

            if (this.storageManager) {
                if (oldFilename) this.storageManager.deleteOfflineTrack(oldFilename).catch(() => {});
                if (targetTrack && targetTrack.id) this.storageManager.deleteOfflineTrack(targetTrack.id).catch(() => {});
                if (window.player && typeof window.player.backgroundCacheTrack === 'function') {
                    window.player.backgroundCacheTrack(newYtItem);
                }
            }
        } catch (delCatch) {
            console.warn("[ReplaceVersion] Cleanup error:", delCatch);
        }

        // 5. If track was in active player queue / playlist:
        try {
            if (window.player && window.player.playlist && window.player.playlist.length > 0) {
                const stdNewTrack = this.toStandardPlayerTrack(newYtItem);
                let isCurrentlyPlaying = false;
                for (let i = 0; i < window.player.playlist.length; i++) {
                    const pTrack = window.player.playlist[i];
                    const matches = (oldFilename && (pTrack.filename === oldFilename || pTrack.id === oldFilename)) ||
                                    (targetTrack && targetTrack.id && (pTrack.id === targetTrack.id || pTrack.filename === targetTrack.id)) ||
                                    (targetTrack && targetTrack.filename && (pTrack.filename === targetTrack.filename || pTrack.id === targetTrack.filename));
                    if (matches) {
                        window.player.playlist[i] = stdNewTrack;
                        if (i === window.player.currentIndex) {
                            isCurrentlyPlaying = true;
                        }
                    }
                }
                if (isCurrentlyPlaying) {
                    window.player.loadTrack(window.player.currentIndex, window.player.isPlaying, false);
                }
                window.player.renderQueue();
                window.player.triggerSaveUserState();
            }
        } catch (queueErr) {
            console.warn("[ReplaceVersion] Queue update error:", queueErr);
        }
    }

    modalToggleLibraryAction() {
        const track = this.selectedModalTrack;
        if (!track) return;

        const libTrack = this.getLibraryTrackForItem(track);
        const inLibrary = !!libTrack || !!track.filename;

        if (inLibrary) {
            this.modalDeleteFromLibrary();
        } else {
            this.modalDownloadTrack();
        }
    }

    modalPlayNow() {
        const track = this.selectedModalTrack;
        this.wasMainPlayerPausedByPreview = false;
        this.mainPlayerWasPlayingOnModalOpen = false;
        this.stopStandalonePreview();
        this.closeSongModal();
        if (!track) return;
        const playerTrack = this.toStandardPlayerTrack(track);
        if (window.player && playerTrack) {
            window.player.playNowWithResume(playerTrack);
            this.showToast(`Reproduciendo ahora: ${playerTrack.title}`);
        }
    }

    modalPlayNext() {
        const track = this.selectedModalTrack;
        this.stopStandalonePreview();
        this.closeSongModal();
        if (!track) return;
        const playerTrack = this.toStandardPlayerTrack(track);
        if (window.player && playerTrack) {
            const isEmptyOrStopped = window.player.playlist.length === 0 || window.player.currentIndex === -1;
            window.player.playNextInQueue(playerTrack);
            if (isEmptyOrStopped) {
                this.showToast(`Reproduciendo ahora: ${playerTrack.title}`);
            } else {
                this.showToast(`Se reproducirá a continuación: ${playerTrack.title}`);
            }
        }
    }

    modalAddToPlaylist() {
        const track = this.selectedModalTrack;
        this.closeSongModal();
        if (!track) return;

        const libTrack = this.getLibraryTrackForItem(track);
        const filename = (libTrack ? libTrack.filename : null) || track.filename;

        this.openAddToPlaylistModal(filename || null, filename ? null : track);
    }

    async modalDownloadTrack() {
        const track = this.selectedModalTrack;
        const context = this.selectedModalTrackContext;
        this.closeSongModal();
        if (!track) return;

        const libTrack = this.getLibraryTrackForItem(track);
        if (libTrack || track.filename) {
            this.showToast('Esta canción ya está en tu biblioteca', 'info');
            return;
        }

        if (track.preview || track.is_deezer || track.album || context === 'deezer_top' || context === 'deezer_album') {
            await this.downloadDeezerTrack(track);
            return;
        }

        await this.triggerDownload(track.url || (track.id ? `https://youtube.com/watch?v=${track.id}` : ''), track.title, track.id);
    }

    async modalDeleteFromCache() {
        const track = this.selectedModalTrack;
        if (!track || !this.storageManager) return;

        const libTrack = this.getLibraryTrackForItem(track);
        const trackKey = (libTrack ? libTrack.filename : null) || track.filename || track.id;
        if (!trackKey) return;

        // Close modal immediately and return to main app
        this.closeSongModal();

        try {
            await this.storageManager.deleteOfflineTrack(trackKey);
            this.showToast('Canción eliminada de la caché local', 'success');
            if (this.currentTab === 'library') {
                this.applyLibraryFilters();
            } else if (this.currentTab === 'settings' || this.currentTab === 'storage') {
                this.loadSettingsView();
            }
        } catch (err) {
            console.error("Error deleting from offline cache:", err);
            this.showToast('Error al eliminar de la caché', 'error');
        }
    }

    async modalDeleteFromLibrary() {
        const track = this.selectedModalTrack;
        if (!track) return;

        const libTrack = this.getLibraryTrackForItem(track);
        const filename = libTrack ? libTrack.filename : track.filename;

        if (!filename) {
            this.closeSongModal();
            this.showToast('Esta canción no está en la biblioteca', 'warning');
            return;
        }

        const trackTitle = track.title || filename;
        // Close modal immediately
        this.closeSongModal();

        if (!confirm(`¿Deseas eliminar '${trackTitle}' de la biblioteca?`)) return;

        try {
            const res = await this.customFetch(`/api/library/${encodeURIComponent(filename)}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                this.showNotification(`Canción eliminada de la biblioteca`, 'success');
                await this.loadLibrary();
                if (this.currentTab === 'search' && this.lastSearchResults) {
                    this.renderSearchResults(this.lastSearchResults);
                } else if (this.currentTab === 'trending' && this.currentTrendingResults) {
                    this.renderTrendingResults(this.currentTrendingResults);
                }
            } else {
                this.showNotification(`Error al eliminar`, 'error');
            }
        } catch (err) {
            this.showNotification(`Error de conexión`, 'error');
        }
    }

    // ==========================================
    // PLAYLISTS MANAGEMENT
    // ==========================================

    getLocalPlaylists() {
        try {
            const raw = localStorage.getItem(`music_app_playlists_${this.currentUser || 'invitado'}`);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (e) {
            return null;
        }
    }

    setLocalPlaylists(playlists) {
        try {
            localStorage.setItem(`music_app_playlists_${this.currentUser || 'invitado'}`, JSON.stringify(playlists));
        } catch (e) {}
    }

    async loadPlaylists(forceRefresh = false) {
        // 1. Instantly render cached playlists if available
        if (!forceRefresh && (!this.playlists || this.playlists.length === 0)) {
            const cached = this.getLocalPlaylists();
            if (cached && Array.isArray(cached) && cached.length > 0) {
                this.playlists = cached;
                this.renderPlaylistsGrid();
            }
        }

        // 2. Fetch fresh playlists from server
        try {
            const url = forceRefresh ? `/api/playlists?_t=${Date.now()}` : '/api/playlists';
            const res = await this.customFetch(url);
            if (!res.ok) return;
            const data = await res.json();
            this.playlists = data.playlists || [];
            this.setLocalPlaylists(this.playlists);
            this.renderPlaylistsGrid();
        } catch (err) {
            console.error("Failed to load playlists:", err);
            if (!this.playlists || this.playlists.length === 0) {
                const cached = this.getLocalPlaylists();
                if (cached && Array.isArray(cached) && cached.length > 0) {
                    this.playlists = cached;
                    this.renderPlaylistsGrid();
                }
            }
        }
    }

    async exportPlaylists() {
        if (!this.playlists || this.playlists.length === 0) {
            this.showToast("No hay listas de reproducción para exportar", "warning");
            return;
        }

        try {
            const res = await this.customFetch('/api/playlists/export');
            if (!res.ok) throw new Error("Error obteniendo datos de exportación");
            const data = await res.json();

            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(data, null, 2));
            const downloadAnchor = document.createElement('a');
            const dateStr = new Date().toISOString().slice(0, 10);
            downloadAnchor.setAttribute("href", dataStr);
            downloadAnchor.setAttribute("download", `listas_reproduccion_${dateStr}.json`);
            document.body.appendChild(downloadAnchor);
            downloadAnchor.click();
            downloadAnchor.remove();

            this.showToast(`Se han exportado ${this.playlists.length} listas con éxito`, "success");
        } catch (err) {
            console.error("Failed to export playlists:", err);
            this.showToast("Ocurrió un error al exportar las listas", "error");
        }
    }

    triggerImportPlaylists() {
        const fileInput = document.getElementById('playlists-import-file');
        if (fileInput) {
            fileInput.value = '';
            fileInput.click();
        }
    }

    async importPlaylists(event) {
        const file = event.target && event.target.files && event.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            const data = JSON.parse(text);

            let importedListas = data.playlists || (Array.isArray(data) ? data : null);
            if (!importedListas || !Array.isArray(importedListas) || importedListas.length === 0) {
                this.showToast("El archivo seleccionado no contiene listas válidas.", "error");
                return;
            }

            const res = await this.customFetch('/api/playlists/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ playlists: importedListas })
            }, 60000);

            if (!res.ok) throw new Error("Error en la respuesta del servidor al importar listas");

            const result = await res.json();
            const plCount = result.playlists_imported || 0;
            const queuedCount = result.queued_downloads || 0;

            if (queuedCount > 0) {
                this.showToast(`Importadas ${plCount} listas (${queuedCount} canciones añadidas a la cola de descarga).`, "success");
            } else {
                this.showToast(`Se han importado ${plCount} listas con éxito.`, "success");
            }

            await this.loadPlaylists();
            if (queuedCount > 0 && typeof this.startDownloadPolling === 'function') {
                this.startDownloadPolling();
            }
        } catch (err) {
            console.error("Error al importar listas:", err);
            this.showToast("Ocurrió un error al importar el archivo JSON de listas.", "error");
        }
    }

    renderPlaylistsGrid() {
        const container = document.getElementById('playlists-grid');
        if (!container) return;

        if (this.playlists.length === 0) {
            container.innerHTML = `
                <div class="glass-card p-12 text-center text-gray-400 col-span-full">
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-16 h-16 mx-auto text-purple-400/40 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
                    </svg>
                    <p class="text-lg font-medium text-white">No hay listas de reproducción creadas.</p>
                    <p class="text-sm text-gray-500 mt-1">Crea tu primera lista compartida para agrupar tus canciones favoritas.</p>
                </div>
            `;
            return;
        }

        container.innerHTML = this.playlists.map(pl => {
            const isOwner = pl.created_by === this.currentUser || pl.created_by === 'invitado' || !pl.created_by || this.currentUser === 'admin';
            return `
            <div class="glass-card p-4 sm:p-5 space-y-3 sm:space-y-4 hover:border-purple-500/40 transition">
                <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0 flex-1">
                        <h3 class="font-bold text-white text-base truncate">${this.escapeHtml(pl.name)}</h3>
                        <p class="text-xs text-gray-400 mt-0.5 line-clamp-2">${this.escapeHtml(pl.description || 'Sin descripción')}</p>
                    </div>
                    <div class="flex flex-col items-end gap-1 flex-shrink-0">
                        <span class="text-[10px] px-2 py-0.5 rounded-full bg-purple-950/80 text-purple-300 border border-purple-800/40 font-mono">
                            👤 ${this.escapeHtml(pl.created_by || 'Comunidad')}
                        </span>
                        ${!isOwner ? '<span class="text-[10px] text-slate-400 font-mono italic">Solo lectura</span>' : ''}
                    </div>
                </div>

                <div class="hidden sm:flex items-center justify-between text-xs text-gray-500 font-mono pt-2 border-t border-white/10">
                    <span>${pl.tracks ? pl.tracks.length : 0} canciones</span>
                    <span>${pl.created_at}</span>
                </div>

                <div class="flex items-center gap-2 pt-0 sm:pt-1">
                    <button onclick="window.app.playPlaylist('${pl.id}')" class="btn-secondary text-xs py-2 px-3 flex-1 flex items-center justify-center gap-1.5">
                        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 fill-current ml-0.5" viewBox="0 0 24 24">
                            <polygon points="5 3 19 12 5 21 5 3"/>
                        </svg>
                        Reproducir Lista
                    </button>
                    
                    ${isOwner ? `
                        <button onclick="window.app.openEditPlaylistModal('${pl.id}')" class="btn-secondary text-xs py-2 px-2.5 text-purple-400 hover:text-purple-300" title="Editar lista">
                            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                        </button>
                        <button onclick="window.app.deletePlaylist('${pl.id}')" class="btn-secondary text-xs py-2 px-2.5 text-red-400 hover:text-red-300" title="Eliminar lista">
                            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                            </svg>
                        </button>
                    ` : ''}
                </div>
            </div>
        `; }).join('');
    }

    openCreatePlaylistModal() {
        const modal = document.getElementById('modal-create-playlist');
        if (modal) modal.classList.remove('hidden');
    }

    async submitCreatePlaylist() {
        const nameInput = document.getElementById('playlist-name-input');
        const descInput = document.getElementById('playlist-desc-input');
        const name = nameInput ? nameInput.value.trim() : '';
        const desc = descInput ? descInput.value.trim() : '';

        if (!name) {
            this.showNotification('El nombre de la lista es obligatorio', 'error');
            return;
        }

        try {
            const res = await this.customFetch('/api/playlists', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name, description: desc })
            });

            const data = await res.json();
            if (data.success) {
                this.showNotification(`Lista '${name}' creada por ${this.currentUser}`, 'success');
                if (nameInput) nameInput.value = '';
                if (descInput) descInput.value = '';
                document.getElementById('modal-create-playlist').classList.add('hidden');
                this.loadPlaylists();
            } else {
                this.showNotification(data.detail || 'Error al crear la lista', 'error');
            }
        } catch (err) {
            this.showNotification('Error de conexión', 'error');
        }
    }

    async saveCurrentQueueAsPlaylist() {
        if (!window.player || !window.player.playlist || window.player.playlist.length === 0) {
            this.showToast('No hay canciones en la lista para guardar', 'warning');
            return;
        }

        const name = prompt('Introduce el nombre para la nueva lista de reproducción:');
        if (!name || !name.trim()) return;

        try {
            const createRes = await this.customFetch('/api/playlists', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.trim(), description: 'Guardada desde pistas disponibles' })
            });
            const createData = await createRes.json();
            if (!createData.success || !createData.playlist) {
                this.showNotification(createData.detail || 'Error al crear la lista', 'error');
                return;
            }

            const playlistId = createData.playlist.id;
            // Get all library filenames from current playlist
            const tracks = window.player.playlist.map(t => {
                const libTrack = this.getLibraryTrackForItem(t);
                return libTrack ? libTrack.filename : (t.filename || null);
            }).filter(Boolean);

            if (tracks.length > 0) {
                await this.customFetch(`/api/playlists/${playlistId}/tracks`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tracks: tracks })
                });
            }

            this.showToast(`Lista '${name.trim()}' guardada con ${tracks.length} canciones`, 'success');
            await this.loadPlaylists();
        } catch (err) {
            console.error("Error saving queue as playlist:", err);
            this.showNotification('Error al guardar la lista', 'error');
        }
    }

    openAddToPlaylistModal(filename, trackToDownload = null) {
        this.selectedTrackForPlaylist = filename;
        this.selectedTrackObjectForPlaylist = trackToDownload;
        const trackNameEl = document.getElementById('add-to-playlist-track-name');
        const optionsEl = document.getElementById('add-to-playlist-options');
        const modal = document.getElementById('modal-add-to-playlist');

        let displayName = filename || '';
        if (trackToDownload) {
            const parsed = this.parseSongInfo(trackToDownload);
            displayName = parsed.title ? `${parsed.artist} - ${parsed.title}` : (trackToDownload.title || filename || 'Canción');
        } else if (filename) {
            const parsed = this.parseSongInfo({ filename });
            displayName = parsed.title ? `${parsed.artist} - ${parsed.title}` : filename;
        }

        if (trackNameEl) trackNameEl.innerText = displayName;

        if (optionsEl) {
            const userPlaylists = this.playlists.filter(pl => 
                pl.created_by === this.currentUser || 
                pl.created_by === 'invitado' || 
                !pl.created_by || 
                this.currentUser === 'admin'
            );

            if (userPlaylists.length === 0) {
                optionsEl.innerHTML = `<p class="text-xs text-gray-400 p-3 text-center">No tienes listas creadas. Crea una en la pestaña 'Listas'.</p>`;
            } else {
                optionsEl.innerHTML = userPlaylists.map(pl => `
                    <div onclick="window.app.addTrackToPlaylist('${pl.id}')" 
                         class="p-3 rounded-xl bg-slate-900/80 hover:bg-purple-950/60 border border-white/5 hover:border-purple-500/30 cursor-pointer transition flex items-center justify-between">
                        <div>
                            <p class="text-xs font-semibold text-white">${this.escapeHtml(pl.name)}</p>
                            <p class="text-[10px] text-gray-400">Creada por ${this.escapeHtml(pl.created_by || 'Tú')} • ${pl.tracks ? pl.tracks.length : 0} canciones</p>
                        </div>
                        <span class="text-xs font-bold text-purple-400">+ Añadir</span>
                    </div>
                `).join('');
            }
        }

        if (modal) modal.classList.remove('hidden');
    }

    async addTrackToPlaylist(playlistId) {
        if (!this.selectedTrackForPlaylist && !this.selectedTrackObjectForPlaylist) return;

        let filename = this.selectedTrackForPlaylist;
        const trackObj = this.selectedTrackObjectForPlaylist;

        // If track is not yet in library, trigger download and add
        if (!filename && trackObj) {
            const modal = document.getElementById('modal-add-to-playlist');
            if (modal) modal.classList.add('hidden');
            this.showToast('Descargando canción a la biblioteca y añadiéndola a la lista...', 'info');
            try {
                if (trackObj.preview || trackObj.is_deezer || trackObj.album) {
                    await this.downloadDeezerTrack(trackObj);
                } else {
                    await this.triggerDownload(trackObj.url || (trackObj.id ? `https://youtube.com/watch?v=${trackObj.id}` : ''), trackObj.title, trackObj.id);
                }
                const parsed = this.parseSongInfo(trackObj);
                filename = `${parsed.artist} - ${parsed.title}.mp3`;
            } catch (e) {
                console.warn("Auto-download for playlist failed:", e);
            }
        }

        if (!filename) return;

        try {
            const res = await this.customFetch(`/api/playlists/${playlistId}/tracks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: filename })
            });

            const data = await res.json();
            if (data.success) {
                this.showNotification('Canción añadida a la lista', 'success');
                const modal = document.getElementById('modal-add-to-playlist');
                if (modal) modal.classList.add('hidden');
                this.loadPlaylists();
            } else {
                this.showNotification(data.detail || 'Error al añadir canción', 'error');
            }
        } catch (err) {
            this.showNotification('Error de conexión', 'error');
        }
    }

    playPlaylist(playlistId) {
        const pl = this.playlists.find(p => p.id === playlistId);
        if (!pl || !pl.tracks || pl.tracks.length === 0) {
            this.showNotification('La lista está vacía', 'info');
            return;
        }

        const playlistTracks = this.libraryTracks
            .filter(t => pl.tracks.includes(t.filename))
            .map(t => ({ ...t, playlist_name: pl.name }));

        if (playlistTracks.length === 0) {
            this.showNotification('No se encontraron los archivos de audio de esta lista', 'error');
            return;
        }

        if (window.player) {
            window.player.setPlaylist(playlistTracks, 0);
            this.showNotification(`Reproduciendo lista '${pl.name}'`, 'info');
        }
    }

    async deletePlaylist(playlistId) {
        if (!confirm("¿Estás seguro de que deseas eliminar esta lista de reproducción?")) return;

        try {
            const res = await this.customFetch(`/api/playlists/${playlistId}`, {
                method: 'DELETE'
            });

            if (!res.ok) throw new Error("No tienes permisos o la lista no existe");

            this.showNotification('Lista eliminada correctamente', 'success');
            await this.loadPlaylists();
        } catch (err) {
            console.error("Error deleting playlist:", err);
            this.showNotification('Error al eliminar la lista', 'error');
        }
    }

    openEditPlaylistModal(playlistId) {
        const pl = this.playlists.find(p => p.id === playlistId);
        if (!pl) return;

        this.editingPlaylistId = playlistId;
        this.editingTracks = [...(pl.tracks || [])];
        this.selectedEditTrackIndex = null;

        this.renderEditPlaylistTracks();

        const modal = document.getElementById('modal-edit-playlist');
        if (modal) modal.classList.remove('hidden');
    }

    selectEditTrack(index) {
        if (this.selectedEditTrackIndex === index) {
            this.selectedEditTrackIndex = null;
        } else {
            this.selectedEditTrackIndex = index;
        }
        this.renderEditPlaylistTracks();
    }

    renderEditPlaylistTracks() {
        const listEl = document.getElementById('edit-playlist-tracks-list');
        const titleEl = document.getElementById('edit-playlist-title');
        if (!listEl) return;

        const pl = this.playlists.find(p => p.id === this.editingPlaylistId);
        const playlistName = pl ? pl.name : 'Lista';

        if (titleEl) {
            titleEl.innerHTML = `${this.escapeHtml(playlistName)} <span class="text-xs font-normal text-purple-300 ml-1.5">(${this.editingTracks.length} canciones)</span>`;
        }

        const btnUp = document.getElementById('edit-btn-up');
        const btnDown = document.getElementById('edit-btn-down');
        const btnDelete = document.getElementById('edit-btn-delete');

        const hasSelection = this.selectedEditTrackIndex !== null && 
                             this.selectedEditTrackIndex >= 0 && 
                             this.selectedEditTrackIndex < this.editingTracks.length;

        if (btnUp) {
            const canUp = hasSelection && this.selectedEditTrackIndex > 0;
            btnUp.disabled = !canUp;
            btnUp.classList.toggle('opacity-40', !canUp);
            btnUp.classList.toggle('cursor-not-allowed', !canUp);
            btnUp.classList.toggle('text-slate-500', !canUp);
            btnUp.classList.toggle('text-white', canUp);
        }

        if (btnDown) {
            const canDown = hasSelection && this.selectedEditTrackIndex < this.editingTracks.length - 1;
            btnDown.disabled = !canDown;
            btnDown.classList.toggle('opacity-40', !canDown);
            btnDown.classList.toggle('cursor-not-allowed', !canDown);
            btnDown.classList.toggle('text-slate-500', !canDown);
            btnDown.classList.toggle('text-white', canDown);
        }

        if (btnDelete) {
            btnDelete.disabled = !hasSelection;
            btnDelete.classList.toggle('opacity-40', !hasSelection);
            btnDelete.classList.toggle('cursor-not-allowed', !hasSelection);
            btnDelete.classList.toggle('text-red-500/50', !hasSelection);
            btnDelete.classList.toggle('text-red-400', hasSelection);
        }

        if (this.editingTracks.length === 0) {
            listEl.innerHTML = `
                <div class="p-8 text-center text-slate-400 bg-slate-900/40 rounded-xl border border-white/5">
                    <p class="text-sm font-medium">Esta lista no tiene canciones.</p>
                </div>
            `;
            return;
        }

        listEl.innerHTML = this.editingTracks.map((filename, index) => {
            const isSelected = index === this.selectedEditTrackIndex;
            const libTrack = this.libraryTracks ? this.libraryTracks.find(t => t.filename === filename) : null;
            let displayTitle = filename.replace(/\.(mp3|m4a|flac|wav|webm)$/i, '');
            if (libTrack) {
                const parsed = this.parseSongInfo(libTrack);
                if (parsed.title) {
                    displayTitle = (parsed.artist && parsed.artist !== 'Desconocido') ? `${parsed.artist} - ${parsed.title}` : parsed.title;
                }
            }

            return `
                <div onclick="window.app.selectEditTrack(${index})" 
                     class="py-2.5 px-3 border-b border-white/5 last:border-b-0 flex items-center justify-between gap-3 cursor-pointer rounded-xl transition ${
                         isSelected 
                         ? 'bg-purple-950/80 border border-purple-500/50 text-white shadow-md' 
                         : 'hover:bg-white/5 text-slate-200 border-transparent'
                     }">
                    <div class="flex items-center gap-2.5 min-w-0 flex-1">
                        <div class="w-4 h-4 rounded-full border ${isSelected ? 'border-purple-400 bg-purple-500' : 'border-slate-600'} flex items-center justify-center flex-shrink-0 transition">
                            ${isSelected ? '<div class="w-1.5 h-1.5 rounded-full bg-white"></div>' : ''}
                        </div>
                        <span class="text-xs sm:text-sm font-medium truncate" title="${this.escapeHtml(displayTitle)}">${this.escapeHtml(displayTitle)}</span>
                    </div>
                </div>
            `;
        }).join('');
    }

    moveSelectedTrack(direction) {
        if (this.selectedEditTrackIndex === null) return;
        const targetIndex = this.selectedEditTrackIndex + direction;
        if (targetIndex < 0 || targetIndex >= this.editingTracks.length) return;

        const temp = this.editingTracks[this.selectedEditTrackIndex];
        this.editingTracks[this.selectedEditTrackIndex] = this.editingTracks[targetIndex];
        this.editingTracks[targetIndex] = temp;

        this.selectedEditTrackIndex = targetIndex;
        this.renderEditPlaylistTracks();
    }

    removeSelectedTrack() {
        if (this.selectedEditTrackIndex === null) return;
        this.editingTracks.splice(this.selectedEditTrackIndex, 1);

        if (this.editingTracks.length === 0) {
            this.selectedEditTrackIndex = null;
        } else if (this.selectedEditTrackIndex >= this.editingTracks.length) {
            this.selectedEditTrackIndex = this.editingTracks.length - 1;
        }

        this.renderEditPlaylistTracks();
    }

    async saveEditedPlaylist() {
        if (!this.editingPlaylistId) return;

        try {
            const res = await this.customFetch(`/api/playlists/${this.editingPlaylistId}/tracks`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tracks: this.editingTracks })
            });

            if (!res.ok) throw new Error("Error guardando cambios de la lista");

            const pl = this.playlists.find(p => p.id === this.editingPlaylistId);
            if (pl) pl.tracks = [...this.editingTracks];

            this.showNotification('Lista actualizada correctamente', 'success');
            document.getElementById('modal-edit-playlist').classList.add('hidden');
            this.renderPlaylistsGrid();
        } catch (err) {
            console.error("Error updating playlist:", err);
            this.showNotification('Error al guardar los cambios de la lista', 'error');
        }
    }

    showNotification(message, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        let bgClass = 'bg-slate-800 text-white border-slate-700';
        if (type === 'success') bgClass = 'bg-emerald-950/90 text-emerald-200 border-emerald-500/40';
        else if (type === 'error') bgClass = 'bg-red-950/90 text-red-200 border-red-500/40';

        toast.className = `p-3.5 rounded-xl border backdrop-blur-md shadow-2xl text-xs font-medium flex items-center gap-2 transition-all duration-300 transform translate-y-2 opacity-0 ${bgClass}`;
        toast.innerHTML = message;

        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.remove('translate-y-2', 'opacity-0');
        }, 10);

        setTimeout(() => {
            toast.classList.add('opacity-0', 'translate-y-2');
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    }

    escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str).replace(/[&<>"']/g, function(m) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
        });
    }

    escapeJs(str) {
        if (str === null || str === undefined) return '';
        return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    }

    async loadSettingsView() {
        this.refreshPlaybackSettingsUI();
        await this.loadStorageView();
    }

    refreshPlaybackSettingsUI() {
        // Trim silence setting
        const trimCheckbox = document.getElementById('setting-trim-silence');
        const isTrimEnabled = window.player ? !!window.player.trimSilence : (localStorage.getItem('music_app_trim_silence') === 'true');
        if (trimCheckbox) {
            trimCheckbox.checked = isTrimEnabled;
        }

        // Volume normalization setting
        const normCheckbox = document.getElementById('setting-normalize-volume');
        const isNormEnabled = window.player ? !!window.player.normalizeVolume : (localStorage.getItem('music_app_normalize_volume') === 'true');
        if (normCheckbox) {
            normCheckbox.checked = isNormEnabled;
        }

        // Loading beep setting
        const beepCheckbox = document.getElementById('setting-loading-beep');
        const isBeepEnabled = window.player ? !!window.player.loadingBeepEnabled : (localStorage.getItem('music_app_loading_beep') === 'true');
        if (beepCheckbox) {
            beepCheckbox.checked = isBeepEnabled;
        }

        // Modal preview setting
        const previewCheckbox = document.getElementById('setting-modal-preview');
        if (previewCheckbox) {
            previewCheckbox.checked = this.modalPreviewEnabled;
        }

        // Postpone uncached setting
        const postponeCheckbox = document.getElementById('setting-postpone-uncached');
        const isPostponeEnabled = window.player ? !!window.player.postponeUncached : (localStorage.getItem('music_app_postpone_uncached') === 'true');
        if (postponeCheckbox) {
            postponeCheckbox.checked = isPostponeEnabled;
        }
    }

    toggleTrimSilenceSetting(checked) {
        if (window.player && typeof window.player.setTrimSilence === 'function') {
            window.player.setTrimSilence(checked);
        } else {
            localStorage.setItem('music_app_trim_silence', checked ? 'true' : 'false');
        }
        this.showToast(checked ? 'Eliminación de silencios activada' : 'Eliminación de silencios desactivada', 'info');
        this.saveUserState();
    }

    toggleNormalizeVolumeSetting(checked) {
        if (window.player && typeof window.player.setNormalizeVolume === 'function') {
            window.player.setNormalizeVolume(checked);
        } else {
            localStorage.setItem('music_app_normalize_volume', checked ? 'true' : 'false');
        }
        this.showToast(checked ? 'Normalización de volumen activada' : 'Normalización de volumen desactivada', 'info');
        this.saveUserState();
    }

    toggleLoadingBeepSetting(checked) {
        if (window.player && typeof window.player.setLoadingBeep === 'function') {
            window.player.setLoadingBeep(checked);
        } else {
            localStorage.setItem('music_app_loading_beep', checked ? 'true' : 'false');
        }
        this.showToast(checked ? 'Sonido de carga activado' : 'Sonido de carga desactivado', 'info');
        this.saveUserState();
    }

    toggleModalPreviewSetting(checked) {
        this.modalPreviewEnabled = !!checked;
        localStorage.setItem('music_app_modal_preview', this.modalPreviewEnabled ? 'true' : 'false');
        this.refreshPlaybackSettingsUI();
        this.showToast(this.modalPreviewEnabled ? 'Preescucha en fichas activada' : 'Preescucha en fichas desactivada', 'info');
        this.saveUserState();
    }

    togglePostponeUncachedSetting(checked) {
        if (window.player && typeof window.player.setPostponeUncached === 'function') {
            window.player.setPostponeUncached(checked);
        } else {
            localStorage.setItem('music_app_postpone_uncached', checked ? 'true' : 'false');
        }
        this.showToast(checked ? 'Postponer canciones no cacheadas activado' : 'Postponer canciones no cacheadas desactivado', 'info');
        this.saveUserState();
    }

    async loadStorageView() {
        if (this.storageManager) {
            this.storageManager.updateDataUsageUI();
            this.storageManager.refreshLocalStorageUI();

            const ttlSelect = document.getElementById('local-ttl-select');
            const limitSelect = document.getElementById('local-limit-select');
            if (ttlSelect) ttlSelect.value = this.storageManager.localTtlDays.toString();
            if (limitSelect) limitSelect.value = this.storageManager.localLimit.toString();
        }

        this.loadNavidromeStatus();

        try {
            const res = await this.customFetch('/api/storage/cloud_settings');
            const data = await res.json();

            const usedStr = document.getElementById('cloud-storage-used-str');
            const limitStr = document.getElementById('cloud-storage-limit-str');
            const bar = document.getElementById('cloud-storage-progress-bar');
            const select = document.getElementById('cloud-limit-select');

            const usedBytes = data.total_size_bytes || 0;
            const limitBytes = data.storage_limit_bytes || 0;

            if (usedStr && this.storageManager) usedStr.textContent = this.storageManager.formatBytes(usedBytes);
            if (limitStr && this.storageManager) {
                limitStr.textContent = 'Límite: ' + (limitBytes > 0 ? this.storageManager.formatBytes(limitBytes) : 'Sin límite');
            }
            if (select) select.value = limitBytes.toString();

            if (bar) {
                const percent = limitBytes > 0 ? Math.min(100, (usedBytes / limitBytes) * 100) : (usedBytes > 0 ? 100 : 0);
                bar.style.width = percent + '%';
            }
        } catch (err) {
            console.error("Error loading cloud storage settings:", err);
        }
    }

    updateLocalStorageSettings() {
        const ttlSelect = document.getElementById('local-ttl-select');
        const limitSelect = document.getElementById('local-limit-select');
        if (ttlSelect && this.storageManager) {
            this.storageManager.localTtlDays = parseInt(ttlSelect.value, 10);
            localStorage.setItem('music_app_local_ttl', ttlSelect.value);
        }
        if (limitSelect && this.storageManager) {
            this.storageManager.localLimit = parseInt(limitSelect.value, 10);
            localStorage.setItem('music_app_local_limit', limitSelect.value);
        }
        if (this.storageManager) {
            this.storageManager.autoCleanOfflineCache();
        }
        this.showToast('Configuración de caché local actualizada');
    }

    async clearLocalOfflineCache() {
        if (this.storageManager) {
            await this.storageManager.clearAllOfflineCache();
            this.showToast('Caché offline local del móvil vaciada');
        }
    }

    resetDataCounters() {
        if (this.storageManager) {
            this.storageManager.resetDataCounters();
            this.showToast('Contadores de consumo de datos restablecidos');
        }
    }

    async updateCloudStorageLimit() {
        const select = document.getElementById('cloud-limit-select');
        if (!select) return;

        const limitBytes = parseInt(select.value, 10);
        try {
            const res = await this.customFetch('/api/storage/cloud_settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ storage_limit_bytes: limitBytes })
            });
            const data = await res.json();
            if (data.deleted_count > 0) {
                this.showToast(`Límite aplicado: Se eliminaron ${data.deleted_count} canciones antiguas (${this.storageManager ? this.storageManager.formatBytes(data.freed_bytes) : ''} liberados)`, 'warning');
                this.loadLibrary();
            } else {
                this.showToast('Límite de almacenamiento en la nube guardado');
            }
            this.loadStorageView();
        } catch (err) {
            this.showToast('Error al actualizar límite en la nube', 'error');
        }
    }

    async cleanCloudStorageNow() {
        try {
            const res = await this.customFetch('/api/storage/clean_cloud', { method: 'POST' });
            const data = await res.json();
            if (data.deleted_count > 0) {
                this.showToast(`Limpieza completada: ${data.deleted_count} canciones eliminadas (${this.storageManager ? this.storageManager.formatBytes(data.freed_bytes) : ''} liberados)`, 'success');
                this.loadLibrary();
            } else {
                this.showToast('Almacenamiento en la nube dentro del límite');
            }
            this.loadStorageView();
        } catch (err) {
            this.showToast('Error ejecutando limpieza en la nube', 'error');
        }
    }

    async loadNavidromeStatus() {
        const badge = document.getElementById('navidrome-status-badge');
        const countEl = document.getElementById('navidrome-track-count');
        try {
            const res = await this.customFetch('/api/navidrome/status');
            const data = await res.json();
            if (countEl) {
                countEl.innerText = `${data.synced_tracks || 0} pistas`;
            }
            if (badge) {
                if (data.running) {
                    badge.className = 'px-3 py-1 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex items-center gap-1.5 shadow';
                    badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span> Activo :4533';
                } else {
                    badge.className = 'px-3 py-1 rounded-full text-xs font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center gap-1.5 shadow';
                    badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-amber-400"></span> Iniciando...';
                }
            }
        } catch (err) {
            if (countEl) countEl.innerText = 'Consultando...';
        }
    }

    async rescanNavidrome() {
        const btn = document.getElementById('navidrome-rescan-btn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `
                <svg class="animate-spin w-3.5 h-3.5 text-white inline-block mr-1" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                </svg> Sincronizando...`;
        }
        try {
            const res = await this.customFetch('/api/navidrome/rescan', { method: 'POST' });
            const data = await res.json();
            if (res.ok && data.success) {
                this.showToast(`Navidrome sincronizado: ${data.synced_tracks} pistas listas para streaming`, 'success');
                const countEl = document.getElementById('navidrome-track-count');
                if (countEl) countEl.innerText = `${data.synced_tracks} pistas`;
                this.loadNavidromeStatus();
            } else {
                this.showToast(data.detail || 'Error al sincronizar Navidrome', 'warning');
            }
        } catch (err) {
            this.showToast('Error conectando con el servicio Navidrome', 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = `
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-indigo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="23 4 23 10 17 10"></polyline>
                        <polyline points="1 20 1 14 7 14"></polyline>
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                    </svg>
                    <span>Sincronizar Pistas</span>`;
            }
        }
    }
}

class StorageManager {
    constructor(app) {
        this.app = app;
        this.dbName = 'MusicAppOfflineDB';
        this.dbVersion = 1;
        this.db = null;
        this.cachedKeys = new Set();
        this.dataUsage = {
            wifi: parseInt(localStorage.getItem('music_app_wifi_bytes') || '0', 10),
            mobile: parseInt(localStorage.getItem('music_app_mobile_bytes') || '0', 10)
        };
        this.localLimit = parseInt(localStorage.getItem('music_app_local_limit') || '1073741824', 10);
        this.localTtlDays = parseInt(localStorage.getItem('music_app_local_ttl') || '30', 10);
        // Auto-fix previous misclassification where effectiveType '4g' put Wi-Fi bytes into mobile bytes
        if (!localStorage.getItem('music_app_fixed_connection_v2')) {
            localStorage.setItem('music_app_fixed_connection_v2', 'true');
            if (this.dataUsage.mobile > 0 && this.dataUsage.wifi === 0) {
                this.dataUsage.wifi = this.dataUsage.mobile;
                this.dataUsage.mobile = 0;
                localStorage.setItem('music_app_wifi_bytes', this.dataUsage.wifi.toString());
                localStorage.setItem('music_app_mobile_bytes', '0');
            }
        }
        this.initDb();
    }

    async ensureDb() {
        if (this.db) return this.db;
        if (this.dbPromise) return this.dbPromise;
        this.dbPromise = new Promise((resolve) => {
            const req = indexedDB.open(this.dbName, this.dbVersion);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('offline_tracks')) {
                    const store = db.createObjectStore('offline_tracks', { keyPath: 'filename' });
                    store.createIndex('lastListenedAt', 'lastListenedAt', { unique: false });
                }
            };
            req.onsuccess = (e) => {
                this.db = e.target.result;
                resolve(this.db);
            };
            req.onerror = (err) => {
                console.error("IndexedDB open error:", err);
                resolve(null);
            };
        });
        return this.dbPromise;
    }

    checkMonthlyDataReset() {
        const now = new Date();
        const currentMonthKey = `${now.getFullYear()}-${now.getMonth() + 1}`;
        const lastResetMonth = localStorage.getItem('music_app_last_data_reset_month');

        if (lastResetMonth !== currentMonthKey) {
            localStorage.setItem('music_app_last_data_reset_month', currentMonthKey);
            this.resetDataCounters();
            console.log(`[StorageManager] Monthly data counters auto-reset for ${currentMonthKey}`);
        }
    }

    async refreshCacheKeys() {
        const db = await this.ensureDb();
        if (!db) return new Set();
        return new Promise((resolve) => {
            const tx = db.transaction('offline_tracks', 'readonly');
            const store = tx.objectStore('offline_tracks');
            const req = store.getAll();
            req.onsuccess = () => {
                const keys = new Set();
                (req.result || []).forEach(item => {
                    if (item.filename) keys.add(item.filename);
                    if (item.metadata) {
                        if (item.metadata.filename) keys.add(item.metadata.filename);
                        if (item.metadata.id) keys.add(item.metadata.id);
                    }
                });
                this.cachedKeys = keys;
                resolve(this.cachedKeys);
            };
            req.onerror = () => resolve(new Set());
        });
    }

    async initDb() {
        this.checkMonthlyDataReset();
        const db = await this.ensureDb();
        if (db) {
            await this.refreshCacheKeys();
            this.autoCleanOfflineCache();
            this.updateDataUsageUI();
        }
    }

    isTrackCached(track) {
        if (!track) return false;
        if (!this.cachedKeys || this.cachedKeys.size === 0) return false;
        const trackKey = track.filename || track.id;
        if (trackKey && this.cachedKeys.has(trackKey)) return true;
        if (track.filename && this.cachedKeys.has(track.filename)) return true;
        if (track.id && this.cachedKeys.has(track.id)) return true;
        if (this.app && typeof this.app.getLibraryTrackForItem === 'function') {
            const libTrack = this.app.getLibraryTrackForItem(track);
            if (libTrack && libTrack.filename && this.cachedKeys.has(libTrack.filename)) {
                return true;
            }
        }
        return false;
    }

    async isTrackCachedAsync(track) {
        if (!track) return false;
        if (this.cachedKeys && this.cachedKeys.size > 0) {
            return this.isTrackCached(track);
        }
        await this.refreshCacheKeys();
        return this.isTrackCached(track);
    }

    recordNetworkUsage(bytesTransferred) {
        if (!bytesTransferred || bytesTransferred <= 0) return;
        const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        let isCellular = false;

        const isMobileDevice = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
            || (navigator.maxTouchPoints > 1 && window.innerWidth <= 1024);

        if (conn) {
            const type = conn.type ? String(conn.type).toLowerCase() : '';
            const effType = conn.effectiveType ? String(conn.effectiveType).toLowerCase() : '';

            if (['cellular', 'mobile', '2g', '3g', '4g', '5g', 'wimax'].includes(type)) {
                isCellular = true;
            } else if (['wifi', 'ethernet'].includes(type)) {
                isCellular = false;
            } else if (conn.saveData) {
                isCellular = true;
            } else if (isMobileDevice) {
                // In modern mobile browsers (Chrome on Android, iOS WebKit), conn.type is undefined/unknown.
                // On mobile devices without explicit Wi-Fi/Ethernet, classify active data transfers as mobile data.
                isCellular = true;
            }
        } else if (isMobileDevice) {
            // Mobile Safari / iOS PWA without NetworkInformation API
            isCellular = true;
        }

        if (isCellular) {
            this.dataUsage.mobile += bytesTransferred;
            localStorage.setItem('music_app_mobile_bytes', this.dataUsage.mobile.toString());
        } else {
            this.dataUsage.wifi += bytesTransferred;
            localStorage.setItem('music_app_wifi_bytes', this.dataUsage.wifi.toString());
        }
        this.updateDataUsageUI();
    }

    formatBytes(bytes) {
        if (!bytes || bytes <= 0) return '0.0 MB';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    updateDataUsageUI() {
        const wifiEl = document.getElementById('data-usage-wifi-str');
        const mobileEl = document.getElementById('data-usage-mobile-str');
        if (wifiEl) wifiEl.textContent = this.formatBytes(this.dataUsage.wifi);
        if (mobileEl) mobileEl.textContent = this.formatBytes(this.dataUsage.mobile);
    }

    resetDataCounters() {
        this.dataUsage.wifi = 0;
        this.dataUsage.mobile = 0;
        localStorage.setItem('music_app_wifi_bytes', '0');
        localStorage.setItem('music_app_mobile_bytes', '0');
        this.updateDataUsageUI();
    }

    async getOfflineTrack(filename) {
        const db = await this.ensureDb();
        if (!db) return null;
        return new Promise((resolve) => {
            const tx = db.transaction('offline_tracks', 'readonly');
            const store = tx.objectStore('offline_tracks');
            const req = store.get(filename);
            req.onsuccess = () => {
                if (req.result) {
                    this.touchOfflineTrack(filename);
                }
                resolve(req.result || null);
            };
            req.onerror = () => resolve(null);
        });
    }

    async saveOfflineTrack(filename, audioBlob, metadata = {}) {
        const db = await this.ensureDb();
        if (!db) return;
        const tx = db.transaction('offline_tracks', 'readwrite');
        const store = tx.objectStore('offline_tracks');
        store.put({
            filename,
            blob: audioBlob,
            size: audioBlob.size,
            lastListenedAt: Date.now(),
            addedAt: Date.now(),
            metadata
        });
        tx.oncomplete = () => {
            if (this.cachedKeys) {
                this.cachedKeys.add(filename);
                if (metadata) {
                    if (metadata.filename) this.cachedKeys.add(metadata.filename);
                    if (metadata.id) this.cachedKeys.add(metadata.id);
                }
            }
            this.refreshLocalStorageUI();
            this.autoCleanOfflineCache();
            if (this.app) {
                if (typeof this.app.applyLibraryFilters === 'function' && this.app.libraryTracks) {
                    this.app.applyLibraryFilters();
                }
                if (this.app.currentTab === 'settings' || this.app.currentTab === 'storage') {
                    if (typeof this.app.loadSettingsView === 'function') {
                        this.app.loadSettingsView();
                    }
                }
            }
            if (window.player && typeof window.player.renderQueue === 'function') {
                window.player.renderQueue();
            }
        };
    }

    async touchOfflineTrack(filename) {
        const db = await this.ensureDb();
        if (!db) return;
        const tx = db.transaction('offline_tracks', 'readwrite');
        const store = tx.objectStore('offline_tracks');
        const req = store.get(filename);
        req.onsuccess = () => {
            if (req.result) {
                req.result.lastListenedAt = Date.now();
                store.put(req.result);
            }
        };
    }

    async autoCleanOfflineCache() {
        const db = await this.ensureDb();
        if (!db) return;
        const tracks = await this.getAllOfflineTracks();
        const now = Date.now();
        let totalSize = 0;

        // 1. Inactivity TTL Expiration
        if (this.localTtlDays > 0) {
            const maxAgeMs = this.localTtlDays * 24 * 60 * 60 * 1000;
            for (const t of tracks) {
                if (now - (t.lastListenedAt || t.addedAt) > maxAgeMs) {
                    await this.deleteOfflineTrack(t.filename);
                }
            }
        }

        // 2. Max Size LRU Pruning
        const updatedTracks = await this.getAllOfflineTracks();
        updatedTracks.sort((a, b) => (a.lastListenedAt || a.addedAt) - (b.lastListenedAt || b.addedAt));
        totalSize = updatedTracks.reduce((acc, t) => acc + (t.size || 0), 0);

        if (this.localLimit > 0 && totalSize > this.localLimit) {
            for (const t of updatedTracks) {
                if (totalSize <= this.localLimit) break;
                await this.deleteOfflineTrack(t.filename);
                totalSize -= (t.size || 0);
            }
        }
        this.refreshLocalStorageUI();
    }

    async getAllOfflineTracks() {
        const db = await this.ensureDb();
        if (!db) return [];
        return new Promise((resolve) => {
            const tx = db.transaction('offline_tracks', 'readonly');
            const store = tx.objectStore('offline_tracks');
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
        });
    }

    async deleteOfflineTrack(filename) {
        const db = await this.ensureDb();
        if (!db) return;
        return new Promise((resolve) => {
            const tx = db.transaction('offline_tracks', 'readwrite');
            const store = tx.objectStore('offline_tracks');
            store.delete(filename);
            tx.oncomplete = () => {
                if (this.cachedKeys) this.cachedKeys.delete(filename);
                this.refreshLocalStorageUI();
                if (window.player && typeof window.player.renderQueue === 'function') {
                    window.player.renderQueue();
                }
                resolve();
            };
        });
    }

    async clearAllOfflineCache() {
        const db = await this.ensureDb();
        if (!db) return;
        const tx = db.transaction('offline_tracks', 'readwrite');
        const store = tx.objectStore('offline_tracks');
        store.clear();
        tx.oncomplete = () => {
            if (this.cachedKeys) this.cachedKeys.clear();
            this.refreshLocalStorageUI();
            if (window.player && typeof window.player.renderQueue === 'function') {
                window.player.renderQueue();
            }
        };
    }

    async refreshLocalStorageUI() {
        const tracks = await this.getAllOfflineTracks();
        const usedBytes = tracks.reduce((acc, t) => acc + (t.size || 0), 0);

        const usedStr = document.getElementById('local-storage-used-str');
        const limitStr = document.getElementById('local-storage-limit-str');
        const bar = document.getElementById('local-storage-progress-bar');
        const countEl = document.getElementById('local-cache-track-count');
        const listEl = document.getElementById('local-cache-track-list');

        if (usedStr) usedStr.textContent = this.formatBytes(usedBytes);
        if (countEl) countEl.textContent = `${tracks.length} items`;

        if (limitStr) {
            limitStr.textContent = (this.localLimit > 0 ? this.formatBytes(this.localLimit) : 'Sin límite');
        }

        if (bar) {
            const percent = this.localLimit > 0 ? Math.min(100, (usedBytes / this.localLimit) * 100) : (usedBytes > 0 ? 100 : 0);
            bar.style.width = percent + '%';
        }

        if (listEl) {
            if (tracks.length === 0) {
                listEl.innerHTML = '<p class="text-xs text-slate-500 italic text-center py-2">No hay canciones guardadas en la caché local del móvil.</p>';
            } else {
                listEl.innerHTML = tracks.map(t => {
                    const meta = t.metadata || {};
                    const title = meta.title || t.filename;
                    const artist = meta.artist || meta.channel || 'Desconocido';
                    const sizeStr = this.formatBytes(t.size || 0);
                    const safeFn = (t.filename || '').replace(/'/g, "\\'");
                    return `
                        <div class="flex items-center justify-between p-2 rounded-lg bg-slate-900/60 border border-white/5 text-xs">
                            <div class="min-w-0 flex-1 pr-2">
                                <p class="font-medium text-white truncate">${this.app.escapeHtml(title)}</p>
                                <p class="text-[10px] text-slate-400 truncate">${this.app.escapeHtml(artist)} &bull; ${sizeStr}</p>
                            </div>
                            <button onclick="window.app.storageManager.deleteOfflineTrack('${safeFn}')" class="p-1 text-slate-400 hover:text-red-400 transition" title="Quitar de caché">
                                <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                                </svg>
                            </button>
                        </div>
                    `;
                }).join('');
            }
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.app = new MusicApp();
});
