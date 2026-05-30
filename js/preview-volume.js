// Owns the "Preview volume" slider on both the Settings block and the plugin
// screen. The level is the plugin's own preview volume (decoupled from the
// host Song channel) — it reads/writes AudioController, which persists it and
// applies it live. Both surfaces mirror each other so they never disagree.
//
// The enable toggle is the master switch: the whole volume row is hidden
// whenever previews are disabled (volume only matters once previews are on).
// Volume 0 is treated as "off" by PreviewLoop, and the readout shows "Off",
// so a muted slider is obvious and reversible rather than a silent mystery.
export class PreviewVolume {
    constructor({ audio, toggle }) {
        this._audio = audio;
        this._toggle = toggle;
        // Settings IDs and their `-screen` counterparts on the plugin screen.
        this.SLIDER_IDS = ['song-preview-volume', 'song-preview-volume-screen'];
        this.ROW_IDS = ['song-preview-volume-row', 'song-preview-volume-row-screen'];
        this.READOUT_IDS = ['song-preview-volume-readout', 'song-preview-volume-readout-screen'];
        this._handlers = new WeakMap();
        this._onToggleChange = () => this.syncVisibility();
    }

    // Idempotent — safe to call every render tick (dataset flags gate the
    // actual binding). Only does the (cheap) reflect/visibility work when a
    // fresh surface mounted, mirroring PreviewToggle's pattern.
    bindDom() {
        let boundNew = false;
        for (const id of this.SLIDER_IDS) {
            const el = document.getElementById(id);
            if (!el || el.dataset.songPreviewVolBound) continue;
            el.dataset.songPreviewVolBound = '1';
            boundNew = true;
            const handler = () => {
                const v = (parseInt(el.value, 10) || 0) / 100;
                this._audio.setVolume(v);
                this._reflect(v);
            };
            this._handlers.set(el, handler);
            el.addEventListener('input', handler);
        }
        // React to the enable toggle so the row shows/hides as it flips.
        for (const tid of this._toggle.TOGGLE_IDS) {
            const t = document.getElementById(tid);
            if (!t || t.dataset.songPreviewVolToggleBound) continue;
            t.dataset.songPreviewVolToggleBound = '1';
            t.addEventListener('change', this._onToggleChange);
        }
        if (boundNew) {
            this._reflect(this._audio.getVolume());
            this.syncVisibility();
        }
    }

    // Mirror value + readout across both surfaces. The slider is loudness only
    // (the toggle owns on/off), so it floors above 0 and the readout is always
    // a percentage — never "Off".
    _reflect(v01) {
        const pct = Math.round(v01 * 100);
        for (const id of this.SLIDER_IDS) {
            const el = document.getElementById(id);
            if (el && String(el.value) !== String(pct)) el.value = String(pct);
        }
        for (const id of this.READOUT_IDS) {
            const el = document.getElementById(id);
            if (el) el.textContent = `${pct}%`;
        }
    }

    syncVisibility() {
        const show = this._toggle.isEnabled();
        for (const id of this.ROW_IDS) {
            const row = document.getElementById(id);
            if (row) row.classList.toggle('hidden', !show);
        }
    }

    destroy() {
        for (const id of this.SLIDER_IDS) {
            const el = document.getElementById(id);
            if (!el) continue;
            const handler = this._handlers.get(el);
            if (handler) el.removeEventListener('input', handler);
            delete el.dataset.songPreviewVolBound;
        }
        for (const tid of this._toggle.TOGGLE_IDS) {
            const t = document.getElementById(tid);
            if (!t) continue;
            t.removeEventListener('change', this._onToggleChange);
            delete t.dataset.songPreviewVolToggleBound;
        }
    }
}