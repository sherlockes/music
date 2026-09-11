/**
 * Audio Player Manager for Music Docker App
 * Simplified native HTML5 audio player with forced pre-caching for flawless background & screen-off playback.
 */
class AudioPlayer {
    constructor() {
        // Dual native HTML5 Audio elements for seamless background transition & preloading
        this.audioA = new Audio();
        this.audioB = new Audio();
        this.audioA.preload = 'auto';
        this.audioB.preload = 'auto';
        this.audioA.volume = 1.0;
        this.audioB.volume = 1.0;
        this.userVolume = 1.0;

        this.currentAudio = this.audioA;
        this.nextAudio = this.audioB;
        this._primed = false;

        // Playback state
        this.playlist = [];
        this.currentIndex = -1;
        this.isPlaying = false;
        this.isLoading = false;

        // Preloaded next track state & sequence guards
        this._loadTrackSeq = 0;
        this._prepSeq = 0;
        this._preparedTrack = null; // { index, track, url, isBlob }
        this._preparedBlobUrl = null;
        this.currentBlobUrl = null;
        this._cachingPromises = new Map();

        // Listen & Ranking tracking
        this._currentTrackListened = false;
        this.backendPlayCounts = {};
        this.isSortByMonthlyPlays = localStorage.getItem('music_app_sort_by_monthly_plays') === 'true';
        this.monthlyPlaysSortDirection = localStorage.getItem('music_app_sort_monthly_direction') || 'desc';

        // Sleep Timer
        this.sleepTimerMode = null; // null | 'track_end' | 'playlist_end' | 30 | 60
        this.sleepTimerEndTimestamp = null;
        this.sleepTimerInterval = null;
        this.sleepTimerOriginalVolume = 1.0;
        this._sleepTimerFadeInterval = null;

        // Compatibility dummy flags & stubs for removed features
        this.isShuffle = false;
        this.isCacheOnly = false;
        this.isRepeat = false;
        this.trimSilence = false;
        this.normalizeVolume = false;
        this.loadingBeepEnabled = false;
        this.eqEnabled = false;

        // DOM Elements and events
        this.initDOMElements();
        this.bindEvents();
    }

    get audio() {
        return this.currentAudio;
    }

    set audio(el) {
        this.currentAudio = el;
    }

    initDOMElements() {
        this.elCover = document.getElementById('player-cover');
        this.elTitle = document.getElementById('player-title');
        this.elArtist = document.getElementById('player-artist');
        this.elPlayBtn = document.getElementById('player-play-btn');
        this.elPrevBtn = document.getElementById('player-prev-btn');
        this.elNextBtn = document.getElementById('player-next-btn');
        this.elSeekSlider = document.getElementById('player-seek-slider');
        this.elCurrTime = document.getElementById('player-curr-time');
        this.elDuration = document.getElementById('player-duration');
        this.elVolumeSlider = document.getElementById('player-volume-slider');
        this.elMuteBtn = document.getElementById('player-mute-btn');
        this.elQueueToggleBtn = document.getElementById('player-queue-btn');
        this.elQueueDrawer = document.getElementById('queue-drawer');
        this.elQueueCloseBtn = document.getElementById('queue-modal-close-btn');
        this.elQueueList = document.getElementById('queue-list');
        this.elSleepTimerBtn = document.getElementById('player-sleep-timer-btn');
        this.elSleepTimerBadge = document.getElementById('player-sleep-timer-badge');
        this.elSleepTimerModal = document.getElementById('modal-sleep-timer');
        this.elDeleteTrackBtn = document.getElementById('player-delete-track-btn');
        this.elQueueSortMonthlyBtn = document.getElementById('queue-sort-monthly-btn');
        this.elBottomPlayer = document.getElementById('bottom-player');

        this.updateSortMonthlyBtn();
        this.syncBackendPlayStats();

        if (this.currentIndex === -1 && this.elBottomPlayer) {
            this.elBottomPlayer.classList.add('hidden');
        }
    }

