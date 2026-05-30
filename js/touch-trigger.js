// Touch-device preview trigger. The hover loop (PreviewLoop) is the primary
// modality and is built on two things a touchscreen doesn't have: a persistent
// pointer (start = elementFromPoint) and a "cursor left the card" signal
// (stop). Long-press is unusable too — the browser claims it for the
// context/selection menu. So on touch we don't try to patch hover; we add an
// explicit affordance: a tap-to-play / tap-to-stop button per card/row.
//
// This is graceful degradation, not a parallel UX — desktop is left completely
// untouched. We only inject anything when the device reports no hover + a
// coarse pointer, and everything below the trigger is reused: AudioController
// owns playback (start/stop, handoff, the 404 memo), and ProgressScope draws
// its ring off the same 'play'/'stop' events, so the clip looks identical to a
// hover-triggered one.
//
// Two deliberate details that mirror PreviewBackfill:
//   - One document-level click delegate, not per-button handlers — survives
//     the library re-rendering card innerHTML out from under us.
//   - State changes (idle ↔ playing) toggle a CLASS, never innerHTML. The
//     bootstrap MutationObserver watches childList only, so an attribute flip
//     is invisible to it; an innerHTML rewrite inside an observed card grid
//     would re-trigger the observer → re-decorate → rewrite, a per-frame loop.

const STYLE_ID = 'song-preview-touch-styles';
// Dataset key marking nodes we've injected a play button into. Value is the
// filename, so a recycled card node (infinite scroll re-uses DOM) whose
// data-play changed underneath us is detected and re-wired.
const FLAG = 'songPreviewTouchBtn';

// Self-contained styles — the host ships a purged, prebuilt tailwind.min.css
// that doesn't include plugin-only classes, so anything that must render is
// scoped here rather than leaning on host utilities. Accent matches the host
// the same way style.css does: --sm-accent triplet with the literal #4080e0
// fallback.
const STYLES = `
.sp-touch-play{
    position:absolute;right:8px;bottom:8px;z-index:3;
    /* 44x44 minimum touch target (Apple HIG / WCAG 2.5.5). */
    width:44px;height:44px;display:flex;align-items:center;justify-content:center;
    padding:0;border:none;border-radius:9999px;cursor:pointer;
    color:#fff;background:rgba(0,0,0,.55);
    -webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);
    box-shadow:0 1px 3px rgba(0,0,0,.5);
    transition:background-color 150ms ease,transform 100ms ease;
    touch-action:manipulation;-webkit-tap-highlight-color:transparent;
}
.sp-touch-play:active{transform:scale(.92)}
.sp-touch-play.is-playing{background:rgb(var(--sm-accent, 64, 128, 224))}
.sp-touch-play svg{width:20px;height:20px;display:block;pointer-events:none}
.sp-touch-play .sp-ico-stop{display:none}
.sp-touch-play.is-playing .sp-ico-play{display:none}
.sp-touch-play.is-playing .sp-ico-stop{display:block}
/* Row variant: no album art to overlay, so sit inline beside the title.
   Keep the full 44px hit target. */
.sp-touch-play--row{
    position:static;width:44px;height:44px;margin-left:8px;flex:0 0 auto;
}
.sp-touch-play--row svg{width:18px;height:18px}
`;

// Play triangle + stop square, both present in the DOM so the visible one is a
// pure CSS toggle (see the class-not-innerHTML note above).
const ICONS =
    '<svg class="sp-ico-play" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>' +
    '<svg class="sp-ico-stop" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';

