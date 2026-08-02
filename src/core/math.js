// ---------------------------------------------------------------------------
// math.js — scalars, seeded RNG, noise, mat4, and 2D polygon surgery.
//
// Everything the world generator needs to be deterministic lives here. The
// whole town is rebuilt identically from a single integer seed, which is what
// makes the layout tunable instead of merely random.
// ---------------------------------------------------------------------------

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
export const sign = Math.sign;

/** Shortest signed angular difference b-a, wrapped to [-PI, PI]. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/**
 * Where the bearing `ang` sits relative to a camera looking along `viewYaw`,
 * in the screen's sense: POSITIVE is to the player's right, in radians.
 *
 * This is the negation of angleDelta and that is the whole point. Yaw grows
 * from +Z toward +X, but the camera basis puts screen-right at (-cos yaw,
 * sin yaw) — see mat4View — so a bearing at a *larger* yaw than the player's
 * is on their LEFT. Anything that turns a world bearing into a left/right cue
 * (compass, damage arrows, stereo pan) goes through here rather than
 * re-deriving the sign and getting it backwards.
 */
export function bearingRight(viewYaw, ang) { return -angleDelta(viewYaw, ang); }

/**
 * Screen-right in world terms for a camera at `yaw`, on the ground plane.
 * Matches the `right` basis vector mat4View builds. Returns {x, z}.
 */
export function rightOfYaw(yaw) { return { x: -Math.cos(yaw), z: Math.sin(yaw) }; }

/** Frame-rate independent exponential approach. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

// --- seeded RNG ------------------------------------------------------------

/** mulberry32 — small, fast, good enough for level generation. */
export class RNG {
  constructor(seed = 1) { this.s = (seed >>> 0) || 1; }
  /** [0,1) */
  next() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  chance(p) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  /** Weighted pick: entries are [value, weight]. */
  weighted(entries) {
    let total = 0;
    for (const e of entries) total += e[1];
    let r = this.next() * total;
    for (const e of entries) { r -= e[1]; if (r <= 0) return e[0]; }
    return entries[entries.length - 1][0];
  }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  /** Gaussian-ish via sum of uniforms — cheap, bounded, no tails to clamp. */
  gauss() { return (this.next() + this.next() + this.next() - 1.5) / 1.5; }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  fork(salt = 0) { return new RNG((this.s ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0); }
}

/** Deterministic hash → [0,1). Used for per-texel / per-instance jitter. */
export function hash2(x, y, seed = 0) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Bilinear value noise. Cheap, tileable when period is supplied. */
export function valueNoise(x, y, seed = 0, period = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const w = (t) => t * t * (3 - 2 * t);
  const u = w(xf), v = w(yf);
  const wrap = (n) => (period ? ((n % period) + period) % period : n);
  const a = hash2(wrap(xi), wrap(yi), seed);
  const b = hash2(wrap(xi + 1), wrap(yi), seed);
  const c = hash2(wrap(xi), wrap(yi + 1), seed);
  const d = hash2(wrap(xi + 1), wrap(yi + 1), seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/** Fractal value noise. `period` keeps it seamless for tiling textures. */
export function fbm(x, y, octaves = 4, seed = 0, period = 0) {
  let sum = 0, amp = 0.5, norm = 0, freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + i * 131, period * freq);
    norm += amp;
    amp *= 0.5; freq *= 2;
  }
  return sum / norm;
}

// --- vectors ---------------------------------------------------------------

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const v3copy = (a) => ({ x: a.x, y: a.y, z: a.z });
export const v3len = (a) => Math.hypot(a.x, a.y, a.z);
export function v3norm(a) {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}
export const v3dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const v3sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const v3add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const v3scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export function v3cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
export const dist2D = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

// --- mat4 (column-major, WebGL layout) -------------------------------------

export function mat4() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function mat4Identity(out) {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

export function mat4Mul(out, a, b) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
    out[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  }
  return out;
}

export function mat4Perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

/**
 * Camera view matrix from position + yaw/pitch/roll (radians).
 *
 * Convention, shared with the AI and movement code: yaw 0 looks along +Z, and
 * forward = (sin yaw · cos pitch, sin pitch, cos yaw · cos pitch). The basis is
 * built the gluLookAt way — right = forward × up, up = right × forward, back =
 * −forward — so it is genuinely right-handed and the image is not mirrored.
 * Note that with +Z forward and +Y up, screen-right is world −X at yaw 0.
 */
export function mat4View(out, pos, yaw, pitch, roll = 0) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const fx = sy * cp, fy = sp, fz = cy * cp;
  // right = forward × worldUp, normalised in the horizontal plane
  let rx = -fz, rz = fx;
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl; rz /= rl;
  let ry = 0;
  // up = right × forward
  let ux = ry * fz - rz * fy;
  let uy = rz * fx - rx * fz;
  let uz = rx * fy - ry * fx;
  let bx = -fx, by = -fy, bz = -fz;
  if (roll !== 0) {
    const nrx = rx * cr + ux * sr, nry = ry * cr + uy * sr, nrz = rz * cr + uz * sr;
    const nux = ux * cr - rx * sr, nuy = uy * cr - ry * sr, nuz = uz * cr - rz * sr;
    rx = nrx; ry = nry; rz = nrz; ux = nux; uy = nuy; uz = nuz;
  }
  out[0] = rx; out[4] = ry; out[8] = rz; out[12] = -(rx * pos.x + ry * pos.y + rz * pos.z);
  out[1] = ux; out[5] = uy; out[9] = uz; out[13] = -(ux * pos.x + uy * pos.y + uz * pos.z);
  out[2] = bx; out[6] = by; out[10] = bz; out[14] = -(bx * pos.x + by * pos.y + bz * pos.z);
  out[3] = 0; out[7] = 0; out[11] = 0; out[15] = 1;
  return out;
}

