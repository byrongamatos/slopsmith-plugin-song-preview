// Canvas overlay that traces a rounded perimeter clockwise from the
// bottom-left as currentTime/duration advances. No Web Audio needed —
// purely a visual derived from the audio element's clock. Subscribes to
// AudioController so attach/detach follow play/stop without the loop
// having to drive them.
//
// Two anchors: song *cards* trace their `.card-art` square; song *rows*
// (list view) have no art, so they trace the row's own rounded rect — the
// same loop visual, just a long thin rectangle instead of a square. Both
// also get a `song-preview-playing` class so the active item can be tinted
// (a thin perimeter alone is easy to miss on a dense list).
const PLAYING_STYLE_ID = 'song-preview-playing-styles';
const PLAYING_STYLES = `
.song-row.song-preview-playing{
    background: rgba(64, 128, 224, 0.14);
    box-shadow: inset 3px 0 0 rgb(var(--sm-accent, 64, 128, 224));
}`;
function _ensurePlayingStyles() {
    if (typeof document === 'undefined' || document.getElementById(PLAYING_STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = PLAYING_STYLE_ID;
    el.textContent = PLAYING_STYLES;
    document.head.appendChild(el);
}

export class ProgressScope {
    constructor(audioCtrl) {
        this._audioCtrl = audioCtrl;
        this._scope = null; // { canvas, art, host }
        _ensurePlayingStyles();

        audioCtrl.on('play', (_file, host) => this.attach(host));
        audioCtrl.on('stop', () => this.detach());
    }

    // Per-corner radii. If the element has no rounding of its own, the
    // visual corners are clipped by an ancestor with overflow:hidden +
    // border-radius — inherit only the top corners from that ancestor
    // (the .card-art's bottom edge is interior, never visually rounded).
    _resolveCornerRadii(el, dpr, inset) {
        const cs = getComputedStyle(el);
        let tl = parseFloat(cs.borderTopLeftRadius) || 0;
        let tr = parseFloat(cs.borderTopRightRadius) || 0;
        let br = parseFloat(cs.borderBottomRightRadius) || 0;
        let bl = parseFloat(cs.borderBottomLeftRadius) || 0;
        if (tl === 0 && tr === 0 && br === 0 && bl === 0) {
            let p = el.parentElement;
            for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
                const pcs = getComputedStyle(p);
                const ptl = parseFloat(pcs.borderTopLeftRadius) || 0;
                const ptr = parseFloat(pcs.borderTopRightRadius) || 0;
                if (ptl > 0 || ptr > 0) { tl = ptl; tr = ptr; break; }
            }
        }
        const conv = r => Math.max(0, r * dpr - inset);
        return { tl: conv(tl), tr: conv(tr), br: conv(br), bl: conv(bl) };
    }

    // Walk the rounded-rect perimeter clockwise starting at the bottom-left
    // corner — a sharp 90° in our layout (only the top corners inherit the
    // card's rounding). Starting at a sharp corner means the first growth
    // of the trace runs along a straight vertical edge instead of curving
    // through an arc, which reads as smoother motion.
    _traceProgress(ctx2d, x, y, w, h, radii, progress) {
        const { tl, tr, br, bl } = radii;
        const lenL = Math.max(0, h - bl - tl);
        const lenT = Math.max(0, w - tl - tr);
        const lenR = Math.max(0, h - tr - br);
        const lenB = Math.max(0, w - br - bl);
        const HALF_PI = Math.PI / 2;
        const aTL = HALF_PI * tl;
        const aTR = HALF_PI * tr;
        const aBR = HALF_PI * br;
        const aBL = HALF_PI * bl;
        const total = lenL + aTL + lenT + aTR + lenR + aBR + lenB + aBL;
        let rem = Math.max(0, Math.min(1, progress)) * total;

        ctx2d.beginPath();
        ctx2d.moveTo(x, y + h - bl);

        // Skip zero-length segments without consuming budget; otherwise
        // consume and return true when the budget runs out.
        const step = (len, full, partial) => {
            if (len <= 0) return false;
            if (rem <= 0) return true;
            if (rem >= len) { full(); rem -= len; return false; }
            partial(rem / len); rem = 0; return true;
        };

        let done = step(lenL,
            () => ctx2d.lineTo(x, y + tl),
            t => ctx2d.lineTo(x, y + h - bl - lenL * t));
        if (!done) done = step(aTL,
            () => ctx2d.arc(x + tl, y + tl, tl, Math.PI, 3 * HALF_PI, false),
            t => ctx2d.arc(x + tl, y + tl, tl, Math.PI, Math.PI + HALF_PI * t, false));
        if (!done) done = step(lenT,
            () => ctx2d.lineTo(x + w - tr, y),
            t => ctx2d.lineTo(x + tl + lenT * t, y));
        if (!done) done = step(aTR,
            () => ctx2d.arc(x + w - tr, y + tr, tr, -HALF_PI, 0, false),
            t => ctx2d.arc(x + w - tr, y + tr, tr, -HALF_PI, -HALF_PI + HALF_PI * t, false));
        if (!done) done = step(lenR,
            () => ctx2d.lineTo(x + w, y + h - br),
            t => ctx2d.lineTo(x + w, y + tr + lenR * t));
        if (!done) done = step(aBR,
            () => ctx2d.arc(x + w - br, y + h - br, br, 0, HALF_PI, false),
            t => ctx2d.arc(x + w - br, y + h - br, br, 0, HALF_PI * t, false));
        if (!done) done = step(lenB,
            () => ctx2d.lineTo(x + bl, y + h),
            t => ctx2d.lineTo(x + w - br - lenB * t, y + h));
        if (!done) step(aBL,
            () => ctx2d.arc(x + bl, y + h - bl, bl, HALF_PI, Math.PI, false),
            t => ctx2d.arc(x + bl, y + h - bl, bl, HALF_PI, HALF_PI + HALF_PI * t, false));

        ctx2d.stroke();
    }

    // Pick up the host's accent so the progress trace matches what the
    // user sees on focused/selected cards.
    //
    // Resolution order:
    //   1. `--song-preview-accent` / `--sm-accent` on :root — neither is
    //      set by stock Slopsmith today, but `--sm-accent` is referenced
    //      as a fallback in style.css and stores a space-separated rgb
    //      triplet, so users (or a future theme system) can override
    //      with e.g.  :root { --sm-accent: 200, 80, 40 }.
    //   2. The host card's `border-color` when focused. Slopsmith's
    //      `.song-card:focus` sets `border-color: rgba(64,128,224,0.7)`,
    //      so this naturally adapts to any CSS override of the focus
    //      ring colour. We strip the host's faint alpha and use 0.95 so
    //      the ring is fully visible over the card art.
    //   3. Slopsmith's literal accent #4080e0. NOT accent-light (#60a0ff) —
    //      that's the brighter hover/text variant; the focused border
    //      uses accent proper.
    //
    // Deliberately skip `outline-color`: Slopsmith sets `outline: none`
    // on .song-card, so `outline-color` resolves to `currentcolor` (the
    // text colour). Reading it gave us a near-white ring on dark themes.
    _resolveAccentColor(host) {
        try {
            const rootCS = getComputedStyle(document.documentElement);
            for (const name of ['--song-preview-accent', '--sm-accent']) {
                const v = rootCS.getPropertyValue(name).trim();
                if (v) return v.includes('(') ? v : `rgb(${v})`;
            }
        } catch (_) {}
        if (host) {
            try {
                const parsed = this._parseRgb(getComputedStyle(host).borderTopColor);
                // Filter out the unfocused default (very faint white at
                // alpha ~0.04) so we don't paint a washed-out ring when
                // the host card isn't actually showing its focus state.
                if (parsed && parsed.a > 0.3) {
                    return `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, 0.95)`;
                }
            } catch (_) {}
        }
        return 'rgba(64, 128, 224, 0.95)';
    }

    _parseRgb(str) {
        if (!str) return null;
        const m = str.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/);
        if (!m) return null;
        return {
            r: parseInt(m[1], 10),
            g: parseInt(m[2], 10),
            b: parseInt(m[3], 10),
            a: m[4] !== undefined ? parseFloat(m[4]) : 1,
        };
    }

    attach(host) {
        this.detach();
        // Cards trace their album-art square; rows have no art, so trace the
        // row's own rounded rect.
        let art = host && host.querySelector ? host.querySelector('.card-art') : null;
        if (!art && host && host.classList && host.classList.contains('song-row')) {
            art = host;
        }
        if (!art) return; // nothing paintable (e.g. a card mid-render)

        // Tint the playing item so it's obvious which one is sounding.
        if (host && host.classList) host.classList.add('song-preview-playing');

        const canvas = document.createElement('canvas');
        canvas.className = 'song-preview-scope';
        canvas.style.cssText =
            'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
        if (getComputedStyle(art).position === 'static') art.style.position = 'relative';
        art.appendChild(canvas);

        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.floor(art.clientWidth * dpr));
        canvas.height = Math.max(1, Math.floor(art.clientHeight * dpr));
        const stroke = 3 * dpr;
        const inset = stroke / 2;

        // Everything draw() needs lives on the scope object — we no longer
        // run our own rAF, PreviewLoop calls draw() from its shared tick.
        this._scope = {
            canvas,
            art,
            host,
            ctx2d: canvas.getContext('2d'),
            stroke,
            inset,
            radii: this._resolveCornerRadii(art, dpr, inset),
            accent: this._resolveAccentColor(host),
        };
    }

    detach() {
        if (!this._scope) return;
        try { this._scope.canvas.remove(); } catch (_) {}
        const host = this._scope.host;
        if (host && host.classList) host.classList.remove('song-preview-playing');
        this._scope = null;
    }

    // Called once per frame from PreviewLoop._tick. No-op when no scope
    // is attached, so safe to call unconditionally.
    draw() {
        const s = this._scope;
        if (!s) return;
        const audio = this._audioCtrl.audioElement();
        const dur = audio && Number.isFinite(audio.duration) ? audio.duration : 0;
        const cur = audio ? audio.currentTime : 0;
        const progress = dur > 0 ? Math.min(1, Math.max(0, cur / dur)) : 0;
        const { canvas, ctx2d, stroke, inset, radii, accent } = s;
        const w = canvas.width;
        const h = canvas.height;
        const innerW = w - stroke;
        const innerH = h - stroke;
        ctx2d.clearRect(0, 0, w, h);
        ctx2d.lineWidth = stroke;
        ctx2d.lineCap = 'butt';
        ctx2d.lineJoin = 'round';
        // Faint backdrop trace so the full perimeter is hinted at.
        ctx2d.strokeStyle = 'rgba(0,0,0,0.4)';
        this._traceProgress(ctx2d, inset, inset, innerW, innerH, radii, 1);
        // Foreground progress, themed — see _resolveAccentColor.
        ctx2d.strokeStyle = accent;
        this._traceProgress(ctx2d, inset, inset, innerW, innerH, radii, progress);
    }

    // The library re-renders cards in place. When that happens the .card-art
    // we anchored to is gone from the document but the same filename is
    // still under the cursor — re-anchor to the fresh DOM node without
    // interrupting playback.
    reanchorIfDetached(host) {
        if (!this._scope) return;
        if (this._scope.art && document.contains(this._scope.art)) return;
        this.attach(host);
    }

    destroy() { this.detach(); }
}