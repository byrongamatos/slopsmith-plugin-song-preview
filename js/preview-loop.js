// Cursor-driven preview loop. Replaces an older per-card mouseenter/leave
// design which couldn't be patched into correctness when the library
// re-renders under a stationary cursor (the old card's mouseleave never
// fires, so the preview leaks). Modelled on Rocksmith 2014's song picker:
// the selected item is what plays, and the question is asked continuously
// per-frame rather than derived from a history of events.
//
// Two input modalities, switched automatically by InputTracker:
//   - Mouse mode (default): _whatsUnderCursor() is the truth — what card
//     is under the cursor right now? Cursor leaves cards → preview ends,
//     full stop. Focus is mirrored to the cursor's card as a *visual*
//     side effect so the host's focus ring follows the mouse.
//   - Keyboard mode (after any keydown, until next mousemove): the host
//     owns focus via its arrow-key handlers. document.activeElement is
//     the truth. We don't touch focus.
// Decoupling target from focus means previews still behave correctly even
// if focus() calls fail silently or the host re-focuses things itself.
export class PreviewLoop {
    constructor({ toggle, menu, input, audio, scope }) {
        this._toggle = toggle;
        this._menu = menu;
        this._input = input;
        this._audio = audio;
        this._scope = scope;

        this.DEBOUNCE_MS = 180;
        this.PREVIEWABLE_SELECTOR = '.song-card, .song-row[data-play]';

        this._candidateTarget = null;
        this._candidateSince = 0;
        // Single-play gate: when a clip plays through to 'ended', store its
        // filename here so the poll won't immediately replay it while the
        // cursor sits on the same card. Cleared the moment the cursor moves
        // to a different file, off cards entirely, or a hard-suspend fires.
        this._completedFile = null;
        this._raf = 0;

        // Cursor-target cache. elementFromPoint is the most expensive call
        // per tick (it hits the browser's hit-test tree). If the cursor
        // hasn't moved and the DOM hasn't mutated, the answer can't change,
        // so we reuse the previous result.
        this._cursorCacheX = -1;
        this._cursorCacheY = -1;
        this._cursorCacheResult = null;
        this._cursorCacheDirty = true;

        audio.on('completed', (file) => { this._completedFile = file; });
        input.onMouseMove(() => audio.clearExternalAudio());
        input.onSuspend(() => this.suspend());

        // Cursor XY can stay the same while what's under it changes
        // because the page scrolled. The MutationObserver-driven
        // invalidation only catches DOM changes, not scroll, so listen
        // here too. Capture-phase + passive so we catch scrolls inside
        // any container (scroll doesn't bubble by default).
        this._onScroll = () => this.invalidateCursorCache();
        document.addEventListener('scroll', this._onScroll, { capture: true, passive: true });
    }

    start() {
        // Single rAF drives both target resolution and the progress-ring
        // draw. Previously ProgressScope ran its own rAF in parallel, so
        // the page had two scheduler callbacks per frame during playback.
        // scope.draw() is a no-op when no scope is attached.
        const loop = () => {
            this._tick();
            this._scope.draw();
            this._raf = requestAnimationFrame(loop);
        };
        this._raf = requestAnimationFrame(loop);
    }

    suspend() {
        if (this._audio.isActive()) this._audio.stop('suspend');
        this._resetCandidate();
        this._completedFile = null;
    }

    _resetCandidate() {
        this._candidateTarget = null;
        this._candidateSince = 0;
    }

    _readPlayFilename(card) {
        let fn = '';
        try { fn = decodeURIComponent(card.dataset.play || ''); }
        catch (_) { fn = card.dataset.play || ''; }
        if (!fn) return null;
        return fn;
    }

    _whatsUnderCursor() {
        if (!this._input.hasMousePosition()) return null;
        const x = this._input.mouseX();
        const y = this._input.mouseY();
        if (!this._cursorCacheDirty && x === this._cursorCacheX && y === this._cursorCacheY) {
            return this._cursorCacheResult;
        }
        const el = document.elementFromPoint(x, y);
        const card = el ? el.closest(this.PREVIEWABLE_SELECTOR) : null;
        const fn = card ? this._readPlayFilename(card) : null;
        const result = fn ? { fn, card } : null;
        this._cursorCacheX = x;
        this._cursorCacheY = y;
        this._cursorCacheResult = result;
        this._cursorCacheDirty = false;
        return result;
    }

    // Called by the bootstrap's MutationObserver when the DOM changes —
    // the cached cursor target might now point at a stale node, so the
    // next _whatsUnderCursor() must re-query.
    invalidateCursorCache() {
        this._cursorCacheDirty = true;
    }

    // Resolves the preview target from document.activeElement. Only used
    // in keyboard mode — the host's arrow-key nav moves focus, we read it.
    _getFocusedTarget() {
        const ae = document.activeElement;
        if (!ae || typeof ae.closest !== 'function') return null;
        const card = ae.closest(this.PREVIEWABLE_SELECTOR);
        if (!card || !card.dataset.play) return null;
        const fn = this._readPlayFilename(card);
        return fn ? { fn, card } : null;
    }

