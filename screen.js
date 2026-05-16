(function () {
    'use strict';

    const PLUGIN = 'song_preview';
    const API = `/api/plugins/${PLUGIN}`;

    const STORAGE_KEY = 'slopsmith_song_preview_enabled';
    const TOGGLE_IDS = ['song-preview-enabled', 'song-preview-enabled-screen'];

    function isPreviewEnabled() {
        return localStorage.getItem(STORAGE_KEY) !== 'false';
    }

    function setPreviewEnabled(on) {
        localStorage.setItem(STORAGE_KEY, on ? 'true' : 'false');
        // Mirror to every known toggle currently in the DOM so the
        // Settings page and the dedicated screen stay in sync.
        for (const id of TOGGLE_IDS) {
            const el = document.getElementById(id);
            if (el && el.checked !== on) el.checked = on;
        }
    }

    function bindToggles() {
        for (const id of TOGGLE_IDS) {
            const el = document.getElementById(id);
            if (!el || el.dataset.songPreviewBound) continue;
            el.dataset.songPreviewBound = '1';
            el.checked = isPreviewEnabled();
            el.addEventListener('change', () => setPreviewEnabled(el.checked));
        }
    }

    // One shared <audio> for the whole page. Starting a new preview kills the old one.
    let _audio = null;
    let _loadingFile = null;
    let _playingFile = null;

    function getAudio() {
        if (_audio) return _audio;
        _audio = document.createElement('audio');
        _audio.preload = 'none';
        document.body.appendChild(_audio);

        _audio.addEventListener('playing', () => {
            if (_loadingFile) {
                _playingFile = _loadingFile;
                _loadingFile = null;
            }
        });
        _audio.addEventListener('ended', () => {
            _playingFile = null;
            _loadingFile = null;
        });
        _audio.addEventListener('error', () => {
            console.warn(`[${PLUGIN}] audio error for`, _loadingFile || _playingFile);
            _playingFile = null;
            _loadingFile = null;
        });

        // If the main app fires up any other audio element, get out of its way.
        // 'play' doesn't bubble, so listen in the capture phase.
        document.addEventListener('play', (e) => {
            if (e.target !== _audio) stopPreview();
        }, true);

        return _audio;
    }

    function startPreview(filename) {
        if (_loadingFile === filename || _playingFile === filename) return;
        const audio = getAudio();

        // Cut off whatever was playing before.
        if (_loadingFile || _playingFile) {
            audio.pause();
            audio.src = '';
            _loadingFile = null;
            _playingFile = null;
        }

        _loadingFile = filename;

        audio.src = `${API}/audio?file=${encodeURIComponent(filename)}`;
        audio.play().catch((e) => {
            // play() often rejects because the user already moved on to another
            // card. Only clear state if this filename is still the active one.
            if (_loadingFile === filename || _playingFile === filename) {
                console.warn(`[${PLUGIN}] play() rejected:`, e);
                _loadingFile = null;
                _playingFile = null;
            }
        });
    }

    function stopPreview() {
        if (!_loadingFile && !_playingFile) return;
        const audio = getAudio();
        audio.pause();
        audio.src = '';
        _loadingFile = null;
        _playingFile = null;
    }

    function attachHover(host, filename) {
        if (host.dataset.songPreviewHover) return;
        host.dataset.songPreviewHover = '1';

        let timer = null;
        host.addEventListener('mouseenter', () => {
            if (!isPreviewEnabled()) return;

            // The library re-renders cards mid-hover, which can leave a stale
            // preview playing because the old card's mouseleave never fired.
            // If a different file is still going, cut it dead now.
            const active = _loadingFile || _playingFile;
            if (active && active !== filename) stopPreview();

            // Short debounce so scrolling past cards doesn't fire one request per card.
            timer = setTimeout(() => {
                timer = null;
                startPreview(filename);
            }, 180);
        });

        host.addEventListener('mouseleave', () => {
            if (timer) { clearTimeout(timer); timer = null; }
            if (_loadingFile === filename || _playingFile === filename) stopPreview();
        });
    }

    // data-play holds the DLC-root-relative path (same value the rest of the app uses).
    function entryFilename(el) {
        try { return decodeURIComponent(el.dataset.play || ''); }
        catch (_) { return el.dataset.play || ''; }
    }

    // Only PSARCs and loose folders get previews. Sloppaks are skipped on purpose.
    function isPreviewable(fn) {
        return !!fn && !fn.toLowerCase().endsWith('.sloppak');
    }

    function injectIntoCard(card) {
        const fn = entryFilename(card);
        if (!isPreviewable(fn)) return;
        attachHover(card, fn);
    }

    function injectIntoRow(row) {
        const fn = entryFilename(row);
        if (!isPreviewable(fn)) return;
        attachHover(row, fn);
    }

    function injectAll() {
        document.querySelectorAll('.song-card').forEach(injectIntoCard);
        document.querySelectorAll('.song-row[data-play]').forEach(injectIntoRow);
        bindToggles();
    }

    // The library re-renders a lot. Coalesce inject calls to one per frame.
    let _injectPending = false;

    function scheduleInject() {
        if (_injectPending) return;
        _injectPending = true;
        requestAnimationFrame(() => {
            _injectPending = false;
            injectAll();
        });
    }

    const obs = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) {
                scheduleInject();
                return;
            }
        }
    });

    obs.observe(document.body, { childList: true, subtree: true });
    injectAll();
})();