// ---------------------------------------------------------------------------
// meshbuilder.js — accumulates PS1-style geometry.
//
// Design notes:
//  * Vertex light is baked at emit time through a pluggable probe, exactly as
//    PS1/N64-era tools did. Nothing is lit per-pixel except the flashlight.
//  * Quads are tessellated to a maximum edge length. Real PS1 games subdivided
//    large polygons for precisely this reason: it keeps vertex lighting from
//    turning walls into gradients and keeps affine warping believable rather
//    than catastrophic.
//  * A transform stack lets props be authored in convenient local space.
//
// Materials are `{ layer, tile, fit, uvOff, rot }`:
//    layer  – index into the texture array
//    tile   – metres per texture repeat (default 2)
//    fit    – stretch the texture exactly once across the face
//    uvOff  – [u,v] offset applied after scaling
//    rot    – 1 to swap u/v (rotate the texture 90 degrees)
// ---------------------------------------------------------------------------

import { VERTEX_FLOATS } from './gl.js';

const DEFAULT_TILE = 2;

export function mat(layer, tile = DEFAULT_TILE, extra) {
  return Object.assign({ layer, tile }, extra);
}

export class MeshBuilder {
  constructor(opts = {}) {
    this.verts = [];
    this.indices = [];
    this.vertCount = 0;
    this.maxEdge = opts.maxEdge ?? 2.2;
    this.probe = opts.probe || (() => [1, 1, 1]);
    this.stack = [];
    this.tx = 0; this.ty = 0; this.tz = 0;
    this.cy = 1; this.sy = 0;      // cos/sin of the current yaw
    this.tint = null;              // multiply baked light, e.g. for decay
  }

  // --- transform stack -----------------------------------------------------
  push(x = 0, y = 0, z = 0, yaw = 0) {
    this.stack.push([this.tx, this.ty, this.tz, this.cy, this.sy]);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    // Compose: new = parent ∘ local
    const ncy = this.cy * c - this.sy * s;
    const nsy = this.sy * c + this.cy * s;
    const wx = this.tx + x * this.cy + z * this.sy;
    const wz = this.tz - x * this.sy + z * this.cy;
    this.tx = wx; this.ty = this.ty + y; this.tz = wz;
    this.cy = ncy; this.sy = nsy;
    return this;
  }

  pop() {
    const s = this.stack.pop();
    if (s) { this.tx = s[0]; this.ty = s[1]; this.tz = s[2]; this.cy = s[3]; this.sy = s[4]; }
    return this;
  }

  _wx(x, z) { return this.tx + x * this.cy + z * this.sy; }
  _wz(x, z) { return this.tz - x * this.sy + z * this.cy; }

  /** Convert a point from the current local frame into world space. */
  worldPoint(x, y, z) {
    return { x: this._wx(x, z), y: this.ty + y, z: this._wz(x, z) };
  }

  /** Current yaw of the transform stack, for orienting world-space data. */
  get worldYaw() { return Math.atan2(this.sy, this.cy); }

  // --- primitives ----------------------------------------------------------

  /** Emit one vertex in local space; returns its index. */
  vertex(x, y, z, u, v, layer, nx, ny, nz, lightOverride) {
    const wx = this._wx(x, z);
    const wy = this.ty + y;
    const wz = this._wz(x, z);
    const wnx = nx * this.cy + nz * this.sy;
    const wnz = -nx * this.sy + nz * this.cy;
    let l = lightOverride || this.probe(wx, wy, wz, wnx, ny, wnz);
    if (this.tint) l = [l[0] * this.tint[0], l[1] * this.tint[1], l[2] * this.tint[2]];
    this.verts.push(wx, wy, wz, u, v, layer, l[0], l[1], l[2], wnx, ny, wnz);
    return this.vertCount++;
  }

  tri(a, b, c) { this.indices.push(a, b, c); }

  /**
   * A tessellated quad. Corners must be given counter-clockwise when viewed
   * from the front. `uv` is [u0,v0,u1,v1] in texture space for the whole quad.
   */
  quad(p0, p1, p2, p3, uv, layer, normal, opts = {}) {
    const maxEdge = opts.maxEdge ?? this.maxEdge;
    const lenA = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
    const lenB = Math.hypot(p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]);
    const nu = opts.noTess ? 1 : Math.max(1, Math.min(10, Math.ceil(lenA / maxEdge)));
    const nv = opts.noTess ? 1 : Math.max(1, Math.min(10, Math.ceil(lenB / maxEdge)));
    const [nx, ny, nz] = normal;
    const base = this.vertCount;
    const light = opts.light;

