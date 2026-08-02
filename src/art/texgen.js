// ---------------------------------------------------------------------------
// texgen.js — the procedural texture painter.
//
// Every surface in the game is drawn here, pixel by pixel, into a 128x128
// RGBA buffer. Rules the brief imposes and this module enforces:
//
//  * Everything tiles seamlessly (all ops wrap).
//  * Everything is quantised to a small palette so it reads at PS1 resolution
//    — strong value contrast, hard edges, no soft gradients.
//  * Weathering is a parameter, not a separate texture: `decay` 0..1 drives
//    moss, rust, staining, peeling and cracking, so the same brick material
//    produces a crisp downtown variant and a rotten outskirts variant.
// ---------------------------------------------------------------------------

import { RNG, clamp, clamp01, fbm, lerp } from '../core/math.js';

export const TEX_SIZE = 128;

// --- cached noise fields ---------------------------------------------------
// Evaluating fbm per pixel per texture costs seconds across a ~240 texture
// library. Instead we bake one tileable field per frequency and sample it with
// a wrapped offset, which is visually indistinguishable and ~40x faster.

const _fields = new Map();

function field(period) {
  const p = Math.max(2, Math.round(period));
  let f = _fields.get(p);
  if (!f) {
    f = new Float32Array(TEX_SIZE * TEX_SIZE);
    for (let y = 0; y < TEX_SIZE; y++) {
      for (let x = 0; x < TEX_SIZE; x++) {
        f[y * TEX_SIZE + x] = fbm((x / TEX_SIZE) * p, (y / TEX_SIZE) * p, 3, 7, p);
      }
    }
    _fields.set(p, f);
  }
  return f;
}

/** Sample a cached field with a wrapped offset. Returns [0,1). */
function sampleField(f, x, y, ox, oy) {
  const xx = (x + ox) & (TEX_SIZE - 1);
  const yy = (y + oy) & (TEX_SIZE - 1);
  return f[yy * TEX_SIZE + xx];
}

// --- colour helpers --------------------------------------------------------

export function rgb(r, g, b) { return [r, g, b]; }

export function shift(c, amount) {
  return [clamp(c[0] + amount, 0, 255), clamp(c[1] + amount, 0, 255), clamp(c[2] + amount, 0, 255)];
}

export function mulColor(c, f) {
  return [clamp(c[0] * f, 0, 255), clamp(c[1] * f, 0, 255), clamp(c[2] * f, 0, 255)];
}

