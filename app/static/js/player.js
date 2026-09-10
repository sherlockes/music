/**
 * Audio Player Manager for Music Docker App
 */
class AudioPlayer {
    constructor() {
        this.audio = new Audio();
        this.audio.preload = 'auto';
        this.audio.volume = 1.0;
        this.playlist = [];
        this.currentIndex = -1;
        this.isPlaying = false;
        this.isLoading = false;
        this.isChangingTrack = false;
        this.isShuffle = false;
        this.isRepeat = false; // false = off, true = repeat current track
        this.isPreloadingNext = false;
        this.errorRetryCount = 0;
        this.errorSkipTimer = null;

        // Anti-stutter buffer management & auto-resume guards
        this._autoResumeTimer = null;
        this._bufferProgressHandler = null;
        this._bufferCanPlayThroughHandler = null;

        // Offline blob & track transition guards
        this._loadTrackSeq = 0;
        this._lastSourceChangeTime = 0;
        this._userRequestedPause = false;
        this.activeBlob = null;
        this.currentBlobUrl = null;

        // Silence Trimming (Skip silence at start/end of track for library & cached songs)
        this.trimSilence = localStorage.getItem('music_app_trim_silence') === 'true';
        this.currentTrimPoints = { start: 0, end: 0 };
        this.silenceCache = new Map();

        // Volume Normalization (Mastering compressor & gain staging for uniform volume)
        this.normalizeVolume = localStorage.getItem('music_app_normalize_volume') === 'true';
        this.currentTrackGain = 1.0;
        this.audioCtx = null;
        this.sourceNode = null;
        this.compressorNode = null;
        this.limiterNode = null;
        this.gainNode = null;

        // 3-Band Parametric Equalizer (Bajos 120Hz, Medios 1000Hz, Altos 6000Hz)
        this.eqEnabled = localStorage.getItem('music_app_eq_enabled') !== 'false';
        this.eqBass = parseFloat(localStorage.getItem('music_app_eq_bass') || '0');
        this.eqMid = parseFloat(localStorage.getItem('music_app_eq_mid') || '0');
        this.eqTreble = parseFloat(localStorage.getItem('music_app_eq_treble') || '0');
        this.eqPreset = localStorage.getItem('music_app_eq_preset') || 'flat';
        this.bassFilter = null;
        this.midFilter = null;
        this.trebleFilter = null;

        // Loading Beep (Subtle audio indicator while tracks are loading / phone in pocket)
        this.loadingBeepEnabled = localStorage.getItem('music_app_loading_beep') === 'true';
        this._loadingBeepTimer = null;
        this._loadingBeepInterval = null;
        this._beepCtx = null;

        // Sleep Timer (Turns off music after track, playlist, 30m, 60m)
        this.sleepTimerMode = null; // null | 'track_end' | 'playlist_end' | 30 | 60
        this.sleepTimerEndTimestamp = null;
        this.sleepTimerInterval = null;
        this.sleepTimerOriginalVolume = 1.0;
        this._sleepTimerFadeInterval = null;

        // Postpone Uncached (Smart Zero-Latency playback with background caching)
        this.postponeUncached = localStorage.getItem('music_app_postpone_uncached') === 'true';

        // Solo Caché Mode (Skip un-cached tracks to prevent data usage)
        this.isCacheOnly = localStorage.getItem('music_app_cache_only') === 'true';

        // Sort by Monthly Plays (Order queue by most listened tracks in last 30 days)
        this.isSortByMonthlyPlays = localStorage.getItem('music_app_sort_by_monthly_plays') === 'true';
        this.monthlyPlaysSortDirection = localStorage.getItem('music_app_sort_monthly_direction') || 'desc';
        this.backendPlayCounts = {};
        this._currentTrackListened = false;

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
        this.elEqualizerBtn = document.getElementById('player-equalizer-btn');
        this.elEqBadge = document.getElementById('player-eq-badge');
        this.elEqualizerModal = document.getElementById('modal-equalizer');
        this.elCacheOnlyBtn = document.getElementById('player-cache-only-btn');
        this.elRepeatBtn = document.getElementById('player-repeat-btn');
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

        this.updateShuffleBtn();
        this.updateCacheOnlyBtn();
        this.updateRepeatBtn();
        this.updateEqualizerBtn();
        this.updateSortMonthlyBtn();
        this.syncBackendPlayStats();

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
            console.log(`[AudioPlayer] Buffer starvation (waiting event). Current buffered ahead: ${this.getBufferedAhead().toFixed(2)}s`);
            this.isLoading = true;
            this.updatePlayButton();
            this.renderQueue();
            this.startLoadingBeep();

            // If we are actively playing and buffer starves, pause temporarily so the browser
            // does NOT stutter through 20ms chunks (choppy sound). Buffer 1.5s cushion before resuming!
            if (this.isPlaying && !this._userRequestedPause && !this.isChangingTrack) {
                try {
                    this.audio.pause();
                } catch (e) {}
                this.scheduleBufferResume();
            }
        });
        this.audio.addEventListener('stalled', () => {
            if (this.isPlaying && !this._userRequestedPause && !this.isChangingTrack) {
                console.log("[AudioPlayer] Audio stream stalled, ensuring sufficient buffer before smooth resume...");
                this.isLoading = true;
                this.updatePlayButton();
                if (!this.hasSufficientBuffer(1.5)) {
                    try {
                        this.audio.pause();
                    } catch (e) {}
                    this.scheduleBufferResume();
                }
            }
        });

        // Window resize listener to recalculate text overflow marquee
        window.addEventListener('resize', () => {
            if (this._marqueeResizeTimeout) clearTimeout(this._marqueeResizeTimeout);
            this._marqueeResizeTimeout = setTimeout(() => this.updateTextMarquees(), 100);
        });

        // Visibility change listener: when user unlocks phone or foregrounds PWA, resume any suspended audio
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                if (this.audioCtx && this.audioCtx.state === 'suspended') {
                    console.log("[AudioPlayer] App foregrounded, resuming suspended AudioContext...");
                    this.audioCtx.resume().catch(() => {});
                }
                if (this.isPlaying && !this._userRequestedPause && this.audio && this.audio.paused) {
                    console.log("[AudioPlayer] App foregrounded, auto-resuming paused playback...");
                    this.attemptResume();
                }
            }
        });

        this.audio.addEventListener('playing', () => {
            this.isLoading = false;
            this.stopLoadingBeep();
            this.clearBufferResumeListeners();
            this.isChangingTrack = false;
            this.isPlaying = true;
            this._userRequestedPause = false;
            this.errorRetryCount = 0;
            if (this.audioCtx && this.audioCtx.state === 'suspended') {
                this.audioCtx.resume().catch(() => {});
            }
            this.applyStartSilenceTrim();
            this.updatePlayButton();
            this.renderQueue();
        });
        this.audio.addEventListener('canplay', () => {
            this.isLoading = false;
            this.stopLoadingBeep();
            this.updatePlayButton();
        });
        this.audio.addEventListener('pause', () => {
            this.stopLoadingBeep();

            // Ignore pause events triggered during track changing / source loading
            if (this.isChangingTrack) return;

            // If the user did NOT request a pause and player state is intended to be playing:
            // This is an involuntary pause caused by mobile OS power saving or background buffer underrun.
            // Do NOT set isPlaying = false; auto-resume smoothly once sufficient buffer is accumulated!
            if (!this._userRequestedPause && this.isPlaying) {
                console.log("[AudioPlayer] Involuntary pause intercepted. Buffering before auto-resume...");
                this.isLoading = true;
                this.updatePlayButton();

                this.clearBufferResumeListeners();

                // If sufficient buffer (>= 1.5s) is already present (e.g. transient focus glitch), resume quickly
                if (this.hasSufficientBuffer(1.5)) {
                    this._autoResumeTimer = setTimeout(() => this.attemptResume(), 200);
                } else {
                    // Buffer underrun: wait for at least 1.5s of buffer cushion so playback does not stutter!
                    this.scheduleBufferResume();
                }
                return;
            }

            // Legitimate user-requested pause
            this.clearBufferResumeListeners();
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
        if (this.elEqualizerBtn) this.elEqualizerBtn.addEventListener('click', () => this.openEqualizerModal());
        if (this.elCacheOnlyBtn) this.elCacheOnlyBtn.addEventListener('click', () => this.toggleCacheOnly());
        if (this.elRepeatBtn) this.elRepeatBtn.addEventListener('click', () => this.toggleRepeat());
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

        // Keyboard Shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeQueueModal();
                return;
            }

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

        // Register Web Media Session API for background playback lock & lockscreen controls
        this.bindMediaSessionHandlers();
    }

    getBufferedAhead() {
        if (!this.audio) return 0;
        try {
            const buffered = this.audio.buffered;
            if (!buffered || buffered.length === 0) return 0;
            const cur = this.audio.currentTime || 0;
            for (let i = 0; i < buffered.length; i++) {
                const start = buffered.start(i);
                const end = buffered.end(i);
                if (cur >= start - 0.25 && cur <= end) {
                    return Math.max(0, end - cur);
                }
            }
        } catch (e) {}
        return 0;
    }

    hasSufficientBuffer(minSeconds = 1.5) {
        if (!this.audio) return false;
        // Local offline blob has 100% of data locally
        if (this.activeBlob || this.currentBlobUrl) {
            return true;
        }
        // If track is already near the end
        if (this.audio.duration && (this.audio.duration - this.audio.currentTime) <= minSeconds) {
            return true;
        }
        const ahead = this.getBufferedAhead();
        return (ahead >= minSeconds) || (this.audio.readyState >= 4);
    }

    clearBufferResumeListeners() {
        if (this._autoResumeTimer) {
            clearTimeout(this._autoResumeTimer);
            this._autoResumeTimer = null;
        }
        if (this._bufferProgressHandler && this.audio) {
            this.audio.removeEventListener('progress', this._bufferProgressHandler);
            this._bufferProgressHandler = null;
        }
        if (this._bufferCanPlayThroughHandler && this.audio) {
            this.audio.removeEventListener('canplaythrough', this._bufferCanPlayThroughHandler);
            this._bufferCanPlayThroughHandler = null;
        }
    }

    scheduleBufferResume() {
        this.clearBufferResumeListeners();

        this._bufferProgressHandler = () => {
            if (this.hasSufficientBuffer(1.5)) {
                this.clearBufferResumeListeners();
                this.attemptResume();
            }
        };

        this._bufferCanPlayThroughHandler = () => {
            this.clearBufferResumeListeners();
            this.attemptResume();
        };

        this.audio.addEventListener('progress', this._bufferProgressHandler);
        this.audio.addEventListener('canplaythrough', this._bufferCanPlayThroughHandler, { once: true });

        // Fallback safety timer: give up to 2.5s for sufficient buffer before resuming
        this._autoResumeTimer = setTimeout(() => {
            this.clearBufferResumeListeners();
            this.attemptResume();
        }, 2500);
    }

    attemptResume() {
        this.clearBufferResumeListeners();

        if (this._userRequestedPause || !this.isPlaying || !this.audio) return;

        // If not enough buffer yet on network stream, keep waiting to avoid stuttering
        if (!this.hasSufficientBuffer(1.5)) {
            this.isLoading = true;
            this.updatePlayButton();
            this.scheduleBufferResume();
            return;
        }

        if (this.audioCtx && this.audioCtx.state === 'suspended') {
            this.audioCtx.resume().catch(() => {});
        }

        if (this.audio.paused) {
            this.audio.play().then(() => {
                this.isChangingTrack = false;
                this.isLoading = false;
                this.updatePlayButton();
            }).catch(e => {
                console.debug("[AudioPlayer] Auto-resume postponed, will retry:", e);
                if (!this._userRequestedPause && this.isPlaying) {
                    this._autoResumeTimer = setTimeout(() => this.attemptResume(), 1000);
                }
            });
        } else {
            this.isChangingTrack = false;
            this.isLoading = false;
            this.updatePlayButton();
        }
    }

    bindMediaSessionHandlers() {
        if (!('mediaSession' in navigator)) return;

        const actionHandlers = [
            ['play', () => this.togglePlay()],
            ['pause', () => this.togglePlay()],
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

    setupAudioProcessing() {
        if (this.audioCtx) {
            if (this.audioCtx.state === 'suspended') {
                this.audioCtx.resume().catch(() => {});
            }
            return;
        }

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;

        try {
            this.audioCtx = new AudioCtx({ latencyHint: 'playback' });
            this.sourceNode = this.audioCtx.createMediaElementSource(this.audio);

            if (typeof this.audioCtx.addEventListener === 'function') {
                this.audioCtx.addEventListener('statechange', () => {
                    if (this.audioCtx.state === 'suspended' && this.isPlaying && !this._userRequestedPause) {
                        console.log("[AudioProcessing] AudioContext suspended in background, auto-resuming...");
                        this.audioCtx.resume().catch(() => {});
                    }
                });
            }

            // Stage 1: 3-Band Parametric Equalizer (Bajos 120Hz, Medios 1000Hz, Altos 6000Hz)
            this.bassFilter = this.audioCtx.createBiquadFilter();
            this.bassFilter.type = 'lowshelf';
            this.bassFilter.frequency.setValueAtTime(120, this.audioCtx.currentTime);
            this.bassFilter.gain.setValueAtTime(this.eqEnabled ? this.eqBass : 0, this.audioCtx.currentTime);

            this.midFilter = this.audioCtx.createBiquadFilter();
            this.midFilter.type = 'peaking';
            this.midFilter.frequency.setValueAtTime(1000, this.audioCtx.currentTime);
            this.midFilter.Q.setValueAtTime(1.0, this.audioCtx.currentTime);
            this.midFilter.gain.setValueAtTime(this.eqEnabled ? this.eqMid : 0, this.audioCtx.currentTime);

            this.trebleFilter = this.audioCtx.createBiquadFilter();
            this.trebleFilter.type = 'highshelf';
            this.trebleFilter.frequency.setValueAtTime(6000, this.audioCtx.currentTime);
            this.trebleFilter.gain.setValueAtTime(this.eqEnabled ? this.eqTreble : 0, this.audioCtx.currentTime);

            // Stage 2: Normalization Gain Node (with volume boost)
            this.gainNode = this.audioCtx.createGain();
            this.gainNode.gain.setValueAtTime(1.0, this.audioCtx.currentTime);

            // Stage 3: Leveling & Punch Dynamics Compressor
            this.compressorNode = this.audioCtx.createDynamicsCompressor();
            this.compressorNode.threshold.setValueAtTime(-12, this.audioCtx.currentTime);
            this.compressorNode.knee.setValueAtTime(12, this.audioCtx.currentTime);
            this.compressorNode.ratio.setValueAtTime(4.0, this.audioCtx.currentTime);
            this.compressorNode.attack.setValueAtTime(0.003, this.audioCtx.currentTime);
            this.compressorNode.release.setValueAtTime(0.20, this.audioCtx.currentTime);

            // Stage 4: Peak Brickwall Limiter (Prevents all digital clipping / distortion completely)
            this.limiterNode = this.audioCtx.createDynamicsCompressor();
            this.limiterNode.threshold.setValueAtTime(-0.5, this.audioCtx.currentTime);
            this.limiterNode.knee.setValueAtTime(0, this.audioCtx.currentTime);
            this.limiterNode.ratio.setValueAtTime(20.0, this.audioCtx.currentTime);
            this.limiterNode.attack.setValueAtTime(0.001, this.audioCtx.currentTime);
            this.limiterNode.release.setValueAtTime(0.05, this.audioCtx.currentTime);

            // Graph: source -> bassFilter -> midFilter -> trebleFilter -> gainNode -> compressorNode -> limiterNode -> destination
            this.sourceNode.connect(this.bassFilter);
            this.bassFilter.connect(this.midFilter);
            this.midFilter.connect(this.trebleFilter);
            this.trebleFilter.connect(this.gainNode);
            this.gainNode.connect(this.compressorNode);
            this.compressorNode.connect(this.limiterNode);
            this.limiterNode.connect(this.audioCtx.destination);

            this.applyNormalizationSettings();
            this.applyEqualizerSettings();
            console.log("[AudioProcessing] Web Audio EQ & Normalization pipeline with anti-clipping limiter initialized.");
        } catch (err) {
            console.debug("[AudioProcessing] Web Audio setup warning:", err);
        }
    }

    applyNormalizationSettings() {
        if (!this.audioCtx || !this.compressorNode || !this.gainNode) return;
        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume().catch(() => {});
        }

        const now = this.audioCtx.currentTime;
        if (this.normalizeVolume) {
            // Leveling compressor
            this.compressorNode.threshold.setTargetAtTime(-12, now, 0.05);
            this.compressorNode.ratio.setTargetAtTime(4.0, now, 0.05);
            this.compressorNode.knee.setTargetAtTime(12, now, 0.05);

            // Brickwall peak limiter at -0.5 dBFS to prevent saturation
            if (this.limiterNode) {
                this.limiterNode.threshold.setTargetAtTime(-0.5, now, 0.05);
                this.limiterNode.ratio.setTargetAtTime(20.0, now, 0.05);
            }

            // Normalization gain with volume boost matching Deezer preview loudness
            const targetGain = 1.35 * (this.currentTrackGain || 1.0);
            this.gainNode.gain.setTargetAtTime(targetGain, now, 0.05);
        } else {
            // Bypass compression & limiting (linear pass-through)
            this.compressorNode.threshold.setTargetAtTime(0, now, 0.05);
            this.compressorNode.ratio.setTargetAtTime(1, now, 0.05);
            if (this.limiterNode) {
                this.limiterNode.threshold.setTargetAtTime(0, now, 0.05);
                this.limiterNode.ratio.setTargetAtTime(1, now, 0.05);
            }
            this.gainNode.gain.setTargetAtTime(1.0, now, 0.05);
        }
    }

    applyEqualizerSettings() {
        if (!this.audioCtx) return;
        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume().catch(() => {});
        }
        const now = this.audioCtx.currentTime;
        const bassGain = this.eqEnabled ? this.eqBass : 0;
        const midGain = this.eqEnabled ? this.eqMid : 0;
        const trebleGain = this.eqEnabled ? this.eqTreble : 0;

        if (this.bassFilter) this.bassFilter.gain.setTargetAtTime(bassGain, now, 0.03);
        if (this.midFilter) this.midFilter.gain.setTargetAtTime(midGain, now, 0.03);
        if (this.trebleFilter) this.trebleFilter.gain.setTargetAtTime(trebleGain, now, 0.03);

        this.updateEqualizerUI();
        this.drawEqCurve();
        this.updateEqualizerBtn();
    }

    openEqualizerModal() {
        this.setupAudioProcessing();
        if (this.elEqualizerModal) {
            this.elEqualizerModal.classList.remove('hidden');
        }
        this.setupEqualizerTouchControls();
        this.updateEqualizerUI();
        requestAnimationFrame(() => {
            this.drawEqCurve();
        });
    }

    setupEqualizerTouchControls() {
        if (this._eqTouchBound) return;
        this._eqTouchBound = true;

        ['bass', 'mid', 'treble'].forEach(band => {
            const track = document.getElementById(`eq-track-${band}`);
            if (!track) return;

            const handlePointer = (e) => {
                const rect = track.getBoundingClientRect();
                if (rect.height <= 0) return;
                const offsetY = e.clientY - rect.top;
                const ratio = Math.max(0, Math.min(1, offsetY / rect.height)); // 0 (top) to 1 (bottom)
                // Invert ratio: top (0) -> +12, center (0.5) -> 0, bottom (1) -> -12
                const gain = Math.round((1 - ratio * 2) * 12);
                this.setEqualizerBand(band, gain);
            };

            track.addEventListener('pointerdown', (e) => {
                try { track.setPointerCapture(e.pointerId); } catch(err) {}
                handlePointer(e);

                const onPointerMove = (moveEvent) => {
                    handlePointer(moveEvent);
                };

                const onPointerUp = (upEvent) => {
                    try { track.releasePointerCapture(upEvent.pointerId); } catch(err) {}
                    track.removeEventListener('pointermove', onPointerMove);
                    track.removeEventListener('pointerup', onPointerUp);
                    track.removeEventListener('pointercancel', onPointerUp);
                };

                track.addEventListener('pointermove', onPointerMove);
                track.addEventListener('pointerup', onPointerUp);
                track.addEventListener('pointercancel', onPointerUp);
            });
        });
    }

    closeEqualizerModal() {
        if (this.elEqualizerModal) {
            this.elEqualizerModal.classList.add('hidden');
        }
    }

    setEqualizerBand(band, value) {
        this.setupAudioProcessing();
        const val = parseFloat(value);
        if (band === 'bass') this.eqBass = val;
        if (band === 'mid') this.eqMid = val;
        if (band === 'treble') this.eqTreble = val;

        this.eqPreset = 'custom';
        localStorage.setItem(`music_app_eq_${band}`, val);
        localStorage.setItem('music_app_eq_preset', 'custom');

        this.applyEqualizerSettings();
    }

    setEqualizerPreset(presetName) {
        this.setupAudioProcessing();
        const presets = {
            flat: { bass: 0, mid: 0, treble: 0 },
            bass_boost: { bass: 6, mid: 0, treble: 1 },
            vocal: { bass: -2, mid: 5, treble: 3 },
            rock: { bass: 5, mid: -1, treble: 4 },
            pop: { bass: 3, mid: 2, treble: 4 },
            electronic: { bass: 7, mid: 1, treble: 5 },
            acoustic: { bass: 3, mid: 3, treble: 2 },
            treble_boost: { bass: -1, mid: 1, treble: 6 }
        };
        const p = presets[presetName] || presets.flat;
        this.eqBass = p.bass;
        this.eqMid = p.mid;
        this.eqTreble = p.treble;
        this.eqPreset = presetName;

        localStorage.setItem('music_app_eq_bass', this.eqBass);
        localStorage.setItem('music_app_eq_mid', this.eqMid);
        localStorage.setItem('music_app_eq_treble', this.eqTreble);
        localStorage.setItem('music_app_eq_preset', presetName);

        this.applyEqualizerSettings();
    }

    resetEqualizer() {
        this.setEqualizerPreset('flat');
    }

    setEqualizerEnabled(enabled) {
        this.eqEnabled = !!enabled;
        localStorage.setItem('music_app_eq_enabled', this.eqEnabled ? 'true' : 'false');
        this.setupAudioProcessing();
        this.applyEqualizerSettings();
    }

    updateEqualizerUI() {
        const toggle = document.getElementById('eq-toggle-enabled');
        if (toggle) toggle.checked = this.eqEnabled;

        const updateBand = (band, val) => {
            const valEl = document.getElementById(`eq-val-${band}`);
            const thumbEl = document.getElementById(`eq-thumb-${band}`);
            const fillEl = document.getElementById(`eq-fill-${band}`);

            if (valEl) valEl.innerText = (val > 0 ? `+${val}` : val) + ' dB';

            // Top percentage: val=+12 -> 0%, val=0 -> 50%, val=-12 -> 100%
            const pct = Math.max(0, Math.min(100, ((12 - val) / 24) * 100));
            if (thumbEl) thumbEl.style.top = `${pct}%`;

            if (fillEl) {
                if (val >= 0) {
                    fillEl.style.top = `${pct}%`;
                    fillEl.style.height = `${50 - pct}%`;
                } else {
                    fillEl.style.top = '50%';
                    fillEl.style.height = `${pct - 50}%`;
                }
            }
        };

        updateBand('bass', this.eqBass);
        updateBand('mid', this.eqMid);
        updateBand('treble', this.eqTreble);

        // Highlight active preset button
        document.querySelectorAll('.eq-preset-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        const activeBtn = document.querySelector(`.eq-preset-btn[onclick*="'${this.eqPreset}'"]`);
        if (activeBtn) {
            activeBtn.classList.add('active');
        }
    }

    getUnifiedBtnActiveClass() {
        return 'bg-purple-600 hover:bg-purple-500 text-white shadow-sm shadow-purple-500/30 border border-purple-400/40 transition p-1.5 rounded-lg flex items-center justify-center relative cursor-pointer';
    }

    getUnifiedBtnInactiveClass() {
        return 'text-slate-300 hover:text-white hover:bg-white/10 border border-transparent transition p-1.5 rounded-lg flex items-center justify-center relative cursor-pointer';
    }

    isEqualizerActive() {
        if (!this.eqEnabled) return false;
        return (this.eqBass !== 0 || this.eqMid !== 0 || this.eqTreble !== 0 || (this.eqPreset && this.eqPreset !== 'flat'));
    }

    updateEqualizerBtn() {
        if (!this.elEqualizerBtn) return;
        const active = this.isEqualizerActive();
        if (active) {
            this.elEqualizerBtn.className = this.getUnifiedBtnActiveClass();
            this.elEqualizerBtn.title = 'Ecualizador: Activado (Altos, Medios, Bajos)';
        } else {
            this.elEqualizerBtn.className = this.getUnifiedBtnInactiveClass();
            this.elEqualizerBtn.title = 'Ecualizador: Desactivado (Altos, Medios, Bajos)';
        }
        if (this.elEqBadge) {
            this.elEqBadge.classList.add('hidden');
        }
    }

    updateEqualizerBadge() {
        this.updateEqualizerBtn();
    }

    drawEqCurve() {
        const canvas = document.getElementById('eq-curve-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const width = canvas.width;
        const height = canvas.height;
        ctx.clearRect(0, 0, width, height);

        const midY = height / 2;
        const dbRange = 15;

        // Background subtle grid
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
        ctx.lineWidth = 1;

        // Horizontal Grid lines (+12dB, +6dB, 0dB, -6dB, -12dB)
        [-12, -6, 0, 6, 12].forEach(db => {
            const y = midY - (db / dbRange) * (height / 2);
            ctx.beginPath();
            if (db === 0) {
                ctx.strokeStyle = 'rgba(168, 85, 247, 0.3)';
                ctx.setLineDash([4, 4]);
            } else {
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
                ctx.setLineDash([]);
            }
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        });
        ctx.setLineDash([]);

        // Vertical frequency grid lines
        const freqMarks = [
            { f: 120, label: '120 Hz' },
            { f: 1000, label: '1 kHz' },
            { f: 6000, label: '6 kHz' }
        ];
        ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
        ctx.font = '9px monospace';
        ctx.textAlign = 'center';

        const minLog = Math.log10(20);
        const maxLog = Math.log10(20000);

        freqMarks.forEach(mark => {
            const x = ((Math.log10(mark.f) - minLog) / (maxLog - minLog)) * width;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
            ctx.fillText(mark.label, x, height - 4);
        });

        // 0dB label
        ctx.textAlign = 'left';
        ctx.fillText('0 dB', 4, midY - 3);
        ctx.fillText('+12', 4, midY - (12 / dbRange) * (height / 2) + 9);
        ctx.fillText('-12', 4, midY - (-12 / dbRange) * (height / 2) - 3);

        // Generate frequency points
        const numPoints = 100;
        const freqs = new Float32Array(numPoints);
        for (let i = 0; i < numPoints; i++) {
            const logF = minLog + (i / (numPoints - 1)) * (maxLog - minLog);
            freqs[i] = Math.pow(10, logF);
        }

        const bassMag = new Float32Array(numPoints);
        const bassPhase = new Float32Array(numPoints);
        const midMag = new Float32Array(numPoints);
        const midPhase = new Float32Array(numPoints);
        const trebleMag = new Float32Array(numPoints);
        const treblePhase = new Float32Array(numPoints);

        if (this.bassFilter && this.midFilter && this.trebleFilter) {
            this.bassFilter.getFrequencyResponse(freqs, bassMag, bassPhase);
            this.midFilter.getFrequencyResponse(freqs, midMag, midPhase);
            this.trebleFilter.getFrequencyResponse(freqs, trebleMag, treblePhase);
        } else {
            bassMag.fill(1.0);
            midMag.fill(1.0);
            trebleMag.fill(1.0);
        }

        // Draw EQ curve
        ctx.beginPath();
        for (let i = 0; i < numPoints; i++) {
            const x = (i / (numPoints - 1)) * width;
            let totalMag = 1.0;
            if (this.eqEnabled) {
                totalMag = (bassMag[i] || 1.0) * (midMag[i] || 1.0) * (trebleMag[i] || 1.0);
            }
            const db = 20 * Math.log10(Math.max(0.001, totalMag));
            const y = midY - (db / dbRange) * (height / 2);
            const clampedY = Math.max(2, Math.min(height - 2, y));
            if (i === 0) {
                ctx.moveTo(x, clampedY);
            } else {
                ctx.lineTo(x, clampedY);
            }
        }

        // Stroke curve with glowing gradient
        const gradient = ctx.createLinearGradient(0, 0, width, 0);
        gradient.addColorStop(0, '#ec4899'); // pink (bass)
        gradient.addColorStop(0.5, '#a855f7'); // purple (mid)
        gradient.addColorStop(1, '#06b6d4'); // cyan (treble)

        ctx.strokeStyle = gradient;
        ctx.lineWidth = 2.5;
        ctx.shadowColor = '#a855f7';
        ctx.shadowBlur = 8;
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Fill area under curve
        ctx.lineTo(width, midY);
        ctx.lineTo(0, midY);
        ctx.closePath();
        const fillGrad = ctx.createLinearGradient(0, 0, 0, height);
        fillGrad.addColorStop(0, 'rgba(168, 85, 247, 0.22)');
        fillGrad.addColorStop(1, 'rgba(168, 85, 247, 0.0)');
        ctx.fillStyle = fillGrad;
        ctx.fill();

        // Draw 3 Interactive control dots for Bass, Mid, Treble on the curve
        const dots = [
            { f: 120, gain: this.eqBass, color: '#ec4899' },
            { f: 1000, gain: this.eqMid, color: '#a855f7' },
            { f: 6000, gain: this.eqTreble, color: '#06b6d4' }
        ];
        dots.forEach(d => {
            const x = ((Math.log10(d.f) - minLog) / (maxLog - minLog)) * width;
            const y = this.eqEnabled ? (midY - (d.gain / dbRange) * (height / 2)) : midY;
            const clampedY = Math.max(4, Math.min(height - 4, y));
            ctx.beginPath();
            ctx.arc(x, clampedY, 4, 0, Math.PI * 2);
            ctx.fillStyle = d.color;
            ctx.shadowColor = d.color;
            ctx.shadowBlur = 6;
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.shadowBlur = 0;
        });
    }

    setNormalizeVolume(enabled) {
        this.normalizeVolume = !!enabled;
        localStorage.setItem('music_app_normalize_volume', this.normalizeVolume ? 'true' : 'false');
        console.log(`[VolumeNorm] Setting changed: normalizeVolume = ${this.normalizeVolume}`);
        if (this.normalizeVolume) {
            this.setupAudioProcessing();
        }
        this.applyNormalizationSettings();
        if (this.normalizeVolume && this.currentIndex >= 0 && this.currentIndex < this.playlist.length) {
            const track = this.playlist[this.currentIndex];
            this.analyzeSilence(track, this.activeBlob, this._loadTrackSeq);
        }
    }

    setTrimSilence(enabled) {
        this.trimSilence = !!enabled;
        localStorage.setItem('music_app_trim_silence', this.trimSilence ? 'true' : 'false');
        console.log(`[SilenceTrim] Setting changed: trimSilence = ${this.trimSilence}`);
        if (this.trimSilence && this.currentIndex >= 0 && this.currentIndex < this.playlist.length) {
            const track = this.playlist[this.currentIndex];
            this.analyzeSilence(track, this.activeBlob, this._loadTrackSeq);
        }
    }

    setPostponeUncached(enabled) {
        this.postponeUncached = !!enabled;
        localStorage.setItem('music_app_postpone_uncached', this.postponeUncached ? 'true' : 'false');
        console.log(`[SmartCache] Setting changed: postponeUncached = ${this.postponeUncached}`);
    }

    setLoadingBeep(enabled) {
        this.loadingBeepEnabled = !!enabled;
        localStorage.setItem('music_app_loading_beep', this.loadingBeepEnabled ? 'true' : 'false');
        console.log(`[LoadingBeep] Setting changed: loadingBeepEnabled = ${this.loadingBeepEnabled}`);
        if (!this.loadingBeepEnabled) {
            this.stopLoadingBeep();
        } else if (this.isLoading) {
            this.startLoadingBeep();
        }
    }

    startLoadingBeep() {
        if (!this.loadingBeepEnabled || this._loadingBeepInterval || this._loadingBeepTimer) return;

        // Give a 450ms initial grace period so instant cache loads don't beep
        this._loadingBeepTimer = setTimeout(() => {
            this._loadingBeepTimer = null;
            if (!this.isLoading || !this.loadingBeepEnabled) return;

            // Play first beep
            this.playSingleBeep();

            // Schedule recurring pulse every 1000ms until loading finishes
            this._loadingBeepInterval = setInterval(() => {
                if (!this.isLoading || !this.loadingBeepEnabled) {
                    this.stopLoadingBeep();
                    return;
                }
                this.playSingleBeep();
            }, 1000);
        }, 450);
    }

    playSingleBeep() {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            if (!this._beepCtx) {
                this._beepCtx = new AudioCtx();
            }
            if (this._beepCtx.state === 'suspended') {
                this._beepCtx.resume().catch(() => {});
            }

            const now = this._beepCtx.currentTime;
            const osc = this._beepCtx.createOscillator();
            const gain = this._beepCtx.createGain();

            // Pleasant, soft 920Hz ping (gentle sonar tone)
            osc.type = 'sine';
            osc.frequency.setValueAtTime(920, now);

            // Subtle volume envelope with gentle attack & decay (peak 0.05)
            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.exponentialRampToValueAtTime(0.05, now + 0.012);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.075);

            osc.connect(gain);
            gain.connect(this._beepCtx.destination);

            osc.start(now);
            osc.stop(now + 0.08);
        } catch (e) {
            console.debug("[LoadingBeep] Beep error:", e);
        }
    }

    stopLoadingBeep() {
        if (this._loadingBeepTimer) {
            clearTimeout(this._loadingBeepTimer);
            this._loadingBeepTimer = null;
        }
        if (this._loadingBeepInterval) {
            clearInterval(this._loadingBeepInterval);
            this._loadingBeepInterval = null;
        }
    }

    async analyzeSilence(track, blob = null, seq = null) {
        if (!track || (!this.trimSilence && !this.normalizeVolume)) return;
        const trackKey = track.filename || track.id;
        if (!trackKey) return;

        // In-memory cache hit
        if (this.silenceCache.has(trackKey)) {
            const cached = this.silenceCache.get(trackKey);
            if (seq === null || this._loadTrackSeq === seq) {
                this.currentTrimPoints = cached;
                this.currentTrackGain = cached.trackGain || 1.0;
                this.applyStartSilenceTrim();
                this.applyNormalizationSettings();
            }
            return cached;
        }

        // Only perform intensive audio buffer silence/loudness analysis if the track is
        // already available locally as a Blob (offline cached in IndexedDB).
        // Doing a parallel remote network fetch for streaming tracks saturates bandwidth,
        // blocks rclone/Google Drive, spikes CPU, and causes audio stuttering during initial playback.
        if (!blob) {
            console.debug(`[AudioAnalysis] Track '${trackKey}' is streaming over network; skipping full-file analysis to preserve streaming bandwidth.`);
            return;
        }

        // Delay intensive decoding so initial playback begins smoothly without CPU spike
        await new Promise(r => setTimeout(r, 600));
        if (seq !== null && this._loadTrackSeq !== seq) return;

        try {
            let arrayBuffer = null;
            if (blob) {
                arrayBuffer = await blob.arrayBuffer();
            } else if (track.filename) {
                const streamUrl = `/api/stream/${encodeURIComponent(track.filename)}`;
                const fetcher = (window.app && window.app.customFetch) ? window.app.customFetch.bind(window.app) : fetch;
                const res = await fetcher(streamUrl, {}, 25000);
                if (res.ok) {
                    const fetchedBlob = await res.blob();
                    arrayBuffer = await fetchedBlob.arrayBuffer();
                }
            } else if (track.id || track.is_yt) {
                const streamUrl = `/api/stream_yt?v=${encodeURIComponent(track.id || `${track.artist || ''} ${track.title || ''}`.trim())}`;
                const fetcher = (window.app && window.app.customFetch) ? window.app.customFetch.bind(window.app) : fetch;
                const res = await fetcher(streamUrl, {}, 25000);
                if (res.ok) {
                    const fetchedBlob = await res.blob();
                    arrayBuffer = await fetchedBlob.arrayBuffer();
                }
            }

            if (!arrayBuffer) return;

            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            const ctx = new AudioCtx();
            const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
            ctx.close().catch(() => {});

            if (!audioBuffer) return;

            const sampleRate = audioBuffer.sampleRate;
            const duration = audioBuffer.duration;
            const numChannels = audioBuffer.numberOfChannels;
            const channel0 = audioBuffer.getChannelData(0);
            const channel1 = numChannels > 1 ? audioBuffer.getChannelData(1) : null;
            const totalSamples = channel0.length;

            // Frame-based energy analysis (40ms analysis windows)
            const frameSize = Math.floor(sampleRate * 0.04);
            // Thresholds:
            // Audible sound threshold: RMS > 0.012 (~ -38.4 dBFS) or Peak > 0.025 (~ -32 dBFS)
            // Outro fade threshold: RMS > 0.008 (~ -41.9 dBFS)
            const rmsStartThreshold = 0.012;
            const peakStartThreshold = 0.025;
            const rmsEndThreshold = 0.008;

            const getFrameEnergy = (startSampleIdx) => {
                let sumSq = 0;
                let maxPeak = 0;
                const end = Math.min(totalSamples, startSampleIdx + frameSize);
                const count = end - startSampleIdx;
                if (count <= 0) return { rms: 0, peak: 0 };

                let sampledCount = 0;
                for (let j = startSampleIdx; j < end; j += 4) {
                    let v = Math.abs(channel0[j]);
                    if (channel1) {
                        const v1 = Math.abs(channel1[j]);
                        if (v1 > v) v = v1;
                    }
                    if (v > maxPeak) maxPeak = v;
                    sumSq += v * v;
                    sampledCount++;
                }
                const rms = sampledCount > 0 ? Math.sqrt(sumSq / sampledCount) : 0;
                return { rms, peak: maxPeak };
            };

            // 1. Detect Start Silence (scan first 25 seconds)
            let startSample = 0;
            const maxStartSamples = Math.min(totalSamples, Math.floor(sampleRate * 25));
            for (let i = 0; i < maxStartSamples; i += frameSize) {
                const { rms, peak } = getFrameEnergy(i);
                if (rms >= rmsStartThreshold || peak >= peakStartThreshold) {
                    // Back up 60ms for smooth transient preservation
                    startSample = Math.max(0, i - Math.floor(sampleRate * 0.06));
                    break;
                }
            }

            // 2. Detect End Silence (scan backwards last 30 seconds)
            let endSample = totalSamples;
            const minEndSamples = Math.max(0, totalSamples - Math.floor(sampleRate * 30));
            for (let i = totalSamples - frameSize; i >= minEndSamples; i -= frameSize) {
                const { rms, peak } = getFrameEnergy(i);
                if (rms >= rmsEndThreshold || peak >= (peakStartThreshold * 0.7)) {
                    // Add 120ms safety tail so reverbs/fadeouts are never cut abruptly
                    endSample = Math.min(totalSamples, i + frameSize + Math.floor(sampleRate * 0.12));
                    break;
                }
            }

            // 3. Compute overall track RMS for volume normalization
            let sumSquares = 0;
            let sampleCount = 0;
            const step = 64;
            for (let i = startSample; i < endSample; i += step) {
                const v = channel0[i];
                sumSquares += v * v;
                sampleCount++;
            }
            const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0.16;
            // Target RMS: 0.165 (~ -15.6 dBFS) to match commercial streaming & Deezer preview levels
            const targetRms = 0.165;
            let trackGain = 1.0;
            if (rms > 0.005) {
                trackGain = parseFloat(Math.min(2.2, Math.max(0.65, targetRms / rms)).toFixed(2));
            }

            const startSec = startSample / sampleRate;
            const endSec = endSample / sampleRate;

            const trim = {
                start: startSec > 0.15 ? parseFloat(startSec.toFixed(2)) : 0,
                end: (duration - endSec > 0.25) ? parseFloat(endSec.toFixed(2)) : parseFloat(duration.toFixed(2)),
                trackGain: trackGain
            };

            this.silenceCache.set(trackKey, trim);
            console.log(`[AudioAnalysis] "${track.title || trackKey}": start trimmed: ${trim.start}s, end trimmed: ${trim.end}s (total: ${duration.toFixed(2)}s), gain: ${trim.trackGain}x`);

            if (seq === null || this._loadTrackSeq === seq) {
                this.currentTrimPoints = trim;
                this.currentTrackGain = trim.trackGain || 1.0;
                this.applyStartSilenceTrim();
                this.applyNormalizationSettings();
            }
            return trim;
        } catch (err) {
            console.debug("[AudioAnalysis] Error in silence analysis:", err);
        }
    }

    applyStartSilenceTrim() {
        if (!this.trimSilence || !this.currentTrimPoints || !this.currentTrimPoints.start || this.currentTrimPoints.start <= 0.1) return;
        if (this.audio) {
            // Do not seek on network stream unless the seek point is safely buffered ahead
            if (!this.hasSufficientBuffer(this.currentTrimPoints.start + 0.5)) return;
            const cur = this.audio.currentTime || 0;
            // Only skip initial silence before playback has audibly progressed (< 0.08s).
            // Seeking mid-stream after playback has started induces mobile audio buffer underruns and pauses.
            if (cur < 0.08 && cur < this.currentTrimPoints.start - 0.04) {
                console.log(`[SilenceTrim] Skipping initial silence from ${cur.toFixed(2)}s to ${this.currentTrimPoints.start}s`);
                try {
                    this.audio.currentTime = this.currentTrimPoints.start;
                } catch (e) {
                    console.debug("[SilenceTrim] Seek deferred:", e);
                }
            }
        }
    }

    setPlaylist(tracks, startIndex = 0) {
        this.playlist = tracks || [];
        if (this.playlist.length > 0) {
            let initialIndex = startIndex;
            if (this.isCacheOnly) {
                if (this.isTrackCached(this.playlist[startIndex])) {
                    initialIndex = startIndex;
                } else {
                    const found = this.findNextTrackIndex('next', startIndex - 1);
                    if (found !== -1) {
                        initialIndex = found;
                    } else {
                        this.currentIndex = -1;
                        if (this.audio) {
                            this._userRequestedPause = true;
                            this.audio.pause();
                            this.audio.src = '';
                        }
                        this.isPlaying = false;
                        this.updatePlayButton();
                        this.renderQueue();
                        this.triggerSaveUserState();
                        if (window.app && typeof window.app.showToast === 'function') {
                            window.app.showToast('No hay canciones guardadas en la caché local dentro de esta lista (Modo Solo Caché)', 'warning');
                        }
                        return;
                    }
                }
            } else if (this.isShuffle) {
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

    async loadTrack(index, autoPlay = true, allowSmartSwap = false) {
        if (index < 0 || index >= this.playlist.length) return;
        this._currentTrackListened = false;

        // Smart Zero-Latency Switch: If track is not in cache, skip to next cached track & cache this one for next
        if (this.postponeUncached && autoPlay && allowSmartSwap && !this.isCacheOnly && this.playlist.length > 1) {
            const candidateTrack = this.playlist[index];
            if (candidateTrack && !candidateTrack._smartPostponed && !this.isTrackCached(candidateTrack)) {
                const cachedIdx = this.findNextCachedTrackIndex(index);
                if (cachedIdx !== -1 && cachedIdx !== index) {
                    candidateTrack._smartPostponed = true;
                    const uncachedTrack = this.playlist[index];
                    const cachedTrack = this.playlist[cachedIdx];

                    let uncachedTitle = uncachedTrack.title || uncachedTrack.filename || 'Canción';
                    let cachedTitle = cachedTrack.title || cachedTrack.filename || 'Canción';
                    if (window.app && typeof window.app.parseSongInfo === 'function') {
                        uncachedTitle = window.app.parseSongInfo(uncachedTrack).title || uncachedTitle;
                        cachedTitle = window.app.parseSongInfo(cachedTrack).title || cachedTitle;
                    }

                    // 1. Start background downloading & caching of the requested uncached track
                    this.backgroundCacheTrack(uncachedTrack);

                    // 2. Reorder queue: move cachedTrack to current position, and place uncachedTrack immediately after
                    const oldIdx = this.playlist.indexOf(cachedTrack);
                    if (oldIdx !== -1) {
                        this.playlist.splice(oldIdx, 1);
                    }
                    const targetPos = this.playlist.indexOf(uncachedTrack);
                    if (targetPos !== -1) {
                        this.playlist.splice(targetPos, 0, cachedTrack);
                        index = targetPos;
                    }

                    this.renderQueue();
                    this.triggerSaveUserState();

                    if (window.app && typeof window.app.showToast === 'function') {
                        window.app.showToast(`Cacheando '${uncachedTitle}' para sonar después. Reproduciendo '${cachedTitle}' al instante`, 'info');
                    }

                    return this.loadTrack(index, true, false);
                }
            }
        }

        const seq = ++this._loadTrackSeq;
        this.clearBufferResumeListeners();
        this._lastSourceChangeTime = Date.now();
        this._userRequestedPause = !autoPlay;
        this.isChangingTrack = true;
        this.currentIndex = index;
        const track = this.playlist[this.currentIndex];
        if (track) {
            track._smartPostponed = false;
        }
        const trackKey = track.filename || track.id;

        // Clean up previous blob URL to prevent memory leaks and dangling streams
        if (this.currentBlobUrl) {
            try {
                URL.revokeObjectURL(this.currentBlobUrl);
            } catch (e) {}
            this.currentBlobUrl = null;
            this.activeBlob = null;
        }

        // Unhide bottom player bar if hidden
        if (this.elBottomPlayer) {
            this.elBottomPlayer.classList.remove('hidden');
        }

        // Format title and artist lines cleanly
        let titleText = track.title || 'Canción Desconocida';
        let artistText = track.artist || track.channel || 'Desconocido';
        if (window.app && typeof window.app.parseSongInfo === 'function') {
            const parsed = window.app.parseSongInfo(track);
            titleText = parsed.title;
            artistText = parsed.artist;
        }

        // Update UI
        if (this.elTitle) this.elTitle.innerText = titleText;
        if (this.elArtist) this.elArtist.innerText = artistText;
        this.updateTextMarquees();

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

        // Update OS Media Session (Lockscreen controls / Background audio lock)
        this.updateMediaSession(track);

        this.triggerSaveUserState();

        let streamUrl = '';
        let isOfflineCache = false;

        // Reset preloader state for next cycle
        this.isPreloadingNext = false;

        // Check if track is available in local IndexedDB offline storage
        if (window.app && window.app.storageManager && trackKey) {
            try {
                const offlineItem = await window.app.storageManager.getOfflineTrack(trackKey);
                if (this._loadTrackSeq !== seq) return; // Stale async call discarded
                if (offlineItem && offlineItem.blob && offlineItem.blob.size > 10000) {
                    this.activeBlob = offlineItem.blob;
                    this.currentBlobUrl = URL.createObjectURL(this.activeBlob);
                    streamUrl = this.currentBlobUrl;
                    isOfflineCache = true;
                    console.log(`[Offline PWA] Playing ${trackKey} from local IndexedDB cache (${this.activeBlob.size} bytes).`);
                }
            } catch (err) {
                console.debug("IndexedDB offline cache check failed:", err);
            }
        }

        if (this._loadTrackSeq !== seq) return;

        if (!streamUrl) {
            if (track.filename) {
                streamUrl = `/api/stream/${encodeURIComponent(track.filename)}`;
            } else if (track.is_yt || track.id) {
                streamUrl = `/api/stream_yt?v=${encodeURIComponent(track.id)}`;
            } else {
                streamUrl = `/api/stream_yt?v=${encodeURIComponent(`${track.artist || ''} ${track.title || ''}`.trim())}`;
            }
        }

        this._lastSourceChangeTime = Date.now();
        this.audio.src = streamUrl;
        this.audio.load();

        // Trigger automatic silence analysis & loudness calculation for library/cached tracks
        this.currentTrimPoints = { start: 0, end: 0 };
        this.currentTrackGain = 1.0;
        if (this.trimSilence || this.normalizeVolume) {
            this.analyzeSilence(track, this.activeBlob, seq);
        }

        if (autoPlay) {
            this.isLoading = true;
            this.isPlaying = true;
            this._userRequestedPause = false;
            this.updatePlayButton();
            this.startLoadingBeep();

            const tryPlay = () => {
                if (this._loadTrackSeq !== seq) return;
                if (this.normalizeVolume) {
                    this.setupAudioProcessing();
                }
                const playPromise = this.audio.play();
                if (playPromise !== undefined) {
                    playPromise.then(() => {
                        if (this._loadTrackSeq !== seq) return;
                        this.stopLoadingBeep();
                        if (this.normalizeVolume) {
                            this.setupAudioProcessing();
                            this.applyNormalizationSettings();
                        }

                        // If streaming over network and initial buffer is still critically thin (< 1.5s):
                        // Temporarily pause to let the stream buffer ahead 1.5s of audio cushion.
                        // This prevents initial choppy sound (entrecorte) when phone screen is locked!
                        if (!isOfflineCache && !this.hasSufficientBuffer(1.5)) {
                            console.log("[AudioPlayer] Initial streaming buffer < 1.5s. Buffering safety cushion...");
                            this.isLoading = true;
                            this.updatePlayButton();
                            try {
                                this.audio.pause();
                            } catch (e) {}
                            this.scheduleBufferResume();
                            return;
                        }

                        this.isChangingTrack = false;
                        this.isLoading = false;
                        this.isPlaying = true;
                        this._userRequestedPause = false;
                        this.errorRetryCount = 0;
                        this.updatePlayButton();
                        this.renderQueue();

                        // Track network data usage
                        if (window.app && window.app.storageManager && !isOfflineCache) {
                            const approxSize = track.size_bytes || 5000000;
                            window.app.storageManager.recordNetworkUsage(approxSize);
                        }

                        // Record listen event for LRU
                        if (track.filename) {
                            fetch('/api/track/listen', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ filename: track.filename })
                            }).catch(() => {});
                        }
                    }).catch(err => {
                        if (this._loadTrackSeq !== seq) return;
                        console.warn("[AudioPlayer] play() deferred/buffering:", err);
                        if (this.hasSufficientBuffer(1.5)) {
                            this.attemptResume();
                        } else {
                            this.scheduleBufferResume();
                        }
                    });
                }
            };
            tryPlay();
        } else {
            this.isChangingTrack = false;
            this.isLoading = false;
            this.isPlaying = false;
            this._userRequestedPause = true;
            this.updatePlayButton();
        }

        this.renderQueue();
    }

    async playPreviewTrack(track) {
        // track: { id, title, channel, thumbnail }
        const seq = ++this._loadTrackSeq;
        this._lastSourceChangeTime = Date.now();
        this._userRequestedPause = false;
        this.isChangingTrack = true;
        this.currentIndex = -1;
        this.playlist = [];
        this.renderQueue();

        if (this.currentBlobUrl) {
            try {
                URL.revokeObjectURL(this.currentBlobUrl);
            } catch (e) {}
            this.currentBlobUrl = null;
            this.activeBlob = null;
        }

        if (this.elBottomPlayer) {
            this.elBottomPlayer.classList.remove('hidden');
        }

        if (this.elTitle) this.elTitle.innerText = track.title || 'Previsualización';
        if (this.elArtist) this.elArtist.innerText = track.channel || 'YouTube';
        this.updateTextMarquees();
        if (this.elCover) {
            this.elCover.src = track.thumbnail || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300';
        }

        // Update OS Media Session (Lockscreen controls / Background audio lock)
        this.updateMediaSession(track);

        const trackKey = track.filename || track.id;
        let streamUrl = '';
        let isOfflineCache = false;

        // Check if track is available in local IndexedDB offline storage
        if (window.app && window.app.storageManager && trackKey) {
            try {
                const offlineItem = await window.app.storageManager.getOfflineTrack(trackKey);
                if (this._loadTrackSeq !== seq) return;
                if (offlineItem && offlineItem.blob && offlineItem.blob.size > 10000) {
                    this.activeBlob = offlineItem.blob;
                    this.currentBlobUrl = URL.createObjectURL(this.activeBlob);
                    streamUrl = this.currentBlobUrl;
                    isOfflineCache = true;
                    console.log(`[Offline PWA] Playing preview track ${trackKey} from local IndexedDB cache.`);
                }
            } catch (err) {
                console.debug("IndexedDB offline cache check failed for preview:", err);
            }
        }

        if (this._loadTrackSeq !== seq) return;

        if (!streamUrl) {
            if (track.preview || track.preview_url) {
                streamUrl = track.preview || track.preview_url;
            } else if (track.id) {
                streamUrl = `/api/stream_yt?v=${encodeURIComponent(track.id)}`;
            }
        }

        this._lastSourceChangeTime = Date.now();
        this.audio.src = streamUrl;
        this.audio.load();

        this.isLoading = true;
        this.isPlaying = true;
        this._userRequestedPause = false;
        this.updatePlayButton();

        this.audio.play().then(() => {
            if (this._loadTrackSeq !== seq) return;
            this.isChangingTrack = false;
            this.isLoading = false;
            this.isPlaying = true;
            this._userRequestedPause = false;
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
                    .then(blob => {
                        if (blob && blob.size > 10000) {
                            window.app.storageManager.saveOfflineTrack(trackKey, blob, metadata);
                        }
                    })
                    .catch(err => console.error("Auto offline caching failed for preview track:", err));
            }
        }).catch(err => {
            if (this._loadTrackSeq !== seq) return;
            console.warn("Autoplay blocked or preview error:", err);
            this.isChangingTrack = false;
            this.isLoading = false;
            this.isPlaying = false;
            this.updatePlayButton();
        });
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

        // 1. Search if track already exists in the playlist and remove previous occurrences to avoid duplicates
        for (let i = this.playlist.length - 1; i >= 0; i--) {
            if (this.isSameTrack(this.playlist[i], track)) {
                this.playlist.splice(i, 1);
                if (i < this.currentIndex) {
                    this.currentIndex--;
                }
            }
        }

        // 2. Insert at next playback position
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

        // 3. Immediately play the newly added track
        this.loadTrack(insertIdx, true);
        this.renderQueue();
        this.triggerSaveUserState();
    }

    playNextInQueue(track) {
        if (!track) return;

        // If playback is empty, initialize with this track
        if (this.playlist.length === 0 || this.currentIndex === -1) {
            this.playlist = [track];
            this.currentIndex = 0;
            this.loadTrack(0, true);
            return;
        }

        // 1. Search if track already exists and remove previous occurrences
        for (let i = this.playlist.length - 1; i >= 0; i--) {
            if (i !== this.currentIndex && this.isSameTrack(this.playlist[i], track)) {
                this.playlist.splice(i, 1);
                if (i < this.currentIndex) {
                    this.currentIndex--;
                }
            }
        }

        // 2. Insert next in queue right after the currently playing song
        const insertIdx = (this.currentIndex >= 0 && this.currentIndex < this.playlist.length) 
            ? this.currentIndex + 1 
            : this.playlist.length;
        this.playlist.splice(insertIdx, 0, track);
        this.renderQueue();
        this.triggerSaveUserState();
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
            if (this.audio) {
                this._userRequestedPause = true;
                this.audio.pause();
                this.audio.src = '';
            }
            this.isPlaying = false;
            this.updatePlayButton();
            if (this.elTitle) this.elTitle.innerText = 'No hay reproducción';
            if (this.elArtist) this.elArtist.innerText = '';
        } else if (isCurrent) {
            const newIndex = index < this.playlist.length ? index : 0;
            this.loadTrack(newIndex, true);
        } else if (index < this.currentIndex) {
            this.currentIndex--;
        }

        this.renderQueue();
        this.triggerSaveUserState();
        if (!silent && window.app && typeof window.app.showToast === 'function') {
            window.app.showToast(`Quitada de la lista: ${removedTrack.title || 'Canción'}`, 'info');
        }
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

        // 1. Identify filename and cache keys
        let filename = track.filename || null;
        if (!filename && window.app && typeof window.app.getLibraryTrackForItem === 'function') {
            const lib = window.app.getLibraryTrackForItem(track);
            if (lib && lib.filename) filename = lib.filename;
        }

        const keysToDelete = new Set();
        if (filename) keysToDelete.add(filename);
        if (track.filename) keysToDelete.add(track.filename);
        if (track.id) keysToDelete.add(track.id);

        // 2. Delete from IndexedDB offline storage
        if (window.app && window.app.storageManager) {
            for (const k of keysToDelete) {
                try {
                    await window.app.storageManager.deleteOfflineTrack(k);
                } catch (e) {
                    console.debug("[AudioPlayer] Error deleting from offline cache:", e);
                }
            }
        }

        // 3. Delete from backend library
        if (filename) {
            try {
                const fetcher = (window.app && window.app.customFetch) ? window.app.customFetch.bind(window.app) : fetch;
                const res = await fetcher(`/api/library/${encodeURIComponent(filename)}`, { method: 'DELETE' });
                if (res.ok) {
                    console.log(`[AudioPlayer] Track '${filename}' deleted from server library.`);
                }
            } catch (err) {
                console.error("[AudioPlayer] Error deleting track from server library:", err);
            }
        }

        // 4. Remove from active player queue and advance to next track
        const targetIndex = this.currentIndex;
        this.removeFromQueue(targetIndex, true);

        // 5. Refresh library view and notify user
        if (window.app) {
            if (typeof window.app.loadLibrary === 'function') {
                window.app.loadLibrary();
            }
            if (typeof window.app.showToast === 'function') {
                window.app.showToast(`'${title}' eliminada de la lista, caché y biblioteca`, 'success');
            }
        }
    }


    togglePlay() {
        if (this.currentIndex === -1 && this.playlist.length > 0) {
            this.loadTrack(0, true);
            return;
        }

        if (!this.audio.src) return;

        if (this.audio.paused) {
            this.clearBufferResumeListeners();
            this._userRequestedPause = false;
            this._lastSourceChangeTime = Date.now();
            if (this.normalizeVolume) {
                this.setupAudioProcessing();
                this.applyNormalizationSettings();
            }
            this.audio.play().then(() => {
                if (this.normalizeVolume) {
                    this.setupAudioProcessing();
                    this.applyNormalizationSettings();
                }
                this.isPlaying = true;
                this.updatePlayButton();
                this.triggerSaveUserState();
            }).catch(console.error);
        } else {
            this.clearBufferResumeListeners();
            this._userRequestedPause = true;
            this.audio.pause();
            this.isPlaying = false;
            this.updatePlayButton();
            this.triggerSaveUserState();
        }
    }

    isTrackCached(track) {
        if (!track) return false;
        if (window.app && window.app.storageManager && typeof window.app.storageManager.isTrackCached === 'function') {
            return window.app.storageManager.isTrackCached(track);
        }
        return false;
    }

    findNextCachedTrackIndex(fromIndex) {
        if (!this.playlist || this.playlist.length === 0) return -1;
        const len = this.playlist.length;
        for (let step = 1; step < len; step++) {
            const idx = (fromIndex + step) % len;
            if (this.isTrackCached(this.playlist[idx])) {
                return idx;
            }
        }
        return -1;
    }

    async backgroundCacheTrack(track) {
        if (!track || !window.app || !window.app.storageManager) return;
        const trackKey = track.filename || track.id;
        if (!trackKey) return;

        if (!this._currentlyBackgroundCaching) {
            this._currentlyBackgroundCaching = new Set();
        }
        if (this._currentlyBackgroundCaching.has(trackKey)) {
            return;
        }
        this._currentlyBackgroundCaching.add(trackKey);

        try {
            const existing = await window.app.storageManager.getOfflineTrack(trackKey);
            if (existing && existing.blob && existing.blob.size > 10000) {
                this._currentlyBackgroundCaching.delete(trackKey);
                return;
            }

            let streamUrl = '';
            if (track.filename) {
                streamUrl = `/api/stream/${encodeURIComponent(track.filename)}`;
            } else if (track.id && !String(track.id).startsWith('lib_')) {
                streamUrl = `/api/stream_yt?v=${encodeURIComponent(track.id)}`;
            } else if (track.is_yt) {
                streamUrl = `/api/stream_yt?v=${encodeURIComponent(`${track.artist || ''} ${track.title || ''}`.trim())}`;
            }

            if (!streamUrl) {
                this._currentlyBackgroundCaching.delete(trackKey);
                return;
            }

            console.log(`[Smart Cache] Background caching '${trackKey}' while cached track plays...`);
            const fetcher = window.app.customFetch ? window.app.customFetch.bind(window.app) : fetch;
            const res = await fetcher(streamUrl, {}, 90000);
            if (res && res.ok) {
                const blob = await res.blob();
                if (blob && blob.size > 10000) {
                    await window.app.storageManager.saveOfflineTrack(trackKey, blob, track);
                    window.app.storageManager.recordNetworkUsage(blob.size);
                    console.log(`[Smart Cache] Successfully cached '${trackKey}' in background for next playback.`);
                    if (window.app && typeof window.app.showToast === 'function') {
                        let title = track.title || track.filename || 'Canción';
                        if (typeof window.app.parseSongInfo === 'function') {
                            title = window.app.parseSongInfo(track).title || title;
                        }
                        window.app.showToast(`Lista para sonar: '${title}' (guardada en caché)`, 'success');
                    }
                    this.renderQueue();
                }
            }
        } catch (err) {
            console.warn("[Smart Cache] Error background caching track:", err);
        } finally {
            this._currentlyBackgroundCaching.delete(trackKey);
        }
    }

    findNextTrackIndex(direction = 'next', fromIndex = this.currentIndex) {
        if (!this.playlist || this.playlist.length === 0) return -1;
        const len = this.playlist.length;

        if (!this.isCacheOnly) {
            if (this.isShuffle) {
                if (len <= 1) return 0;
                let nextIdx = fromIndex;
                let attempts = 0;
                while ((nextIdx === fromIndex || nextIdx < 0) && attempts < 20) {
                    nextIdx = Math.floor(Math.random() * len);
                    attempts++;
                }
                return nextIdx >= 0 ? nextIdx : 0;
            }
            if (direction === 'next') {
                return (fromIndex + 1 + len * 2) % len;
            } else {
                return (fromIndex - 1 + len * 2) % len;
            }
        }

        // --- Cache-Only Mode (Skip un-cached songs and loop endlessly) ---
        const cachedIndices = [];
        for (let i = 0; i < len; i++) {
            if (this.isTrackCached(this.playlist[i])) {
                cachedIndices.push(i);
            }
        }
        if (cachedIndices.length === 0) return -1;
        if (cachedIndices.length === 1) return cachedIndices[0];

        if (this.isShuffle) {
            const otherCached = cachedIndices.filter(idx => idx !== fromIndex);
            const pool = otherCached.length > 0 ? otherCached : cachedIndices;
            return pool[Math.floor(Math.random() * pool.length)];
        }

        if (direction === 'next') {
            for (let step = 1; step <= len; step++) {
                const idx = (fromIndex + step + len * 2) % len;
                if (this.isTrackCached(this.playlist[idx])) {
                    return idx;
                }
            }
            return cachedIndices[0]; // Infinite loop: restarts list from first cached track
        } else {
            for (let step = 1; step <= len; step++) {
                const idx = (fromIndex - step + len * 2) % len;
                if (this.isTrackCached(this.playlist[idx])) {
                    return idx;
                }
            }
            return cachedIndices[cachedIndices.length - 1]; // Infinite loop: wraps around to last cached track
        }
    }

    playNext(isAutoAdvance = false) {
        if (this.playlist.length === 0) return;

        const nextIdx = this.findNextTrackIndex('next', this.currentIndex);
        if (nextIdx === -1) {
            if (this.isCacheOnly) {
                if (window.app && typeof window.app.showToast === 'function') {
                    window.app.showToast('No hay más canciones guardadas en caché dentro de esta lista', 'warning');
                }
                this.isPlaying = false;
                this.updatePlayButton();
            }
            return;
        }

        this.loadTrack(nextIdx, true, isAutoAdvance);
    }

    playPrevious() {
        if (this.playlist.length === 0) return;

        if (this.audio.currentTime > 3) {
            this.audio.currentTime = 0;
            return;
        }

        const prevIdx = this.findNextTrackIndex('prev', this.currentIndex);
        if (prevIdx === -1) {
            if (this.isCacheOnly) {
                if (window.app && typeof window.app.showToast === 'function') {
                    window.app.showToast('No hay canciones guardadas en caché dentro de esta lista', 'warning');
                }
            }
            return;
        }

        this.loadTrack(prevIdx, true);
    }

    updateShuffleBtn() {
        if (!this.elShuffleBtn) return;
        if (this.isShuffle) {
            this.elShuffleBtn.className = this.getUnifiedBtnActiveClass();
            this.elShuffleBtn.title = 'Modo Aleatorio: Activado';
        } else {
            this.elShuffleBtn.className = this.getUnifiedBtnInactiveClass();
            this.elShuffleBtn.title = 'Modo Aleatorio: Desactivado';
        }
    }

    updateCacheOnlyBtn() {
        if (!this.elCacheOnlyBtn) return;
        if (this.isCacheOnly) {
            this.elCacheOnlyBtn.className = this.getUnifiedBtnActiveClass();
            this.elCacheOnlyBtn.title = 'Solo Caché: Activado (Omitiendo canciones sin descargar para no gastar datos)';
        } else {
            this.elCacheOnlyBtn.className = this.getUnifiedBtnInactiveClass();
            this.elCacheOnlyBtn.title = 'Solo Caché: Desactivado (Toca para reproducir solo canciones descargadas)';
        }
    }

    updateRepeatBtn() {
        if (!this.elRepeatBtn) return;
        if (this.isRepeat) {
            this.elRepeatBtn.className = 'text-purple-400 hover:text-purple-300 bg-purple-500/20 shadow-sm border border-purple-500/30 transition p-1.5 rounded-lg flex items-center justify-center';
            this.elRepeatBtn.title = 'Repetir canción: Activado';
        } else {
            this.elRepeatBtn.className = 'text-gray-400 hover:text-white hover:bg-white/5 border border-transparent transition p-1.5 rounded-lg flex items-center justify-center';
            this.elRepeatBtn.title = 'Repetir canción: Desactivado';
        }
    }

    toggleShuffle() {
        this.isShuffle = !this.isShuffle;
        this.updateShuffleBtn();
        if (this.elShuffleBtn) this.elShuffleBtn.blur();
        this.triggerSaveUserState();
    }

    toggleCacheOnly(forceVal) {
        this.isCacheOnly = typeof forceVal === 'boolean' ? forceVal : !this.isCacheOnly;
        localStorage.setItem('music_app_cache_only', this.isCacheOnly ? 'true' : 'false');
        this.updateCacheOnlyBtn();
        if (this.elCacheOnlyBtn) this.elCacheOnlyBtn.blur();
        this.renderQueue();
        this.triggerSaveUserState();

        if (window.app && typeof window.app.showToast === 'function') {
            if (this.isCacheOnly) {
                window.app.showToast('Modo Solo Caché activado: solo se reproducirán canciones descargadas', 'success');
            } else {
                window.app.showToast('Modo Solo Caché desactivado', 'info');
            }
        }
    }

    toggleRepeat() {
        this.isRepeat = !this.isRepeat;
        this.updateRepeatBtn();
        if (this.elRepeatBtn) this.elRepeatBtn.blur();
        this.triggerSaveUserState();
    }

    onTrackEnded() {
        const finishedTrack = (this.currentIndex >= 0 && this.currentIndex < this.playlist.length) 
            ? this.playlist[this.currentIndex] 
            : null;

        if (!this._currentTrackListened && finishedTrack) {
            this._currentTrackListened = true;
            this.recordTrackPlay(finishedTrack);
        }

        // Check Sleep Timer: Stop at end of current track
        if (this.sleepTimerMode === 'track_end') {
            if (finishedTrack && window.app && window.app.storageManager) {
                this.cacheCompletedTrack(finishedTrack);
            }
            this.triggerSleepTimerShutdown('Temporizador: Canción finalizada, reproducción pausada');
            return;
        }

        // Check Sleep Timer: Stop at end of playlist
        if (this.sleepTimerMode === 'playlist_end') {
            const isLastTrack = this.currentIndex >= this.playlist.length - 1;
            if (isLastTrack) {
                if (finishedTrack && window.app && window.app.storageManager) {
                    this.cacheCompletedTrack(finishedTrack);
                }
                this.triggerSleepTimerShutdown('Temporizador: Lista finalizada, reproducción pausada');
                return;
            }
        }

        if (this.isRepeat) {
            // Repeat single track (accounting for start silence if trimmed)
            const startTime = (this.trimSilence && this.currentTrimPoints && this.currentTrimPoints.start) ? this.currentTrimPoints.start : 0;
            this.audio.currentTime = startTime;
            this.audio.play().catch(console.error);
        } else if (this.playlist.length > 0) {
            // Advance to next track in queue (loops indefinitely when reaching the end)
            this.playNext(true);
        } else {
            this.isPlaying = false;
            this.updatePlayButton();
        }

        if (finishedTrack && window.app && window.app.storageManager) {
            // Delay caching completed track by 35s so it does not saturate network bandwidth
            // or cloud rclone I/O while the new track is buffering its critical initial phase.
            setTimeout(() => {
                if (!this.isPlaying || (this.audio && this.audio.readyState >= 4)) {
                    this.cacheCompletedTrack(finishedTrack);
                }
            }, 35000);
        }
    }

    async cacheCompletedTrack(track) {
        if (!track || !window.app || !window.app.storageManager) return;

        let trackKey = track.filename || track.id;
        if (!trackKey) return;

        if (window.app && typeof window.app.getLibraryTrackForItem === 'function') {
            const lib = window.app.getLibraryTrackForItem(track);
            if (lib && lib.filename) {
                trackKey = lib.filename;
            }
        }

        try {
            const existing = await window.app.storageManager.getOfflineTrack(trackKey);
            if (existing && existing.blob && existing.blob.size > 10000) {
                console.log(`[Offline Cache] Track '${trackKey}' is already in local cache.`);
                return;
            }

            let streamUrl = '';
            if (track.filename) {
                streamUrl = `/api/stream/${encodeURIComponent(track.filename)}`;
            } else if (track.id) {
                streamUrl = `/api/stream_yt?v=${encodeURIComponent(track.id)}`;
            } else if (track.is_yt) {
                streamUrl = `/api/stream_yt?v=${encodeURIComponent(`${track.artist || ''} ${track.title || ''}`.trim())}`;
            }

            if (!streamUrl) return;

            console.log(`[Offline Cache] Auto-caching completed track '${trackKey}' from ${streamUrl}...`);
            const fetcher = window.app.customFetch ? window.app.customFetch.bind(window.app) : fetch;
            const res = await fetcher(streamUrl, {}, 60000);
            if (res.ok) {
                const blob = await res.blob();
                if (blob && blob.size > 10000) {
                    await window.app.storageManager.saveOfflineTrack(trackKey, blob, track);
                    console.log(`[Offline Cache] Successfully saved completed track '${trackKey}' into IndexedDB (${blob.size} bytes).`);
                    if (window.app && typeof window.app.showToast === 'function') {
                        window.app.showToast(`Canción guardada en caché local (${window.app.storageManager.formatBytes(blob.size)})`, 'success');
                    }
                }
            } else {
                console.warn(`[Offline Cache] Could not fetch audio blob for caching: HTTP ${res.status}`);
            }
        } catch (err) {
            console.warn("[Offline Cache] Error caching completed track:", err);
        }
    }

    onTimeUpdate() {
        if (!this.audio.duration) return;
        const current = this.audio.currentTime;
        const total = this.audio.duration;
        const percent = (current / total) * 100;

        if (this.elSeekSlider) this.elSeekSlider.value = percent;
        if (this.elCurrTime) this.elCurrTime.innerText = this.formatTime(current);

        this.updateMediaSessionPosition();
        this.checkPreloadNextTrack();

        // Check listen threshold (15s or 50% of track) to register play event for monthly ranking
        if (!this._currentTrackListened && (current >= 15 || (total > 0 && current >= total * 0.5))) {
            this._currentTrackListened = true;
            const currentTrack = (this.currentIndex >= 0 && this.currentIndex < this.playlist.length) ? this.playlist[this.currentIndex] : null;
            if (currentTrack) {
                this.recordTrackPlay(currentTrack);
            }
        }

        // Automatic start silence catch-up in early playback (only if playback has barely started < 0.08s)
        if (this.trimSilence && this.currentTrimPoints && this.currentTrimPoints.start > 0.15 && current < 0.08 && current < this.currentTrimPoints.start - 0.04) {
            this.applyStartSilenceTrim();
        }

        // Automatic end silence trimming: if current playback reached the active end trim point
        if (this.trimSilence && this.currentTrimPoints && this.currentTrimPoints.end > 0 && current >= this.currentTrimPoints.end && total > this.currentTrimPoints.end + 0.25) {
            console.log(`[SilenceTrim] End silence reached at ${current.toFixed(2)}s (trim point: ${this.currentTrimPoints.end}s, total: ${total.toFixed(2)}s). Advancing track.`);
            this.onTrackEnded();
        }
    }

    async checkPreloadNextTrack() {
        if (!this.audio || !this.audio.duration || this.playlist.length === 0) return;
        const remaining = this.audio.duration - this.audio.currentTime;

        // Trigger background pre-warming when 10s remain in current song
        if (remaining > 0 && remaining <= 10 && !this.isPreloadingNext) {
            this.isPreloadingNext = true;
            let nextIdx = (this.currentIndex + 1) % this.playlist.length;
            if (this.isShuffle && this.playlist.length > 1) {
                nextIdx = Math.floor(Math.random() * this.playlist.length);
            }

            const nextTrack = this.playlist[nextIdx];
            if (!nextTrack) {
                this.isPreloadingNext = false;
                return;
            }

            if (nextTrack.is_yt || nextTrack.id) {
                if (window.app && typeof window.app.preloadYtTrack === 'function') {
                    window.app.preloadYtTrack(nextTrack.id);
                }
            }
        } else if (remaining > 15) {
            this.isPreloadingNext = false;
        }
    }

    onLoadedMetadata() {
        if (this.elDuration) this.elDuration.innerText = this.formatTime(this.audio.duration || 0);
        this.updateMediaSessionPosition();
    }

    onAudioError(e) {
        console.error("Audio playback error:", e);
        this.stopLoadingBeep();
        if (this.errorSkipTimer) clearTimeout(this.errorSkipTimer);

        // Fallback: If offline blob failed to play or decode, fallback to live server stream
        if (this.currentBlobUrl && this.currentIndex >= 0 && this.currentIndex < this.playlist.length) {
            console.warn("[AudioPlayer] Cached blob failed to play, falling back to server stream...");
            try {
                URL.revokeObjectURL(this.currentBlobUrl);
            } catch (err) {}
            this.currentBlobUrl = null;
            this.activeBlob = null;

            const track = this.playlist[this.currentIndex];
            let fallbackUrl = '';
            if (track.filename) {
                fallbackUrl = `/api/stream/${encodeURIComponent(track.filename)}`;
            } else if (track.is_yt || track.id) {
                fallbackUrl = `/api/stream_yt?v=${encodeURIComponent(track.id)}`;
            }
            if (fallbackUrl) {
                this._lastSourceChangeTime = Date.now();
                this.audio.src = fallbackUrl;
                this.audio.load();
                this.audio.play().then(() => {
                    this.isPlaying = true;
                    this.updatePlayButton();
                }).catch(console.error);
                return;
            }
        }

        if (this.playlist && this.playlist.length > 1) {
            console.warn(`[AudioPlayer] Stream error on track index ${this.currentIndex}. Advancing to next track...`);
            if (window.app && window.app.showToast) {
                window.app.showToast("Error en la pista de audio. Pasando a la siguiente...", "warning");
            }
            this.errorSkipTimer = setTimeout(() => {
                this.playNext();
            }, 600);
        } else if (this.playlist && this.playlist.length === 1) {
            this.errorRetryCount = (this.errorRetryCount || 0) + 1;
            if (this.errorRetryCount <= 3) {
                console.warn(`[AudioPlayer] Retrying current track in 1s (attempt ${this.errorRetryCount})...`);
                this.errorSkipTimer = setTimeout(() => {
                    if (this.playlist.length === 1) {
                        this.loadTrack(0, true);
                    }
                }, 1000);
            } else {
                this.isLoading = false;
                this.isPlaying = false;
                this.updatePlayButton();
            }
        } else {
            this.isLoading = false;
            this.isPlaying = false;
            this.updatePlayButton();
        }
    }

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

    toggleQueueModal() {
        const el = this.elQueueDrawer || document.getElementById('queue-drawer');
        if (!el) return;
        if (el.classList.contains('hidden')) {
            this.openQueueModal();
        } else {
            this.closeQueueModal();
        }
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

    selectTrackFromQueue(index) {
        if (this.isCacheOnly && this.playlist && this.playlist[index] && !this.isTrackCached(this.playlist[index])) {
            const nextCached = this.findNextTrackIndex('next', index - 1);
            if (nextCached !== -1) {
                if (window.app && typeof window.app.showToast === 'function') {
                    window.app.showToast('Esta canción no está en la caché. Saltando a la siguiente guardada...', 'info');
                }
                this.loadTrack(nextCached, true);
            } else {
                if (window.app && typeof window.app.showToast === 'function') {
                    window.app.showToast('Esta canción no está en la caché y no hay canciones guardadas en la lista', 'warning');
                }
            }
            this.closeQueueModal();
            return;
        }

        this.loadTrack(index, true);
        this.closeQueueModal();
    }

    renderQueue() {
        if (!this.elQueueList) return;

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

            const unplayableInCacheOnly = this.isCacheOnly && !isCached;
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
                <div class="group flex items-center justify-between gap-2 sm:gap-3 p-2 sm:p-2.5 rounded-xl transition ${isActive ? 'bg-purple-900/40 text-purple-200 border border-purple-500/40 shadow-sm' : 'hover:bg-white/5 text-slate-300 border border-transparent'} ${unplayableInCacheOnly ? 'opacity-45 hover:opacity-75' : ''}">
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
            volume: 1.0,
            isPlaying: this.isPlaying,
            isShuffle: !!this.isShuffle,
            isRepeat: !!this.isRepeat,
            isCacheOnly: !!this.isCacheOnly,
            isSortByMonthlyPlays: !!this.isSortByMonthlyPlays,
            monthlyPlaysSortDirection: this.monthlyPlaysSortDirection || 'desc'
        };
    }

    restoreState(state) {
        if (!state) return;
        if (typeof state.isShuffle === 'boolean') {
            this.isShuffle = state.isShuffle;
            this.updateShuffleBtn();
        }
        if (typeof state.isRepeat === 'boolean') {
            this.isRepeat = state.isRepeat;
            this.updateRepeatBtn();
        }
        if (typeof state.isCacheOnly === 'boolean') {
            this.isCacheOnly = state.isCacheOnly;
            this.updateCacheOnlyBtn();
        }
        if (typeof state.isSortByMonthlyPlays === 'boolean') {
            this.isSortByMonthlyPlays = state.isSortByMonthlyPlays;
        }
        if (state.monthlyPlaysSortDirection) {
            this.monthlyPlaysSortDirection = state.monthlyPlaysSortDirection;
        }
        this.updateSortMonthlyBtn();

        // If audio is currently actively playing in this session, do not disrupt or reload audio!
        if (this.isPlaying && this.audio && !this.audio.paused) {
            console.log("[AudioPlayer] restoreState: Audio is actively playing, keeping live playback uninterrupted.");
            return;
        }

        if (state.playlist && Array.isArray(state.playlist) && state.playlist.length > 0) {
            this.playlist = state.playlist;
            const originalTrack = (typeof state.currentIndex === 'number' && state.currentIndex >= 0 && state.currentIndex < state.playlist.length) 
                ? state.playlist[state.currentIndex] 
                : state.playlist[0];

            // Reorder queue on app launch if monthly sort is enabled
            if (this.isSortByMonthlyPlays && this.playlist.length > 1) {
                this.sortByMonthlyPlays(false);
            }

            const idx = originalTrack ? Math.max(0, this.playlist.indexOf(originalTrack)) : 0;
            
            // If the current track is already loaded at index, do not reload source
            if (this.currentIndex === idx && this.audio && this.audio.src) {
                this.renderQueue();
                return;
            }

            this.loadTrack(idx, false);
            if (state.currentTime && state.currentTime > 0) {
                const targetTime = state.currentTime;
                const onLoadedMeta = () => {
                    this.audio.removeEventListener('loadedmetadata', onLoadedMeta);
                    try {
                        if (this.audio.duration && targetTime < this.audio.duration) {
                            this.audio.currentTime = targetTime;
                        }
                    } catch(e) {}
                };
                this.audio.addEventListener('loadedmetadata', onLoadedMeta);
            }
        }
        if (this.audio) {
            this.audio.volume = 1.0;
        }
    }

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

        // Prune entries older than 35 days
        const cutoff = now - (35 * 24 * 60 * 60 * 1000);
        for (const k in history) {
            history[k] = history[k].filter(ts => ts >= cutoff);
            if (history[k].length === 0) delete history[k];
        }

        this.savePlayHistory(history);

        // Sync listen event to backend
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

        // Alternar continuamente entre 'desc' (más a menos) y 'asc' (menos a más)
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

        // Stable sort by monthly play count (descending or ascending)
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

        // SVG Arrow Paths:
        // Arrow Down (más a menos): M12 5v14M19 12l-7 7-7-7
        // Arrow Up (menos a más): M12 19V5M5 12l7-7 7 7
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

    triggerSaveUserState() {
        if (window.app && typeof window.app.saveUserState === 'function') {
            window.app.saveUserState();
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

    // ==========================================
    // SLEEP TIMER MANAGER
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
                } else if (this.sleepTimerEndTimestamp) {
                    const remainingMin = Math.max(1, Math.ceil((this.sleepTimerEndTimestamp - Date.now()) / 60000));
                    statusText.textContent = `Activo: Se apagará en aprox. ${remainingMin} min`;
                }
            }
        } else {
            if (cancelContainer) cancelContainer.classList.add('hidden');
            if (statusText) statusText.textContent = 'Detén la música automáticamente';
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

        // Restore volume if cancelled during fade
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

        // Soft fade out during the last 6 seconds
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

        this._userRequestedPause = true;
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

    escapeHtml(str) {
        if (!str) return '';
        return str.replace(/[&<>"']/g, function(m) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
        });
    }
}

window.player = new AudioPlayer();