/** Model matrix from translation, Y-rotation and uniform-ish scale. */
export function mat4TRS(out, tx, ty, tz, yaw, sx = 1, sy = 1, sz = 1) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  out[0] = c * sx; out[1] = 0; out[2] = -s * sx; out[3] = 0;
  out[4] = 0; out[5] = sy; out[6] = 0; out[7] = 0;
  out[8] = s * sz; out[9] = 0; out[10] = c * sz; out[11] = 0;
  out[12] = tx; out[13] = ty; out[14] = tz; out[15] = 1;
  return out;
}

/** Extract the 6 frustum planes from a view-projection matrix (world space). */
export function frustumFromMatrix(m, out) {
  const p = out || new Float32Array(24);
  const rows = [
    [m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]],   // left
    [m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]],   // right
    [m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]],   // bottom
    [m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]],   // top
    [m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]],  // near
    [m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]],  // far
  ];
  for (let i = 0; i < 6; i++) {
    const r = rows[i];
    const inv = 1 / (Math.hypot(r[0], r[1], r[2]) || 1);
    p[i * 4] = r[0] * inv; p[i * 4 + 1] = r[1] * inv;
    p[i * 4 + 2] = r[2] * inv; p[i * 4 + 3] = r[3] * inv;
  }
  return p;
}

export function aabbInFrustum(planes, min, max) {
  for (let i = 0; i < 6; i++) {
    const a = planes[i * 4], b = planes[i * 4 + 1], c = planes[i * 4 + 2], d = planes[i * 4 + 3];
    const px = a >= 0 ? max[0] : min[0];
    const py = b >= 0 ? max[1] : min[1];
    const pz = c >= 0 ? max[2] : min[2];
    if (a * px + b * py + c * pz + d < 0) return false;
  }
  return true;
}

// --- 2D polygon utilities --------------------------------------------------
// Points are {x, z} — the ground plane. Y is up everywhere else in the codebase.

export function polyArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}