export function mixColor(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** Shift hue/saturation/value without a full HSL round trip. */
export function tintColor(c, tint, amount) {
  return mixColor(c, tint, amount);
}

// --- the canvas ------------------------------------------------------------

export class Tex {
  constructor(size = TEX_SIZE) {
    this.size = size;
    this.mask = (size & (size - 1)) === 0 ? size - 1 : 0;
    this.data = new Uint8ClampedArray(size * size * 4);
    this.data.fill(255);
  }

  /**
   * Wrapping index. Coordinates are truncated to integers first — passing a
   * float here used to produce a fractional index, which a TypedArray silently
   * ignores, so sub-pixel blobs and lines drew nothing at all.
   */
  idx(x, y) {
    const s = this.size;
    if (this.mask) return ((((y | 0) & this.mask) * s) + ((x | 0) & this.mask)) * 4;
    let xi = (x | 0) % s; if (xi < 0) xi += s;
    let yi = (y | 0) % s; if (yi < 0) yi += s;
    return (yi * s + xi) * 4;
  }

  set(x, y, c, a = 255) {
    const i = this.idx(x, y);
    this.data[i] = c[0]; this.data[i + 1] = c[1]; this.data[i + 2] = c[2]; this.data[i + 3] = a;
  }

  /** Scalar setter for hot inner loops — avoids allocating a colour array. */
  px(x, y, r, g, b, a = 255) {
    const i = this.idx(x, y);
    this.data[i] = r; this.data[i + 1] = g; this.data[i + 2] = b; this.data[i + 3] = a;
  }

  blend(x, y, c, alpha) {
    if (alpha <= 0) return;
    if (alpha >= 1) return this.set(x, y, c);
    const i = this.idx(x, y);
    this.data[i] = lerp(this.data[i], c[0], alpha);
    this.data[i + 1] = lerp(this.data[i + 1], c[1], alpha);
    this.data[i + 2] = lerp(this.data[i + 2], c[2], alpha);
  }

  get(x, y) {
    const i = this.idx(x, y);
    return [this.data[i], this.data[i + 1], this.data[i + 2]];
  }

  alpha(x, y, a) { this.data[this.idx(x, y) + 3] = a; }

  fill(c, a = 255) {
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) this.set(x, y, c, a);
    return this;
  }

  rect(x, y, w, h, c, a = 255) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c, a);
    return this;
  }

  rectBlend(x, y, w, h, c, alpha) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.blend(x + i, y + j, c, alpha);
    return this;
  }

  frame(x, y, w, h, c, t = 1) {
    this.rect(x, y, w, t, c); this.rect(x, y + h - t, w, t, c);
    this.rect(x, y, t, h, c); this.rect(x + w - t, y, t, h, c);
    return this;
  }

  hline(y, x0, x1, c, a = 1) { for (let x = x0; x < x1; x++) this.blend(x, y, c, a); return this; }
  vline(x, y0, y1, c, a = 1) { for (let y = y0; y < y1; y++) this.blend(x, y, c, a); return this; }

  line(x0, y0, x1, y1, c, a = 1) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= steps; i++) {
      this.blend(Math.round(lerp(x0, x1, i / steps)), Math.round(lerp(y0, y1, i / steps)), c, a);
    }
    return this;
  }

  /** Per-pixel monochrome grain. */
  grain(rng, amount) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        const d = (rng.next() - 0.5) * amount;
        const i = this.idx(x, y);
        this.data[i] += d; this.data[i + 1] += d; this.data[i + 2] += d;
      }
    }
    return this;
  }

  /** Large-scale blotchy value variation. Seamless (the field is periodic). */
  mottle(seed, scale, amount, tint) {
    const f = field(this.size / scale);
    const ox = (seed * 37) & (TEX_SIZE - 1);
    const oy = (seed * 101) & (TEX_SIZE - 1);
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        const n = sampleField(f, x, y, ox, oy) - 0.5;
        const i = this.idx(x, y);
        if (tint) {
          // `amount` is expressed in 0..255 channel units like the untinted
          // path, so it has to be normalised before use as a blend factor.
          // Using it raw drove clamp01 to 1 across half the texture and buried
          // every weathered material under solid grime.
          const t = clamp01(n * (amount / 90));
          this.data[i] = lerp(this.data[i], tint[0], t);
          this.data[i + 1] = lerp(this.data[i + 1], tint[1], t);
          this.data[i + 2] = lerp(this.data[i + 2], tint[2], t);
        } else {
          const d = n * amount;
          this.data[i] += d; this.data[i + 1] += d; this.data[i + 2] += d;
        }
      }
    }
    return this;
  }

  speckle(rng, count, colors, size = 1) {
    for (let i = 0; i < count; i++) {
      const x = Math.floor(rng.next() * this.size);
      const y = Math.floor(rng.next() * this.size);
      const c = colors[Math.floor(rng.next() * colors.length)];
      const s = size === 1 ? 1 : 1 + Math.floor(rng.next() * size);
      this.rect(x, y, s, s, c);
    }
    return this;
  }

  /** Irregular blob, drawn as a jittered disc so edges stay pixelated. */
  blob(cx, cy, r, c, rng, alpha = 1) {
    const rr = Math.ceil(r) + 1;
    const f = field(28);
    const ox = (cx * 13) & (TEX_SIZE - 1), oy = (cy * 29) & (TEX_SIZE - 1);
    for (let y = -rr; y <= rr; y++) {
      for (let x = -rr; x <= rr; x++) {
        const d = Math.hypot(x, y);
        const wobble = r * (0.72 + 0.5 * sampleField(f, x | 0, y | 0, ox | 0, oy | 0));
        if (d < wobble) {
          const fade = clamp01(1 - d / Math.max(wobble, 0.001));
          this.blend(cx + x, cy + y, c, alpha * clamp01(0.35 + fade));
        }
      }
    }
    return this;
  }

  /** Random-walk cracks. Reads clearly even at 1 pixel wide. */
  cracks(rng, count, c, len = 40, alpha = 0.8) {
    for (let i = 0; i < count; i++) {
      let x = rng.next() * this.size, y = rng.next() * this.size;
      let a = rng.next() * Math.PI * 2;
      const l = len * rng.range(0.5, 1.4);
      for (let s = 0; s < l; s++) {
        a += (rng.next() - 0.5) * 0.9;
        x += Math.cos(a); y += Math.sin(a);
        this.blend(Math.round(x), Math.round(y), c, alpha * rng.range(0.5, 1));
        if (rng.chance(0.04)) {   // branch
          let bx = x, by = y, ba = a + rng.sign() * 0.9;
          for (let k = 0; k < l * 0.35; k++) {
            ba += (rng.next() - 0.5) * 0.8;
            bx += Math.cos(ba); by += Math.sin(ba);
            this.blend(Math.round(bx), Math.round(by), c, alpha * 0.6);
          }
        }
      }
    }
    return this;
  }

  /** Vertical drip stains running down from a start row. */
  streaks(rng, count, c, alpha = 0.35, fromTop = true) {
    for (let i = 0; i < count; i++) {
      const x = Math.floor(rng.next() * this.size);
      const w = 1 + Math.floor(rng.next() * 3);
      const start = fromTop ? Math.floor(rng.next() * this.size * 0.3) : Math.floor(rng.range(0.3, 0.9) * this.size);
      const len = Math.floor(rng.range(0.2, 0.85) * this.size);
      for (let y = 0; y < len; y++) {
        const fade = alpha * (1 - y / len) * rng.range(0.6, 1);
        for (let k = 0; k < w; k++) this.blend(x + k, start + y, c, fade);
      }
    }
    return this;
  }

  /** Growth creeping in from one edge — moss at the base, soot at the top. */
  creep(rng, from, depth, c, density = 1) {
    const s = this.size;
    const count = Math.min(1400, s * depth * density * 0.9);
    for (let i = 0; i < count; i++) {
      const t = Math.pow(rng.next(), 1.9);
      const d = t * depth;
      let x, y;
      if (from === 'bottom') { x = rng.next() * s; y = s - d; }
      else if (from === 'top') { x = rng.next() * s; y = d; }
      else if (from === 'left') { x = d; y = rng.next() * s; }
      else { x = s - d; y = rng.next() * s; }
      const r = rng.range(0.8, 2.6);
      this.blob(Math.round(x), Math.round(y), r, c, rng, rng.range(0.35, 0.9));
    }
    return this;
  }

  /** Multiply by a vertical gradient — fakes ambient occlusion on trim. */
  vGradient(topMul, bottomMul) {
    for (let y = 0; y < this.size; y++) {
      const f = lerp(topMul, bottomMul, y / (this.size - 1));
      for (let x = 0; x < this.size; x++) {
        const i = this.idx(x, y);
        this.data[i] *= f; this.data[i + 1] *= f; this.data[i + 2] *= f;
      }
    }
    return this;
  }

  /** Collapse to N levels per channel — the palettised PS1 look. */
  quantize(levels = 12) {
    const step = 255 / (levels - 1);
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = Math.round(this.data[i] / step) * step;
      this.data[i + 1] = Math.round(this.data[i + 1] / step) * step;
      this.data[i + 2] = Math.round(this.data[i + 2] / step) * step;
    }
    return this;
  }

  /** Global hue/value shift — how one base material becomes a dozen. */
  recolor(tint, amount, valueMul = 1) {
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = clamp(lerp(this.data[i], tint[0], amount) * valueMul, 0, 255);
      this.data[i + 1] = clamp(lerp(this.data[i + 1], tint[1], amount) * valueMul, 0, 255);
      this.data[i + 2] = clamp(lerp(this.data[i + 2], tint[2], amount) * valueMul, 0, 255);
    }
    return this;
  }

  /** Punch out transparency where the pixel matches a key colour. */
  keyOut(color, tolerance = 12) {
    for (let i = 0; i < this.data.length; i += 4) {
      if (Math.abs(this.data[i] - color[0]) < tolerance &&
          Math.abs(this.data[i + 1] - color[1]) < tolerance &&
          Math.abs(this.data[i + 2] - color[2]) < tolerance) {
        this.data[i + 3] = 0;
      }
    }
    return this;
  }

  setAlpha(a) {
    for (let i = 3; i < this.data.length; i += 4) this.data[i] = a;
    return this;
  }
}

// ---------------------------------------------------------------------------
// Weathering — applied on top of any base material.
// ---------------------------------------------------------------------------

