(function () {
    'use strict';

    // Idempotency guard: slopsmith can re-evaluate a plugin's screen.js
    // (loader cache miss / desktop hot reload). Without this, every reload
    // stacks another MutationObserver and capture-phase 'play' listener and
    // leaks an orphaned <audio> element. Install the page-level hooks exactly
    // once — the first evaluation stays authoritative.
    if (window.__slopsmithSongPreviewHooksInstalled) return;
    window.__slopsmithSongPreviewHooksInstalled = true;

    const PLUGIN = 'song_preview';
    const API = `/api/plugins/${PLUGIN}`;
    const JS_URL = `${API}/js`;

    // Slopsmith loads exactly one script per plugin (manifest's `script`
    // field). routes.py serves the rest of the source as static files
    // under /js/, and we pull them in via dynamic import here.
    const modules = [
        'preview-toggle',
        'menu-gate',
        'input-tracker',
        'audio-controller',
        'progress-scope',
        'preview-loop',
        'preview-backfill',
        'preview-volume',
        'touch-trigger',
    ];

    Promise.all(modules.map(name => import(`${JS_URL}/${name}.js`)))
        .then(([
            { PreviewToggle },
            { MenuGate },
            { InputTracker },
            { AudioController },
            { ProgressScope },
            { PreviewLoop },
            { PreviewBackfill },
            { PreviewVolume },
            { TouchTrigger },
        ]) => {
            const toggle = new PreviewToggle();
            const menu = new MenuGate();
            const input = new InputTracker();
            const audio = new AudioController({ apiBase: API, pluginName: PLUGIN });
            const scope = new ProgressScope(audio);
            const loop = new PreviewLoop({ toggle, menu, input, audio, scope });
            // Pass audio so PreviewBackfill can flush the 404 memo for
            // files it just fixed, otherwise the hover loop would keep
            // short-circuiting on stale "no preview" state until reload.
            const backfill = new PreviewBackfill({ audio });
            // Owns the preview-volume slider on both surfaces; reads/writes
            // `audio`'s own (decoupled) volume and hides itself when `toggle`
            // is off.
            const volume = new PreviewVolume({ audio, toggle });
            // Touch-only graceful degradation: a tap-to-play button per card
            // where hover can't work. No-op on desktop (gated on a coarse-
            // pointer/no-hover media query). Reuses audio + the same gates.
            const touch = new TouchTrigger({ audio, toggle, menu });

            // Per-DOM-tick bindings. The library re-renders often — coalesce
            // to one inject call per frame.
            let injectPending = false;
            const injectAll = () => {
                toggle.bindDom();
                volume.bindDom();
                menu.bindDom();
                // Settings block lives in a screen that mounts/unmounts on
                // navigation; bindSettings is idempotent (dataset guard).
                backfill.bindSettings();
                // Card badges piggy-back on the existing MutationObserver
                // tick — re-running on every DOM mutation keeps badges in
                // sync with infinite-scroll appends and tree expansions.
                backfill.decorate();
                // Touch play buttons ride the same tick for the same reason:
                // stay in sync with infinite-scroll appends / re-renders.
                touch.decorate();
            };
            const scheduleInject = () => {
                if (injectPending) return;
                injectPending = true;
                requestAnimationFrame(() => {
                    injectPending = false;
                    injectAll();
                });
            };

            const obs = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) {
                        // Caches may now point at detached nodes — invalidate
                        // synchronously before the next rAF tick reads them.
                        // Inject is coalesced separately.
                        loop.invalidateCursorCache();
                        menu.invalidateCache();
                        scheduleInject();
                        return;
                    }
                }
            });
            // Narrow the observer to the card-bearing containers instead of
            // `body, subtree:true`. The browser's subtree tracking is the
            // expensive part (it has to register every descendant); limiting
            // it to the four grids/trees the library actually re-renders
            // keeps the cost where the mutations are.
            //
            // body itself is still observed with subtree:false to catch
            // screen-level mount/unmount events (settings page, plugin
            // screens) — those happen as direct children of body and are
            // rare enough that a shallow observer is essentially free.
            const cardContainers = ['lib-grid', 'lib-tree', 'fav-grid', 'fav-tree']
                .map(id => document.getElementById(id))
                .filter(Boolean);
            if (cardContainers.length) {
                for (const el of cardContainers) {
                    obs.observe(el, { childList: true, subtree: true });
                }
                obs.observe(document.body, { childList: true, subtree: false });
            } else {
                // Fallback: containers not yet rendered (plugin loaded before
                // the library HTML). Fall back to the old wide scope.
                obs.observe(document.body, { childList: true, subtree: true });
            }
            injectAll();
            loop.start();

            // Kick the audit once on plugin init so card badges appear
            // in the library without the user needing to visit settings
            // first. bindSettings()'s own refresh() only fires when the
            // settings DOM is present — necessary for the count UI but
            // useless for cards in the library grid.
            backfill.refresh();

            // Teardown for when slopsmith unloads the plugin. Reverses
            // everything the idempotency-guarded install set up so a
            // subsequent re-evaluation starts from a clean slate.
            window.__slopsmithSongPreviewTeardown = function teardown() {
                try { obs.disconnect(); } catch (_) {}
                loop.destroy();
                scope.destroy();
                audio.destroy();
                input.destroy();
                menu.destroy();
                toggle.destroy();
                backfill.destroy();
                volume.destroy();
                touch.destroy();
                delete window.__slopsmithSongPreviewHooksInstalled;
                delete window.__slopsmithSongPreviewTeardown;
            };
        })
        .catch((err) => {
            console.error(`[${PLUGIN}] module load failed`, err);
            // Release the guard so a future re-evaluation can retry rather
            // than silently no-op'ing forever.
            delete window.__slopsmithSongPreviewHooksInstalled;
        });
})();