export function polyCentroid(poly) {
  let cx = 0, cz = 0, a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    const f = p.x * q.z - q.x * p.z;
    a += f; cx += (p.x + q.x) * f; cz += (p.z + q.z) * f;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-9) {
    cx = 0; cz = 0;
    for (const p of poly) { cx += p.x; cz += p.z; }
    return { x: cx / poly.length, z: cz / poly.length };
  }
  return { x: cx / (6 * a), z: cz / (6 * a) };
}

export function polyPerimeter(poly) {
  let s = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    s += Math.hypot(q.x - p.x, q.z - p.z);
  }
  return s;
}

export function ensureCCW(poly) {
  return polyArea(poly) < 0 ? poly.slice().reverse() : poly;
}

export function pointInPoly(poly, x, z) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) &&
        x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Distance from point to segment, plus the closest point. */
export function distPointSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 1e-12 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = clamp01(t);
  const cx = ax + dx * t, cz = az + dz * t;
  return { dist: Math.hypot(px - cx, pz - cz), t, x: cx, z: cz };
}

export function distPointPolyEdges(poly, x, z) {
  let best = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const d = distPointSeg(x, z, a.x, a.z, b.x, b.z).dist;
    if (d < best) best = d;
  }
  return best;
}

/** Segment/segment intersection. Returns {x,z,t,u} or null. */
export function segIntersect(ax, az, bx, bz, cx, cz, dx, dz, eps = 1e-9) {
  const r1 = bx - ax, r2 = bz - az;
  const s1 = dx - cx, s2 = dz - cz;
  const denom = r1 * s2 - r2 * s1;
  if (Math.abs(denom) < eps) return null;
  const t = ((cx - ax) * s2 - (cz - az) * s1) / denom;
  const u = ((cx - ax) * r2 - (cz - az) * r1) / denom;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return { x: ax + r1 * t, z: az + r2 * t, t, u };
}

/**
 * Inset a polygon by a uniform distance (positive = shrink for CCW input).
 * Offsets each edge line and re-intersects neighbours; returns null when the
 * shape collapses, which callers treat as "this lot is too small to build on".
 */
export function polyInset(poly, d) {
  const n = poly.length;
  if (n < 3) return null;
  const ccw = ensureCCW(poly);
  const lines = [];
  for (let i = 0; i < n; i++) {
    const a = ccw[i], b = ccw[(i + 1) % n];
    const ex = b.x - a.x, ez = b.z - a.z;
    const len = Math.hypot(ex, ez);
    if (len < 1e-6) continue;
    // Inward normal. With this file's CCW convention (positive polyArea),
    // (ez,-ex) points OUT of the polygon, so the inward normal is (-ez,ex).
    const nx = -ez / len, nz = ex / len;
    lines.push({ px: a.x + nx * d, pz: a.z + nz * d, dx: ex / len, dz: ez / len });
  }
  if (lines.length < 3) return null;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l1 = lines[i], l2 = lines[(i + 1) % lines.length];
    const denom = l1.dx * l2.dz - l1.dz * l2.dx;
    if (Math.abs(denom) < 1e-6) { out.push({ x: l2.px, z: l2.pz }); continue; }
    const t = ((l2.px - l1.px) * l2.dz - (l2.pz - l1.pz) * l2.dx) / denom;
    out.push({ x: l1.px + l1.dx * t, z: l1.pz + l1.dz * t });
  }
  if (out.length < 3) return null;
  const area = polyArea(out);
  if (area <= 0.5) return null;
  // Reject shapes that folded through themselves during the offset.
  const per = polyPerimeter(out);
  if (per > polyPerimeter(poly) * 1.6) return null;
  return out;
}

/**
 * Inset with a different distance per edge. Streets have different widths, so
 * a block's curb line is not a uniform offset of its centreline loop.
 * `dists[i]` applies to the edge from poly[i] to poly[i+1].
 */