export function weather(tex, decay, rng, opts = {}) {
  const d = clamp01(decay);
  if (d <= 0.01) { tex.grain(rng, 6); return tex; }

  // Grime settles everywhere first.
  tex.mottle(rng.int(0, 9999), 26, 60 * d, opts.grimeColor || [46, 44, 38]);

  if (opts.moss !== false && d > 0.25) {
    const moss = opts.mossColor || [58, 78, 44];
    tex.creep(rng, 'bottom', 14 + 44 * d, moss, (d - 0.2) * 1.5);
    if (d > 0.6) tex.creep(rng, rng.pick(['left', 'right']), 10 + 26 * d, moss, (d - 0.55) * 1.4);
  }

  if (opts.rust && d > 0.15) {
    const rust = opts.rustColor || [122, 62, 30];
    for (let i = 0; i < 26 * d; i++) {
      tex.blob(rng.int(0, tex.size), rng.int(0, tex.size), rng.range(2, 9), rust, rng, rng.range(0.3, 0.85));
    }
    tex.streaks(rng, Math.round(10 * d), rust, 0.4 * d);
  }

  if (opts.stains !== false) {
    tex.streaks(rng, Math.round(4 + 16 * d), opts.stainColor || [38, 36, 32], 0.16 + 0.3 * d);
  }

  if (opts.peel && d > 0.35) {
    const under = opts.peelUnder || [96, 84, 70];
    for (let i = 0; i < 30 * d; i++) {
      tex.blob(rng.int(0, tex.size), rng.int(0, tex.size), rng.range(1.5, 6.5), under, rng, rng.range(0.5, 1));
    }
  }

  if (opts.crack !== false && d > 0.4) {
    tex.cracks(rng, Math.round(2 + 7 * d), opts.crackColor || [30, 28, 26], 30 + 40 * d, 0.55);
  }

  tex.grain(rng, 8 + 10 * d);
  return tex;
}

// ---------------------------------------------------------------------------
// Base materials
// ---------------------------------------------------------------------------

/** Running-bond brick. `p.brickW/H` are in pixels; 128 must divide evenly. */
export function brick(rng, p = {}) {
  const t = new Tex();
  const base = p.color || [138, 74, 58];
  const mortar = p.mortar || [150, 146, 136];
  const bw = p.brickW || 32, bh = p.brickH || 16;
  const gap = p.gap ?? 2;
  t.fill(mortar);
  t.grain(rng, 22);
  const rows = TEX_SIZE / bh;
  for (let r = 0; r < rows; r++) {
    const offset = (r % 2) * (bw / 2) + (p.jitterRow ? rng.int(-2, 2) : 0);
    for (let c = -1; c <= TEX_SIZE / bw; c++) {
      const x = c * bw + offset;
      const y = r * bh;
      const variance = p.variance ?? 18;
      let col = shift(base, rng.range(-variance, variance));
      if (rng.chance(p.oddChance ?? 0.08)) col = mixColor(col, p.oddColor || [92, 62, 54], 0.6);
      const cr = col[0], cg = col[1], cb = col[2];
      for (let j = 0; j < bh - gap; j++) {
        // Slight per-brick lighting: lighter top-left, darker bottom-right.
        const rowShade = (j < 1 ? 14 : 0) - (j > bh - gap - 2 ? 16 : 0);
        for (let i = 0; i < bw - gap; i++) {
          const s = rowShade + (i < 1 ? 8 : 0) + (rng.next() * 14 - 7);
          t.px(x + i, y + j, cr + s, cg + s, cb + s);
        }
      }
    }
  }
  t.mottle(rng.int(0, 9999), 40, 26);
  return t;
}

/** Coursed ashlar stone — the church, the library, the older civic blocks. */
export function stone(rng, p = {}) {
  const t = new Tex();
  const base = p.color || [142, 138, 128];
  const mortar = p.mortar || [104, 100, 92];
  const courseH = p.courseH || 32;
  t.fill(mortar);
  t.grain(rng, 18);
  for (let r = 0; r < TEX_SIZE / courseH; r++) {
    const y = r * courseH;
    let x = -rng.int(0, 40);
    while (x < TEX_SIZE + 8) {
      const w = rng.int(p.minW || 26, p.maxW || 58);
      const col = shift(base, rng.range(-26, 26));
      const cr = col[0], cg = col[1], cb = col[2];
      const h = courseH - 3;
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w - 3; i++) {
          // Rounded, hand-cut face: bright top-left, occlusion bottom-right.
          const edge = Math.min(i, j, w - 4 - i, h - 1 - j);
          let f = edge < 1 ? 0.80 : edge < 2 ? 0.94 : 1;
          if (j < 2) f += 0.12;
          const n = (rng.next() - 0.5) * 26;
          t.px(x + i, y + j, (cr + n) * f, (cg + n) * f, (cb + n) * f);
        }
      }
      x += w;
    }
  }
  t.mottle(rng.int(0, 9999), 44, 30);
  return t;
}

/** Horizontal lap siding (clapboard) with a hard shadow under each board. */
export function siding(rng, p = {}) {
  const t = new Tex();
  const base = p.color || [176, 172, 158];
  const boardH = p.boardH || 16;
  t.fill(base);
  for (let y = 0; y < TEX_SIZE; y += boardH) {
    const v = rng.range(-10, 10);
    const br = base[0] + v, bg = base[1] + v, bb = base[2] + v;
    for (let j = 0; j < boardH; j++) {
      const f = j < 2 ? 1.16 : j > boardH - 3 ? 0.74 : 1 - (j / boardH) * 0.10;
      for (let x = 0; x < TEX_SIZE; x++) {
        const n = (rng.next() - 0.5) * 8;
        t.px(x, y + j, (br + n) * f, (bg + n) * f, (bb + n) * f);
      }
    }
    t.hline(y + boardH - 1, 0, TEX_SIZE, [0, 0, 0], 0.30);
  }
  // Occasional vertical board joints.
  for (let i = 0; i < 2; i++) {
    const x = rng.int(0, TEX_SIZE);
    t.vline(x, 0, TEX_SIZE, mulColor(base, 0.72), 0.5);
  }
  t.mottle(rng.int(0, 9999), 48, 22);
  return t;
}

/** Vertical board-and-batten — barns, sheds, boarded shopfronts. */
export function boards(rng, p = {}) {
  const t = new Tex();
  const base = p.color || [128, 102, 74];
  const bw = p.boardW || 16;
  t.fill(base);
  const F = field(26);
  for (let x = 0; x < TEX_SIZE; x += bw) {
    const v = rng.range(-16, 16);
    const br = base[0] + v, bg = base[1] + v, bb = base[2] + v;
    for (let i = 0; i < bw; i++) {
      const f = i === 0 ? 0.66 : i === bw - 1 ? 0.80 : 1;
      // Wood grain: tight across the board, stretched along it.
      const gx = Math.round((x + i) * 3);
      for (let y = 0; y < TEX_SIZE; y++) {
        const g = (sampleField(F, gx, y >> 3, 0, 0) - 0.5) * 40;
        t.px(x + i, y, (br + g) * f, (bg + g) * f, (bb + g) * f);
      }
    }
    if (p.batten) t.rect(x + bw - 3, 0, 3, TEX_SIZE, mulColor(shift(base, 12), 1.05));
  }
  // Knots.
  for (let i = 0; i < (p.knots ?? 3); i++) {
    const kx = rng.int(0, TEX_SIZE), ky = rng.int(0, TEX_SIZE);
    t.blob(kx, ky, rng.range(1.5, 3), mulColor(base, 0.55), rng, 0.9);
  }
  return t;
}

