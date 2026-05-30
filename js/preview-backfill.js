// Preview backfill UX. Three surfaces, one source of truth:
//
//   1. Settings inline block (#song-preview-backfill) — count, Fix All,
//      progress, errors. Compact summary.
//   2. Plugin screen (#song-preview-backfill-screen) — same plus a
//      scrollable per-song list with source pills and per-song Fix
//      buttons. Richer view, reached via the Plugins menu.
//   3. Library cards / rows — a "Fix Missing Preview" button below the
//      tags row (cards) or an inline pill (rows). Swaps to an
//      indeterminate progress bar while the inject runs.
//
// All three subscribe to the same internal `_missing` set, so a fix
// triggered from any surface updates the others without explicit
// coordination.

const API_BASE = '/api/plugins/song_preview';
const POLL_INTERVAL_MS = 500;
// Per-file progress poll cadence while a single fix is in flight. Faster than
// the Fix-All status poll because a single fix is short — we want the bar to
// catch each stage transition without a visible lag.
const PROGRESS_POLL_MS = 350;
// Dataset key marking cards/rows we've already injected a Fix button
// into. Value is the filename so we can detect "the data-play changed
// underneath us" (infinite scroll re-uses card nodes).
const BUTTON_FLAG = 'songPreviewFixBtn';

// ── Tailwind backfill ───────────────────────────────────────────────────
//
// The host serves a prebuilt, purged tailwind.min.css. Its content globs
// (slopsmith tailwind.config.js) scan plugin *.html and screen.js but NOT
// the js/ modules, and its safelist omits opacity modifiers (`/20`),
// hover/focus variants, and arbitrary values (`[28rem]`). Every such class
// used by this module's markup — the Fix buttons, source pills, list/card
// chrome — plus a handful on the settings page is therefore absent from the
// shipped CSS, leaving the UI unstyled (the symptom that reads as "buttons
// don't work"). We re-supply the exact dropped declarations here, injected
// document-wide so the library-card / -row Fix buttons (which live outside
// our screen fragment) are covered too. Same self-contained approach the
// toggle pill uses in screen.html — the plugin can't assume the host's
// purge included plugin-only classes. Values mirror Tailwind v3 defaults
// and the host's `dark` palette (#181830 = dark-600).
const STYLE_ID = 'song-preview-backfill-styles';
const BACKFILL_STYLES = `
.border-accent\\/30{border-color:rgb(64 128 224 / .3)}
.bg-emerald-900\\/40{background-color:rgb(6 78 59 / .4)}
.text-emerald-300{color:rgb(110 231 183)}
.border-emerald-700\\/50{border-color:rgb(4 120 87 / .5)}
.hover\\:bg-emerald-900\\/30:hover{background-color:rgb(6 78 59 / .3)}
.bg-emerald-400{background-color:rgb(52 211 153)}
.bg-yellow-900\\/40{background-color:rgb(113 63 18 / .4)}
.border-yellow-700\\/50{border-color:rgb(161 98 7 / .5)}
.hover\\:bg-yellow-900\\/30:hover{background-color:rgb(113 63 18 / .3)}
.bg-yellow-500\\/20{background-color:rgb(234 179 8 / .2)}
.hover\\:bg-yellow-500\\/20:hover{background-color:rgb(234 179 8 / .2)}
.hover\\:bg-yellow-500\\/30:hover{background-color:rgb(234 179 8 / .3)}
.border-yellow-500\\/30{border-color:rgb(234 179 8 / .3)}
.border-yellow-500\\/40{border-color:rgb(234 179 8 / .4)}
.text-yellow-400\\/60{color:rgb(250 204 21 / .6)}
.border-red-700\\/50{border-color:rgb(185 28 28 / .5)}
.text-red-300\\/80{color:rgb(252 165 165 / .8)}
.h-1\\.5{height:.375rem}
.w-2\\.5{width:.625rem}
.h-2\\.5{height:.625rem}
.w-3\\.5{width:.875rem}
.h-3\\.5{height:.875rem}
.h-12{height:3rem}
.rounded-md{border-radius:.375rem}
.ml-2{margin-left:.5rem}
.pb-4{padding-bottom:1rem}
.-mt-1{margin-top:-.25rem}
.my-5{margin-top:1.25rem;margin-bottom:1.25rem}
.min-w-\\[12rem\\]{min-width:12rem}
.max-h-\\[28rem\\]{max-height:28rem}
.leading-relaxed{line-height:1.625}
.border-dashed{border-style:dashed}
.list-disc{list-style-type:disc}
.list-inside{list-style-position:inside}
.placeholder-gray-500::placeholder{color:rgb(107 114 128)}
.disabled\\:cursor-not-allowed:disabled{cursor:not-allowed}
.divide-y>:not([hidden])~:not([hidden]){border-top-width:1px;border-bottom-width:0}
.divide-dark-600>:not([hidden])~:not([hidden]){border-color:#181830}
@media (min-width:640px){
.sm\\:flex-row{flex-direction:row}
.sm\\:flex-wrap{flex-wrap:wrap}
.sm\\:items-center{align-items:center}
}`;

function _ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = BACKFILL_STYLES;
    document.head.appendChild(el);
}

