/**
 * Audio Player Manager for Music Docker App
 */
class AudioPlayer {
    constructor() {
        this.audio = new Audio();
        this.playlist = [];
        this.currentIndex = -1;
        this.isPlaying = false;
        this.isLoading = false;
        this.isShuffle = false;
        this.isRepeat = false; // false = off, true = repeat current track
        this.preloadedNextIndex = -1;
        this.preloadedNextBlobUrl = null;
        this.isPreloadingNext = false;

        // DOM elements
        this.initDOMElements();
        this.bindEvents();
    }

    initDOMElements() {
        this.elCover = document.getElementById('player-cover');
        this.elTitle = document.getElementById('player-title');
        this.elArtist = document.getElementById('player-artist');
        this.elPlayBtn = document.getElementById('player-play-btn');
        this.elPrevBtn = document.getElementById('player-prev-btn');
        this.elNextBtn = document.getElementById('player-next-btn');
        this.elShuffleBtn = document.getElementById('player-shuffle-btn');
        this.elRepeatBtn = document.getElementById('player-repeat-btn');
        this.elSeekSlider = document.getElementById('player-seek-slider');
        this.elCurrTime = document.getElementById('player-curr-time');
        this.elDuration = document.getElementById('player-duration');
        this.elVolumeSlider = document.getElementById('player-volume-slider');
        this.elMuteBtn = document.getElementById('player-mute-btn');
        this.elQueueToggleBtn = document.getElementById('player-queue-btn');
        this.elQueueDrawer = document.getElementById('queue-drawer');
        this.elQueueList = document.getElementById('queue-list');
        this.elBottomPlayer = document.getElementById('bottom-player');

        if (this.currentIndex === -1 && this.elBottomPlayer) {
            this.elBottomPlayer.classList.add('hidden');
        }
    }