    bindEvents() {
        // Native event listeners bound to both dual audio elements
        const setupAudioListeners = (audioEl) => {
            audioEl.addEventListener('play', (e) => {
                if (e.target !== this.currentAudio) return;
                this.isPlaying = true;
                this.isLoading = false;
                this.updatePlayButton();
                this.renderQueue();
                this.updateMediaSessionPlaybackState();
            });

            audioEl.addEventListener('pause', (e) => {
                if (e.target !== this.currentAudio) return;
                if (audioEl.ended) return;
                this.isPlaying = false;
                this.isLoading = false;
                this.updatePlayButton();
                this.renderQueue();
                this.updateMediaSessionPlaybackState();
            });

            audioEl.addEventListener('waiting', (e) => {
                if (e.target !== this.currentAudio) return;
                this.isLoading = true;
                this.updatePlayButton();
            });

            audioEl.addEventListener('playing', (e) => {
                if (e.target !== this.currentAudio) return;
                this.isPlaying = true;
                this.isLoading = false;
                this.updatePlayButton();
                this.updateMediaSessionPlaybackState();
            });

            audioEl.addEventListener('timeupdate', (e) => {
                if (e.target !== this.currentAudio) return;
                this.onTimeUpdate();
            });

            audioEl.addEventListener('loadedmetadata', (e) => {
                if (e.target !== this.currentAudio) return;
                this.onLoadedMetadata();
            });

            audioEl.addEventListener('ended', (e) => {
                if (e.target !== this.currentAudio) return;
                this.onTrackEnded();
            });

            audioEl.addEventListener('error', (e) => {
                if (e.target !== this.currentAudio) return;
                this.onAudioError(e);
            });
        };

        setupAudioListeners(this.audioA);
        setupAudioListeners(this.audioB);

        // Visibility change listener: when user returns or unlocks phone
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                if (this.isPlaying && this.currentAudio && this.currentAudio.paused && !this.currentAudio.ended) {
                    console.log('[AudioPlayer] Visibility changed to visible: checking paused audio state...');
                    this.currentAudio.play().catch(e => console.debug('[AudioPlayer] Visibility resume error:', e));
                }
                this.updatePlayButton();
                this.renderQueue();
                this.updateTextMarquees();
            }
        });

        // Window resize: recompute text marquees
        window.addEventListener('resize', () => {
            if (this._marqueeResizeTimeout) clearTimeout(this._marqueeResizeTimeout);
            this._marqueeResizeTimeout = setTimeout(() => this.updateTextMarquees(), 100);
        });

        // Bottom player controls
        if (this.elPlayBtn) this.elPlayBtn.addEventListener('click', () => this.togglePlay());
        if (this.elPrevBtn) this.elPrevBtn.addEventListener('click', () => this.playPrevious());
        if (this.elNextBtn) this.elNextBtn.addEventListener('click', () => this.playNext());
        if (this.elDeleteTrackBtn) this.elDeleteTrackBtn.addEventListener('click', () => this.deleteCurrentTrack());

        // Seek slider
        if (this.elSeekSlider) {
            this.elSeekSlider.addEventListener('input', (e) => {
                const targetTime = (e.target.value / 100) * (this.audio.duration || 0);
                if (this.elCurrTime) this.elCurrTime.innerText = this.formatTime(targetTime);
            });
            this.elSeekSlider.addEventListener('change', (e) => {
                const targetTime = (e.target.value / 100) * (this.audio.duration || 0);
                this.audio.currentTime = targetTime;
                this.triggerSaveUserState();
            });
        }

        // Volume slider
        if (this.elVolumeSlider) {
            this.elVolumeSlider.addEventListener('input', (e) => {
                this.userVolume = parseFloat(e.target.value) / 100;
                this.applyVolume();
                this.audio.muted = false;
                this.updateVolumeIcon();
                this.triggerSaveUserState();
            });
        }

        // Mute button
        if (this.elMuteBtn) {
            this.elMuteBtn.addEventListener('click', () => {
                this.audio.muted = !this.audio.muted;
                this.updateVolumeIcon();
            });
        }

        // Cover click: open song detail modal
        if (this.elCover) {
            this.elCover.style.cursor = 'pointer';
            this.elCover.addEventListener('click', (e) => {
                e.stopPropagation();
                if (window.app && typeof window.app.openCurrentPlayerSongModal === 'function') {
                    window.app.openCurrentPlayerSongModal();
                }
            });
        }

        // Queue modal toggle & close
        if (this.elQueueToggleBtn) {
            this.elQueueToggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleQueueModal();
            });
        }
        if (this.elQueueCloseBtn) {
            this.elQueueCloseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.closeQueueModal();
            });
        }
        if (this.elQueueDrawer) {
            this.elQueueDrawer.addEventListener('click', (e) => {
                if (e.target === this.elQueueDrawer) {
                    this.closeQueueModal();
                }
            });
        }

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeQueueModal();
                this.closeSleepTimerModal();
                return;
            }

            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;

            if (e.code === 'Space') {
                e.preventDefault();
                this.togglePlay();
            } else if (e.code === 'ArrowRight' && e.shiftKey) {
                this.playNext();
            } else if (e.code === 'ArrowLeft' && e.shiftKey) {
                this.playPrevious();
            } else if (e.code === 'ArrowRight') {
                this.audio.currentTime = Math.min(this.audio.duration || 0, this.audio.currentTime + 5);
            } else if (e.code === 'ArrowLeft') {
                this.audio.currentTime = Math.max(0, this.audio.currentTime - 5);
            } else if (e.code === 'KeyM') {
                this.audio.muted = !this.audio.muted;
                this.updateVolumeIcon();
            }
        });

        // Media Session API for mobile lockscreen
        this.bindMediaSessionHandlers();
    }

    // ==========================================
    // NATIVE MEDIA SESSION (LOCKSCREEN CONTROLS)
    // ==========================================

    bindMediaSessionHandlers() {
        if (!('mediaSession' in navigator)) return;

        const actionHandlers = [
            ['play', () => this.play()],
            ['pause', () => this.pause()],
            ['stop', () => this.pause()],
            ['previoustrack', () => this.playPrevious()],
            ['nexttrack', () => this.playNext()],
            ['seekto', (details) => {
                if (details && details.seekTime !== undefined && this.audio) {
                    this.audio.currentTime = details.seekTime;
                    this.updateMediaSessionPosition();
                }
            }],
            ['seekbackward', (details) => {
                const skipTime = (details && details.seekOffset) ? details.seekOffset : 10;
                if (this.audio) {
                    this.audio.currentTime = Math.max(0, this.audio.currentTime - skipTime);
                    this.updateMediaSessionPosition();
                }
            }],
            ['seekforward', (details) => {
                const skipTime = (details && details.seekOffset) ? details.seekOffset : 10;
                if (this.audio) {
                    this.audio.currentTime = Math.min(this.audio.duration || 0, this.audio.currentTime + skipTime);
                    this.updateMediaSessionPosition();
                }
            }]
        ];

        for (const [action, handler] of actionHandlers) {
            try {
                navigator.mediaSession.setActionHandler(action, handler);
            } catch (err) {
                console.debug(`MediaSession handler for ${action} not supported:`, err);
            }
        }
    }

    updateMediaSession(track) {
        if (!('mediaSession' in navigator) || !track) return;

        let titleText = track.title || 'Canción Desconocida';
        let artistText = track.artist || track.channel || 'Desconocido';
        if (window.app && typeof window.app.parseSongInfo === 'function') {
            const parsed = window.app.parseSongInfo(track);
            titleText = parsed.title;
            artistText = parsed.artist;
        }

        let artworkUrl = `${window.location.origin}/static/icon-512.png`;
        if (track.thumbnail) {
            artworkUrl = track.thumbnail;
        } else if (track.has_cover && track.filename) {
            artworkUrl = `${window.location.origin}/api/library/cover/${encodeURIComponent(track.filename)}`;
        }

        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: titleText,
                artist: artistText,
                album: 'Music Cloud',
                artwork: [
                    { src: artworkUrl, sizes: '96x96', type: 'image/png' },
                    { src: artworkUrl, sizes: '128x128', type: 'image/png' },
                    { src: artworkUrl, sizes: '192x192', type: 'image/png' },
                    { src: artworkUrl, sizes: '256x256', type: 'image/png' },
                    { src: artworkUrl, sizes: '512x512', type: 'image/png' }
                ]
            });
        } catch (e) {
            console.debug("MediaSession metadata error:", e);
        }
    }

    updateMediaSessionPlaybackState() {
        if (!('mediaSession' in navigator)) return;
        try {
            navigator.mediaSession.playbackState = this.isPlaying ? 'playing' : 'paused';
        } catch (e) {}
    }

    updateMediaSessionPosition() {
        if (!('mediaSession' in navigator) || !this.audio || isNaN(this.audio.duration)) return;
        if (document.hidden) {
            const now = Date.now();
            if (this._lastMediaSessionPositionUpdate && (now - this._lastMediaSessionPositionUpdate < 2500)) {
                return;
            }
            this._lastMediaSessionPositionUpdate = now;
        }
        try {
            if ('setPositionState' in navigator.mediaSession) {
                navigator.mediaSession.setPositionState({
                    duration: Math.max(0, this.audio.duration || 0),
                    playbackRate: this.audio.playbackRate || 1.0,
                    position: Math.max(0, Math.min(this.audio.duration || 0, this.audio.currentTime || 0))
                });
            }
        } catch (e) {}
    }

    // ==========================================
    // MANDATORY CACHING BEFORE PLAYBACK & PRE-CACHE
    // ==========================================

    getTrackKey(track) {
        if (!track) return null;
        if (track.filename) return track.filename;
        if (track.id) return track.id;
        if (track.youtube_id) return track.youtube_id;
        let title = track.title || '';
        let artist = track.artist || track.channel || '';
        if (window.app && typeof window.app.parseSongInfo === 'function') {
            const parsed = window.app.parseSongInfo(track);
            if (parsed.title) title = parsed.title;
            if (parsed.artist) artist = parsed.artist;
        }
        if (title && artist) return `${artist.trim()} - ${title.trim()}`;
        if (title) return title.trim();
        return null;
    }

    getStreamUrl(track) {
        if (!track) return '';
        if (track.filename) {
            return `/api/stream/${encodeURIComponent(track.filename)}`;
        }
        if (track.id) {
            return `/api/stream_yt?v=${encodeURIComponent(track.id)}`;
        }
        if (track.youtube_id) {
            return `/api/stream_yt?v=${encodeURIComponent(track.youtube_id)}`;
        }
        let title = track.title || '';
        let artist = track.artist || track.channel || '';
        if (window.app && typeof window.app.parseSongInfo === 'function') {
            const parsed = window.app.parseSongInfo(track);
            if (parsed.title) title = parsed.title;
            if (parsed.artist) artist = parsed.artist;
        }
        const query = `${artist} ${title}`.trim();
        if (query) {
            return `/api/stream_yt?v=${encodeURIComponent(query)}`;
        }
        return '';
    }

    isTrackCached(track) {
        if (!track) return false;
        if (window.app && window.app.storageManager) {
            return window.app.storageManager.isTrackCached(track);
        }
        return false;
    }

    async ensureTrackCached(track) {
        if (!track) return null;
        const trackKey = this.getTrackKey(track);
        if (!trackKey) return null;

        // 1. Check if already stored in IndexedDB offline cache
        if (window.app && window.app.storageManager) {
            try {
                let cached = await window.app.storageManager.getOfflineTrack(trackKey);
                if (!cached && track.filename && track.filename !== trackKey) {
                    cached = await window.app.storageManager.getOfflineTrack(track.filename);
                }
                if (!cached && track.id && track.id !== trackKey) {
                    cached = await window.app.storageManager.getOfflineTrack(track.id);
                }
                if (!cached && typeof window.app.getLibraryTrackForItem === 'function') {
                    const lib = window.app.getLibraryTrackForItem(track);
                    if (lib && lib.filename) {
                        cached = await window.app.storageManager.getOfflineTrack(lib.filename);
                    }
                }
                if (cached && cached.blob && cached.blob.size > 1000) {
                    return cached.blob;
                }
            } catch (e) {
                console.warn("[AudioPlayer] Error checking offline cache:", e);
            }
        }

        // 2. If a download is already in flight for this trackKey, await that promise
        if (this._cachingPromises.has(trackKey)) {
            return this._cachingPromises.get(trackKey);
        }

        // 3. Download and save to IndexedDB before playback
        const streamUrl = this.getStreamUrl(track);
        if (!streamUrl) return null;

        const cachePromise = (async () => {
            try {
                console.log(`[AudioPlayer] Caching track '${trackKey}' in local storage...`);
                const fetcher = (window.app && window.app.customFetch) ? window.app.customFetch.bind(window.app) : fetch;
                const res = await fetcher(streamUrl, {}, 120000);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const blob = await res.blob();
                if (blob && blob.size > 1000) {
                    if (window.app && window.app.storageManager) {
                        await window.app.storageManager.saveOfflineTrack(trackKey, blob, track);
                        window.app.storageManager.recordNetworkUsage(blob.size);
                    }
                    console.log(`[AudioPlayer] Track '${trackKey}' successfully cached (${blob.size} bytes).`);
                    if (!document.hidden) {
                        this.renderQueue();
                    }
                    return blob;
                }
                return null;
            } catch (err) {
                console.error(`[AudioPlayer] Failed caching track '${trackKey}':`, err);
                return null;
            } finally {
                this._cachingPromises.delete(trackKey);
            }
        })();

        this._cachingPromises.set(trackKey, cachePromise);
        return cachePromise;
    }

    preCacheNextTrack() {}
    backgroundCacheTrack() {}

    // ==========================================
    // SEAMLESS DUAL-AUDIO PRELOADING & PLAYBACK
    // ==========================================

    _primeAudio() {
        if (this._primed) return;
        this._primed = true;

        // Unlock nextAudio so it retains background autoplay permissions on iOS & Android
        try {
            this.nextAudio.muted = true;
            const silentUri = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
            this.nextAudio.src = silentUri;
            const p = this.nextAudio.play();
            if (p && p.then) {
                p.then(() => {
                    this.nextAudio.pause();
                    this.nextAudio.muted = false;
                    this.nextAudio.removeAttribute('src');
                }).catch(() => {
                    this.nextAudio.muted = false;
                });
            } else {
                this.nextAudio.pause();
                this.nextAudio.muted = false;
                this.nextAudio.removeAttribute('src');
            }
            console.log('[AudioPlayer] Audio elements primed for background playback.');
        } catch (e) {
            console.debug('[AudioPlayer] Audio priming failed:', e);
        }
    }

    updatePlayerUI(track) {
        if (!track) return;

        // Ensure bottom player is visible
        if (this.elBottomPlayer) {
            this.elBottomPlayer.classList.remove('hidden');
        }

        // Format and render title and artist
        let titleText = track.title || 'Canción Desconocida';
        let artistText = track.artist || track.channel || 'Desconocido';
        if (window.app && typeof window.app.parseSongInfo === 'function') {
            const parsed = window.app.parseSongInfo(track);
            titleText = parsed.title;
            artistText = parsed.artist;
        }

        if (this.elTitle) this.elTitle.innerText = titleText;
        if (this.elArtist) this.elArtist.innerText = artistText;
        this.updateTextMarquees();

        // Update cover
        if (this.elCover) {
            if (track.thumbnail) {
                this.elCover.src = track.thumbnail;
            } else if (track.has_cover && track.filename) {
                this.elCover.src = `/api/library/cover/${encodeURIComponent(track.filename)}`;
            } else {
                this.elCover.src = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="%238b5cf6" stroke-width="1.5"><rect width="18" height="18" x="3" y="3" rx="2" fill="%231e1b4b"/><circle cx="12" cy="12" r="4"/><polygon points="10 10 15 12 10 14 10 10"/></svg>`;
            }
        }

        this.updateMediaSession(track);
        if (!document.hidden) {
            this.renderQueue();
        }
        this.triggerSaveUserState();
    }

    async prepareNextTrack() {
        if (!this.playlist || this.playlist.length <= 1) {
            this._preparedTrack = null;
            return;
        }

        const nextIndex = (this.currentIndex + 1) % this.playlist.length;
        const nextTrack = this.playlist[nextIndex];
        if (!nextTrack) return;

        // Already prepared for this exact index and track
        if (this._preparedTrack && this._preparedTrack.index === nextIndex && this.isSameTrack(this._preparedTrack.track, nextTrack)) {
            return;
        }

        const seq = ++this._prepSeq;
        let playUrl = null;
        let blobUrl = null;

        // 1. Check if track is cached in IndexedDB
        if (window.app && window.app.storageManager && window.app.storageManager.isTrackCached(nextTrack)) {
            try {
                const trackKey = this.getTrackKey(nextTrack);
                const cached = await window.app.storageManager.getOfflineTrack(trackKey);
                if (cached && cached.blob && cached.blob.size > 1000) {
                    blobUrl = URL.createObjectURL(cached.blob);
                    playUrl = blobUrl;
                }
            } catch (e) {
                console.debug("[AudioPlayer] Error retrieving offline track for prep:", e);
            }
        }

        // 2. Fallback to direct HTTP range stream
        if (!playUrl) {
            playUrl = this.getStreamUrl(nextTrack);
        }

        if (this._prepSeq !== seq) {
            if (blobUrl) try { URL.revokeObjectURL(blobUrl); } catch (e) {}
            return;
        }

        if (this._preparedBlobUrl && this._preparedBlobUrl !== blobUrl) {
            try { URL.revokeObjectURL(this._preparedBlobUrl); } catch (e) {}
        }
        this._preparedBlobUrl = blobUrl;

        this._preparedTrack = {
            index: nextIndex,
            track: nextTrack,
            url: playUrl,
            isBlob: !!blobUrl
        };

        // Assign to nextAudio and buffer in background
        try {
            this.nextAudio.preload = 'auto';
            this.nextAudio.src = playUrl;
            this.nextAudio.load();
            console.log(`[AudioPlayer] Preloaded next track #${nextIndex + 1} (${nextTrack.title || nextTrack.filename}) on standby audio.`);
        } catch (e) {
            console.warn('[AudioPlayer] Error preloading next track:', e);
        }
    }

    _transitionToPreparedTrack() {
        const prepared = this._preparedTrack;
        this._preparedTrack = null;

        const oldAudio = this.currentAudio;
        // Swap currentAudio and nextAudio references immediately
        this.currentAudio = this.nextAudio;
        this.nextAudio = oldAudio;

        // Clean up previous audio element
        try {
            oldAudio.pause();
            oldAudio.removeAttribute('src');
            oldAudio.load();
        } catch (e) {}

        if (this.currentBlobUrl && this.currentBlobUrl !== prepared.url) {
            try { URL.revokeObjectURL(this.currentBlobUrl); } catch (e) {}
        }
        this.currentBlobUrl = prepared.isBlob ? prepared.url : null;
        this._preparedBlobUrl = null;

        this.currentIndex = prepared.index;
        this._currentTrackListened = false;

        // Apply volume to active player
        this.applyVolume();

        // 1. Play synchronously within the same event tick!
        this.play();

        // 2. Update UI and MediaSession
        this.updatePlayerUI(prepared.track);

        // 3. Preload the subsequent track on the now-idle nextAudio
        this.prepareNextTrack();
    }

    async loadTrack(index, autoPlay = true) {
        if (index < 0 || index >= this.playlist.length) return;

        const seq = ++this._loadTrackSeq;
        this.currentIndex = index;
        const track = this.playlist[this.currentIndex];
        this._currentTrackListened = false;

        this.isLoading = true;
        this.updatePlayButton();
        this.updatePlayerUI(track);

        // 1. Check if track is ALREADY in offline IndexedDB cache
        let playUrl = null;
        let isBlob = false;
        if (window.app && window.app.storageManager && window.app.storageManager.isTrackCached(track)) {
            try {
                const trackKey = this.getTrackKey(track);
                const cached = await window.app.storageManager.getOfflineTrack(trackKey);
                if (cached && cached.blob && cached.blob.size > 1000) {
                    if (this.currentBlobUrl) {
                        try { URL.revokeObjectURL(this.currentBlobUrl); } catch (e) {}
                    }
                    this.currentBlobUrl = URL.createObjectURL(cached.blob);
                    playUrl = this.currentBlobUrl;
                    isBlob = true;
                }
            } catch (e) {
                console.debug("[AudioPlayer] Offline cache check skipped:", e);
            }
        }

        // 2. Fallback to direct HTTP range stream
        if (!playUrl) {
            if (this.currentBlobUrl) {
                try { URL.revokeObjectURL(this.currentBlobUrl); } catch (e) {}
                this.currentBlobUrl = null;
            }
            playUrl = this.getStreamUrl(track);
        }

        if (this._loadTrackSeq !== seq) return;

        this.currentAudio.src = playUrl;

        if (autoPlay) {
            this.play();
        } else {
            this.isLoading = false;
            this.isPlaying = false;
            this.updatePlayButton();
        }

        // Preload next track in background
        this.prepareNextTrack();
    }

    async play() {
        if (!this.currentAudio || !this.currentAudio.src) return;
        this._primeAudio();

        try {
            console.log('[AudioPlayer] play()', {
                hidden: document.hidden,
                paused: this.currentAudio.paused,
                readyState: this.currentAudio.readyState,
                networkState: this.currentAudio.networkState,
                src: (this.currentAudio.src || '').substring(0, 80)
            });

            await this.currentAudio.play();

            console.log('[AudioPlayer] PLAY OK', {
                currentTime: this.currentAudio.currentTime,
                readyState: this.currentAudio.readyState
            });

            this.isPlaying = true;
            this.isLoading = false;
            this.updatePlayButton();
            this.triggerSaveUserState();

        } catch (err) {
            console.error('[AudioPlayer] PLAY FAILED', {
                name: err?.name,
                message: err?.message,
                hidden: document.hidden,
                readyState: this.currentAudio ? this.currentAudio.readyState : null,
                networkState: this.currentAudio ? this.currentAudio.networkState : null
            });

            this.isPlaying = false;
            this.isLoading = false;
            this.updatePlayButton();
        }
    }

    pause() {
        if (this.currentAudio) {
            this.currentAudio.pause();
        }
        this.isPlaying = false;
        this.isLoading = false;
        this.updatePlayButton();
        this.triggerSaveUserState();
    }

    togglePlay() {
        this._primeAudio();
        if (this.currentIndex === -1 && this.playlist.length > 0) {
            this.loadTrack(0, true);
            return;
        }
        if (!this.currentAudio || !this.currentAudio.src) return;

        if (this.currentAudio.paused) {
            this.play();
        } else {
            this.pause();
        }
    }

    playNext(autoPlay = true) {
        if (!this.playlist || this.playlist.length === 0) return;
        const nextIdx = (this.currentIndex + 1) % this.playlist.length;
        if (autoPlay && this._preparedTrack && this._preparedTrack.index === nextIdx) {
            this._transitionToPreparedTrack();
        } else {
            this.loadTrack(nextIdx, autoPlay);
        }
    }

    playPrevious() {
        if (!this.playlist || this.playlist.length === 0) return;
        if (this.currentAudio && this.currentAudio.currentTime > 3) {
            this.currentAudio.currentTime = 0;
            return;
        }
        const prevIdx = (this.currentIndex - 1 + this.playlist.length) % this.playlist.length;
        this.loadTrack(prevIdx, true);
    }

    applyVolume() {
        const vol = Math.max(0.0, Math.min(1.0, this.userVolume));
        if (this.audioA) this.audioA.volume = vol;
        if (this.audioB) this.audioB.volume = vol;
    }

    // ==========================================
    // AUDIO EVENTS
    // ==========================================

    onTimeUpdate() {
        if (!this.currentAudio || !this.currentAudio.duration) return;
        const current = this.currentAudio.currentTime;
        const total = this.currentAudio.duration;
        const percent = (current / total) * 100;

        if (!document.hidden) {
            if (this.elSeekSlider) this.elSeekSlider.value = percent;
            if (this.elCurrTime) this.elCurrTime.innerText = this.formatTime(current);
        }

        this.updateMediaSessionPosition();

        // Listen threshold (15s or 50%) to register play event
        if (!this._currentTrackListened && (current >= 15 || (total > 0 && current >= total * 0.5))) {
            this._currentTrackListened = true;
            const currentTrack = (this.currentIndex >= 0 && this.currentIndex < this.playlist.length) ? this.playlist[this.currentIndex] : null;
            if (currentTrack) {
                this.recordTrackPlay(currentTrack);
            }
        }
    }

    onLoadedMetadata() {
        if (this.elDuration && this.currentAudio) {
            this.elDuration.innerText = this.formatTime(this.currentAudio.duration || 0);
        }
        this.updateMediaSessionPosition();
    }

    onTrackEnded() {
        console.log('[AudioPlayer] Track playback ended naturally');
        const currentTrack = (this.currentIndex >= 0 && this.currentIndex < this.playlist.length) ? this.playlist[this.currentIndex] : null;
        if (currentTrack) {
            this.recordTrackPlay(currentTrack);
        }

        // Check sleep timer
        if (this.sleepTimerMode === 'track_end') {
            this.triggerSleepTimerShutdown('Temporizador: Canción finalizada');
            return;
        }
        if (this.sleepTimerMode === 'playlist_end' && this.currentIndex >= this.playlist.length - 1) {
            this.triggerSleepTimerShutdown('Temporizador: Lista finalizada');
            return;
        }

        if (!this.playlist || this.playlist.length === 0) return;

        const nextIndex = (this.currentIndex + 1) % this.playlist.length;

        // Seamless zero-latency transition if preloaded
        if (this._preparedTrack && this._preparedTrack.index === nextIndex) {
            console.log(`[AudioPlayer] Executing seamless transition to #${nextIndex + 1}`);
            this._transitionToPreparedTrack();
        } else {
            console.log(`[AudioPlayer] Track #${nextIndex + 1} not preloaded; loading directly without async blocking`);
            this.currentIndex = nextIndex;
            const nextTrack = this.playlist[nextIndex];
            this.currentAudio.src = this.getStreamUrl(nextTrack);
            this.play();
            this.updatePlayerUI(nextTrack);
            this.prepareNextTrack();
        }
    }

    onAudioError(e) {
        console.error("[AudioPlayer] Playback error:", e);
        if (this.playlist && this.playlist.length > 1) {
            if (window.app && typeof window.app.showToast === 'function' && !document.hidden) {
                window.app.showToast("Error al reproducir. Pasando a la siguiente pista...", "warning");
            }
            this.playNext(true);
        } else {
            this.isLoading = false;
            this.isPlaying = false;
            this.updatePlayButton();
        }
    }

    // ==========================================
    // PLAYLIST & QUEUE MANAGEMENT
    // ==========================================

    setPlaylist(tracks, startIndex = 0, autoPlay = true) {
        this.playlist = tracks || [];
        this._preparedTrack = null;
        if (this._preparedBlobUrl) {
            try { URL.revokeObjectURL(this._preparedBlobUrl); } catch (e) {}
            this._preparedBlobUrl = null;
        }
        if (this.isSortByMonthlyPlays && this.playlist.length > 1) {
            this.sortByMonthlyPlays(false);
        }
        if (this.playlist.length > 0) {
            this.currentIndex = Math.min(Math.max(0, startIndex), this.playlist.length - 1);
            this.loadTrack(this.currentIndex, autoPlay);
        } else {
            this.currentIndex = -1;
        }
        this.renderQueue();
        this.triggerSaveUserState();
    }

    isSameTrack(a, b) {
        if (!a || !b) return false;
        if (a.filename && b.filename && a.filename === b.filename) return true;
        if (a.id && b.id && a.id === b.id) return true;
        if (a.title && b.title && a.artist && b.artist) {
            const clean = s => String(s).toLowerCase().trim().replace(/[\s\-_.,()]+/g, ' ');
            if (clean(a.title) === clean(b.title) && clean(a.artist) === clean(b.artist)) {
                return true;
            }
        }
        return false;
    }

    playNowWithResume(track) {
        if (!track) return;

        // Remove previous occurrences of same track to avoid duplicates
        for (let i = this.playlist.length - 1; i >= 0; i--) {
            if (this.isSameTrack(this.playlist[i], track)) {
                this.playlist.splice(i, 1);
                if (i < this.currentIndex) {
                    this.currentIndex--;
                }
            }
        }

        // Insert at next playback position
        let insertIdx = 0;
        if (this.playlist.length === 0 || this.currentIndex === -1) {
            this.playlist = [track];
            insertIdx = 0;
        } else {
            insertIdx = (this.currentIndex >= 0 && this.currentIndex < this.playlist.length)
                ? this.currentIndex + 1
                : this.playlist.length;
            this.playlist.splice(insertIdx, 0, track);
        }

        this.loadTrack(insertIdx, true);
        this.renderQueue();
        this.triggerSaveUserState();
    }

    playNextInQueue(track) {
        if (!track) return;

        if (this.playlist.length === 0 || this.currentIndex === -1) {
            this.playlist = [track];
            this.currentIndex = 0;
            this.loadTrack(0, true);
            return;
        }

        for (let i = this.playlist.length - 1; i >= 0; i--) {
            if (i !== this.currentIndex && this.isSameTrack(this.playlist[i], track)) {
                this.playlist.splice(i, 1);
                if (i < this.currentIndex) {
                    this.currentIndex--;
                }
            }
        }

        const insertIdx = (this.currentIndex >= 0 && this.currentIndex < this.playlist.length)
            ? this.currentIndex + 1
            : this.playlist.length;
        this.playlist.splice(insertIdx, 0, track);
        this.renderQueue();
        this.triggerSaveUserState();
        this.prepareNextTrack();
    }

    addToQueue(track) {
        if (!track) return;
        if (this.playlist.length === 0 || this.currentIndex === -1) {
            this.playlist = [track];
            this.currentIndex = 0;
            this.loadTrack(0, true);
            return;
        }
        this.playlist.push(track);
        this.renderQueue();
        this.triggerSaveUserState();
        this.prepareNextTrack();
    }

    removeFromQueue(index, silent = false) {
        if (index < 0 || index >= this.playlist.length) return;
        const removedTrack = this.playlist[index];
        const isCurrent = index === this.currentIndex;

        this.playlist.splice(index, 1);

        if (this.playlist.length === 0) {
            this.currentIndex = -1;
            if (this.currentBlobUrl) {
                try { URL.revokeObjectURL(this.currentBlobUrl); } catch (e) {}
                this.currentBlobUrl = null;
                this.activeBlob = null;
            }
            if (this._preparedBlobUrl) {
                try { URL.revokeObjectURL(this._preparedBlobUrl); } catch (e) {}
                this._preparedBlobUrl = null;
            }
            this._preparedTrack = null;
            if (this.audioA) {
                this.audioA.pause();
                this.audioA.removeAttribute('src');
                this.audioA.load();
            }
            if (this.audioB) {
                this.audioB.pause();
                this.audioB.removeAttribute('src');
                this.audioB.load();
            }
            this.isPlaying = false;
            this.updatePlayButton();
            if (this.elTitle) this.elTitle.innerText = 'No hay reproducción';
            if (this.elArtist) this.elArtist.innerText = '';
        } else if (isCurrent) {
            const newIndex = index < this.playlist.length ? index : 0;
            this.loadTrack(newIndex, true);
        } else {
            if (index < this.currentIndex) {
                this.currentIndex--;
            }
            this.prepareNextTrack();
        }

        this.renderQueue();
        this.triggerSaveUserState();
        if (!silent && window.app && typeof window.app.showToast === 'function') {
            window.app.showToast(`Quitada de la lista: ${removedTrack.title || 'Canción'}`, 'info');
        }
    }

    selectTrackFromQueue(index) {
        this.loadTrack(index, true);
        this.closeQueueModal();
    }

    async deleteCurrentTrack() {
        if (!this.playlist || this.playlist.length === 0 || this.currentIndex < 0 || this.currentIndex >= this.playlist.length) {
            if (window.app && typeof window.app.showToast === 'function') {
                window.app.showToast('No hay ninguna canción en reproducción', 'info');
            }
            return;
        }

        const track = this.playlist[this.currentIndex];
        if (!track) return;

        let title = track.title || track.filename || 'Canción';
        if (window.app && typeof window.app.parseSongInfo === 'function') {
            const parsed = window.app.parseSongInfo(track);
            title = parsed.title || title;
        }

        if (!confirm(`¿Eliminar '${title}' de la lista, caché y biblioteca?`)) {
            return;
        }

        let filename = track.filename || null;
        if (!filename && window.app && typeof window.app.getLibraryTrackForItem === 'function') {
            const lib = window.app.getLibraryTrackForItem(track);
            if (lib && lib.filename) filename = lib.filename;
        }

        const keysToDelete = new Set();
        if (filename) keysToDelete.add(filename);
        if (track.filename) keysToDelete.add(track.filename);
        if (track.id) keysToDelete.add(track.id);

        if (window.app && window.app.storageManager) {
            for (const k of keysToDelete) {
                try {
                    await window.app.storageManager.deleteOfflineTrack(k);
                } catch (e) {
                    console.debug("[AudioPlayer] Error deleting from offline cache:", e);
                }
            }
        }

        if (filename) {
            try {
                const fetcher = (window.app && window.app.customFetch) ? window.app.customFetch.bind(window.app) : fetch;
                await fetcher(`/api/library/${encodeURIComponent(filename)}`, { method: 'DELETE' });
            } catch (err) {
                console.error("[AudioPlayer] Error deleting track from server library:", err);
            }
        }

        const targetIndex = this.currentIndex;
        this.removeFromQueue(targetIndex, true);

        if (window.app) {
            if (typeof window.app.loadLibrary === 'function') window.app.loadLibrary();
            if (typeof window.app.showToast === 'function') {
                window.app.showToast(`'${title}' eliminada de la lista, caché y biblioteca`, 'success');
            }
        }
    }

    renderQueue() {
        if (document.hidden || !this.elQueueList) return;

        const countBadge = document.getElementById('queue-count-badge');
        if (countBadge) {
            countBadge.textContent = this.playlist.length;
        }

        if (this.playlist.length === 0) {
            this.elQueueList.innerHTML = `
                <div class="h-full min-h-[16rem] p-8 text-center text-sm text-slate-400 flex flex-col items-center justify-center gap-3">
                    <div class="w-14 h-14 rounded-2xl bg-purple-900/30 border border-purple-500/20 flex items-center justify-center">
                        <svg xmlns="http://www.w3.org/2000/svg" class="w-7 h-7 text-purple-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                        </svg>
                    </div>
                    <div>
                        <p class="font-medium text-slate-200">No hay pistas disponibles</p>
                        <p class="text-xs text-slate-500 mt-0.5">Selecciona canciones de la biblioteca o de tus listas para añadirlas.</p>
                    </div>
                </div>
            `;
            return;
        }

        this.elQueueList.innerHTML = this.playlist.map((track, i) => {
            const isActive = i === this.currentIndex;
            const isCached = this.isTrackCached(track);
            let statusIcon = `<span class="font-mono text-xs text-slate-400">${i + 1}</span>`;
            if (isActive) {
                if (this.isLoading) {
                    statusIcon = `<svg class="animate-spin w-4 h-4 text-purple-400 inline" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>`;
                } else if (this.isPlaying) {
                    statusIcon = `<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-purple-400 fill-current" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
                } else {
                    statusIcon = `<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-purple-400 fill-current" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
                }
            }

            let title = track.title || track.filename || 'Canción';
            let artist = track.artist || track.channel || 'Desconocido';
            if (window.app && typeof window.app.parseSongInfo === 'function') {
                const parsed = window.app.parseSongInfo(track);
                title = parsed.title;
                artist = parsed.artist;
            }

            let coverSrc = '';
            if (track.thumbnail) {
                coverSrc = track.thumbnail;
            } else if (track.has_cover && track.filename) {
                coverSrc = `/api/library/cover/${encodeURIComponent(track.filename)}`;
            }

            const playCount = this.getTrackPlayCountLastMonth(track);
            const playBadge = (playCount > 0 || this.isSortByMonthlyPlays) ? `
                <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold ${playCount > 0 ? 'bg-purple-500/20 text-purple-300 border-purple-500/30' : 'bg-slate-800/60 text-slate-400 border-slate-700/40'} border flex-shrink-0" title="${playCount} reproducción${playCount !== 1 ? 'es' : ''} en el último mes">
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-2.5 h-2.5 fill-current ${playCount > 0 ? 'text-purple-400' : 'text-slate-500'}" viewBox="0 0 24 24">
                        <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                    <span>${playCount}</span>
                </span>
            ` : '';

            return `
                <div class="group flex items-center justify-between gap-2 sm:gap-3 p-2 sm:p-2.5 rounded-xl transition ${isActive ? 'bg-purple-900/40 text-purple-200 border border-purple-500/40 shadow-sm' : 'hover:bg-white/5 text-slate-300 border border-transparent'}">
                    <div onclick="window.player.selectTrackFromQueue(${i})" class="flex items-center gap-2.5 sm:gap-3 flex-1 min-w-0 cursor-pointer">
                        <span class="w-5 sm:w-6 text-center ${isActive ? 'text-purple-400 font-bold' : 'text-slate-500'} flex items-center justify-center flex-shrink-0">${statusIcon}</span>
                        ${coverSrc ? `<img src="${coverSrc}" class="w-9 h-9 sm:w-10 sm:h-10 rounded-lg object-cover flex-shrink-0 shadow-sm border border-white/10" alt="cover" loading="lazy" />` : `<div class="w-9 h-9 sm:w-10 sm:h-10 rounded-lg bg-slate-800 border border-white/10 flex items-center justify-center flex-shrink-0 text-slate-500"><svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-purple-400/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="12" cy="12" r="3"/><polygon points="10 10 14 12 10 14 10 10"/></svg></div>`}
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-1.5 flex-wrap sm:flex-nowrap">
                                <p class="text-xs sm:text-sm font-semibold truncate leading-tight ${isActive ? 'text-purple-200 font-bold' : 'text-slate-200'}">${this.escapeHtml(title)}</p>
                                ${playBadge}
                                ${isCached ? `
                                    <span class="inline-flex items-center p-0.5 text-purple-400 flex-shrink-0" title="Guardada en caché local">
                                        <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                                            <polyline points="20 6 9 17 4 12"/>
                                        </svg>
                                    </span>
                                ` : ''}
                            </div>
                            <p class="text-[11px] sm:text-xs text-slate-400 truncate leading-tight mt-0.5">${this.escapeHtml(artist)}</p>
                        </div>
                    </div>
                    <div class="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
                        <span class="text-xs text-slate-400 font-mono hidden sm:inline">${track.duration_string || ''}</span>
                        <button onclick="event.stopPropagation(); window.player.removeFromQueue(${i})" 
                                class="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition cursor-pointer"
                                title="Quitar de la lista">
                            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                            </svg>
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    }

    openQueueModal() {
        const el = this.elQueueDrawer || document.getElementById('queue-drawer');
        if (!el) return;
        el.classList.remove('hidden');
        this.updateSortMonthlyBtn();
        this.renderQueue();
    }

    closeQueueModal() {
        const el = this.elQueueDrawer || document.getElementById('queue-drawer');
        if (!el) return;
        el.classList.add('hidden');
    }

    toggleQueueModal() {
        const el = this.elQueueDrawer || document.getElementById('queue-drawer');
        if (!el) return;
        if (el.classList.contains('hidden')) {
            this.openQueueModal();
        } else {
            this.closeQueueModal();
        }
    }

    // ==========================================
    // SLEEP TIMER
    // ==========================================

    openSleepTimerModal() {
        if (!this.elSleepTimerModal) {
            this.elSleepTimerModal = document.getElementById('modal-sleep-timer');
        }
        if (!this.elSleepTimerModal) return;

        this.updateSleepTimerModalUI();
        this.elSleepTimerModal.classList.remove('hidden');
    }

    closeSleepTimerModal() {
        if (!this.elSleepTimerModal) {
            this.elSleepTimerModal = document.getElementById('modal-sleep-timer');
        }
        if (this.elSleepTimerModal) {
            this.elSleepTimerModal.classList.add('hidden');
        }
    }

    updateSleepTimerModalUI() {
        const checkTrackEnd = document.getElementById('sleep-timer-check-track_end');
        const checkPlaylistEnd = document.getElementById('sleep-timer-check-playlist_end');
        const check30 = document.getElementById('sleep-timer-check-30');
        const check60 = document.getElementById('sleep-timer-check-60');
        const statusText = document.getElementById('sleep-timer-status-text');
        const cancelContainer = document.getElementById('sleep-timer-cancel-container');

        if (checkTrackEnd) checkTrackEnd.classList.toggle('hidden', this.sleepTimerMode !== 'track_end');
        if (checkPlaylistEnd) checkPlaylistEnd.classList.toggle('hidden', this.sleepTimerMode !== 'playlist_end');
        if (check30) check30.classList.toggle('hidden', this.sleepTimerMode !== 30);
        if (check60) check60.classList.toggle('hidden', this.sleepTimerMode !== 60);

        if (this.sleepTimerMode) {
            if (cancelContainer) cancelContainer.classList.remove('hidden');
            if (statusText) {
                if (this.sleepTimerMode === 'track_end') {
                    statusText.textContent = 'Activo: Se apagará al finalizar la canción actual';
                } else if (this.sleepTimerMode === 'playlist_end') {
                    statusText.textContent = 'Activo: Se apagará al finalizar la lista';
                } else if (typeof this.sleepTimerMode === 'number') {
                    const remainingMs = Math.max(0, (this.sleepTimerEndTimestamp || 0) - Date.now());
                    const mins = Math.ceil(remainingMs / 60000);
                    statusText.textContent = `Activo: Se apagará en aprox. ${mins} min`;
                }
            }
        } else {
            if (cancelContainer) cancelContainer.classList.add('hidden');
            if (statusText) statusText.textContent = 'No hay ningún temporizador programado';
        }
    }

    updateSleepTimerButtonUI() {
        const btn = document.getElementById('player-sleep-timer-btn');
        const badge = document.getElementById('player-sleep-timer-badge');

        if (this.sleepTimerMode) {
            if (btn) {
                btn.classList.remove('text-gray-400');
                btn.classList.add('text-purple-400', 'font-bold');
            }
            if (badge) badge.classList.remove('hidden');
        } else {
            if (btn) {
                btn.classList.remove('text-purple-400', 'font-bold');
                btn.classList.add('text-gray-400');
            }
            if (badge) badge.classList.add('hidden');
        }
    }

    setSleepTimer(mode) {
        this.cancelSleepTimer(false);

        let toastMsg = '';
        if (mode === 'track_end') {
            this.sleepTimerMode = 'track_end';
            toastMsg = 'Temporizador: Se detendrá al finalizar la canción';
        } else if (mode === 'playlist_end') {
            this.sleepTimerMode = 'playlist_end';
            toastMsg = 'Temporizador: Se detendrá al finalizar la lista';
        } else if (typeof mode === 'number') {
            this.sleepTimerMode = mode;
            this.sleepTimerEndTimestamp = Date.now() + (mode * 60 * 1000);
            this.sleepTimerInterval = setInterval(() => this.checkSleepTimerCountdown(), 1000);
            toastMsg = `Temporizador activado para ${mode} minutos`;
        }

        this.updateSleepTimerButtonUI();
        this.updateSleepTimerModalUI();
        this.closeSleepTimerModal();

        if (window.app && typeof window.app.showToast === 'function' && toastMsg) {
            window.app.showToast(toastMsg, 'info');
        }
    }

    cancelSleepTimer(showToast = true) {
        if (this.sleepTimerInterval) {
            clearInterval(this.sleepTimerInterval);
            this.sleepTimerInterval = null;
        }
        if (this._sleepTimerFadeInterval) {
            clearInterval(this._sleepTimerFadeInterval);
            this._sleepTimerFadeInterval = null;
        }

        if (this.audio && this.sleepTimerOriginalVolume !== undefined) {
            this.audio.volume = this.sleepTimerOriginalVolume;
        }

        this.sleepTimerMode = null;
        this.sleepTimerEndTimestamp = null;

        this.updateSleepTimerButtonUI();
        this.updateSleepTimerModalUI();
        this.closeSleepTimerModal();

        if (showToast && window.app && typeof window.app.showToast === 'function') {
            window.app.showToast('Temporizador desactivado', 'info');
        }
    }

    checkSleepTimerCountdown() {
        if (!this.sleepTimerEndTimestamp) return;

        const remainingMs = this.sleepTimerEndTimestamp - Date.now();
        const remainingSec = Math.round(remainingMs / 1000);

        if (remainingSec <= 6 && remainingSec > 0 && !this._sleepTimerFadeInterval) {
            this.sleepTimerOriginalVolume = this.audio.volume;
            let steps = 6;
            this._sleepTimerFadeInterval = setInterval(() => {
                steps--;
                if (this.audio && steps > 0) {
                    this.audio.volume = Math.max(0, this.audio.volume * 0.7);
                } else {
                    clearInterval(this._sleepTimerFadeInterval);
                    this._sleepTimerFadeInterval = null;
                }
            }, 1000);
        }

        if (remainingMs <= 0) {
            this.triggerSleepTimerShutdown('Temporizador: Tiempo cumplido, reproducción pausada');
        }
    }

    triggerSleepTimerShutdown(reason = 'Temporizador: Reproducción pausada') {
        const originalVol = this.sleepTimerOriginalVolume || 1.0;
        this.cancelSleepTimer(false);

        if (this.audio) {
            this.audio.pause();
            this.audio.volume = originalVol;
        }
        this.isPlaying = false;
        this.updatePlayButton();
        this.triggerSaveUserState();

        if (window.app && typeof window.app.showToast === 'function') {
            window.app.showToast(reason, 'info');
        }
    }

    // ==========================================
    // PLAY STATS & MONTHLY TOP RANKING
    // ==========================================

    getPlayHistory() {
        try {
            const raw = localStorage.getItem('music_app_play_history');
            if (raw) return JSON.parse(raw);
        } catch (e) {}
        return {};
    }

    savePlayHistory(history) {
        try {
            localStorage.setItem('music_app_play_history', JSON.stringify(history));
        } catch (e) {}
    }

    getTrackKeys(track) {
        if (!track) return [];
        const keys = new Set();
        if (track.filename) keys.add(track.filename);
        if (track.id) keys.add(String(track.id));
        if (track.youtube_id) keys.add(String(track.youtube_id));

        let title = track.title;
        let artist = track.artist;
        if (window.app && typeof window.app.parseSongInfo === 'function') {
            const parsed = window.app.parseSongInfo(track);
            if (parsed.title) title = parsed.title;
            if (parsed.artist) artist = parsed.artist;
        }

        if (title && artist) {
            keys.add(`${artist.trim().toLowerCase()} - ${title.trim().toLowerCase()}`);
        } else if (title) {
            keys.add(title.trim().toLowerCase());
        }

        if (window.app && typeof window.app.getLibraryTrackForItem === 'function') {
            const lib = window.app.getLibraryTrackForItem(track);
            if (lib && lib.filename) keys.add(lib.filename);
        }

        return Array.from(keys);
    }

    getTrackPlayCountLastMonth(track) {
        if (!track) return 0;
        const keys = this.getTrackKeys(track);
        if (keys.length === 0) return 0;

        const history = this.getPlayHistory();
        const now = Date.now();
        const cutoff = now - (30 * 24 * 60 * 60 * 1000); // 30 days

        const timestamps = new Set();
        keys.forEach(k => {
            const list = history[k];
            if (Array.isArray(list)) {
                list.forEach(ts => {
                    if (ts >= cutoff) {
                        timestamps.add(Math.floor(ts / 60000));
                    }
                });
            }
        });

        let total = timestamps.size;

        if (this.backendPlayCounts) {
            for (const k of keys) {
                if (typeof this.backendPlayCounts[k] === 'number') {
                    total = Math.max(total, this.backendPlayCounts[k]);
                }
            }
        }

        return total;
    }

    recordTrackPlay(track) {
        if (!track) return;
        const now = Date.now();
        const history = this.getPlayHistory();
        const keys = this.getTrackKeys(track);
        if (keys.length === 0) return;

        const primaryKey = keys[0];
        if (!history[primaryKey]) history[primaryKey] = [];
        history[primaryKey].push(now);

        const cutoff = now - (35 * 24 * 60 * 60 * 1000);
        for (const k in history) {
            history[k] = history[k].filter(ts => ts >= cutoff);
            if (history[k].length === 0) delete history[k];
        }

        this.savePlayHistory(history);

        try {
            const payload = {
                filename: track.filename || null,
                id: track.id || track.youtube_id || null,
                title: track.title || null,
                artist: track.artist || null
            };
            fetch('/api/track/listen', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).catch(() => {});
        } catch (e) {}

        const drawer = this.elQueueDrawer || document.getElementById('queue-drawer');
        if (drawer && !drawer.classList.contains('hidden')) {
            this.renderQueue();
        }
    }

    async syncBackendPlayStats() {
        try {
            const res = await fetch('/api/tracks/play_stats');
            if (res.ok) {
                const data = await res.json();
                if (data && data.counts) {
                    this.backendPlayCounts = data.counts;
                    if (this.isSortByMonthlyPlays && this.playlist && this.playlist.length > 1) {
                        this.sortByMonthlyPlays(false);
                    } else {
                        this.renderQueue();
                    }
                }
            }
        } catch (e) {}
    }

    toggleSortByMonthlyPlays() {
        if (!this.playlist || this.playlist.length <= 1) {
            if (window.app && typeof window.app.showToast === 'function') {
                window.app.showToast('No hay suficientes pistas para ordenar', 'info');
            }
            return;
        }

        if (!this.isSortByMonthlyPlays) {
            this.isSortByMonthlyPlays = true;
            this.monthlyPlaysSortDirection = 'desc';
        } else {
            this.monthlyPlaysSortDirection = (this.monthlyPlaysSortDirection === 'desc') ? 'asc' : 'desc';
        }

        localStorage.setItem('music_app_sort_by_monthly_plays', 'true');
        localStorage.setItem('music_app_sort_monthly_direction', this.monthlyPlaysSortDirection);

        this.sortByMonthlyPlays(true);
        this.updateSortMonthlyBtn();
    }

    sortByMonthlyPlays(showToast = false) {
        if (!this.playlist || this.playlist.length <= 1) {
            this.renderQueue();
            if (showToast && window.app && typeof window.app.showToast === 'function') {
                window.app.showToast('No hay suficientes pistas para ordenar', 'info');
            }
            return;
        }

        const isDesc = this.monthlyPlaysSortDirection !== 'asc';
        const currentTrack = (this.currentIndex >= 0 && this.currentIndex < this.playlist.length)
            ? this.playlist[this.currentIndex]
            : null;

        const trackMeta = new Map();
        this.playlist.forEach((track, idx) => {
            trackMeta.set(track, {
                count: this.getTrackPlayCountLastMonth(track),
                originalIndex: idx
            });
        });

        this.playlist.sort((a, b) => {
            const aMeta = trackMeta.get(a) || { count: 0, originalIndex: 0 };
            const bMeta = trackMeta.get(b) || { count: 0, originalIndex: 0 };
            if (bMeta.count !== aMeta.count) {
                return isDesc ? (bMeta.count - aMeta.count) : (aMeta.count - bMeta.count);
            }
            return aMeta.originalIndex - bMeta.originalIndex;
        });

        if (currentTrack) {
            const newIndex = this.playlist.indexOf(currentTrack);
            if (newIndex !== -1) {
                this.currentIndex = newIndex;
            }
        }

        this.renderQueue();
        this.triggerSaveUserState();

        if (showToast && window.app && typeof window.app.showToast === 'function') {
            if (isDesc) {
                window.app.showToast('Pistas ordenadas de más a menos reproducciones', 'success');
            } else {
                window.app.showToast('Pistas ordenadas de menos a más reproducciones', 'success');
            }
        }
    }

    updateSortMonthlyBtn() {
        const btn = this.elQueueSortMonthlyBtn || document.getElementById('queue-sort-monthly-btn');
        if (!btn) return;

        const isDesc = this.monthlyPlaysSortDirection !== 'asc';
        const arrow = document.getElementById('queue-sort-monthly-arrow');
        const arrowDownSvg = '<path d="M12 5v14M19 12l-7 7-7-7"/>';
        const arrowUpSvg = '<path d="M12 19V5M5 12l7-7 7 7"/>';

        if (this.isSortByMonthlyPlays) {
            btn.className = 'px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition shadow-sm cursor-pointer bg-purple-600 hover:bg-purple-500 text-white border border-purple-400/40';
            if (isDesc) {
                btn.title = 'Pistas ordenadas de más a menos reproducciones (Top mes). Clic para ordenar de menos a más';
                if (arrow) arrow.innerHTML = arrowDownSvg;
            } else {
                btn.title = 'Pistas ordenadas de menos a más reproducciones. Clic para ordenar de más a menos';
                if (arrow) arrow.innerHTML = arrowUpSvg;
            }
        } else {
            btn.className = 'px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition shadow-sm cursor-pointer text-slate-300 hover:text-white bg-slate-800/80 hover:bg-white/10 border border-white/10';
            btn.title = 'Ordenar por reproducciones (Top mes)';
            if (arrow) arrow.innerHTML = isDesc ? arrowDownSvg : arrowUpSvg;
        }
    }

    // ==========================================
    // UI HELPERS & STATE
    // ==========================================

    updatePlayButton() {
        this.updateMediaSessionPlaybackState();
        if (!this.elPlayBtn) return;
        if (this.isLoading) {
            this.elPlayBtn.innerHTML = `
                <svg class="animate-spin w-6 h-6 text-purple-300" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
            `;
        } else if (this.isPlaying) {
            this.elPlayBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6 fill-current" viewBox="0 0 24 24">
                    <rect x="6" y="4" width="4" height="16" rx="1"/>
                    <rect x="14" y="4" width="4" height="16" rx="1"/>
                </svg>
            `;
        } else {
            this.elPlayBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6 fill-current ml-0.5" viewBox="0 0 24 24">
                    <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
            `;
        }
    }

    updateVolumeIcon() {
        if (!this.elMuteBtn) return;
        const vol = this.audio.volume;
        if (this.audio.muted || vol === 0) {
            this.elMuteBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;
        } else if (vol < 0.5) {
            this.elMuteBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-gray-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
        } else {
            this.elMuteBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-gray-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
        }
    }

    updateMarquee(element) {
        if (!element) return;
        const wrapper = element.parentElement;
        if (!wrapper) return;

        element.classList.remove('is-scrolling');
        wrapper.classList.remove('has-overflow');
        element.style.removeProperty('--marquee-distance');
        element.style.removeProperty('--marquee-duration');

        requestAnimationFrame(() => {
            const scrollW = element.scrollWidth;
            const clientW = wrapper.clientWidth;

            if (scrollW > clientW + 2) {
                const distance = -(scrollW - clientW + 8);
                const travelTime = Math.abs(distance) / 25;
                const totalDuration = Math.max(6, Math.round(travelTime + 4));

                element.style.setProperty('--marquee-distance', `${distance}px`);
                element.style.setProperty('--marquee-duration', `${totalDuration}s`);
                element.classList.add('is-scrolling');
                wrapper.classList.add('has-overflow');
            }
        });
    }

    updateTextMarquees() {
        this.updateMarquee(this.elTitle);
        this.updateMarquee(this.elArtist);
    }

    formatTime(seconds) {
        if (isNaN(seconds) || seconds === null) return "00:00";
        const secs = Math.floor(seconds);
        const mins = Math.floor(secs / 60);
        const remSecs = secs % 60;
        return `${mins < 10 ? '0' : ''}${mins}:${remSecs < 10 ? '0' : ''}${remSecs}`;
    }

    escapeHtml(str) {
        if (!str) return '';
        return str.replace(/[&<>"']/g, function(m) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
        });
    }

    triggerSaveUserState() {
        if (window.app && typeof window.app.saveUserState === 'function') {
            window.app.saveUserState();
        }
    }

    getState() {
        return {
            playlist: this.playlist,
            currentIndex: this.currentIndex,
            currentTime: this.audio ? (this.audio.currentTime || 0) : 0,
            volume: 1.0,
            isPlaying: this.isPlaying,
            isShuffle: false,
            isRepeat: false,
            isCacheOnly: false,
            isSortByMonthlyPlays: !!this.isSortByMonthlyPlays,
            monthlyPlaysSortDirection: this.monthlyPlaysSortDirection || 'desc'
        };
    }

    restoreState(state) {
        if (!state) return;
        if (typeof state.isSortByMonthlyPlays === 'boolean') {
            this.isSortByMonthlyPlays = state.isSortByMonthlyPlays;
        }
        if (state.monthlyPlaysSortDirection) {
            this.monthlyPlaysSortDirection = state.monthlyPlaysSortDirection;
        }
        this.updateSortMonthlyBtn();

        if (this.isPlaying && this.audio && !this.audio.paused) {
            return;
        }

        if (state.playlist && Array.isArray(state.playlist) && state.playlist.length > 0) {
            this.playlist = state.playlist;
            const originalTrack = (typeof state.currentIndex === 'number' && state.currentIndex >= 0 && state.currentIndex < state.playlist.length)
                ? state.playlist[state.currentIndex]
                : state.playlist[0];

            if (this.isSortByMonthlyPlays && this.playlist.length > 1) {
                this.sortByMonthlyPlays(false);
            }

            const idx = originalTrack ? Math.max(0, this.playlist.indexOf(originalTrack)) : 0;
            if (this.currentIndex === idx && this.audio && this.audio.src) {
                this.renderQueue();
                return;
            }

            this.loadTrack(idx, false);
            if (state.currentTime && state.currentTime > 0) {
                const targetTime = state.currentTime;
                const seekOnce = () => {
                    if (this.audio.duration && targetTime < this.audio.duration) {
                        this.audio.currentTime = targetTime;
                    }
                    this.audio.removeEventListener('loadedmetadata', seekOnce);
                };
                this.audio.addEventListener('loadedmetadata', seekOnce);
            }
        }
    }

    // ==========================================
    // BACKWARDS COMPATIBILITY STUBS
    // ==========================================

    updateShuffleBtn() {}
    toggleShuffle() {}
    updateCacheOnlyBtn() {}
    toggleCacheOnly() {}
    updateEqualizerBtn() {}
    openEqualizerModal() {}
    closeEqualizerModal() {}
    updateRepeatBtn() {}
    toggleRepeat() {}
    setTrimSilence(enabled) { this.trimSilence = !!enabled; localStorage.setItem('music_app_trim_silence', String(this.trimSilence)); }
    setNormalizeVolume(enabled) { this.normalizeVolume = !!enabled; localStorage.setItem('music_app_normalize_volume', String(this.normalizeVolume)); }
    setLoadingBeep(enabled) { this.loadingBeepEnabled = !!enabled; localStorage.setItem('music_app_loading_beep', String(this.loadingBeepEnabled)); }
    stopLoadingBeep() {}
}

window.player = new AudioPlayer();
