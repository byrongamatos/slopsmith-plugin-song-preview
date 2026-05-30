// Owns the single shared <audio> element used for previewing. Centralises
// start/stop, the inter-song handoff, and detection of "some other audio
// just started — get out of its way". Pub/sub keeps ProgressScope and
// PreviewLoop loosely coupled to playback state:
//   'play'      (file, host)   — audio is actually flowing (not just loading).
//   'stop'      (reason)       — any state-clear: manual stop, end, error,
//                                song switch, play() rejected, external audio
//                                override. Listeners use this for cleanup.
//   'completed' (file)         — natural 'ended' only. Drives the single-play
//                                gate so a clip won't immediately replay.
// Preview volume is persisted as 0..100 (matching Slopsmith's mixer
// convention) and applied to the preview <audio> as 0..1. It is the plugin's
// OWN level — deliberately independent of the host Song channel.
const VOLUME_KEY = 'slopsmith_song_preview_volume';
const DEFAULT_VOLUME = 0.2;
// The slider controls loudness only — turning previews OFF is the toggle's job.
// So volume never reaches 0: it floors at a quiet-but-audible minimum. (Also
// migrates any stale 0 saved by an earlier build up to the floor.)
const MIN_VOLUME = 0.05;

export class AudioController {
    constructor({ apiBase, pluginName }) {
        this._apiBase = apiBase;
        this._pluginName = pluginName;
        this._audio = null;
        this._loadingFile = null;
        this._playingFile = null;
        this._activeHost = null;
        this._externalAudioActive = false;
        this._playListenerInstalled = false;
        this._listeners = { play: [], stop: [], completed: [] };

        // Sticky memo of filenames the server has 404'd for. The hover
        // loop polls a candidate target every debounce tick — without
        // this, sitting on a card whose sloppak has no embedded preview
        // would fire one network request + one HTMLMediaElement load
        // cycle per tick (we saw ~38 redundant 404s in a single hover
        // dwell). PreviewBackfill clears entries via clearNoPreviewMemo()
        // once a backfill succeeds, so a freshly-injected preview gets
        // picked up without a page reload.
        this._noPreviewFiles = new Set();

        // Preview volume is the plugin's own level (see VOLUME_KEY), decoupled
        // from the host Song channel. Cross-tab drags fire 'storage'; same-tab
        // changes call setVolume() directly, and start() re-applies it so the
        // next hover always uses the current level.
        this._volume = this._loadVolume();
        this._onStorage = (e) => {
            if (e.key === VOLUME_KEY) {
                this._volume = this._loadVolume();
                this._applyVolume();
            }
        };
        window.addEventListener('storage', this._onStorage);

        // 'play' doesn't bubble — capture-phase document listener catches
        // anything else (host, another plugin) starting audio. Installed
        // lazily alongside the <audio> element so destroy() can pair them.
        this._onDocumentPlay = (e) => {
            if (e.target !== this._audio) {
                this.stop('external-audio');
                this._externalAudioActive = true;
            }
        };
    }

    on(event, cb) {
        if (!this._listeners[event]) throw new Error(`unknown event: ${event}`);
        this._listeners[event].push(cb);
    }

    _emit(event, ...args) {
        for (const cb of this._listeners[event]) cb(...args);
    }

    isActive() { return !!(this._loadingFile || this._playingFile); }
    currentFile() { return this._playingFile || this._loadingFile; }
    activeHost() { return this._activeHost; }
    audioElement() { return this._audio; }
    isExternalAudioActive() { return this._externalAudioActive; }
    clearExternalAudio() { this._externalAudioActive = false; }
    // Called by PreviewBackfill after a successful inject so the next
    // hover doesn't bounce off the stale memo.
    clearNoPreviewMemo(filename) { this._noPreviewFiles.delete(filename); }

    _loadVolume() {
        try {
            const raw = parseFloat(localStorage.getItem(VOLUME_KEY));
            if (Number.isFinite(raw)) return Math.min(1, Math.max(MIN_VOLUME, raw / 100));
        } catch (_) { /* sandboxed storage — fall back to default */ }
        return DEFAULT_VOLUME;
    }

    // 0..1. Read by PreviewLoop's volume gate and the volume slider UI.
    getVolume() { return this._volume; }

    // Called by the volume slider. Persists (as 0..100) and applies live so a
    // drag updates an in-flight preview in real time.
    setVolume(v) {
        this._volume = Math.min(1, Math.max(MIN_VOLUME, Number(v) || 0));
        try { localStorage.setItem(VOLUME_KEY, String(Math.round(this._volume * 100))); }
        catch (_) { /* sandboxed storage — in-memory only this session */ }
        this._applyVolume();
    }