/** Poured / precast concrete, with form-tie marks and pour lines. */
export function concrete(rng, p = {}) {
  const t = new Tex();
  const base = p.color || [148, 146, 140];
  t.fill(base);
  t.mottle(rng.int(0, 9999), 18, 44);
  t.mottle(rng.int(0, 9999), 52, 34);
  t.grain(rng, 26);
  if (p.formLines !== false) {
    for (let y = 0; y < TEX_SIZE; y += p.formH || 64) {
      t.hline(y, 0, TEX_SIZE, mulColor(base, 0.78), 0.7);
      t.hline(y + 1, 0, TEX_SIZE, mulColor(base, 1.10), 0.4);
    }
    for (let i = 0; i < 4; i++) {
      const x = rng.int(0, TEX_SIZE), y = rng.int(0, TEX_SIZE);
      t.rect(x, y, 3, 3, mulColor(base, 0.72));   // form tie
      t.rect(x, y, 1, 1, mulColor(base, 1.12));
    }
  }
  if (p.blocks) {   // CMU / cinder block coursing
    const bw = 64, bh = 32;
    for (let y = 0; y < TEX_SIZE; y += bh) {
      const off = ((y / bh) % 2) * (bw / 2);
      t.hline(y, 0, TEX_SIZE, mulColor(base, 0.70), 0.85);
      t.hline(y + 1, 0, TEX_SIZE, mulColor(base, 1.14), 0.4);
      for (let x = 0; x < TEX_SIZE + bw; x += bw) {
        t.vline((x + off) % TEX_SIZE, y, y + bh, mulColor(base, 0.70), 0.85);
      }
    }
  }
  t.cracks(rng, p.cracks ?? 1, mulColor(base, 0.5), 26, 0.45);
  return t;
}

/** Troweled stucco / render. */
export function stucco(rng, p = {}) {
  const t = new Tex();
  const base = p.color || [198, 186, 162];
  t.fill(base);
  for (let i = 0; i < 2600; i++) {
    const x = rng.int(0, TEX_SIZE), y = rng.int(0, TEX_SIZE);
    t.blend(x, y, shift(base, rng.range(-26, 22)), 0.7);
  }
  t.mottle(rng.int(0, 9999), 30, 30);
  t.grain(rng, 16);
  return t;
}

/** Asphalt / tarmac with aggregate speckle and patch repairs. */
export function asphalt(rng, p = {}) {
  const t = new Tex();
  const base = p.color || [62, 62, 64];
  t.fill(base);
  t.mottle(rng.int(0, 9999), 22, 34);
  t.speckle(rng, 2400, [shift(base, 26), shift(base, -18), shift(base, 40)], 1);
  if (p.patches !== false) {
    for (let i = 0; i < 3; i++) {
      t.blob(rng.int(0, TEX_SIZE), rng.int(0, TEX_SIZE), rng.range(8, 22), shift(base, -14), rng, 0.65);
    }
  }
  t.cracks(rng, 3, shift(base, -24), 44, 0.55);
  t.grain(rng, 18);
  return t;
}

/** Poured sidewalk with scored control joints. */
export function sidewalk(rng, p = {}) {
  const t = concrete(rng, { color: p.color || [156, 152, 143], formLines: false, cracks: 2 });
  const cell = p.cell || 64;
  const joint = mulColor(p.color || [156, 152, 143], 0.66);
  for (let x = 0; x < TEX_SIZE; x += cell) t.vline(x, 0, TEX_SIZE, joint, 0.9);
  for (let y = 0; y < TEX_SIZE; y += cell) t.hline(y, 0, TEX_SIZE, joint, 0.9);
  return t;
}

/** Asphalt shingle roofing — staggered tabs, the default residential roof. */
export function shingle(rng, p = {}) {
  const t = new Tex();
  const base = p.color || [78, 78, 80];
  const rowH = p.rowH || 16, tabW = p.tabW || 21.33;
  t.fill(mulColor(base, 0.8));
  for (let r = 0; r < TEX_SIZE / rowH; r++) {
    const y = r * rowH;
    const off = (r % 2) * (tabW / 2);
    for (let x = -tabW; x < TEX_SIZE + tabW; x += tabW) {
      const v = rng.range(-16, 16);
      const col = shift(base, v);
      const cr = col[0], cg = col[1], cb = col[2];
      for (let j = 0; j < rowH - 1; j++) {
        const f = j < 2 ? 0.72 : 1 - (j / rowH) * 0.12;  // shadow under the course above
        for (let i = 0; i < tabW - 1; i++) {
          const s = rng.next() * 18 - 9;
          t.px(Math.round(x + off + i), y + j, (cr + s) * f, (cg + s) * f, (cb + s) * f);
        }
      }
      t.vline(Math.round(x + off + tabW - 1), y, y + rowH, mulColor(base, 0.55), 0.85);
    }
    t.hline(y, 0, TEX_SIZE, [0, 0, 0], 0.36);
  }
  if (p.missing) {   // bare deck showing through
    for (let i = 0; i < p.missing; i++) {
      const x = rng.int(0, TEX_SIZE), y = Math.floor(rng.int(0, TEX_SIZE) / rowH) * rowH;
      t.rect(x, y, Math.round(tabW - 1), rowH - 1, [86, 68, 48]);
      t.rect(x, y, Math.round(tabW - 1), 2, [64, 50, 36]);
    }
  }
  return t;
}

