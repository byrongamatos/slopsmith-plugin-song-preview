// Owns "what is the user doing right now" state. Tracks cursor position,
// whether the keyboard is the current driver, active wheel scrolling,
// and whether the window is meaningfully visible. Peers subscribe via
// onMouseMove / onSuspend so this class doesn't need refs to them.
//
// Deliberate non-feature: no window 'blur' listener. On Windows pressing
// Alt alone activates the OS menu bar and fires a spurious blur — that
// previously killed previews on every Alt tap. mouseleave catches the
// "actually moved away" case; visibilitychange catches the "window is
// no longer visible at all" case. That covers what we need.
export class InputTracker {
    constructor() {
        this.SCROLL_QUIET_MS = 200;

        this._lastMouseX = -1;
        this._lastMouseY = -1;
        this._keyboardReigns = false;
        // Touch devices have no hover and no persistent pointer, so the
        // cursor-driven PreviewLoop can't make hover decisions there — it
        // reads "no cursor over a card" every tick and would stop any
        // tap-started preview. TouchTrigger owns playback on these devices;
        // PreviewLoop checks isTouchDevice() to stay out of its way.
        this._touchMql = window.matchMedia('(hover: none) and (pointer: coarse)');
        this._isTouch = this._touchMql.matches;
        this._handleTouchMql = (e) => { this._isTouch = e.matches; };
        if (this._touchMql.addEventListener) this._touchMql.addEventListener('change', this._handleTouchMql);
        else if (this._touchMql.addListener) this._touchMql.addListener(this._handleTouchMql);
        this._isScrolling = false;
        this._scrollTimer = 0;
        this._mouseOutOfWindow = false;
        this._documentHidden = false;

        this._onMouseMoveCbs = [];
        this._onSuspendCbs = [];

        this._handleMouseMove = (e) => {
            this._lastMouseX = e.clientX;
            this._lastMouseY = e.clientY;
            this._keyboardReigns = false;
            for (const cb of this._onMouseMoveCbs) cb();
        };
        this._handleKeyDown = () => { this._keyboardReigns = true; };
        this._handleWheel = () => {
            this._isScrolling = true;
            if (this._scrollTimer) clearTimeout(this._scrollTimer);
            this._scrollTimer = setTimeout(() => {
                this._isScrolling = false;
                this._scrollTimer = 0;
            }, this.SCROLL_QUIET_MS);
        };
        // documentElement mouseleave fires once when the cursor crosses
        // the viewport boundary, not for every child transition the way
        // bubbling mouseout would.
        this._handleDocMouseLeave = () => {
            this._mouseOutOfWindow = true;
            this._fireSuspend();
        };
        this._handleDocMouseEnter = () => { this._mouseOutOfWindow = false; };
        this._handleVisibility = () => {
            if (document.hidden) {
                this._documentHidden = true;
                this._fireSuspend();
            } else {
                this._documentHidden = false;
            }
        };

        document.addEventListener('mousemove', this._handleMouseMove);
        document.addEventListener('keydown', this._handleKeyDown);
        document.addEventListener('wheel', this._handleWheel, { passive: true });
        document.documentElement.addEventListener('mouseleave', this._handleDocMouseLeave);
        document.documentElement.addEventListener('mouseenter', this._handleDocMouseEnter);
        document.addEventListener('visibilitychange', this._handleVisibility);
    }

    onMouseMove(cb) { this._onMouseMoveCbs.push(cb); }
    onSuspend(cb) { this._onSuspendCbs.push(cb); }
    _fireSuspend() { for (const cb of this._onSuspendCbs) cb(); }

    mouseX() { return this._lastMouseX; }
    mouseY() { return this._lastMouseY; }
    hasMousePosition() { return this._lastMouseX >= 0; }
    isKeyboardDriving() { return this._keyboardReigns; }
    isScrolling() { return this._isScrolling; }
    isSuspended() { return this._mouseOutOfWindow || this._documentHidden; }
    isTouchDevice() { return this._isTouch; }

    destroy() {
        document.removeEventListener('mousemove', this._handleMouseMove);
        document.removeEventListener('keydown', this._handleKeyDown);
        document.removeEventListener('wheel', this._handleWheel);
        document.documentElement.removeEventListener('mouseleave', this._handleDocMouseLeave);
        document.documentElement.removeEventListener('mouseenter', this._handleDocMouseEnter);
        document.removeEventListener('visibilitychange', this._handleVisibility);
        if (this._touchMql.removeEventListener) this._touchMql.removeEventListener('change', this._handleTouchMql);
        else if (this._touchMql.removeListener) this._touchMql.removeListener(this._handleTouchMql);
        if (this._scrollTimer) {
            clearTimeout(this._scrollTimer);
            this._scrollTimer = 0;
        }
        this._onMouseMoveCbs.length = 0;
        this._onSuspendCbs.length = 0;
    }
}
