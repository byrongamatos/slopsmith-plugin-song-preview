(function () {
    'use strict';

    const PLUGIN = 'song_preview';
    const API = `/api/plugins/${PLUGIN}`;

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
                refreshAllButtons();
            }
        });
        _audio.addEventListener('ended', () => {
            _playingFile = null;
            _loadingFile = null;
            refreshAllButtons();
        });
        _audio.addEventListener('error', () => {
            console.warn(`[${PLUGIN}] audio error for`, _loadingFile || _playingFile);
            _playingFile = null;
            _loadingFile = null;
            refreshAllButtons();
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
        refreshAllButtons();

        audio.src = `${API}/audio?file=${encodeURIComponent(filename)}`;
        audio.play().catch((e) => {
            // play() often rejects because the user already moved on to another
            // card. Only clear state if this filename is still the active one.
            if (_loadingFile === filename || _playingFile === filename) {
                console.warn(`[${PLUGIN}] play() rejected:`, e);
                _loadingFile = null;
                _playingFile = null;
                refreshAllButtons();
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
        refreshAllButtons();
    }

    function btnState(filename) {
        if (_loadingFile === filename) return 'loading';
        if (_playingFile === filename) return 'playing';
        return 'idle';
    }

    function makeButton(filename, variant) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `song-preview-btn song-preview-btn--${variant}`;
        btn.dataset.previewFile = filename;
        btn.dataset.previewVariant = variant;
        applyState(btn, btnState(filename));
        // The card hover does the triggering now; clicking the button just bails
        // out of an in-flight preview without having to move the mouse away.
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (_loadingFile === filename || _playingFile === filename) stopPreview();
        });
        return btn;
    }

    function attachHover(host, filename) {
        if (host.dataset.songPreviewHover) return;
        host.dataset.songPreviewHover = '1';

        let timer = null;
        host.addEventListener('mouseenter', () => {
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

    function applyState(btn, state) {
        // is-active keeps the button visible without needing hover.
        btn.classList.toggle('is-active', state !== 'idle');

        if (state === 'playing') {
            btn.innerHTML = '&#9632;&thinsp;Stop';
            btn.title = 'Stop preview';
            btn.disabled = false;
        } else if (state === 'loading') {
            btn.innerHTML = '&hellip;&thinsp;Loading';
            btn.title = 'Loading preview…';
            btn.disabled = false;
        } else {
            btn.innerHTML = '&#9654;&thinsp;Preview';
            btn.title = 'Preview this song';
            btn.disabled = false;
        }
    }

    function refreshAllButtons() {
        document.querySelectorAll('.song-preview-btn').forEach((btn) => {
            applyState(btn, btnState(btn.dataset.previewFile || ''));
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
        if (card.querySelector('.song-preview-btn')) return;
        const fn = entryFilename(card);
        if (!isPreviewable(fn)) return;
        const body = card.querySelector('.p-4');
        if (!body) return;
        body.appendChild(makeButton(fn, 'card'));
        attachHover(card, fn);
    }

    function injectIntoRow(row) {
        if (row.querySelector('.song-preview-btn')) return;
        const fn = entryFilename(row);
        if (!isPreviewable(fn)) return;
        // Drop the button in the same trailing container sloppak-converter uses,
        // so the two buttons line up next to each other.
        const tail =
            row.querySelector(':scope > .flex.items-center.flex-shrink-0') ||
            row.querySelector(':scope > div:last-child') ||
            row;
        tail.appendChild(makeButton(fn, 'row'));
        attachHover(row, fn);
    }

    function injectAll() {
        document.querySelectorAll('.song-card').forEach(injectIntoCard);
        document.querySelectorAll('.song-row[data-play]').forEach(injectIntoRow);
    }

    const STYLE = `
        .song-preview-btn {
            display: inline-flex;
            align-items: center;
            gap: 3px;
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 6px;
            background: rgba(255,255,255,0.05);
            color: #94a3b8;
            cursor: pointer;
            font-size: 11px;
            line-height: 1;
            white-space: nowrap;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.15s, background 0.15s, color 0.15s, border-color 0.15s;
        }
        .song-preview-btn--card {
            padding: 4px 10px;
            font-size: 12px;
        }
        .song-preview-btn--row {
            padding: 2px 7px;
        }

        .song-card:hover .song-preview-btn,
        .song-row:hover .song-preview-btn {
            opacity: 1;
            pointer-events: auto;
        }

        @media (hover: none) {
            .song-preview-btn {
                opacity: 1;
                pointer-events: auto;
            }
        }

        .song-preview-btn.is-active {
            opacity: 1 !important;
            pointer-events: auto !important;
            background: rgba(167,139,250,0.15);
            border-color: rgba(167,139,250,0.4);
            color: #c4b5fd;
        }
        .song-preview-btn.is-active:hover {
            background: rgba(167,139,250,0.25);
        }

        .song-card:hover .song-preview-btn:hover,
        .song-row:hover .song-preview-btn:hover {
            background: rgba(255,255,255,0.1);
            color: #e2e8f0;
        }
    `;

    function injectStyles() {
        const style = document.createElement('style');
        style.dataset.songPreview = '1';
        style.textContent = STYLE;
        document.head.appendChild(style);
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

    injectStyles();
    obs.observe(document.body, { childList: true, subtree: true });
    injectAll();
})();