/** Clay pantile — the church and a couple of older commercial blocks. */
export function clayTile(rng, p = {}) {
  const t = new Tex();
  const base = p.color || [148, 82, 54];
  const w = 16, h = 32;
  t.fill(mulColor(base, 0.55));
  for (let y = 0; y < TEX_SIZE; y += h) {
    for (let x = 0; x < TEX_SIZE; x += w) {
      const col = shift(base, rng.range(-20, 20));
      const cr = col[0], cg = col[1], cb = col[2];
      for (let i = 0; i < w; i++) {
        // Barrel curvature: bright ridge, dark valley.
        const c = Math.sin((i / w) * Math.PI);
        for (let j = 0; j < h - 2; j++) {
          const f = 0.62 + c * 0.58 - (j / h) * 0.12;
          t.px(x + i, y + j, cr * f, cg * f, cb * f);
        }
      }
      t.hline(y + h - 2, x, x + w, [0, 0, 0], 0.45);
      t.hline(y + h - 1, x, x + w, [0, 0, 0], 0.25);
    }
  }
  return t;
}

/** Corrugated / standing-seam metal — industrial roofs and shed walls. */
export function corrugated(rng, p = {}) {
  const t = new Tex();
  const base = p.color || [122, 126, 128];
  const pitch = p.pitch || 8;
  const F = field(20);
  for (let x = 0; x < TEX_SIZE; x++) {
    const phase = (x % pitch) / pitch;
    const f = 0.60 + 0.62 * Math.pow(Math.sin(phase * Math.PI), 0.7);
    for (let y = 0; y < TEX_SIZE; y++) {
      const n = (sampleField(F, x, y, 0, 0) - 0.5) * 26;
      t.px(x, y, (base[0] + n) * f, (base[1] + n) * f, (base[2] + n) * f);
    }
  }
  if (p.seams !== false) {
    for (let y = 0; y < TEX_SIZE; y += 64) t.hline(y, 0, TEX_SIZE, mulColor(base, 0.55), 0.8);
    for (let y = 8; y < TEX_SIZE; y += 32) {   // fastener rows
      for (let x = pitch / 2; x < TEX_SIZE; x += pitch) t.set(Math.round(x), y, mulColor(base, 0.45));
    }
  }
  return t;
}

/** Rolled/built-up flat roofing with seams and ponding. */
export function builtUpRoof(rng, p = {}) {
  const t = new Tex();
  const base = p.color || [70, 68, 64];
  t.fill(base);
  t.mottle(rng.int(0, 9999), 20, 40);
  t.speckle(rng, 1800, [shift(base, 20), shift(base, -14)], 1);
  for (let y = 0; y < TEX_SIZE; y += 32) {
    t.hline(y, 0, TEX_SIZE, mulColor(base, 1.22), 0.5);
    t.hline(y + 1, 0, TEX_SIZE, mulColor(base, 0.72), 0.6);
  }
  for (let i = 0; i < 4; i++) {   // ponded water / patch tar
    t.blob(rng.int(0, TEX_SIZE), rng.int(0, TEX_SIZE), rng.range(9, 26), mulColor(base, 0.62), rng, 0.6);
  }
  return t;
}

/** Window glass. Dark, reflective bands; optionally shattered. */
export function glass(rng, p = {}) {
  const t = new Tex();
  const base = p.color || [46, 58, 66];
  t.fill(base);
  // Diagonal sky reflection bands.
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const d = ((x + y) % TEX_SIZE) / TEX_SIZE;
      const band = Math.pow(Math.max(0, Math.sin(d * Math.PI * 2)), 6) * (p.gloss ?? 0.55);
      t.blend(x, y, p.reflect || [156, 172, 182], band);
    }
  }
  t.mottle(rng.int(0, 9999), 40, 22);
  if (p.dirty) t.streaks(rng, 12, [40, 38, 32], 0.28);
  if (p.broken) {
    // Shatter web radiating from an impact point; holes become transparent.
    const cx = rng.int(20, 108), cy = rng.int(20, 108);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + rng.range(-0.2, 0.2);
      const len = rng.range(24, 80);
      t.line(cx, cy, cx + Math.cos(a) * len, cy + Math.sin(a) * len, [214, 222, 228], 0.9);
    }
    for (let r = 10; r < 70; r += rng.int(8, 18)) {
      let prev = null;
      for (let i = 0; i <= 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const pt = [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
        if (prev) t.line(prev[0], prev[1], pt[0], pt[1], [206, 216, 222], 0.55);
        prev = pt;
      }
    }
    // Punch a hole in the middle.
    for (let y = -14; y <= 14; y++) {
      for (let x = -14; x <= 14; x++) {
        const wob = 11 * (0.6 + 0.8 * fbm(x * 0.3, y * 0.3, 2, 3, 0));
        if (Math.hypot(x, y) < wob) t.alpha(cx + x, cy + y, 0);
      }
    }
  }
  return t;
}

/** Chain-link fence — alpha-tested diamond mesh. */
export function chainlink(rng, p = {}) {
  const t = new Tex();
  const wire = p.color || [138, 142, 146];
  t.fill([0, 0, 0], 0);
  const cell = 16;
  for (let k = -TEX_SIZE; k < TEX_SIZE * 2; k += cell) {
    for (let i = 0; i < TEX_SIZE; i++) {
      const y1 = i, x1 = k + i;
      const y2 = i, x2 = k - i + TEX_SIZE;
      t.set(x1, y1, wire, 255);
      t.set(x1 + 1, y1, mulColor(wire, 0.7), 255);
      t.set(x2, y2, wire, 255);
      t.set(x2 + 1, y2, mulColor(wire, 0.7), 255);
    }
  }
  if (p.rust) {
    for (let i = 0; i < 200; i++) {
      const x = rng.int(0, TEX_SIZE), y = rng.int(0, TEX_SIZE);
      if (t.data[t.idx(x, y) + 3] > 0) t.set(x, y, [126, 74, 42], 255);
    }
  }
  return t;
}

/** Foliage card — hedges, weeds, ivy. Alpha tested. */
export function foliage(rng, p = {}) {
  const t = new Tex();
  const base = p.color || [58, 76, 42];
  t.fill([0, 0, 0], 0);
  const blades = p.blades || 90;
  for (let i = 0; i < blades; i++) {
    const x0 = rng.range(0, TEX_SIZE);
    const h = rng.range(0.35, 0.98) * TEX_SIZE;
    const lean = rng.range(-16, 16);
    const col = shift(base, rng.range(-26, 30));
    const w = rng.chance(0.3) ? 2 : 1;
    for (let y = 0; y < h; y++) {
      const tt = y / h;
      const x = x0 + lean * tt * tt;
      const c = mulColor(col, 0.62 + 0.5 * tt);
      for (let k = 0; k < w; k++) t.set(Math.round(x) + k, TEX_SIZE - 1 - y, c, 255);
    }
  }
  if (p.leaves) {
    for (let i = 0; i < p.leaves; i++) {
      t.blob(rng.int(0, TEX_SIZE), rng.int(0, TEX_SIZE * 0.8), rng.range(2, 5),
        shift(base, rng.range(-20, 24)), rng, 1);
    }
    // Restore hard alpha where leaves were painted.
    for (let i = 0; i < t.data.length; i += 4) {
      if (t.data[i] + t.data[i + 1] + t.data[i + 2] > 24) t.data[i + 3] = 255;
    }
  }
  return t;
}