export class PreviewBackfill {
    constructor({ audio } = {}) {
        // Backfill the Tailwind classes the host's purge dropped before any
        // markup renders, so the very first paint is styled.
        _ensureStyles();

        this._audio = audio || null;

        // The audit's view of the world. _entries holds full MissingEntry
        // shape; _missing is just the filename set used for fast lookup
        // on every MutationObserver tick. _paired is the subset whose
        // backfill will use the PSARC path (drives source-pill colour).
        this._entries = [];
        this._missing = new Set();
        this._paired = new Set();

        // Per-filename UI state. 'idle' | 'fixing' | 'error'. Drives
        // the button visual in cards, rows, and list.
        this._fileState = new Map();
        this._fileError = new Map();

        // Determinate progress-bar state for the 'fixing' visual. _fileProgress
        // is a 0..1 fraction (monotonic — never regresses); _fileStage is the
        // backend stage name driving the label. Both are painted onto the bar
        // via direct DOM writes (see _paintProgress/_paintStage) rather than an
        // innerHTML rebuild, so the bar can update without re-triggering the
        // library MutationObserver. _progressPolling / _progressTimers track the
        // per-file poll loops kicked off by backfillOne.
        this._fileProgress = new Map();
        this._fileStage = new Map();
        this._progressPolling = new Set();
        this._progressTimers = new Map();

        // Single-flight guards.
        this._refreshInflight = null;
        this._polling = false;
        this._postFixRefreshScheduled = false;

        // Plugin-screen filter state. `search` filters by case-insensitive
        // substring against title / artist / filename combined; `source`
        // is one of 'all' | 'paired' | 'synth'. Both default to permissive
        // ("show everything").
        this._filter = { search: '', source: 'all' };

        // List | Cards layout picker. Persisted in localStorage so the
        // user's pick survives reloads. Default to 'cards' since that's
        // the richer view we built second; users who want the dense
        // list can flip the toggle.
        this._layout = 'cards';
        try {
            const saved = localStorage.getItem('slopsmith_song_preview_layout');
            if (saved === 'list' || saved === 'cards') this._layout = saved;
        } catch (_) { /* sandboxed storage — fall back to default */ }

        // ONE document-level click delegate handles every Fix button
        // across every surface (library cards, library rows, plugin
        // screen list, plugin screen cards). Per-element handlers were
        // racy — each re-render of a container's innerHTML left their
        // buttons orphaned mid-click. A single body-level delegate
        // survives any number of DOM rebuilds and is the same pattern
        // slopsmith uses for its own card click handler. Bound once in
        // the constructor; destroy() removes it.
        this._onDocClick = (e) => {
            const btn = e.target.closest('[data-fix-one]');
            if (!btn) return;
            // Slopsmith's own document-level handler already short-
            // circuits when the click target is inside a <button>
            // (see app.js: `if (card && !e.target.closest('button'))`),
            // so the card won't fire playSong even without our
            // stopPropagation. Stop anyway for hosts that bind on
            // capture phase or other plugins that might fire blindly.
            e.stopPropagation();
            e.preventDefault();
            const filename = btn.getAttribute('data-fix-one');
            if (filename) this.backfillOne(filename);
        };
        document.addEventListener('click', this._onDocClick);
    }

    // ── Network ─────────────────────────────────────────────────────────

    async refresh() {
        if (this._refreshInflight) return this._refreshInflight;
        const p = (async () => {
            try {
                const res = await fetch(`${API_BASE}/audit`);
                if (!res.ok) throw new Error(`audit failed: ${res.status}`);
                const data = await res.json();
                const prevMissing = this._missing;
                this._entries = Array.isArray(data.missing) ? data.missing : [];
                this._missing = new Set(this._entries.map(e => e.filename));
                this._paired = new Set(
                    this._entries.filter(e => e.has_paired_psarc).map(e => e.filename)
                );
                // Clear AudioController's 404 memo for files that just
                // transitioned from missing → fixed.
                if (this._audio && typeof this._audio.clearNoPreviewMemo === 'function') {
                    for (const f of prevMissing) {
                        if (!this._missing.has(f)) this._audio.clearNoPreviewMemo(f);
                    }
                }
                // Drop UI state for files no longer in the missing set.
                for (const f of [...this._fileState.keys()]) {
                    if (!this._missing.has(f)) {
                        this._fileState.delete(f);
                        this._fileError.delete(f);
                    }
                }
                this._renderAll();
                return data;
            } finally {
                this._refreshInflight = null;
            }
        })();
        this._refreshInflight = p;
        return p;
    }

    async backfillOne(filename) {
        if (this._fileState.get(filename) === 'fixing') return;
        // Reset the bar to empty and enter the fixing state (renders the
        // determinate bar at 0%), then start polling the backend for stage
        // updates. The POST itself is the single blocking call; the poll is
        // what makes the bar advance through resolve → extract → inject.
        this._fileProgress.set(filename, 0);
        this._fileStage.delete(filename);
        this._setFileState(filename, 'fixing');
        this._startProgressPoll(filename);

        let res;
        try {
            res = await fetch(
                `${API_BASE}/backfill?file=${encodeURIComponent(filename)}`,
                { method: 'POST' }
            );
        } catch (err) {
            this._stopProgressPoll(filename);
            this._failFixing(filename, err);
            return;
        }
        if (!res.ok) {
            let detail = `HTTP ${res.status}`;
            try {
                const body = await res.json();
                if (body && body.detail) detail = body.detail;
            } catch (_) {}
            this._stopProgressPoll(filename);
            this._failFixing(filename, new Error(detail));
            return;
        }

        // Success — drive the bar to 100% and hold a brief "Done" beat so the
        // completion is visible, then drop the row out of the missing set.
        this._stopProgressPoll(filename);
        this._fileProgress.set(filename, 1);
        this._fileStage.set(filename, 'done');
        this._paintProgress(filename);
        this._paintStage(filename);
        this._completeFixing(filename);
    }