    for (let j = 0; j <= nv; j++) {
      const tv = j / nv;
      for (let i = 0; i <= nu; i++) {
        const tu = i / nu;
        // Bilinear across the quad: p0->p1 is u, p0->p3 is v.
        const ax = p0[0] + (p1[0] - p0[0]) * tu, ay = p0[1] + (p1[1] - p0[1]) * tu, az = p0[2] + (p1[2] - p0[2]) * tu;
        const bx = p3[0] + (p2[0] - p3[0]) * tu, by = p3[1] + (p2[1] - p3[1]) * tu, bz = p3[2] + (p2[2] - p3[2]) * tu;
        const x = ax + (bx - ax) * tv, y = ay + (by - ay) * tv, z = az + (bz - az) * tv;
        const u = uv[0] + (uv[2] - uv[0]) * tu;
        const v = uv[1] + (uv[3] - uv[1]) * tv;
        this.vertex(x, y, z, u, v, layer, nx, ny, nz, light);
      }
    }
    const row = nu + 1;
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = base + j * row + i, b = a + 1, c = a + row, d = c + 1;
        this.indices.push(a, b, d, a, d, c);
      }
    }
    return this;
  }

  /** Convenience: a quad whose UVs come from a material and its world size. */
  quadMat(p0, p1, p2, p3, material, normal, opts = {}) {
    const m = material;
    const wU = opts.spanU ?? Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
    const wV = opts.spanV ?? Math.hypot(p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]);
    const tile = m.tile ?? DEFAULT_TILE;
    let u0 = 0, v0 = 0, u1 = m.fit ? 1 : wU / tile, v1 = m.fit ? 1 : wV / tile;
    if (m.uvOff) { u0 += m.uvOff[0]; u1 += m.uvOff[0]; v0 += m.uvOff[1]; v1 += m.uvOff[1]; }
    if (opts.uvShift) { u0 += opts.uvShift[0]; u1 += opts.uvShift[0]; v0 += opts.uvShift[1]; v1 += opts.uvShift[1]; }
    if (m.flipV) { const t = v0; v0 = v1; v1 = t; }
    const uv = m.rot ? [v0, u0, v1, u1] : [u0, v0, u1, v1];
    return this.quad(p0, p1, p2, p3, uv, m.layer, normal, opts);
  }

  /**
   * Axis-aligned box in local space, from (x0,y0,z0) to (x1,y1,z1).
   * `mats` is a single material or `{ side, top, bottom, px, nx, pz, nz }`.
   * Faces listed in `opts.skip` (e.g. 'bottom') are omitted.
   */
  box(x0, y0, z0, x1, y1, z1, mats, opts = {}) {
    const M = (k, fallback) => (mats.layer !== undefined ? mats : (mats[k] || mats[fallback] || mats.side || mats.all));
    const skip = opts.skip || '';
    const o = { maxEdge: opts.maxEdge, noTess: opts.noTess, light: opts.light };
    const vShift = opts.vAlign ? [0, y0 / ((M('side') || {}).tile ?? DEFAULT_TILE)] : null;
    const q = (a, b, c, d, m, n) => {
      if (!m) return;
      this.quadMat(a, b, c, d, m, n, Object.assign({}, o, vShift ? { uvShift: vShift } : null));
    };
    // +Z / -Z
    if (!skip.includes('pz')) q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], M('pz', 'side'), [0, 0, 1]);
    if (!skip.includes('nz')) q([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], M('nz', 'side'), [0, 0, -1]);
    // +X / -X
    if (!skip.includes('px')) q([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], M('px', 'side'), [1, 0, 0]);
    if (!skip.includes('nx')) q([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], M('nx', 'side'), [-1, 0, 0]);
    // +Y / -Y
    if (!skip.includes('top')) q([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], M('top', 'side'), [0, 1, 0]);
    if (!skip.includes('bottom')) q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], M('bottom', 'side'), [0, -1, 0]);
    return this;
  }

  /** Centre/size flavour of `box` — how most props are authored. */
  boxC(cx, cy, cz, sx, sy, sz, mats, opts) {
    return this.box(cx - sx / 2, cy, cz - sz / 2, cx + sx / 2, cy + sy, cz + sz / 2, mats, opts);
  }

  /**
   * A horizontal polygon at height y (fan-free ear clipping so concave block
   * shapes work). `up` false emits a downward-facing ceiling.
   */
  polyFlat(poly, y, material, up = true, opts = {}) {
    const tris = triangulate(poly);
    const tile = material.tile ?? DEFAULT_TILE;
    const n = up ? [0, 1, 0] : [0, -1, 0];
    const idx = new Map();
    const vid = (p) => {
      const key = `${p.x.toFixed(3)},${p.z.toFixed(3)}`;
      let i = idx.get(key);
      if (i === undefined) {
        const u = (p.x + (opts.uOff || 0)) / tile;
        const v = (p.z + (opts.vOff || 0)) / tile;
        i = this.vertex(p.x, y, p.z, u, v, material.layer, n[0], n[1], n[2], opts.light);
        idx.set(key, i);
      }
      return i;
    };
    for (const t of tris) {
      const a = vid(t[0]), b = vid(t[1]), c = vid(t[2]);
      if (up) this.tri(a, c, b); else this.tri(a, b, c);
    }
    return this;
  }

  /**
   * Tessellated horizontal polygon — used for large surfaces (roads, plazas)
   * where vertex lighting needs interior samples, not just corners.
   */
  polyFlatTess(poly, y, material, cell = 6, opts = {}) {
    // Triangulate first (ear clipping handles concave blocks correctly), then
    // clip each triangle against a world-aligned grid. Clipping the whole
    // polygon directly is wrong — Sutherland-Hodgman on a concave subject emits
    // zero-width bridge edges — and merely subdividing the longest edge leaves
    // slivers, whose extreme aspect ratio is what smeared affine-mapped ground
    // textures into streaks. Grid cells bound edge length *and* aspect ratio,
    // which is what affine mapping actually needs.
    const tile = material.tile ?? DEFAULT_TILE;
    const clip = MeshBuilder._clip.clipPolyHalfplane;
    const uOff = opts.uOff || 0, vOff = opts.vOff || 0;

    const emitConvex = (pts) => {
      if (!pts || pts.length < 3) return;
      const idx = pts.map((p) => this.vertex(p.x, y, p.z,
        (p.x + uOff) / tile, (p.z + vOff) / tile,
        material.layer, 0, 1, 0, opts.light));
      for (let i = 1; i < idx.length - 1; i++) this.tri(idx[0], idx[i + 1], idx[i]);
    };

    for (const t of triangulate(poly)) {
      const tri = [t[0], t[1], t[2]];
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of tri) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
      }
      if (maxX - minX <= cell && maxZ - minZ <= cell) { emitConvex(tri); continue; }
      const gx0 = Math.floor(minX / cell) * cell;
      const gz0 = Math.floor(minZ / cell) * cell;
      for (let gx = gx0; gx < maxX; gx += cell) {
        // Column: keep gx <= x <= gx+cell.
        let col = clip(tri, gx, 0, 0, -1);
        if (col) col = clip(col, gx + cell, 0, 0, 1);
        if (!col) continue;
        for (let gz = gz0; gz < maxZ; gz += cell) {
          // Cell: keep gz <= z <= gz+cell.
          let piece = clip(col, 0, gz, 1, 0);
          if (piece) piece = clip(piece, 0, gz + cell, -1, 0);
          emitConvex(piece);
        }
      }
    }
    return this;
  }

  /** Vertical wall band along a polyline (curbs, parapets, retaining walls). */
  ribbon(points, yBottom, yTop, material, opts = {}) {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-4) continue;
      const nx = dz / len, nz = -dx / len;
      this.quadMat(
        [a.x, yBottom, a.z], [b.x, yBottom, b.z], [b.x, yTop, b.z], [a.x, yTop, a.z],
        material, [nx, 0, nz], Object.assign({ spanU: len, spanV: yTop - yBottom }, opts),
      );
      if (opts.doubleSided) {
        this.quadMat(
          [b.x, yBottom, b.z], [a.x, yBottom, a.z], [a.x, yTop, a.z], [b.x, yTop, b.z],
          material, [-nx, 0, -nz], Object.assign({ spanU: len, spanV: yTop - yBottom }, opts),
        );
      }
    }
    return this;
  }

  /** Sloped roof plane between two horizontal edges at different heights. */
  slope(a0, a1, b1, b0, material, opts = {}) {
    const ux = a1[0] - a0[0], uy = a1[1] - a0[1], uz = a1[2] - a0[2];
    const vx = b0[0] - a0[0], vy = b0[1] - a0[1], vz = b0[2] - a0[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    if (opts.flip) { nx = -nx; ny = -ny; nz = -nz; }
    const spanU = Math.hypot(ux, uy, uz);
    const spanV = Math.hypot(vx, vy, vz);
    return this.quadMat(a0, a1, b1, b0, material, [nx, ny, nz],
      Object.assign({ spanU, spanV }, opts));
  }

  /** Vertical triangle — gable ends, awning sides. */
  triangle(p0, p1, p2, material, normal, uvs) {
    const m = material;
    const tile = m.tile ?? DEFAULT_TILE;
    const uv = uvs || [
      [0, 0],
      [Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) / tile, 0],
      [Math.hypot(p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]) / (tile * 1.4),
       Math.hypot(p2[1] - p0[1], 0, 0) / tile],
    ];
    const a = this.vertex(p0[0], p0[1], p0[2], uv[0][0], uv[0][1], m.layer, normal[0], normal[1], normal[2]);
    const b = this.vertex(p1[0], p1[1], p1[2], uv[1][0], uv[1][1], m.layer, normal[0], normal[1], normal[2]);
    const c = this.vertex(p2[0], p2[1], p2[2], uv[2][0], uv[2][1], m.layer, normal[0], normal[1], normal[2]);
    this.tri(a, b, c);
    return this;
  }

  /** A vertical cylinder approximated with `sides` facets (poles, tanks). */
  cylinder(cx, cy, cz, radius, height, sides, material, opts = {}) {
    const tile = material.tile ?? DEFAULT_TILE;
    const circ = Math.PI * 2 * radius;
    const top = opts.capTop !== false;
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
      const x0 = cx + Math.cos(a0) * radius, z0 = cz + Math.sin(a0) * radius;
      const x1 = cx + Math.cos(a1) * radius, z1 = cz + Math.sin(a1) * radius;
      const nx = Math.cos((a0 + a1) / 2), nz = Math.sin((a0 + a1) / 2);
      const u0 = (i / sides) * (circ / tile), u1 = ((i + 1) / sides) * (circ / tile);
      this.quad([x0, cy, z0], [x1, cy, z1], [x1, cy + height, z1], [x0, cy + height, z0],
        [u0, 0, u1, height / tile], material.layer, [nx, 0, nz], opts);
    }
    if (top) {
      const centre = this.vertex(cx, cy + height, cz, 0.5, 0.5, material.layer, 0, 1, 0);
      const ring = [];
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        ring.push(this.vertex(cx + Math.cos(a) * radius, cy + height, cz + Math.sin(a) * radius,
          0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5, material.layer, 0, 1, 0));
      }
      for (let i = 0; i < sides; i++) this.tri(centre, ring[(i + 1) % sides], ring[i]);
    }
    return this;
  }

  /** Camera-facing-ish crossed billboards: weeds, bushes, hanging cables. */
  cross(cx, cy, cz, w, h, material, opts = {}) {
    const half = w / 2;
    const uv = [0, 0, 1, 1];
    for (let k = 0; k < 2; k++) {
      const a = (k * Math.PI) / 2 + (opts.yaw || 0);
      const dx = Math.cos(a) * half, dz = Math.sin(a) * half;
      this.quad([cx - dx, cy, cz - dz], [cx + dx, cy, cz + dz],
        [cx + dx, cy + h, cz + dz], [cx - dx, cy + h, cz - dz],
        uv, material.layer, [-Math.sin(a), 0.35, Math.cos(a)], { noTess: true, light: opts.light });
      this.quad([cx + dx, cy, cz + dz], [cx - dx, cy, cz - dz],
        [cx - dx, cy + h, cz - dz], [cx + dx, cy + h, cz + dz],
        uv, material.layer, [Math.sin(a), 0.35, -Math.cos(a)], { noTess: true, light: opts.light });
    }
    return this;
  }

  /**
   * An oriented box spanning from A to B — arms, legs, pipes, anything whose
   * axis is not world-aligned. Cheaper and clearer than a full matrix stack.
   */
  limb(ax, ay, az, bx, by, bz, halfW, halfH, material, opts = {}) {
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz) || 1e-4;
    dx /= len; dy /= len; dz /= len;
    // Orthonormal frame around the limb axis.
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(dy) > 0.985) { ux = 1; uy = 0; uz = 0; }
    let rx = uy * dz - uz * dy, ry = uz * dx - ux * dz, rz = ux * dy - uy * dx;
    let rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
    const sx = dy * rz - dz * ry, sy = dz * rx - dx * rz, sz = dx * ry - dy * rx;
    const P = (t, u, v) => [
      ax + dx * t * len + rx * u + sx * v,
      ay + dy * t * len + ry * u + sy * v,
      az + dz * t * len + rz * u + sz * v,
    ];
    const w = halfW, h = halfH;
    const c = [
      P(0, -w, -h), P(0, w, -h), P(0, w, h), P(0, -w, h),
      P(1, -w, -h), P(1, w, -h), P(1, w, h), P(1, -w, h),
    ];
    const q = (i0, i1, i2, i3, nxv, nyv, nzv, spanU, spanV) =>
      this.quadMat(c[i0], c[i1], c[i2], c[i3], material, [nxv, nyv, nzv],
        { spanU, spanV, noTess: opts.noTess !== false });
    q(0, 1, 2, 3, -dx, -dy, -dz, w * 2, h * 2);
    q(5, 4, 7, 6, dx, dy, dz, w * 2, h * 2);
    q(4, 5, 1, 0, -sx, -sy, -sz, w * 2, len);
    q(6, 7, 3, 2, sx, sy, sz, w * 2, len);
    q(7, 4, 0, 3, -rx, -ry, -rz, h * 2, len);
    q(5, 6, 2, 1, rx, ry, rz, h * 2, len);
    return this;
  }

  /** Clear for reuse — dynamic meshes are rebuilt every frame. */
  reset() {
    this.verts.length = 0;
    this.indices.length = 0;
    this.vertCount = 0;
    this.stack.length = 0;
    this.tx = this.ty = this.tz = 0;
    this.cy = 1; this.sy = 0;
    this.tint = null;
    return this;
  }

  get triCount() { return this.indices.length / 3; }
  get isEmpty() { return this.indices.length === 0; }

  toArrays() {
    return {
      vertices: new Float32Array(this.verts),
      indices: this.indices,
      vertCount: this.vertCount,
      tris: this.indices.length / 3,
    };
  }

  /** Merge another builder's contents (already in world space). */
  append(other) {
    const base = this.vertCount;
    for (let i = 0; i < other.verts.length; i++) this.verts.push(other.verts[i]);
    for (let i = 0; i < other.indices.length; i++) this.indices.push(other.indices[i] + base);
    this.vertCount += other.vertCount;
    return this;
  }
}