/** Ground cover: soil, gravel, dead grass, mud. */
export function ground(rng, p = {}) {
  const t = new Tex();
  const base = p.color || [72, 68, 52];
  t.fill(base);
  t.mottle(rng.int(0, 9999), 16, 46);
  t.mottle(rng.int(0, 9999), 44, 40);
  if (p.gravel) t.speckle(rng, 2600, [shift(base, 40), shift(base, 26), shift(base, -22)], 2);
  if (p.grass) {
    for (let i = 0; i < 3000; i++) {
      const x = rng.int(0, TEX_SIZE), y = rng.int(0, TEX_SIZE);
      t.set(x, y, shift(p.grassColor || [78, 88, 50], rng.range(-24, 24)));
      if (rng.chance(0.5)) t.set(x, y + 1, shift(p.grassColor || [70, 80, 46], rng.range(-20, 20)));
    }
  }
  t.grain(rng, 20);
  return t;
}

/** Interior floors: hardwood, lino tile, carpet, ceramic. */
export function floorWood(rng, p = {}) {
  const t = new Tex();
  const base = p.color || [116, 84, 54];
  const plankH = 16;
  const F = field(30);
  for (let r = 0; r < TEX_SIZE / plankH; r++) {
    const y = r * plankH;
    const off = (r % 2) * 32 + rng.int(0, 3) * 8;
    for (let x = -64; x < TEX_SIZE + 64; x += 64) {
      const col = shift(base, rng.range(-22, 22));
      const cr = col[0], cg = col[1], cb = col[2];
      for (let j = 0; j < plankH - 1; j++) {
        for (let i = 0; i < 63; i++) {
          const g = (sampleField(F, (x + i) >> 2, (y + j) * 5, 0, 0) - 0.5) * 34;
          t.px(x + off + i, y + j, cr + g, cg + g, cb + g);
        }
      }
      t.vline(x + off + 63, y, y + plankH, mulColor(base, 0.5), 0.8);
    }
    t.hline(y + plankH - 1, 0, TEX_SIZE, mulColor(base, 0.48), 0.8);
  }
  t.mottle(rng.int(0, 9999), 48, 26);
  return t;
}

export function floorTile(rng, p = {}) {
  const t = new Tex();
  const a = p.color || [186, 182, 172];
  const b = p.color2 || mulColor(a, 0.72);
  const cell = p.cell || 32;
  for (let y = 0; y < TEX_SIZE; y += cell) {
    for (let x = 0; x < TEX_SIZE; x += cell) {
      const checker = ((x / cell + y / cell) % 2) === 0;
      const col = shift(checker ? a : b, rng.range(-8, 8));
      t.rect(x, y, cell, cell, col);
      t.frame(x, y, cell, cell, mulColor(col, 0.78), 1);
    }
  }
  t.mottle(rng.int(0, 9999), 34, 30);
  t.grain(rng, 12);
  return t;
}

export function carpet(rng, p = {}) {
  const t = new Tex();
  const base = p.color || [86, 66, 58];
  t.fill(base);
  for (let i = 0; i < 9000; i++) {
    t.blend(rng.int(0, TEX_SIZE), rng.int(0, TEX_SIZE), shift(base, rng.range(-26, 26)), 0.85);
  }
  t.mottle(rng.int(0, 9999), 30, 26);
  return t;
}

/** Painted interior wall / wallpaper with an optional repeating motif. */
export function wallpaper(rng, p = {}) {
  const t = new Tex();
  const base = p.color || [176, 166, 142];
  t.fill(base);
  t.mottle(rng.int(0, 9999), 40, 18);
  if (p.stripes) {
    for (let x = 0; x < TEX_SIZE; x += p.stripes) {
      t.rect(x, 0, Math.max(2, p.stripes / 2), TEX_SIZE, mulColor(base, 0.90));
    }
  }
  if (p.motif) {
    const c = mulColor(base, 0.80);
    for (let y = 8; y < TEX_SIZE; y += 32) {
      for (let x = 8 + ((y / 32) % 2) * 16; x < TEX_SIZE; x += 32) {
        t.rect(x, y + 2, 5, 1, c); t.rect(x + 2, y, 1, 5, c);
        t.set(x + 1, y + 1, c); t.set(x + 3, y + 3, c);
        t.set(x + 3, y + 1, c); t.set(x + 1, y + 3, c);
      }
    }
  }
  t.grain(rng, 10);
  return t;
}

/** Ceiling: acoustic drop tile or plaster. */
export function ceilingTile(rng, p = {}) {
  const t = new Tex();
  const base = p.color || [186, 184, 172];
  const cell = 64;
  t.fill(base);
  for (let y = 0; y < TEX_SIZE; y += cell) {
    for (let x = 0; x < TEX_SIZE; x += cell) {
      const col = shift(base, rng.range(-10, 6));
      t.rect(x + 1, y + 1, cell - 2, cell - 2, col);
      for (let i = 0; i < 220; i++) {   // acoustic pinholes
        t.blend(x + rng.int(2, cell - 2), y + rng.int(2, cell - 2), mulColor(col, 0.82), 0.7);
      }
      if (rng.chance(0.35)) t.blob(x + rng.int(8, cell - 8), y + rng.int(8, cell - 8),
        rng.range(4, 14), [140, 126, 96], rng, 0.55);   // water stain
    }
    t.hline(y, 0, TEX_SIZE, mulColor(base, 0.66), 0.9);
  }
  for (let x = 0; x < TEX_SIZE; x += cell) t.vline(x, 0, TEX_SIZE, mulColor(base, 0.66), 0.9);
  return t;
}

// --- fitted (non-tiling) textures: doors, windows, signs --------------------