    _failFixing(filename, err) {
        console.error('[song_preview] backfill failed', err);
        this._fileProgress.delete(filename);
        this._fileStage.delete(filename);
        this._setFileState(filename, 'error');
        this._fileError.set(filename, err.message || String(err));
        this._renderAll();
    }

    _completeFixing(filename) {
        // The work is genuinely done; the only reason for the short delay is
        // so the user sees the bar reach 100% rather than the row vanishing
        // mid-fill. Not fabricated progress — just a completion beat.
        setTimeout(() => {
            this._missing.delete(filename);
            this._paired.delete(filename);
            this._entries = this._entries.filter(e => e.filename !== filename);
            this._fileState.delete(filename);
            this._fileError.delete(filename);
            this._fileProgress.delete(filename);
            this._fileStage.delete(filename);
            if (this._audio && typeof this._audio.clearNoPreviewMemo === 'function') {
                this._audio.clearNoPreviewMemo(filename);
            }
            this._renderAll();
        }, 550);
    }

    // ── Single-fix progress poll ────────────────────────────────────────

    _startProgressPoll(filename) {
        if (this._progressPolling.has(filename)) return;
        this._progressPolling.add(filename);
        const tick = async () => {
            if (!this._progressPolling.has(filename)) return;
            try {
                const res = await fetch(
                    `${API_BASE}/backfill-progress?file=${encodeURIComponent(filename)}`
                );
                if (res.ok) {
                    const data = await res.json();
                    this._ingestProgress(filename, data);
                }
            } catch (_) { /* transient — keep polling */ }
            if (this._progressPolling.has(filename)) {
                this._progressTimers.set(filename, setTimeout(tick, PROGRESS_POLL_MS));
            }
        };
        tick();
    }

    _stopProgressPoll(filename) {
        this._progressPolling.delete(filename);
        const t = this._progressTimers.get(filename);
        if (t) { clearTimeout(t); this._progressTimers.delete(filename); }
    }

    // Fold a backend {stage, progress} reading into the bar. Monotonic so a
    // stale 'idle' read (e.g. right after the entry is cleared) can't drag a
    // live bar back to 0. Shared by the single-fix poll and the Fix-All status
    // poll (which reads progress for the song currently being worked on).
    _ingestProgress(filename, data) {
        if (data && typeof data.progress === 'number') {
            const cur = this._fileProgress.get(filename) || 0;
            this._fileProgress.set(filename, Math.max(cur, data.progress));
            this._paintProgress(filename);
        }
        if (data && data.stage) {
            this._fileStage.set(filename, data.stage);
            this._paintStage(filename);
        }
    }

    _stageLabel(stage) {
        switch (stage) {
            case 'resolving': return 'Preparing&hellip;';
            case 'extracting': return 'Extracting preview&hellip;';
            case 'generating': return 'Generating preview&hellip;';
            case 'injecting': return 'Saving&hellip;';
            case 'done': return 'Done';
            default: return 'Fixing preview&hellip;';
        }
    }

    // Direct-DOM bar updates. Querying by attribute value (rather than an
    // innerHTML rebuild) keeps the update off the MutationObserver's childList
    // radar and lets the inline `transition:width` animate the change. Both
    // selectors are cheap — only the in-flight fixes carry these attributes.
    _paintProgress(filename) {
        const pct = Math.round((this._fileProgress.get(filename) || 0) * 100);
        for (const el of document.querySelectorAll('[data-fix-progress]')) {
            if (el.getAttribute('data-fix-progress') === filename) {
                el.style.width = pct + '%';
            }
        }
    }

    _paintStage(filename) {
        const label = this._stageLabel(this._fileStage.get(filename));
        for (const el of document.querySelectorAll('[data-fix-stage]')) {
            // Only write on a real change — the label updates a handful of
            // times per fix, but the poll ticks every 350ms, and a redundant
            // innerHTML write is a childList mutation inside an observed
            // subtree (cheap to no-op, but pointless to trigger).
            if (el.getAttribute('data-fix-stage') === filename && el.innerHTML !== label) {
                el.innerHTML = label;
            }
        }
    }

    async backfillAll() {
        const res = await fetch(`${API_BASE}/backfill-all`, { method: 'POST' });
        if (!res.ok && res.status !== 409) {
            let detail = `HTTP ${res.status}`;
            try {
                const body = await res.json();
                if (body && body.detail) detail = body.detail;
            } catch (_) {}
            throw new Error(detail);
        }
        if (!this._polling) this._pollStatus();
    }

