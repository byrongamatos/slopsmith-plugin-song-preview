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
// Dataset key marking cards/rows we've already injected a Fix button
// into. Value is the filename so we can detect "the data-play changed
// underneath us" (infinite scroll re-uses card nodes).
const BUTTON_FLAG = 'songPreviewFixBtn';

export class PreviewBackfill {
    constructor({ audio } = {}) {
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
        this._setFileState(filename, 'fixing');
        try {
            const res = await fetch(
                `${API_BASE}/backfill?file=${encodeURIComponent(filename)}`,
                { method: 'POST' }
            );
            if (!res.ok) {
                let detail = `HTTP ${res.status}`;
                try {
                    const body = await res.json();
                    if (body && body.detail) detail = body.detail;
                } catch (_) {}
                throw new Error(detail);
            }
            this._missing.delete(filename);
            this._paired.delete(filename);
            this._entries = this._entries.filter(e => e.filename !== filename);
            this._fileState.delete(filename);
            this._fileError.delete(filename);
            if (this._audio && typeof this._audio.clearNoPreviewMemo === 'function') {
                this._audio.clearNoPreviewMemo(filename);
            }
            this._renderAll();
        } catch (err) {
            console.error('[song_preview] backfill failed', err);
            this._setFileState(filename, 'error');
            this._fileError.set(filename, err.message || String(err));
            this._renderAll();
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
                // Mark the currently-being-worked-on file's state so its
                // card / list row shows a spinner inline with the global
                // progress bar.
                if (state.current) this._setFileState(state.current, 'fixing');
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
            status.textContent = 'All Sloppaks have previews ✓';
            status.className = 'text-green-400 flex-1';
            btn.classList.add('hidden');
            return;
        }
        const lines = [`Sloppaks missing previews: ${count}`];
        if (paired > 0 && synth > 0) {
            lines.push(
                `${paired} will use a paired PSARC, ${synth} will be generated.`
            );
        } else if (synth > 0) {
            lines.push('No paired PSARCs found — all will be generated.');
        } else {
            lines.push('All will use a paired PSARC.');
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
            if (state.running || state.done > 0) {
                wrap.classList.remove('hidden');
                const pct = state.total > 0
                    ? Math.round((state.done / state.total) * 100)
                    : 0;
                bar.style.width = `${pct}%`;
                text.textContent = state.current
                    ? `${state.done} / ${state.total} — ${state.current}`
                    : `${state.done} / ${state.total}`;
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
            list.classList.add('hidden');
            legend.classList.add('hidden');
            controls?.classList.add('hidden');
            empty?.classList.add('hidden');
            list.innerHTML = '';
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
        return {
            cls: paired
                ? 'bg-emerald-900/40 text-emerald-300 border border-emerald-700/50'
                : 'bg-yellow-900/40 text-yellow-300 border border-yellow-700/50',
            label: paired ? 'PSARC' : 'Generated',
            title: paired
                ? 'Will lift the original Rocksmith preview out of the paired PSARC'
                : `Will generate a ${this._previewDurationLabel()} clip from this song's own audio`,
        };
    }

    _previewDurationLabel() { return '30s'; }

    _actionHtmlFor(entry, variant) {
        // variant is 'list' (small inline button) or 'card' (full-width).
        const state = this._fileState.get(entry.filename) || 'idle';
        if (state === 'fixing') {
            return variant === 'card'
                ? `<div class="mt-2 w-full">
                       <div class="w-full h-1.5 bg-dark-500 rounded overflow-hidden">
                           <div class="h-full bg-accent animate-pulse" style="width: 100%"></div>
                       </div>
                       <div class="text-[10px] text-gray-500 mt-0.5 text-center">Fixing&hellip;</div>
                   </div>`
                : `<div class="w-24">
                       <div class="w-full h-1.5 bg-dark-500 rounded overflow-hidden">
                           <div class="h-full bg-accent animate-pulse" style="width: 100%"></div>
                       </div>
                       <div class="text-[10px] text-gray-500 mt-0.5 text-center">Fixing&hellip;</div>
                   </div>`;
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

    _renderListItem(entry) {
        const pill = this._pillFor(entry);
        const action = this._actionHtmlFor(entry, 'list');
        const title = entry.title || entry.filename;
        const artist = entry.artist || '—';
        return `
            <li class="flex items-center gap-3 px-3 py-2">
                <div class="flex-1 min-w-0">
                    <div class="text-sm text-white truncate">${_escape(title)}</div>
                    <div class="text-[11px] text-gray-500 truncate">${_escape(artist)} &middot; ${_escape(entry.filename)}</div>
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
        return `
            <div class="bg-dark-700/60 border border-dark-600 rounded-lg p-3 flex flex-col">
                <div class="flex items-start justify-between gap-2 mb-1">
                    <div class="min-w-0 flex-1">
                        <div class="text-sm text-white font-medium truncate">${_escape(title)}</div>
                        <div class="text-[11px] text-gray-400 truncate">${_escape(artist)}</div>
                    </div>
                    <span class="text-[10px] px-1.5 py-0.5 rounded ${pill.cls} whitespace-nowrap flex-shrink-0"
                          title="${_escape(pill.title)}">${pill.label}</span>
                </div>
                <div class="text-[10px] text-gray-500 truncate mt-0.5">${_escape(entry.filename)}</div>
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
        const tooltip = paired
            ? 'Lift the original Rocksmith preview out of the paired PSARC'
            : `Generate a ${this._previewDurationLabel()} preview from this song's audio`;

        // Shared style strings for the row variant. The row button mirrors
        // the format badge's dimensions (px-1.5 py-0.5 text-[10px] font-bold)
        // so the two sit on the same visual baseline and at the same scale.
        const rowBase = 'ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold whitespace-nowrap transition flex items-center gap-1';
        const fnAttr = _escape(filename);

        if (state === 'fixing') {
            // Inline indeterminate progress bar. Replaces button so
            // there's nothing to click during the work.
            wrap.innerHTML = isCard
                ? `<div class="mt-2 w-full">
                       <div class="w-full h-1.5 bg-dark-500 rounded overflow-hidden">
                           <div class="h-full bg-yellow-400 animate-pulse" style="width: 100%"></div>
                       </div>
                       <div class="mt-1 text-center text-[10px] text-yellow-400/60">Fixing preview&hellip;</div>
                   </div>`
                : `<span class="${rowBase} bg-yellow-500/20 border border-yellow-500/40 text-yellow-300 animate-pulse"
                         title="Fixing preview…">Fixing&hellip;</span>`;
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