    // Form controls the user is actively typing/picking in — leave alone.
    // Anything else (a button that triggered a menu close, an arbitrary
    // div) is fair game to steal focus from.
    _focusIsHeldByInput(ae) {
        if (!ae || ae === document.body || ae === document.documentElement) return false;
        const tag = ae.tagName;
        if (tag === 'INPUT') {
            const type = (ae.type || '').toLowerCase();
            return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit';
        }
        return tag === 'TEXTAREA' || tag === 'SELECT' || ae.isContentEditable;
    }

    // Purely visual: mirror the cursor's target card into DOM focus so the
    // host's focus ring follows the mouse. Decoupled from playback target
    // resolution — if these focus()/blur() calls fail silently, preview
    // still behaves correctly because mouse mode reads from the cursor.
    _mirrorCursorVisual(cur) {
        const ae = document.activeElement;
        if (this._focusIsHeldByInput(ae)) return;
        const aeCard = ae && typeof ae.closest === 'function'
            ? ae.closest(this.PREVIEWABLE_SELECTOR)
            : null;
        if (cur) {
            if (aeCard !== cur.card) {
                try { cur.card.focus({ preventScroll: true }); }
                catch (_) { /* tabindex absent? bail silently */ }
            }
        } else if (aeCard) {
            // Cursor isn't over a card. Drop any focus we're holding on
            // one so the host's focus ring follows the cursor away.
            try { ae.blur(); } catch (_) {}
        }
    }

    _tick() {
        // Hard-suspend gates — anything that means "stay quiet, full stop".
        if (this._input.isSuspended()) {
            if (this._audio.isActive()) this._audio.stop('suspend');
            this._resetCandidate();
            return;
        }
        if (this._menu.isAnyMenuOpen()) {
            if (this._audio.isActive()) this._audio.stop('menu-open');
            this._resetCandidate();
            return;
        }
        if (!this._toggle.isEnabled()) {
            if (this._audio.isActive()) this._audio.stop('disabled');
            this._resetCandidate();
            return;
        }
        if (this._audio.isExternalAudioActive()) {
            if (this._audio.isActive()) this._audio.stop('external-audio');
            this._resetCandidate();
            return;
        }
        // Active wheel scroll. Stop in-flight preview and refuse to start
        // new ones until the scroll has settled.
        if (this._input.isScrolling()) {
            if (this._audio.isActive()) this._audio.stop('scrolling');
            this._resetCandidate();
            return;
        }
        // Touch device with no keyboard driving: there's no hover and no
        // persistent cursor, so _whatsUnderCursor() resolves to null every
        // tick and would stop a tap-started preview the frame after
        // TouchTrigger begins it. Stand down and let TouchTrigger own
        // playback. (Keyboard nav on a touch-classified device — a paired
        // BT keyboard — still previews via the keyboard branch below.)
        if (this._input.isTouchDevice() && !this._input.isKeyboardDriving()) {
            this._resetCandidate();
            return;
        }

        // Resolve the playback target. In mouse mode the cursor is the
        // truth; in keyboard mode the host's focus is. Decoupling target
        // from focus is what stops "preview leaked after menu close"
        // and "preview keeps playing after mouse left the card" bugs.
        let target;
        if (this._input.isKeyboardDriving()) {
            target = this._getFocusedTarget();
        } else {
            target = this._whatsUnderCursor();
            this._mirrorCursorVisual(target);
        }

        if (target === null) {
            if (this._audio.isActive()) this._audio.stop('no-target');
            this._resetCandidate();
            this._completedFile = null; // moved off cards — allow replay if they come back
            return;
        }
        const { fn, card } = target;

        // Cursor moved to a different file than the last-completed one —
        // clear the single-play gate.
        if (this._completedFile && fn !== this._completedFile) {
            this._completedFile = null;
        }

        // Same file already loading/playing — keep it. The card under the
        // cursor may be a *fresh* DOM node (library re-render with the same
        // filename), so re-anchor the progress ring to it.
        if (fn === this._audio.currentFile()) {
            this._candidateTarget = fn;
            this._scope.reanchorIfDetached(card);
            return;
        }

        // Single-play gate: this clip just finished and the cursor hasn't
        // left it. Stay quiet until they move on.
        if (fn === this._completedFile) {
            this._candidateTarget = fn;
            return;
        }

        // Target changed since last tick — restart the debounce window.
        if (fn !== this._candidateTarget) {
            this._candidateTarget = fn;
            this._candidateSince = Date.now();
            return;
        }

        // Same candidate held under focus long enough — commit.
        if (Date.now() - this._candidateSince >= this.DEBOUNCE_MS) {
            this._audio.start(fn, card);
        }
    }

    destroy() {
        if (this._raf) {
            cancelAnimationFrame(this._raf);
            this._raf = 0;
        }
        document.removeEventListener('scroll', this._onScroll, { capture: true });
        this._resetCandidate();
        this._completedFile = null;
    }
}