    _pollStatus() {
        if (this._polling) return;
        this._polling = true;
        const tick = async () => {
            try {
                const res = await fetch(`${API_BASE}/backfill-status`);
                if (!res.ok) throw new Error(`status ${res.status}`);
                const state = await res.json();
                // Drop songs out of the list as soon as their fix lands,
                // rather than waiting for the whole run to finish. done_files
                // is cumulative and lists only successes — errored songs stay
                // visible so they can be retried. The post-run refresh() below
                // is still authoritative; this is just the live feedback.
                if (Array.isArray(state.done_files) && state.done_files.length) {
                    let removed = false;
                    for (const f of state.done_files) {
                        if (!this._missing.has(f)) continue;
                        this._missing.delete(f);
                        this._paired.delete(f);
                        this._entries = this._entries.filter(e => e.filename !== f);
                        this._fileState.delete(f);
                        this._fileError.delete(f);
                        this._fileProgress.delete(f);
                        this._fileStage.delete(f);
                        if (this._audio && typeof this._audio.clearNoPreviewMemo === 'function') {
                            this._audio.clearNoPreviewMemo(f);
                        }
                        removed = true;
                    }
                    if (removed) this._renderAll();
                }
                // Mark every in-flight song as fixing and advance each one's
                // own card/list bar from its per-file progress. The bulk run
                // fixes several at once, so there can be more than one; fall
                // back to `current` for an older backend that only reports one.
                const inflight = (Array.isArray(state.in_progress) && state.in_progress.length)
                    ? state.in_progress
                    : (state.current ? [state.current] : []);
                // Mark any newly-in-flight songs fixing, then re-render ONCE
                // (not once per song) so their cards exist before we paint
                // progress into them below.
                let stateChanged = false;
                for (const f of inflight) {
                    if (this._fileState.get(f) !== 'fixing') {
                        this._fileState.set(f, 'fixing');
                        stateChanged = true;
                    }
                }
                if (stateChanged) this._renderAll();
                // Advance each in-flight song's own bar from its per-file
                // progress (direct-DOM paint — no re-render needed).
                for (const f of inflight) {
                    try {
                        const pr = await fetch(
                            `${API_BASE}/backfill-progress?file=${encodeURIComponent(f)}`
                        );
                        if (pr.ok) this._ingestProgress(f, await pr.json());
                    } catch (_) { /* transient — global bar still moves */ }
                }
                this._renderProgress(state);
                if (state.running) {
                    setTimeout(tick, POLL_INTERVAL_MS);
                } else {
                    this._polling = false;
                    if (!this._postFixRefreshScheduled) {
                        this._postFixRefreshScheduled = true;
                        this.refresh().finally(() => {
                            this._postFixRefreshScheduled = false;
                        });
                    }
                }
            } catch (err) {
                console.warn('[song_preview] status poll failed', err);
                this._polling = false;
            }
        };
        tick();
    }

    _setFileState(filename, state) {
        this._fileState.set(filename, state);
        // Re-render just the affected card/row/list entry. Cheaper than
        // _renderAll for single-file state changes but practically
        // both end up walking the DOM, so keep it simple.
        this._renderAll();
    }

    // ── Surface dispatchers ─────────────────────────────────────────────

    bindSettings() {
        // Both surfaces use the same DOM contract (data-backfill-*
        // attributes), so a single bind path handles both. dataset flag
        // prevents double-binding when injectAll runs more than once.
        // We track whether we bound anything NEW this call — the
        // refresh() kick at the bottom must only fire when a freshly-
        // mounted root appeared. Otherwise every MutationObserver tick
        // (which happens on library scroll / re-render) would hammer
        // /audit — saw ~12 calls/sec in the wild.
        let boundNew = false;
        for (const id of ['song-preview-backfill', 'song-preview-backfill-screen']) {
            const root = document.getElementById(id);
            if (!root || root.dataset.boundBackfill) continue;
            root.dataset.boundBackfill = '1';
            boundNew = true;
            const btn = root.querySelector('[data-backfill-action]');
            if (btn) {
                btn.addEventListener('click', async () => {
                    btn.disabled = true;
                    try {
                        await this.backfillAll();
                    } catch (err) {
                        console.error('[song_preview] backfill-all failed', err);
                        btn.disabled = false;
                    }
                });
            }
            // Filter / search controls only exist on the rich plugin
            // screen, but querying both roots keeps this loop simple
            // and avoids a special case.
            const search = root.querySelector('[data-backfill-search]');
            if (search) {
                search.value = this._filter.search;
                search.addEventListener('input', () => {
                    this._filter.search = search.value.trim();
                    this._renderScreenList();
                });
            }
            const filterBtns = root.querySelectorAll('[data-backfill-filter]');
            for (const fb of filterBtns) {
                fb.addEventListener('click', () => {
                    const v = fb.getAttribute('data-backfill-filter') || 'all';
                    this._filter.source = v;
                    this._renderScreenList();
                });
            }
            const layoutBtns = root.querySelectorAll('[data-backfill-layout]');
            for (const lb of layoutBtns) {
                lb.addEventListener('click', () => {
                    const v = lb.getAttribute('data-backfill-layout') || 'cards';
                    if (v !== 'list' && v !== 'cards') return;
                    this._layout = v;
                    try { localStorage.setItem('slopsmith_song_preview_layout', v); }
                    catch (_) {}
                    this._renderScreenList();
                });
            }
        }
        // Kick a fresh audit only when something actually mounted this
        // call — typically the very first injectAll, or a navigation
        // back into a screen that was previously unmounted. Without
        // this gate the refresh fires on every MutationObserver tick
        // (each library scroll, each plugin re-render), hammering /audit
        // and continuously rewriting list/card innerHTML out from under
        // any in-flight clicks.
        if (boundNew) {
            // Also paint static UI from the current cache state so the
            // freshly-mounted root isn't blank for the duration of the
            // /audit round-trip.
            this._renderAll();
            this.refresh();
        }
    }

    _renderAll() {
        for (const id of ['song-preview-backfill', 'song-preview-backfill-screen']) {
            this._renderSummary(id);
        }
        this._renderScreenList();
        this.decorate();
    }