export class TouchTrigger {
    constructor({ audio, toggle, menu }) {
        this._audio = audio;
        this._toggle = toggle;
        this._menu = menu;

        // The whole feature is gated on this. Pure touch devices only — a
        // mouse user on a hybrid 2-in-1 keeps the hover path untouched.
        this._mql = window.matchMedia('(hover: none) and (pointer: coarse)');
        this._isTouch = this._mql.matches;
        // Devices rarely flip modality, but a 2-in-1 detaching its keyboard
        // can. React so buttons appear/disappear without a reload.
        this._onMqlChange = (e) => {
            this._isTouch = e.matches;
            if (this._isTouch) this.decorate();
            else this._removeAll();
        };
        // addEventListener('change') is the modern API; addListener is the
        // deprecated fallback some embedded webviews still ship.
        if (this._mql.addEventListener) this._mql.addEventListener('change', this._onMqlChange);
        else if (this._mql.addListener) this._mql.addListener(this._onMqlChange);

        if (this._isTouch) this._ensureStyles();

        // Keep every visible button's icon in sync with actual playback,
        // whatever started it. Cheap: only fires on play/stop transitions,
        // not per frame.
        this._onPlay = (file) => this._syncButtons(file);
        this._onStop = () => this._syncButtons(null);
        audio.on('play', this._onPlay);
        audio.on('stop', this._onStop);

        // One delegate for every button across every card/row — same reason
        // PreviewBackfill uses one: per-button handlers get orphaned when the
        // library rebuilds a container's innerHTML mid-interaction.
        this._onClick = (e) => {
            const btn = e.target.closest('[data-song-preview-play]');
            if (!btn) return;
            // The card is the host's own click target (it plays the song).
            // Slopsmith's handler already ignores clicks inside a <button>,
            // but stop anyway for capture-phase hosts.
            e.stopPropagation();
            e.preventDefault();
            this._handleTap(btn);
        };
        document.addEventListener('click', this._onClick);

        // On touch, PreviewLoop stands down, so nothing notices when the
        // playing song scrolls off-screen — the preview would keep going
        // after its card is gone. Stop it once the card scrolls fully out of
        // the viewport: the touch analogue of the cursor leaving a card.
        // Capture-phase + passive catches scrolls inside any inner container
        // (scroll doesn't bubble); rAF-coalesced so we hit-test at most once
        // per frame regardless of how fast scroll events fire.
        this._scrollRaf = 0;
        this._onScroll = () => {
            if (this._scrollRaf) return;
            this._scrollRaf = requestAnimationFrame(() => {
                this._scrollRaf = 0;
                this._stopIfScrolledAway();
            });
        };
        document.addEventListener('scroll', this._onScroll, { capture: true, passive: true });
    }

    // Stop playback once the playing card has scrolled fully out of view.
    // Touch only — on desktop the hover loop owns this. Reads the live file
    // from AudioController (covers the loading phase too) and re-queries the
    // card by filename each time, so a library re-render (fresh node) or a
    // virtualised-out card is handled.
    _stopIfScrolledAway() {
        if (!this._isTouch) return;
        const file = this._audio.currentFile();
        if (!file) return;
        let card = null;
        for (const b of document.querySelectorAll('[data-song-preview-play]')) {
            if (b.getAttribute('data-song-preview-play') === file) {
                card = b.closest('.song-card, .song-row');
                break;
            }
        }
        // Gone from the DOM (virtualised out), or scrolled past the top/bottom
        // edge of the viewport → the song is no longer on screen; stop.
        if (!card) { this._audio.stop('scrolled-away'); return; }
        const vh = window.innerHeight || document.documentElement.clientHeight;
        const r = card.getBoundingClientRect();
        if (r.bottom <= 0 || r.top >= vh) this._audio.stop('scrolled-away');
    }

