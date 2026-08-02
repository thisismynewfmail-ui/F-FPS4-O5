// ---------------------------------------------------------------------------
// input.js — keyboard, mouse and pointer lock.
// ---------------------------------------------------------------------------

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();
    this.released = new Set();
    this.mouse = { dx: 0, dy: 0, buttons: 0, wheel: 0 };
    this.mousePressed = 0;
    this.locked = false;
    this.sensitivity = 0.0022;
    this.invertY = false;
    // Mirrors the horizontal look axis AND strafe together, since a player who
    // perceives one as reversed perceives both. Toggled with F4, persisted.
    this.mirrorX = false;
    this.onLockChange = null;

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      const c = e.code;
      if (!this.keys.has(c)) this.pressed.add(c);
      this.keys.add(c);
      if (['Tab', 'Space', 'F1', 'F5', 'Slash', 'Quote'].includes(c)) e.preventDefault();
      if (c.startsWith('Digit') || c.startsWith('Arrow')) e.preventDefault();
    };
    this._onKeyUp = (e) => { this.keys.delete(e.code); this.released.add(e.code); };
    this._onMove = (e) => {
      if (!this.locked) return;
      this.mouse.dx += e.movementX || 0;
      this.mouse.dy += e.movementY || 0;
    };
    this._onDown = (e) => {
      if (!this.locked) return;
      const bit = 1 << e.button;
      if (!(this.mouse.buttons & bit)) this.mousePressed |= bit;
      this.mouse.buttons |= bit;
      e.preventDefault();
    };
    this._onUp = (e) => { this.mouse.buttons &= ~(1 << e.button); };
    this._onWheel = (e) => { if (this.locked) { this.mouse.wheel += Math.sign(e.deltaY); e.preventDefault(); } };
    this._onLock = () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) { this.keys.clear(); this.mouse.buttons = 0; }
      if (this.onLockChange) this.onLockChange(this.locked);
    };
    this._onBlur = () => { this.keys.clear(); this.mouse.buttons = 0; };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMove);
    window.addEventListener('mousedown', this._onDown);
    window.addEventListener('mouseup', this._onUp);
    window.addEventListener('wheel', this._onWheel, { passive: false });
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('pointerlockchange', this._onLock);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  requestLock() {
    if (!this.locked && this.canvas.requestPointerLock) {
      const r = this.canvas.requestPointerLock();
      if (r && typeof r.catch === 'function') r.catch(() => {});
    }
  }
  exitLock() { if (document.exitPointerLock) document.exitPointerLock(); }

  down(code) { return this.keys.has(code); }
  justPressed(code) { return this.pressed.has(code); }
  justReleased(code) { return this.released.has(code); }
  mouseDown(btn) { return (this.mouse.buttons & (1 << btn)) !== 0; }
  mouseJustPressed(btn) { return (this.mousePressed & (1 << btn)) !== 0; }

  /** Consume the frame's accumulated deltas. */
  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.wheel = 0;
    this.mousePressed = 0;
  }
}