    _renderSummary(rootId) {
        const root = document.getElementById(rootId);
        if (!root) return;
        const status = root.querySelector('[data-backfill-status]');
        const btn = root.querySelector('[data-backfill-action]');
        if (!status || !btn) return;
        const count = this._missing.size;
        const paired = this._paired.size;
        const synth = count - paired;
        if (count === 0) {
            status.textContent = 'All songs have a preview ✓';
            status.className = 'text-green-400 flex-1';
            btn.classList.add('hidden');
            return;
        }
        const lines = [`Songs missing a preview: ${count}`];
        if (paired > 0 && synth > 0) {
            lines.push(
                `${paired} will be copied from a PSARC, ${synth} will be generated.`
            );
        } else if (synth > 0) {
            lines.push('All will be generated.');
        } else {
            lines.push('All will be copied from a PSARC.');
        }
        status.innerHTML = lines.map(l => `<div>${_escape(l)}</div>`).join('');
        status.className = 'text-gray-400 flex-1';
        btn.disabled = false;
        btn.textContent = `Fix All (${count})`;
        btn.classList.remove('hidden');
    }

    _renderProgress(state) {
        for (const id of ['song-preview-backfill', 'song-preview-backfill-screen']) {
            const root = document.getElementById(id);
            if (!root) continue;
            const wrap = root.querySelector('[data-backfill-progress]');
            const bar = root.querySelector('[data-backfill-bar]');
            const text = root.querySelector('[data-backfill-progress-text]');
            const btn = root.querySelector('[data-backfill-action]');
            const errBlock = root.querySelector('[data-backfill-errors]');
            const errList = root.querySelector('[data-backfill-errors-list]');
            if (!wrap || !bar || !text) continue;
            if (state.running) {
                wrap.classList.remove('hidden');
                const pct = state.total > 0
                    ? Math.round((state.done / state.total) * 100)
                    : 0;
                bar.style.width = `${pct}%`;
                text.textContent = state.current
                    ? `${state.done} / ${state.total} — ${state.current}`
                    : `${state.done} / ${state.total}`;
            } else {
                // The global bar is only meaningful while a run is in flight.
                // Hide it once the run ends (or before one starts) so a
                // finished run doesn't leave a stuck full bar under the
                // "All songs have a preview" summary.
                wrap.classList.add('hidden');
            }
            if (btn) btn.disabled = !!state.running;
            if (errBlock && errList) {
                if (state.errors && state.errors.length) {
                    errBlock.classList.remove('hidden');
                    errList.innerHTML = state.errors.map(e =>
                        `<li><span class="text-red-300">${_escape(e.filename)}</span>: ${_escape(e.error)}</li>`
                    ).join('');
                } else if (!state.running) {
                    errBlock.classList.add('hidden');
                }
            }
        }
    }

    // ── Plugin screen list ──────────────────────────────────────────────

    _renderScreenList() {
        const root = document.getElementById('song-preview-backfill-screen');
        if (!root) return;
        const list = root.querySelector('[data-backfill-list]');
        const legend = root.querySelector('[data-backfill-legend]');
        const controls = root.querySelector('[data-backfill-controls]');
        const empty = root.querySelector('[data-backfill-empty]');
        const countEl = root.querySelector('[data-backfill-count]');
        if (!list || !legend) return;

        const total = this._entries.length;
        if (total === 0) {
            // Nothing left to fix — tear down BOTH surfaces. The cards
            // container was previously left untouched here, so in card layout
            // the last batch of cards (e.g. a song stuck mid-"Saving…") stayed
            // on screen after everything was fixed.
            const cardsContainer = root.querySelector('[data-backfill-cards]');
            list.classList.add('hidden');
            list.innerHTML = '';
            cardsContainer?.classList.add('hidden');
            if (cardsContainer) cardsContainer.innerHTML = '';
            legend.classList.add('hidden');
            controls?.classList.add('hidden');
            empty?.classList.add('hidden');
            return;
        }

        // Show the filter/legend wrap once there's anything to filter.
        // Use `.flex` rather than `.flex` toggling because
        // classList.remove('hidden') is enough — Tailwind's `flex` and
        // `items-center` etc. are already on the element from the HTML.
        controls?.classList.remove('hidden');

        // Apply filter then sort. Sort puts paired-PSARC first (best
        // quality first), then alphabetical for stable ordering.
        const filtered = this._applyFilter(this._entries);
        const sorted = [...filtered].sort((a, b) => {
            if (a.has_paired_psarc !== b.has_paired_psarc) {
                return a.has_paired_psarc ? -1 : 1;
            }
            return a.filename.localeCompare(b.filename);
        });

        // Update filter-button visual state so the active one stands out.
        for (const btn of root.querySelectorAll('[data-backfill-filter]')) {
            const v = btn.getAttribute('data-backfill-filter');
            if (v === this._filter.source) {
                btn.classList.add('bg-dark-600', 'border-accent', 'text-white');
            } else {
                btn.classList.remove('bg-dark-600', 'border-accent', 'text-white');
            }
        }

        if (countEl) {
            countEl.textContent = sorted.length === total
                ? `${total} song${total === 1 ? '' : 's'}`
                : `Showing ${sorted.length} of ${total}`;
        }
        legend.classList.remove('hidden');
        legend.className = 'flex items-center justify-between gap-3 text-[11px] text-gray-500 mb-2';

        const cardsContainer = root.querySelector('[data-backfill-cards]');
        if (sorted.length === 0) {
            list.classList.add('hidden');
            cardsContainer?.classList.add('hidden');
            list.innerHTML = '';
            if (cardsContainer) cardsContainer.innerHTML = '';
            empty?.classList.remove('hidden');
            return;
        }
        empty?.classList.add('hidden');

        // Render whichever surface is active; hide the other. Both
        // surfaces share the event-delegation handler bound below, so
        // toggling layout doesn't require re-binding.
        if (this._layout === 'cards' && cardsContainer) {
            cardsContainer.innerHTML = sorted.map(e => this._renderCardItem(e)).join('');
            cardsContainer.classList.remove('hidden');
            list.classList.add('hidden');
            list.innerHTML = '';
            this._bindFixDelegate(cardsContainer);
        } else {
            list.innerHTML = sorted.map(e => this._renderListItem(e)).join('');
            list.classList.remove('hidden');
            cardsContainer?.classList.add('hidden');
            if (cardsContainer) cardsContainer.innerHTML = '';
            this._bindFixDelegate(list);
        }

        // Reflect the current layout choice in the toggle button visuals.
        for (const btn of root.querySelectorAll('[data-backfill-layout]')) {
            const v = btn.getAttribute('data-backfill-layout');
            if (v === this._layout) {
                btn.classList.add('bg-dark-600', 'border-accent', 'text-white');
            } else {
                btn.classList.remove('bg-dark-600', 'border-accent', 'text-white');
            }
        }
    }