    _ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const el = document.createElement('style');
        el.id = STYLE_ID;
        el.textContent = STYLES;
        document.head.appendChild(el);
    }

    _handleTap(btn) {
        // Master switch and overlay gates. Buttons aren't injected while the
        // toggle is off, but a tap can still land in the window before a
        // re-decorate removes them — guard here too.
        if (!this._toggle.isEnabled()) return;
        if (this._menu.isAnyMenuOpen()) return;

        const card = btn.closest('.song-card[data-play], .song-row[data-play]');
        const filename = this._readFilename(card);
        if (!filename) return;

        // Tap the playing card again → stop. Tap a different card → switch
        // (AudioController.start emits 'stop' for the old one, then plays the
        // new). currentFile() covers the loading state too, so a double-tap
        // during load cancels rather than stacking.
        if (this._audio.currentFile() === filename) {
            this._audio.stop('touch-toggle');
        } else {
            this._audio.start(filename, card);
        }
    }

    _readFilename(card) {
        if (!card) return null;
        const raw = card.getAttribute('data-play') || '';
        if (!raw) return null;
        try { return decodeURIComponent(raw); }
        catch (_) { return raw; }
    }

    // Reflect playback state onto buttons by class toggle (attribute write —
    // invisible to the childList MutationObserver). `playingFile` is the
    // decoded filename now playing, or null when nothing is.
    _syncButtons(playingFile) {
        for (const btn of document.querySelectorAll('[data-song-preview-play]')) {
            const fn = btn.getAttribute('data-song-preview-play');
            const on = !!playingFile && fn === playingFile;
            btn.classList.toggle('is-playing', on);
            btn.setAttribute('aria-label', on ? 'Stop preview' : 'Play preview');
        }
    }

    // Idempotent, called from the bootstrap's per-tick injectAll. Injects a
    // play button into each previewable card/row and removes stale ones. The
    // dataset flag keeps the actual DOM append to once per node, so the
    // re-entrant decorate the append itself triggers is a no-op.
    decorate() {
        if (!this._isTouch) return;
        // Toggled off → tear the buttons down entirely (and stop anything
        // playing). They come back on the next tick once re-enabled.
        if (!this._toggle.isEnabled()) {
            this._removeAll();
            return;
        }
        this._ensureStyles();

        const active = this._audio.currentFile();
        const nodes = document.querySelectorAll(
            '.song-card[data-play], .song-row[data-play]'
        );
        for (const node of nodes) {
            const filename = this._readFilename(node);
            if (!filename) continue;
            const current = node.dataset[FLAG];
            if (current === filename) {
                // Same node, same file — just keep the icon honest in case
                // it was injected mid-playback (recycled card).
                const btn = node.querySelector('[data-song-preview-play]');
                if (btn) btn.classList.toggle('is-playing', filename === active);
                continue;
            }
            // New node, or a recycled one whose file changed — re-wire.
            node.querySelector('[data-song-preview-play]')?.remove();
            this._attach(node, filename, filename === active);
            node.dataset[FLAG] = filename;
        }
    }

    _attach(node, filename, playing) {
        const isCard = node.classList.contains('song-card');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sp-touch-play' + (isCard ? '' : ' sp-touch-play--row') + (playing ? ' is-playing' : '');
        btn.setAttribute('data-song-preview-play', filename);
        btn.setAttribute('aria-label', playing ? 'Stop preview' : 'Play preview');
        btn.innerHTML = ICONS;
        // Don't let arrow-key library nav walk into the button.
        btn.addEventListener('keydown', (e) => e.stopPropagation());

        if (isCard) {
            // Overlay on the album art, like a typical play button. The
            // ProgressScope ring also lives in .card-art (pointer-events:none),
            // so it draws around the button without intercepting taps.
            const art = node.querySelector('.card-art');
            if (!art) return; // no art surface — skip silently
            if (getComputedStyle(art).position === 'static') art.style.position = 'relative';
            art.appendChild(btn);
        } else {
            // Rows have no art; sit inline beside the title, where the format
            // badge / backfill button already live.
            const titleContainer = node.querySelector(':scope > .flex-1');
            (titleContainer || node).appendChild(btn);
        }
    }

    _removeAll() {
        for (const node of document.querySelectorAll(`[data-${FLAG}]`)) {
            node.querySelector('[data-song-preview-play]')?.remove();
            delete node.dataset[FLAG];
        }
    }

    destroy() {
        document.removeEventListener('click', this._onClick);
        document.removeEventListener('scroll', this._onScroll, { capture: true });
        if (this._scrollRaf) { cancelAnimationFrame(this._scrollRaf); this._scrollRaf = 0; }
        if (this._mql.removeEventListener) this._mql.removeEventListener('change', this._onMqlChange);
        else if (this._mql.removeListener) this._mql.removeListener(this._onMqlChange);
        this._removeAll();
        document.getElementById(STYLE_ID)?.remove();
    }
}