    _applyVolume() {
        if (this._audio) this._audio.volume = this._volume;
    }

    _ensureAudio() {
        if (this._audio) return this._audio;
        const audio = document.createElement('audio');
        audio.preload = 'none';
        document.body.appendChild(audio);

        audio.addEventListener('playing', () => {
            if (this._loadingFile) {
                this._playingFile = this._loadingFile;
                this._loadingFile = null;
            }
            // Listeners (ProgressScope) attach only once audio is flowing,
            // so the perimeter ring doesn't paint a flat line during the
            // initial fetch/transcode.
            this._emit('play', this._playingFile, this._activeHost);
        });
        audio.addEventListener('ended', () => {
            const finished = this._playingFile || this._loadingFile;
            this._clear();
            this._emit('stop', 'ended');
            this._emit('completed', finished);
        });
        audio.addEventListener('error', () => {
            // Cancelling via audio.src = '' resolves the empty string to
            // the page URL, which the decoder rejects and surfaces as a
            // spurious 'error' with no active file. Ignore that.
            const active = this._loadingFile || this._playingFile;
            if (!active) return;
            console.warn(`[${this._pluginName}] audio error for`, active);
            // HTMLMediaElement.error doesn't expose the HTTP status, so
            // do a one-shot HEAD probe to see if the preview is missing
            // (404) vs a real codec/network error. We memoize on 404 OR
            // 405 — 405 means the server doesn't speak HEAD (older
            // backend), and in that case the only reason we'd be here
            // is that the original GET also failed; assume preview-
            // missing so the hover loop stops retrying. Transient 5xx
            // stay unmemoized so they'll be retried on next hover.
            const url = `${this._apiBase}/audio?file=${encodeURIComponent(active)}`;
            fetch(url, { method: 'HEAD' }).then(r => {
                if (r.status === 404 || r.status === 405) {
                    this._noPreviewFiles.add(active);
                }
            }).catch(() => { /* network gone, treat as transient */ });
            this._clear();
            this._emit('stop', 'error');
        });

        if (!this._playListenerInstalled) {
            document.addEventListener('play', this._onDocumentPlay, true);
            this._playListenerInstalled = true;
        }

        this._audio = audio;
        return audio;
    }

    _clear() {
        this._loadingFile = null;
        this._playingFile = null;
        this._activeHost = null;
    }

    start(filename, host) {
        if (this._loadingFile === filename || this._playingFile === filename) return;
        // Short-circuit hover spam on files we already know have no
        // preview. Cleared per-file by PreviewBackfill on successful
        // injection so the new clip plays immediately after Fix.
        if (this._noPreviewFiles.has(filename)) return;
        const audio = this._ensureAudio();

        // Cut off whatever was playing before. Emit stop so the old scope
        // detaches; the new one attaches on the upcoming 'play' event.
        if (this.isActive()) {
            audio.pause();
            audio.src = '';
            this._clear();
            this._emit('stop', 'switch');
        }

        this._loadingFile = filename;
        this._activeHost = host || null;
        this._applyVolume();

        audio.src = `${this._apiBase}/audio?file=${encodeURIComponent(filename)}`;
        audio.play().catch((e) => {
            // play() often rejects because the user already moved on. Only
            // clear state if this filename is still the active one.
            if (this._loadingFile === filename || this._playingFile === filename) {
                console.warn(`[${this._pluginName}] play() rejected:`, e);
                this._clear();
                this._emit('stop', 'play-rejected');
            }
        });
    }

    stop(reason = 'stop') {
        if (!this.isActive()) return;
        const audio = this._audio;
        // pause() alone leaves a partially-buffered stream that can keep
        // leaking audio. removeAttribute('src') + load() aborts any pending
        // fetch and fully resets the element.
        audio.pause();
        audio.removeAttribute('src');
        try { audio.load(); } catch (_) { /* paranoia */ }
        this._clear();
        this._emit('stop', reason);
    }

    destroy() {
        if (this.isActive()) this.stop('destroy');
        window.removeEventListener('storage', this._onStorage);
        if (this._playListenerInstalled) {
            document.removeEventListener('play', this._onDocumentPlay, true);
            this._playListenerInstalled = false;
        }
        if (this._audio) {
            try {
                this._audio.pause();
                this._audio.removeAttribute('src');
                this._audio.load();
                this._audio.remove();
            } catch (_) {}
            this._audio = null;
        }
        this._externalAudioActive = false;
        for (const k of Object.keys(this._listeners)) this._listeners[k].length = 0;
    }
}