    _bindFixDelegate(_container) {
        // No-op — the single document-level click delegate installed in
        // the constructor handles every Fix button click across every
        // surface. Kept as a stub so _renderScreenList can call it
        // without conditional branching while we transition; remove
        // once we're confident nothing else expects it.
    }

    _applyFilter(entries) {
        const { search, source } = this._filter;
        const needle = search.toLowerCase();
        return entries.filter(e => {
            if (source === 'paired' && !e.has_paired_psarc) return false;
            if (source === 'synth' && e.has_paired_psarc) return false;
            if (needle) {
                // Search across title, artist, AND filename so the user
                // can find a row by any of those — typing "311" finds
                // both songs by 311 the band and a song with 311 in the
                // filename.
                const hay = (e.title + ' ' + e.artist + ' ' + e.filename).toLowerCase();
                if (!hay.includes(needle)) return false;
            }
            return true;
        });
    }

    _pillFor(entry) {
        const paired = entry.has_paired_psarc;
        // Labels describe what WILL happen when the song is fixed, not its
        // current state — "Generated" (past tense) next to an unfixed song
        // read as already-done, so these are future/method phrasings.
        return {
            cls: paired
                ? 'bg-emerald-900/40 text-emerald-300 border border-emerald-700/50'
                : 'bg-yellow-900/40 text-yellow-300 border border-yellow-700/50',
            label: paired ? 'Copy from PSARC' : 'Generate',
            title: paired
                ? 'When fixed: copies the ready-made preview clip out of the matching .psarc file (best quality).'
                : `When fixed: makes a ${this._previewDurationLabel()} clip from the song's own audio.`,
        };
    }

    _previewDurationLabel() { return '30s'; }

    // Determinate "fixing" markup: a progress bar the poll drives via the
    // data-fix-progress hook + a stage label via data-fix-stage. Replaces the
    // old indeterminate animate-pulse bar so the user sees the fix actually
    // advance through its stages. Width starts from the cached fraction so a
    // re-render mid-fix (library re-paint, layout toggle, Fix-All status tick)
    // keeps the bar where it was rather than snapping back to 0.
    _fixingMarkup(filename, { wrapClass = 'w-full', barWidth = 'w-full', barClass = 'bg-accent', labelClass = 'text-gray-500' } = {}) {
        const fn = _escape(filename);
        const pct = Math.round((this._fileProgress.get(filename) || 0) * 100);
        const label = this._stageLabel(this._fileStage.get(filename));
        return `<div class="${wrapClass}">
                    <div class="${barWidth} h-1.5 bg-dark-500 rounded overflow-hidden">
                        <div data-fix-progress="${fn}" class="h-full ${barClass}" style="width:${pct}%;transition:width 300ms ease-out"></div>
                    </div>
                    <div data-fix-stage="${fn}" class="${labelClass} text-[10px] mt-0.5 text-center">${label}</div>
                </div>`;
    }

    _actionHtmlFor(entry, variant) {
        // variant is 'list' (small inline button) or 'card' (full-width).
        const state = this._fileState.get(entry.filename) || 'idle';
        if (state === 'fixing') {
            return variant === 'card'
                ? this._fixingMarkup(entry.filename, { wrapClass: 'mt-2 w-full' })
                : this._fixingMarkup(entry.filename, { wrapClass: 'w-24' });
        }
        if (state === 'error') {
            const errMsg = this._fileError.get(entry.filename) || 'unknown';
            const sizing = variant === 'card'
                ? 'mt-2 w-full px-2 py-1.5 text-xs rounded-lg'
                : 'px-2 py-1 text-xs rounded';
            return `<button type="button" data-fix-one="${_escape(entry.filename)}"
                            title="Last error: ${_escape(errMsg)}"
                            class="${sizing} bg-red-900/30 hover:bg-red-900/50 border border-red-700/50 text-red-300 whitespace-nowrap transition">
                        Retry
                    </button>`;
        }
        const sizing = variant === 'card'
            ? 'mt-2 w-full px-2 py-1.5 text-xs rounded-lg flex items-center justify-center gap-1.5'
            : 'px-2 py-1 text-xs rounded whitespace-nowrap';
        const label = variant === 'card' ? 'Fix Missing Preview' : 'Fix';
        const icon = variant === 'card'
            ? `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0l-7.1 12.25A2 2 0 005 19z"/></svg>`
            : '';
        return `<button type="button" data-fix-one="${_escape(entry.filename)}"
                        class="${sizing} bg-yellow-500/10 hover:bg-yellow-500/20 border border-yellow-500/30 text-yellow-400 transition">
                    ${icon}${label}
                </button>`;
    }