export function polyInsetVar(poly, dists) {
  const n = poly.length;
  if (n < 3) return null;
  const lines = [];
  const idxMap = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const ex = b.x - a.x, ez = b.z - a.z;
    const len = Math.hypot(ex, ez);
    if (len < 1e-6) continue;
    const nx = -ez / len, nz = ex / len;   // inward, see polyInset
    const d = dists[i];
    lines.push({ px: a.x + nx * d, pz: a.z + nz * d, dx: ex / len, dz: ez / len });
    idxMap.push(i);
  }
  if (lines.length < 3) return null;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l1 = lines[i], l2 = lines[(i + 1) % lines.length];
    const denom = l1.dx * l2.dz - l1.dz * l2.dx;
    if (Math.abs(denom) < 1e-6) { out.push({ x: l2.px, z: l2.pz, src: idxMap[i] }); continue; }
    const t = ((l2.px - l1.px) * l2.dz - (l2.pz - l1.pz) * l2.dx) / denom;
    out.push({ x: l1.px + l1.dx * t, z: l1.pz + l1.dz * t, src: idxMap[i] });
  }
  if (out.length < 3 || polyArea(out) <= 0.5) return null;
  if (polyPerimeter(out) > polyPerimeter(poly) * 1.7) return null;
  return out;
}

/** Clip a polygon against the half-plane on the "left" of a directed line. */
export function clipPolyHalfplane(poly, px, pz, dx, dz) {
  const out = [];
  const side = (p) => (p.x - px) * dz - (p.z - pz) * dx;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const sa = side(a), sb = side(b);
    if (sa <= 0) out.push(a);
    if ((sa < 0 && sb > 0) || (sa > 0 && sb < 0)) {
      const t = sa / (sa - sb);
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out.length >= 3 ? out : null;
}

/** Split a polygon by an infinite line into [left, right] (either may be null). */
export function splitPoly(poly, px, pz, dx, dz) {
  const left = clipPolyHalfplane(poly, px, pz, dx, dz);
  const right = clipPolyHalfplane(poly, px, pz, -dx, -dz);
  return [left, right];
}

/**
 * Minimum-area oriented bounding rect. Tries every edge direction, which is
 * exact for convex hulls and plenty good for the near-convex lots we produce.
 */
export function minAreaRect(poly) {
  let best = null;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const ex = b.x - a.x, ez = b.z - a.z;
    const len = Math.hypot(ex, ez);
    if (len < 1e-6) continue;
    const ux = ex / len, uz = ez / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of poly) {
      const u = p.x * ux + p.z * uz;
      const v = -p.x * uz + p.z * ux;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    const w = maxU - minU, h = maxV - minV;
    const area = w * h;
    if (!best || area < best.area) {
      best = {
        area, ux, uz, minU, maxU, minV, maxV, w, h,
        cx: ((minU + maxU) / 2) * ux - ((minV + maxV) / 2) * uz,
        cz: ((minU + maxU) / 2) * uz + ((minV + maxV) / 2) * ux,
      };
    }
  }
  return best;
}

/** Resample a polyline so vertices sit roughly `step` apart. */
export function resamplePolyline(pts, step) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    let t = step - carry;
    while (t < seg) {
      out.push({ x: lerp(a.x, b.x, t / seg), z: lerp(a.z, b.z, t / seg) });
      t += step;
    }
    carry = seg - (t - step);
  }
  const last = pts[pts.length - 1];
  const prev = out[out.length - 1];
  if (Math.hypot(last.x - prev.x, last.z - prev.z) > step * 0.35) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

/** Centripetal Catmull-Rom through control points — used for curved streets. */
export function catmullRom(points, samplesPerSpan = 6) {
  if (points.length < 3) return points.slice();
  const out = [];
  const pt = (i) => points[clamp(i, 0, points.length - 1)];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = pt(i - 1), p1 = pt(i), p2 = pt(i + 1), p3 = pt(i + 2);
    for (let s = 0; s < samplesPerSpan; s++) {
      const t = s / samplesPerSpan, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        z: 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t +
          (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 +
          (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
      });
    }
  }
  out.push(points[points.length - 1]);
  return out;
}