// Injected to avoid a circular import with math.js at module-eval time.
MeshBuilder._clip = {};
export function installClip(clipFn) { MeshBuilder._clip.clipPolyHalfplane = clipFn; }

// --- ear clipping ----------------------------------------------------------

function area2(a, b, c) {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function pointInTri(p, a, b, c) {
  const d1 = area2(p, a, b), d2 = area2(p, b, c), d3 = area2(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** Ear clipping for simple polygons. Returns an array of [p,p,p] (CCW). */
export function triangulate(polyIn) {
  let poly = polyIn.slice();
  // Force CCW.
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p.x * q.z - q.x * p.z;
  }
  if (a < 0) poly.reverse();

  const tris = [];
  const idx = poly.map((_, i) => i);
  let guard = 0;
  while (idx.length > 3 && guard++ < 4000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length];
      const ib = idx[i];
      const ic = idx[(i + 1) % idx.length];
      const pa = poly[ia], pb = poly[ib], pc = poly[ic];
      if (area2(pa, pb, pc) <= 1e-7) continue;      // reflex or degenerate
      let ok = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (pointInTri(poly[j], pa, pb, pc)) { ok = false; break; }
      }
      if (!ok) continue;
      tris.push([pa, pb, pc]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;   // self-intersecting input; bail with what we have
  }
  if (idx.length === 3) tris.push([poly[idx[0]], poly[idx[1]], poly[idx[2]]]);
  return tris;
}