    // Album art for the plugin-screen card view. Reuses the host's per-song
    // art endpoint — the same URL the library card uses for this sloppak — so
    // there's nothing to extract plugin-side. Falls back to a music-note
    // placeholder when the song has no art (endpoint 404s → onerror swap).
    _artHtml(entry, sizeClasses) {
        const url = `/api/song/${encodeURIComponent(entry.filename)}/art`;
        return `<div class="${sizeClasses} flex-shrink-0 rounded-md overflow-hidden bg-dark-800 flex items-center justify-center">
                    <img src="${_escape(url)}" alt="" loading="lazy"
                         class="w-full h-full object-cover"
                         onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
                    <span class="text-gray-600" style="display:none;font-size:1.25rem">🎵</span>
                </div>`;
    }

    _renderListItem(entry) {
        const pill = this._pillFor(entry);
        const action = this._actionHtmlFor(entry, 'list');
        const title = entry.title || entry.filename;
        const artist = entry.artist || '—';
        return `
            <li class="flex items-center gap-3 px-3 py-2">
                <div class="flex-1 min-w-0">
                    <div class="text-sm text-white truncate">${_escape(title)}</div>
                    <div class="text-[11px] text-gray-500 truncate">${_escape(artist)}</div>
                </div>
                <span class="text-[10px] px-1.5 py-0.5 rounded ${pill.cls} whitespace-nowrap"
                      title="${_escape(pill.title)}">${pill.label}</span>
                ${action}
            </li>`;
    }

    _renderCardItem(entry) {
        const pill = this._pillFor(entry);
        const action = this._actionHtmlFor(entry, 'card');
        const title = entry.title || entry.filename;
        const artist = entry.artist || '—';
        const art = this._artHtml(entry, 'w-12 h-12');
        return `
            <div class="bg-dark-700/60 border border-dark-600 rounded-lg p-3 flex flex-col gap-3">
                <div class="flex items-center gap-3">
                    ${art}
                    <div class="min-w-0 flex-1">
                        <div class="text-sm text-white font-medium truncate">${_escape(title)}</div>
                        <div class="text-[11px] text-gray-400 truncate">${_escape(artist)}</div>
                        <span class="inline-block mt-1 text-[10px] px-1.5 py-0.5 rounded ${pill.cls} whitespace-nowrap"
                              title="${_escape(pill.title)}">${pill.label}</span>
                    </div>
                </div>
                ${action}
            </div>`;
    }

    // ── Library card / row decoration ───────────────────────────────────

    decorate() {
        if (!this._missing.size) {
            for (const el of document.querySelectorAll(`[data-${BUTTON_FLAG}]`)) {
                el.querySelector('[data-fix-missing-preview]')?.remove();
                delete el.dataset[BUTTON_FLAG];
            }
            return;
        }
        const nodes = document.querySelectorAll(
            '.song-card[data-play], .song-row[data-play]'
        );
        for (const node of nodes) {
            const encoded = node.getAttribute('data-play') || '';
            if (!encoded.toLowerCase().includes('.sloppak')) continue;
            let filename;
            try {
                filename = decodeURIComponent(encoded);
            } catch (_) {
                continue;
            }
            const shouldShow = this._missing.has(filename);
            const currentFile = node.dataset[BUTTON_FLAG];
            if (shouldShow) {
                if (currentFile !== filename) {
                    // New card OR same card recycled with a different
                    // filename (infinite scroll). Wipe and re-attach.
                    node.querySelector('[data-fix-missing-preview]')?.remove();
                    this._attachFixUI(node, filename);
                    node.dataset[BUTTON_FLAG] = filename;
                } else {
                    // Same file — only re-render the button state if it
                    // changed (fixing / error / idle).
                    this._refreshFixUI(node, filename);
                }
            } else if (currentFile) {
                node.querySelector('[data-fix-missing-preview]')?.remove();
                delete node.dataset[BUTTON_FLAG];
            }
        }
    }

    _attachFixUI(node, filename) {
        const isCard = node.classList.contains('song-card');
        const wrap = document.createElement('div');
        wrap.setAttribute('data-fix-missing-preview', filename);
        // Cards: full-width block beneath the tags. Rows: flex child
        // sitting next to the format (STEMS / SLOPPAK) badge in the
        // title's flex container — same horizontal band, same scale,
        // immediately visible at row-glance.
        wrap.className = isCard ? 'px-4 pb-4 -mt-1' : 'flex-shrink-0';
        this._fillFixUI(wrap, filename, isCard);
        if (isCard) {
            // Append to the card itself; placement after p-4 puts the
            // button below the metadata block, matching the convention
            // of retune-btn / sync-status from app.js's renderGridCards.
            node.appendChild(wrap);
        } else {
            // Rows: drop into the title's flex container (the FIRST
            // inner div, which holds title + format badge). The format
            // badge is the host's visual cousin to ours, and putting
            // the Fix button beside it keeps both at the same scale
            // and vertical baseline. Falls back to the row itself if
            // the host markup ever changes shape.
            const titleContainer = node.querySelector(':scope > .flex-1');
            (titleContainer || node).appendChild(wrap);
        }
        // No per-wrap click handler — clicks are caught by the single
        // document-level delegate installed in the constructor. That
        // delegate keys on `[data-fix-one="<filename>"]` (the same
        // attribute the plugin-screen list/cards use), unifying all
        // four surfaces on one event path. Keydown still gets stopped
        // here so arrow-key navigation in the library doesn't try to
        // walk into our button.
        wrap.addEventListener('keydown', (e) => e.stopPropagation());
    }