/** A door leaf, drawn to fit exactly one quad. */
export function door(rng, p = {}) {
  const t = new Tex();
  const base = p.color || [104, 72, 46];
  const style = p.style || 'panel';
  t.fill(mulColor(base, 0.7));
  t.rect(4, 2, TEX_SIZE - 8, TEX_SIZE - 4, base);

  if (style === 'panel') {
    const panels = [[16, 12, 96, 40], [16, 62, 96, 54]];
    for (const [x, y, w, h] of panels) {
      t.rect(x, y, w, h, mulColor(base, 0.88));
      t.frame(x, y, w, h, mulColor(base, 1.18), 2);
      t.frame(x + 2, y + 2, w - 4, h - 4, mulColor(base, 0.66), 2);
      for (let i = 0; i < w - 8; i++) {   // grain inside the panel
        for (let j = 0; j < h - 8; j++) {
          const g = fbm(i * 0.08, j * 0.5, 2, 9, 0) - 0.5;
          t.blend(x + 4 + i, y + 4 + j, shift(base, g * 30), 0.5);
        }
      }
    }
  } else if (style === 'glass') {
    t.rect(14, 8, 100, 62, [50, 62, 68]);
    t.frame(14, 8, 100, 62, mulColor(base, 1.2), 3);
    for (let y = 8; y < 70; y++) {
      for (let x = 14; x < 114; x++) {
        const band = Math.pow(Math.max(0, Math.sin(((x + y) % 60) / 60 * Math.PI)), 5);
        t.blend(x, y, [150, 166, 176], band * 0.5);
      }
    }
    if (p.broken) {
      for (let i = 0; i < 10; i++) {
        const a = rng.next() * Math.PI * 2;
        t.line(64, 40, 64 + Math.cos(a) * 40, 40 + Math.sin(a) * 26, [200, 212, 218], 0.8);
      }
    }
  } else if (style === 'metal') {
    t.fill(p.color || [104, 108, 110]);
    t.mottle(rng.int(0, 9999), 30, 30);
    for (let y = 10; y < TEX_SIZE; y += 26) t.hline(y, 6, TEX_SIZE - 6, [0, 0, 0], 0.25);
    t.rect(10, 6, 6, TEX_SIZE - 12, mulColor(p.color || [104, 108, 110], 1.14));
    t.rect(TEX_SIZE - 16, 6, 6, TEX_SIZE - 12, mulColor(p.color || [104, 108, 110], 0.84));
  } else if (style === 'garage') {
    t.fill(p.color || [154, 150, 142]);
    for (let y = 0; y < TEX_SIZE; y += 21) {
      t.rect(0, y, TEX_SIZE, 19, shift(p.color || [154, 150, 142], rng.range(-8, 8)));
      t.hline(y + 19, 0, TEX_SIZE, [0, 0, 0], 0.4);
      t.hline(y, 0, TEX_SIZE, [255, 255, 255], 0.12);
    }
  }

  // Hardware: knob or push bar, always on the same side.
  if (style !== 'garage') {
    const hy = 66;
    t.blob(p.hingeLeft ? 16 : TEX_SIZE - 16, hy, 4, [176, 156, 92], rng, 1);
    t.blob(p.hingeLeft ? 16 : TEX_SIZE - 16, hy, 2, [220, 206, 140], rng, 1);
    // Hinges on the opposite edge.
    for (const y of [24, 100]) t.rect(p.hingeLeft ? TEX_SIZE - 8 : 3, y, 5, 12, [128, 122, 110]);
  }
  return t;
}

/**
 * A window: frame, mullions, glass, sill. Drawn to fit one quad so the
 * fenestration reads correctly from both inside and out.
 */
export function windowTex(rng, p = {}) {
  const t = new Tex();
  const frame = p.frame || [186, 182, 170];
  const g = p.glass || [44, 54, 62];
  t.fill(frame);
  t.rect(0, 0, TEX_SIZE, 8, mulColor(frame, 1.1));
  const inset = 10;
  t.rect(inset, inset, TEX_SIZE - inset * 2, TEX_SIZE - inset * 2, g);

  // Glass reflection.
  for (let y = inset; y < TEX_SIZE - inset; y++) {
    for (let x = inset; x < TEX_SIZE - inset; x++) {
      const band = Math.pow(Math.max(0, Math.sin((((x * 1.4 + y) % 90) / 90) * Math.PI)), 5);
      t.blend(x, y, p.reflect || [148, 164, 176], band * (p.gloss ?? 0.5));
    }
  }
  // Interior hint: a warm rectangle where a room would be, deep in the glass.
  if (p.litRoom) t.rectBlend(inset + 8, TEX_SIZE - inset - 34, TEX_SIZE - inset * 2 - 16, 26, [122, 96, 56], 0.35);

  // Mullions.
  const bar = mulColor(frame, 0.94);
  const cols = p.cols ?? 2, rows = p.rows ?? 2;
  for (let i = 1; i < cols; i++) t.rect(inset + Math.round((TEX_SIZE - inset * 2) * i / cols) - 2, inset, 4, TEX_SIZE - inset * 2, bar);
  for (let j = 1; j < rows; j++) t.rect(inset, inset + Math.round((TEX_SIZE - inset * 2) * j / rows) - 2, TEX_SIZE - inset * 2, 4, bar);
  t.frame(inset - 2, inset - 2, TEX_SIZE - inset * 2 + 4, TEX_SIZE - inset * 2 + 4, mulColor(frame, 0.7), 2);

  if (p.broken) {
    const cx = rng.int(30, 98), cy = rng.int(30, 98);
    for (let i = 0; i < 14; i++) {
      const a = rng.next() * Math.PI * 2;
      t.line(cx, cy, cx + Math.cos(a) * rng.range(18, 50), cy + Math.sin(a) * rng.range(18, 50), [204, 214, 220], 0.85);
    }
    for (let y = -13; y <= 13; y++) {
      for (let x = -13; x <= 13; x++) {
        const wob = 10 * (0.6 + 0.9 * fbm(x * 0.3, y * 0.3, 2, 3, 0));
        if (Math.hypot(x, y) < wob) {
          const px = cx + x, py = cy + y;
          if (px > inset && px < TEX_SIZE - inset && py > inset && py < TEX_SIZE - inset) t.set(px, py, [8, 8, 10]);
        }
      }
    }
  }
  if (p.boarded) {
    for (let i = 0; i < 4; i++) {
      const y = 14 + i * 28 + rng.int(-4, 4);
      const h = rng.int(16, 24);
      const col = shift([124, 96, 62], rng.range(-16, 16));
      for (let x = -8; x < TEX_SIZE + 8; x++) {
        const yy = y + Math.round(Math.sin(i * 2.1) * 3 * (x / TEX_SIZE));
        for (let k = 0; k < h; k++) {
          const gg = fbm(x * 0.07, (yy + k) * 0.5, 2, 31, 0) - 0.5;
          t.set(x, yy + k, shift(col, gg * 30));
        }
        t.blend(x, yy, [0, 0, 0], 0.35);
        t.blend(x, yy + h - 1, [0, 0, 0], 0.4);
      }
      for (const nx of [12, TEX_SIZE - 14]) t.rect(nx, y + Math.floor(h / 2) - 1, 2, 2, [70, 66, 60]);
    }
  }
  if (p.curtain) {
    const cc = p.curtainColor || [148, 132, 108];
    for (let x = inset; x < TEX_SIZE - inset; x++) {
      const fold = 0.72 + 0.4 * Math.abs(Math.sin(x * 0.35));
      for (let y = inset; y < inset + (p.curtainDrop || 44); y++) t.set(x, y, mulColor(cc, fold));
    }
  }
  return t;
}