    bindEvents() {
        // Audio element events
        this.audio.addEventListener('timeupdate', () => this.onTimeUpdate());
        this.audio.addEventListener('loadedmetadata', () => this.onLoadedMetadata());
        this.audio.addEventListener('ended', () => this.onTrackEnded());
        this.audio.addEventListener('error', (e) => this.onAudioError(e));

        // Loading and buffering state listeners
        this.audio.addEventListener('loadstart', () => {
            this.isLoading = true;
            this.updatePlayButton();
            this.renderQueue();
        });
        this.audio.addEventListener('waiting', () => {
            this.isLoading = true;
            this.updatePlayButton();
            this.renderQueue();
        });
        this.audio.addEventListener('playing', () => {
            this.isLoading = false;
            this.isPlaying = true;
            this.updatePlayButton();
            this.renderQueue();
        });
        this.audio.addEventListener('canplay', () => {
            this.isLoading = false;
            this.updatePlayButton();
        });
        this.audio.addEventListener('pause', () => {
            this.isLoading = false;
            this.isPlaying = false;
            this.updatePlayButton();
            this.renderQueue();
        });

        // Control buttons
        if (this.elPlayBtn) this.elPlayBtn.addEventListener('click', () => this.togglePlay());
        if (this.elPrevBtn) this.elPrevBtn.addEventListener('click', () => this.playPrevious());
        if (this.elNextBtn) this.elNextBtn.addEventListener('click', () => this.playNext());
        if (this.elShuffleBtn) this.elShuffleBtn.addEventListener('click', () => this.toggleShuffle());
        if (this.elRepeatBtn) this.elRepeatBtn.addEventListener('click', () => this.toggleRepeat());

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

        // Volume control
        if (this.elVolumeSlider) {
            this.elVolumeSlider.addEventListener('input', (e) => {
                this.audio.volume = e.target.value / 100;
                this.audio.muted = false;
                this.updateVolumeIcon();
                this.triggerSaveUserState();
            });
        }

        if (this.elMuteBtn) {
            this.elMuteBtn.addEventListener('click', () => {
                this.audio.muted = !this.audio.muted;
                this.updateVolumeIcon();
            });
        }

        // Queue drawer toggle
        if (this.elQueueToggleBtn && this.elQueueDrawer) {
            this.elQueueToggleBtn.addEventListener('click', () => {
                this.elQueueDrawer.classList.toggle('hidden');
            });
        }

        // Keyboard Shortcuts
        document.addEventListener('keydown', (e) => {
            // Ignore if typing in input/textarea
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
    }

    setPlaylist(tracks, startIndex = 0) {
        this.playlist = tracks;
        if (this.playlist.length > 0) {
            let initialIndex = startIndex;
            if (this.isShuffle) {
                initialIndex = Math.floor(Math.random() * this.playlist.length);
            }
            this.currentIndex = initialIndex;
            this.loadTrack(this.currentIndex, true);
        } else {
            this.currentIndex = -1;
        }
        this.renderQueue();
        this.triggerSaveUserState();
    }

    async loadTrack(index, autoPlay = true) {
        if (index < 0 || index >= this.playlist.length) return;

        this.currentIndex = index;
        const track = this.playlist[this.currentIndex];
        const trackKey = track.filename || track.id;

        // Unhide bottom player bar if hidden
        if (this.elBottomPlayer) {
            this.elBottomPlayer.classList.remove('hidden');
        }

        // Update UI
        if (this.elTitle) this.elTitle.innerText = track.title || 'Canción Desconocida';
        if (this.elArtist) this.elArtist.innerText = track.artist || track.channel || 'Desconocido';

        // Set cover image
        if (this.elCover) {
            if (track.thumbnail) {
                this.elCover.src = track.thumbnail;
            } else if (track.has_cover) {
                this.elCover.src = `/api/library/cover/${encodeURIComponent(track.filename)}`;
            } else {
                this.elCover.src = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="%238b5cf6" stroke-width="1.5"><rect width="18" height="18" x="3" y="3" rx="2" fill="%231e1b4b"/><circle cx="12" cy="12" r="4"/><polygon points="10 10 15 12 10 14 10 10"/></svg>`;
            }
        }

        this.audio.pause();
        this.triggerSaveUserState();

        let streamUrl = '';
        let isOfflineCache = false;

        // Check if track was preloaded during 5s window
        if (index === this.preloadedNextIndex && this.preloadedNextBlobUrl) {
            streamUrl = this.preloadedNextBlobUrl;
            isOfflineCache = true;
            console.log(`[Preloader] Instant playback using preloaded Blob for track index ${index}!`);
        }

        // Reset preloader state for next cycle
        this.isPreloadingNext = false;
        this.preloadedNextIndex = -1;
        this.preloadedNextBlobUrl = null;

        // Check if track is available in local IndexedDB offline storage
        if (!streamUrl && window.app && window.app.storageManager && trackKey) {
            try {
                const offlineItem = await window.app.storageManager.getOfflineTrack(trackKey);
                if (offlineItem && offlineItem.blob) {
                    streamUrl = URL.createObjectURL(offlineItem.blob);
                    isOfflineCache = true;
                    console.log(`[Offline PWA] Playing ${trackKey} from local IndexedDB cache.`);
                }
            } catch (err) {
                console.debug("IndexedDB offline cache check failed:", err);
            }
        }

        if (!streamUrl) {
            if (track.is_yt || track.id) {
                streamUrl = `/api/stream_yt?v=${encodeURIComponent(track.id)}`;
            } else {
                streamUrl = `/api/stream/${encodeURIComponent(track.filename)}`;
            }
        }

        this.audio.src = streamUrl;
        this.audio.load();

        if (autoPlay) {
            const tryPlay = () => {
                const playPromise = this.audio.play();
                if (playPromise !== undefined) {
                    playPromise.then(() => {
                        this.isPlaying = true;
                        this.updatePlayButton();

                        // Track network data usage and record listen event for LRU
                        if (window.app && window.app.storageManager) {
                            if (!isOfflineCache) {
                                const approxSize = track.size_bytes || 5000000;
                                window.app.storageManager.recordNetworkUsage(approxSize);
                            }
                        }
                        if (track.filename) {
                            fetch('/api/track/listen', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ filename: track.filename })
                            }).catch(() => {});
                        }

                        // Automatic background offline caching ONLY for local library tracks (not live YouTube streams)
                        if (!isOfflineCache && window.app && window.app.storageManager && trackKey && !track.is_yt && !track.id) {
                            const fetcher = window.app.customFetch ? window.app.customFetch.bind(window.app) : fetch;
                            fetcher(streamUrl, {}, 60000)
                                .then(res => {
                                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                                    return res.blob();
                                })
                                .then(blob => window.app.storageManager.saveOfflineTrack(trackKey, blob, track))
                                .catch(err => console.error("Auto offline caching failed:", err));
                        }
                    }).catch(err => {
                        console.warn("Autoplay deferred or blocked, attaching canplay listener:", err);
                        const onCanPlayOnce = () => {
                            this.audio.play().then(() => {
                                this.isPlaying = true;
                                this.updatePlayButton();
                            }).catch(e => {
                                console.warn("Retry play failed:", e);
                                this.isPlaying = false;
                                this.updatePlayButton();
                            });
                        };
                        this.audio.addEventListener('canplay', onCanPlayOnce, { once: true });
                    });
                }
            };
            tryPlay();
        }

        this.renderQueue();
    }

    async playPreviewTrack(track) {
        // track: { id, title, channel, thumbnail }
        this.currentIndex = -1;
        this.playlist = [];
        this.renderQueue();

        if (this.elBottomPlayer) {
            this.elBottomPlayer.classList.remove('hidden');
        }

        if (this.elTitle) this.elTitle.innerText = track.title || 'Previsualización';
        if (this.elArtist) this.elArtist.innerText = track.channel || 'YouTube';
        if (this.elCover) {
            this.elCover.src = track.thumbnail || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300';
        }

        this.audio.pause();

        const trackKey = track.filename || track.id;
        let streamUrl = '';
        let isOfflineCache = false;

        // Check if track is available in local IndexedDB offline storage
        if (window.app && window.app.storageManager && trackKey) {
            try {
                const offlineItem = await window.app.storageManager.getOfflineTrack(trackKey);
                if (offlineItem && offlineItem.blob) {
                    streamUrl = URL.createObjectURL(offlineItem.blob);
                    isOfflineCache = true;
                    console.log(`[Offline PWA] Playing preview track ${trackKey} from local IndexedDB cache.`);
                }
            } catch (err) {
                console.debug("IndexedDB offline cache check failed for preview:", err);
            }
        }

        if (!streamUrl) {
            streamUrl = `/api/stream_yt?v=${encodeURIComponent(track.id)}`;
        }

        this.audio.src = streamUrl;
        this.audio.load();

        this.audio.play().then(() => {
            this.isPlaying = true;
            this.updatePlayButton();

            // Track network data usage
            if (window.app && window.app.storageManager && !isOfflineCache) {
                const approxSize = track.size_bytes || 5000000;
                window.app.storageManager.recordNetworkUsage(approxSize);
            }

            // Automatic background offline caching ONLY for local tracks
            if (!isOfflineCache && window.app && window.app.storageManager && trackKey && !track.is_yt && !track.id) {
                const fetcher = window.app.customFetch ? window.app.customFetch.bind(window.app) : fetch;
                const metadata = {
                    title: track.title || 'Canción YouTube',
                    artist: track.channel || track.artist || 'YouTube',
                    thumbnail: track.thumbnail || '',
                    duration_string: track.duration_string || '',
                    id: track.id || ''
                };
                fetcher(streamUrl, {}, 60000)
                    .then(res => {
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                        return res.blob();
                    })
                    .then(blob => window.app.storageManager.saveOfflineTrack(trackKey, blob, metadata))
                    .catch(err => console.error("Auto offline caching failed for preview track:", err));
            }
        }).catch(err => {
            console.warn("Autoplay blocked or preview error:", err);
            this.isPlaying = false;
            this.updatePlayButton();
        });
    }

    togglePlay() {
        if (this.currentIndex === -1 && this.playlist.length > 0) {
            this.loadTrack(0, true);
            return;
        }

        if (!this.audio.src) return;

        if (this.audio.paused) {
            this.audio.play().then(() => {
                this.isPlaying = true;
                this.updatePlayButton();
                this.triggerSaveUserState();
            }).catch(console.error);
        } else {
            this.audio.pause();
            this.isPlaying = false;
            this.updatePlayButton();
            this.triggerSaveUserState();
        }
    }

    playNext() {
        if (this.playlist.length === 0) return;

        if (this.isShuffle) {
            let nextIdx = Math.floor(Math.random() * this.playlist.length);
            this.loadTrack(nextIdx, true);
        } else {
            let nextIdx = (this.currentIndex + 1) % this.playlist.length;
            this.loadTrack(nextIdx, true);
        }
    }

    playPrevious() {
        if (this.playlist.length === 0) return;

        if (this.audio.currentTime > 3) {
            this.audio.currentTime = 0;
            return;
        }

        let prevIdx = (this.currentIndex - 1 + this.playlist.length) % this.playlist.length;
        this.loadTrack(prevIdx, true);
    }

    toggleShuffle() {
        this.isShuffle = !this.isShuffle;
        if (this.elShuffleBtn) {
            this.elShuffleBtn.classList.toggle('text-purple-400', this.isShuffle);
            this.elShuffleBtn.classList.toggle('text-gray-400', !this.isShuffle);
        }
    }

    toggleRepeat() {
        this.isRepeat = !this.isRepeat;
        if (this.elRepeatBtn) {
            this.elRepeatBtn.classList.toggle('text-purple-400', this.isRepeat);
            this.elRepeatBtn.classList.toggle('text-gray-400', !this.isRepeat);
        }
    }

    onTrackEnded() {
        const finishedTrack = (this.currentIndex >= 0 && this.currentIndex < this.playlist.length) 
            ? this.playlist[this.currentIndex] 
            : null;

        if (this.isRepeat) {
            this.audio.currentTime = 0;
            this.audio.play();
        } else {
            this.playNext();
        }

        if (finishedTrack && window.app && window.app.storageManager) {
            this.cacheCompletedTrack(finishedTrack);
        }
    }

    async cacheCompletedTrack(track) {
        const trackKey = track.filename || track.id;
        if (!trackKey) return;

        try {
            const existing = await window.app.storageManager.getOfflineTrack(trackKey);
            if (existing && existing.blob) return;

            const streamUrl = (track.is_yt || track.id)
                ? `/api/stream_yt?v=${encodeURIComponent(track.id)}`
                : `/api/stream/${encodeURIComponent(track.filename)}`;

            const fetcher = window.app.customFetch ? window.app.customFetch.bind(window.app) : fetch;
            console.log(`[Offline Cache] Saving finished track to IndexedDB: ${track.title || trackKey}`);
            const res = await fetcher(streamUrl, {}, 30000);
            if (res.ok) {
                const blob = await res.blob();
                await window.app.storageManager.saveOfflineTrack(trackKey, blob, track);
                console.log(`[Offline Cache] Successfully saved completed track into IndexedDB: ${trackKey}`);
            }
        } catch (err) {
            console.debug("Error caching completed track:", err);
        }
    }

    onTimeUpdate() {
        if (!this.audio.duration) return;
        const current = this.audio.currentTime;
        const total = this.audio.duration;
        const percent = (current / total) * 100;

        if (this.elSeekSlider) this.elSeekSlider.value = percent;
        if (this.elCurrTime) this.elCurrTime.innerText = this.formatTime(current);

        this.checkPreloadNextTrack();
    }

    async checkPreloadNextTrack() {
        if (!this.audio || !this.audio.duration || this.playlist.length === 0) return;
        const remaining = this.audio.duration - this.audio.currentTime;

        // Trigger preloading when 5 seconds or less remain in current song
        if (remaining > 0 && remaining <= 5 && !this.isPreloadingNext) {
            this.isPreloadingNext = true;
            let nextIdx = this.currentIndex + 1;
            if (this.isShuffle) {
                nextIdx = Math.floor(Math.random() * this.playlist.length);
            }
            if (nextIdx >= this.playlist.length) {
                nextIdx = 0;
            }

            if (nextIdx === this.currentIndex || nextIdx < 0 || nextIdx >= this.playlist.length) {
                return;
            }

            const nextTrack = this.playlist[nextIdx];
            if (!nextTrack) return;
            const trackKey = nextTrack.filename || nextTrack.id;
            if (!trackKey) return;

            if (window.app && window.app.storageManager) {
                try {
                    const cached = await window.app.storageManager.getOfflineTrack(trackKey);
                    if (cached && cached.blob) {
                        this.preloadedNextBlobUrl = URL.createObjectURL(cached.blob);
                        this.preloadedNextIndex = nextIdx;
                        console.log(`[Preloader] Next track is already in local IndexedDB cache.`);
                    } else if (!nextTrack.is_yt && !nextTrack.id) {
                        console.log(`[Preloader] 5s remaining. Preloading next local track (${nextIdx}): ${nextTrack.title || trackKey}`);
                        const streamUrl = `/api/stream/${encodeURIComponent(nextTrack.filename)}`;
                        const fetcher = window.app.customFetch ? window.app.customFetch.bind(window.app) : fetch;
                        const res = await fetcher(streamUrl, {}, 30000);
                        if (res.ok) {
                            const blob = await res.blob();
                            await window.app.storageManager.saveOfflineTrack(trackKey, blob, nextTrack);
                            this.preloadedNextBlobUrl = URL.createObjectURL(blob);
                            this.preloadedNextIndex = nextIdx;
                            console.log(`[Preloader] Preloaded & saved next track into IndexedDB.`);
                        }
                    }
                } catch (err) {
                    console.warn("[Preloader] Preload error:", err);
                }
            }
        }
    }

    onLoadedMetadata() {
        if (this.elDuration) this.elDuration.innerText = this.formatTime(this.audio.duration || 0);
    }

    onAudioError(e) {
        console.error("Audio playback error:", e);
        this.isPlaying = false;
        this.updatePlayButton();

        // Auto-skip to next track if error occurs in playlist mode
        if (this.playlist && this.playlist.length > 1 && this.currentIndex >= 0) {
            console.warn(`[AudioPlayer] Stream error on track index ${this.currentIndex}. Advancing to next track in 1.5s...`);
            if (window.app && window.app.showToast) {
                window.app.showToast("Error en la fuente de audio. Pasando a la siguiente canción...", "warning");
            }
            if (this.errorSkipTimer) clearTimeout(this.errorSkipTimer);
            this.errorSkipTimer = setTimeout(() => {
                this.playNext();
            }, 1500);
        }
    }

    updatePlayButton() {
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

    renderQueue() {
        if (!this.elQueueList) return;
        if (this.playlist.length === 0) {
            this.elQueueList.innerHTML = `<p class="text-xs text-gray-500 p-3 text-center">La cola está vacía</p>`;
            return;
        }

        this.elQueueList.innerHTML = this.playlist.map((track, i) => {
            const isActive = i === this.currentIndex;
            let statusIcon = (i + 1).toString();
            if (isActive) {
                if (this.isLoading) {
                    statusIcon = `<svg class="animate-spin w-3.5 h-3.5 text-purple-400 inline" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>`;
                } else if (this.isPlaying) {
                    statusIcon = '▶';
                } else {
                    statusIcon = '⏸';
                }
            }
            return `
                <div onclick="window.player.loadTrack(${i}, true)" class="flex items-center gap-3 p-2 rounded-lg cursor-pointer transition ${isActive ? 'bg-purple-900/40 text-purple-200 border border-purple-500/30' : 'hover:bg-slate-800/60 text-gray-300'}">
                    <span class="text-xs font-mono w-4 text-center ${isActive ? 'text-purple-400 font-bold' : 'text-gray-500'} flex items-center justify-center">${statusIcon}</span>
                    <div class="flex-1 min-w-0">
                        <p class="text-xs font-medium truncate">${this.escapeHtml(track.title || track.filename)}</p>
                        <p class="text-[10px] text-gray-400 truncate">${this.escapeHtml(track.artist || 'Desconocido')}</p>
                    </div>
                    <span class="text-[10px] text-gray-500 font-mono">${track.duration_string || ''}</span>
                </div>
            `;
        }).join('');
    }

    formatTime(seconds) {
        if (isNaN(seconds) || seconds === null) return "00:00";
        const secs = Math.floor(seconds);
        const mins = Math.floor(secs / 60);
        const remSecs = secs % 60;
        return `${mins < 10 ? '0' : ''}${mins}:${remSecs < 10 ? '0' : ''}${remSecs}`;
    }

    getState() {
        return {
            playlist: this.playlist,
            currentIndex: this.currentIndex,
            currentTime: this.audio ? (this.audio.currentTime || 0) : 0,
            volume: this.audio ? this.audio.volume : 1,
            isPlaying: false
        };
    }

    restoreState(state) {
        if (!state) return;
        if (state.playlist && Array.isArray(state.playlist) && state.playlist.length > 0) {
            this.playlist = state.playlist;
            const idx = (typeof state.currentIndex === 'number' && state.currentIndex >= 0 && state.currentIndex < state.playlist.length) ? state.currentIndex : 0;
            this.loadTrack(idx, false);
            if (state.currentTime && this.audio) {
                try {
                    this.audio.currentTime = state.currentTime;
                } catch(e) {}
            }
        }
        if (typeof state.volume === 'number' && this.audio) {
            this.audio.volume = state.volume;
            if (this.elVolumeSlider) this.elVolumeSlider.value = state.volume;
        }
    }

    triggerSaveUserState() {
        if (window.app && typeof window.app.saveUserState === 'function') {
            window.app.saveUserState();
        }
    }

    escapeHtml(str) {
        if (!str) return '';
        return str.replace(/[&<>"']/g, function(m) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
        });
    }
}

window.player = new AudioPlayer();