    _refreshFixUI(node, filename) {
        const wrap = node.querySelector('[data-fix-missing-preview]');
        if (!wrap) return;
        const isCard = node.classList.contains('song-card');
        this._fillFixUI(wrap, filename, isCard);
    }

    _fillFixUI(wrap, filename, isCard) {
        const state = this._fileState.get(filename) || 'idle';
        const paired = this._paired.has(filename);

        // Render-signature guard. decorate() runs on EVERY MutationObserver
        // tick, and screen.js observes the library grids with subtree:true.
        // An unconditional innerHTML write here is itself a childList mutation
        // inside that observed subtree, so it re-triggers the observer, which
        // schedules another decorate, which writes again — a per-frame rebuild
        // loop. A <button> destroyed and recreated between mousedown and
        // mouseup never emits a click, which is exactly why the library Fix
        // button looked dead (the plugin screen isn't in the observed subtree,
        // so its buttons were unaffected). Only touch the DOM when the visible
        // state actually changes; error text is in the sig so a new error
        // message still re-renders.
        const sig = `${state}|${paired}|${isCard}|${this._fileError.get(filename) || ''}`;
        if (wrap.dataset.fixSig === sig) return;
        wrap.dataset.fixSig = sig;

        const tooltip = paired
            ? 'Copy the ready-made preview from the matching .psarc file'
            : `Make a ${this._previewDurationLabel()} preview from the song's own audio`;

        // Shared style strings for the row variant. The row button mirrors
        // the format badge's dimensions (px-1.5 py-0.5 text-[10px] font-bold)
        // so the two sit on the same visual baseline and at the same scale.
        const rowBase = 'ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold whitespace-nowrap transition flex items-center gap-1';
        const fnAttr = _escape(filename);

        if (state === 'fixing') {
            // Determinate progress bar (card) / stage-text pill (row). The
            // bar fills as the backend reports stages — width via the
            // data-fix-progress hook, label via data-fix-stage. The row has no
            // room for a bar, so it shows the live stage text instead.
            wrap.innerHTML = isCard
                ? this._fixingMarkup(filename, {
                    wrapClass: 'mt-2 w-full',
                    barClass: 'bg-yellow-400',
                    labelClass: 'text-yellow-400/60',
                })
                : `<span data-fix-stage="${fnAttr}"
                         class="${rowBase} bg-yellow-500/20 border border-yellow-500/40 text-yellow-300"
                         title="Fixing preview…">${this._stageLabel(this._fileStage.get(filename))}</span>`;
            return;
        }
        if (state === 'error') {
            const err = this._fileError.get(filename) || 'unknown error';
            wrap.innerHTML = isCard
                ? `<button type="button" data-fix-one="${fnAttr}"
                           title="Last error: ${_escape(err)}"
                           class="mt-2 w-full px-2 py-1.5 bg-red-900/30 hover:bg-red-900/50 border border-red-700/50 rounded-lg text-xs font-medium text-red-300 transition flex items-center justify-center gap-1.5">
                       <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                       Retry Fix Preview
                   </button>`
                : `<button type="button" data-fix-one="${fnAttr}"
                           title="Last error: ${_escape(err)}"
                           class="${rowBase} bg-red-900/40 hover:bg-red-900/60 border border-red-700/50 text-red-300">
                       Retry Fix Preview
                   </button>`;
            return;
        }
        // idle
        wrap.innerHTML = isCard
            ? `<button type="button" data-fix-one="${fnAttr}" title="${_escape(tooltip)}"
                       class="mt-2 w-full px-2 py-1.5 bg-yellow-500/10 hover:bg-yellow-500/20 border border-yellow-500/30 rounded-lg text-xs font-medium text-yellow-400 transition flex items-center justify-center gap-1.5">
                   <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0l-7.1 12.25A2 2 0 005 19z"/></svg>
                   Fix Missing Preview
               </button>`
            : `<button type="button" data-fix-one="${fnAttr}" title="${_escape(tooltip)}"
                       class="${rowBase} bg-yellow-500/20 hover:bg-yellow-500/30 border border-yellow-500/40 text-yellow-300"
                       aria-label="Fix missing preview">
                   <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0l-7.1 12.25A2 2 0 005 19z"/></svg>
                   Fix Missing Preview
               </button>`;
    }

    destroy() {
        document.removeEventListener('click', this._onDocClick);
        document.getElementById(STYLE_ID)?.remove();
        // Cancel any in-flight single-fix progress polls.
        for (const filename of [...this._progressPolling]) this._stopProgressPoll(filename);
        for (const el of document.querySelectorAll(`[data-${BUTTON_FLAG}]`)) {
            el.querySelector('[data-fix-missing-preview]')?.remove();
            delete el.dataset[BUTTON_FLAG];
        }
        for (const id of ['song-preview-backfill', 'song-preview-backfill-screen']) {
            const root = document.getElementById(id);
            if (root) delete root.dataset.boundBackfill;
        }
    }
}

function _escape(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}