/** Flat painted trim / fascia / corner board. */
export function paint(rng, p = {}) {
  const t = new Tex();
  const base = p.color || [206, 202, 190];
  t.fill(base);
  t.mottle(rng.int(0, 9999), 34, 20);
  if (p.wood) {
    for (let y = 0; y < TEX_SIZE; y++) {
      for (let x = 0; x < TEX_SIZE; x++) {
        const g = fbm(x * 0.05, y * 0.4, 3, 55, 0) - 0.5;
        t.blend(x, y, shift(base, g * 40), 0.4);
      }
    }
  }
  t.grain(rng, 8);
  return t;
}

/** Painted metal (vehicles, HVAC, lockers, dumpsters). */
export function paintedMetal(rng, p = {}) {
  const t = new Tex();
  const base = p.color || [128, 132, 136];
  t.fill(base);
  t.mottle(rng.int(0, 9999), 28, 26);
  if (p.panelLines) {
    for (let y = 0; y < TEX_SIZE; y += 32) t.hline(y, 0, TEX_SIZE, mulColor(base, 0.72), 0.7);
    for (let x = 0; x < TEX_SIZE; x += 64) t.vline(x, 0, TEX_SIZE, mulColor(base, 0.72), 0.7);
  }
  t.grain(rng, 10);
  return t;
}

/** Signage / posters / notices — pure readable graphic shapes. */
export function signTex(rng, p = {}) {
  const t = new Tex();
  const bg = p.bg || [188, 178, 150];
  const ink = p.ink || [40, 36, 34];
  t.fill(bg);
  if (p.border) t.frame(4, 4, TEX_SIZE - 8, TEX_SIZE - 8, ink, 3);
  // Abstract "lettering" — blocks at text scale, unreadable but convincing.
  const lines = p.lines || 3;
  for (let l = 0; l < lines; l++) {
    const y = Math.round(((l + 0.6) / (lines + 0.4)) * TEX_SIZE) - 6;
    const h = l === 0 ? 16 : 8;
    let x = rng.int(12, 26);
    const end = TEX_SIZE - rng.int(12, 30);
    while (x < end) {
      const w = rng.int(4, l === 0 ? 16 : 10);
      if (x + w > end) break;
      t.rect(x, y, w, h, ink);
      x += w + rng.int(3, 6);
    }
  }
  if (p.symbol === 'cross') {
    t.rect(52, 26, 24, 76, [176, 34, 30]);
    t.rect(28, 52, 72, 24, [176, 34, 30]);
  } else if (p.symbol === 'arrow') {
    for (let i = 0; i < 30; i++) t.rect(64 - i, 64 - i, 2 * i, 4, ink);
  } else if (p.symbol === 'hazard') {
    for (let i = -TEX_SIZE; i < TEX_SIZE * 2; i += 24) {
      for (let y = 0; y < TEX_SIZE; y++) t.rect(i + y, y, 12, 1, [26, 24, 22]);
    }
  }
  t.mottle(rng.int(0, 9999), 40, 22);
  return t;
}

/** Blood decal / splatter — alpha, used on floors and walls. */
export function bloodTex(rng, p = {}) {
  const t = new Tex();
  t.fill([0, 0, 0], 0);
  const c = p.color || [96, 14, 12];
  const cx = 64, cy = 64;
  t.blob(cx, cy, p.radius || 30, c, rng, 1);
  for (let i = 0; i < 22; i++) {
    const a = rng.next() * Math.PI * 2, d = rng.range(20, 60);
    t.blob(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rng.range(1.5, 7), c, rng, 1);
  }
  for (let i = 0; i < t.data.length; i += 4) {
    if (t.data[i] + t.data[i + 1] + t.data[i + 2] > 10) {
      t.data[i + 3] = 255;
      const f = 0.72 + rng.next() * 0.5;
      t.data[i] *= f; t.data[i + 1] *= f; t.data[i + 2] *= f;
    }
  }
  return t;
}

/** Road markings — a single alpha strip stretched along a lane. */
export function markingTex(rng, p = {}) {
  const t = new Tex();
  t.fill([0, 0, 0], 0);
  const c = p.color || [196, 190, 150];
  if (p.style === 'dash') {
    t.rect(0, 46, TEX_SIZE, 34, c);
    for (let i = 0; i < 700; i++) t.alpha(rng.int(0, TEX_SIZE), rng.int(46, 80), 0);
  } else if (p.style === 'solid') {
    t.rect(0, 50, TEX_SIZE, 28, c);
    for (let i = 0; i < 500; i++) t.alpha(rng.int(0, TEX_SIZE), rng.int(50, 78), 0);
  } else if (p.style === 'crosswalk') {
    for (let i = 0; i < 4; i++) t.rect(i * 32 + 6, 0, 20, TEX_SIZE, c);
    for (let i = 0; i < 2200; i++) t.alpha(rng.int(0, TEX_SIZE), rng.int(0, TEX_SIZE), 0);
  } else if (p.style === 'stop') {
    t.rect(0, 20, TEX_SIZE, 88, c);
    for (let i = 0; i < 1400; i++) t.alpha(rng.int(0, TEX_SIZE), rng.int(20, 108), 0);
  }
  return t;
}

/** Flat colour with grain — fallback / gore / debris. */
export function solid(rng, p = {}) {
  const t = new Tex();
  t.fill(p.color || [128, 128, 128]);
  t.mottle(rng.int(0, 9999), 32, p.mottle ?? 22);
  t.grain(rng, p.grain ?? 12);
  return t;
}

/** Skin / cloth for the infected, with grime and lividity. */
export function fleshTex(rng, p = {}) {
  const t = new Tex();
  const base = p.color || [140, 132, 116];
  t.fill(base);
  t.mottle(rng.int(0, 9999), 22, 46, p.tint || [86, 92, 78]);
  t.mottle(rng.int(0, 9999), 48, 34);
  for (let i = 0; i < (p.wounds ?? 14); i++) {
    t.blob(rng.int(0, TEX_SIZE), rng.int(0, TEX_SIZE), rng.range(2, 7), [96, 30, 26], rng, rng.range(0.4, 0.9));
  }
  t.grain(rng, 16);
  return t;
}
