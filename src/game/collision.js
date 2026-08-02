// ---------------------------------------------------------------------------
// collision.js — 2.5D collision world.
//
// Buildings are rotated to face their streets, so axis-aligned boxes are no
// use. Instead the world is a soup of vertical wall *segments* (each with a
// height range) plus horizontal *floor plates*. A moving actor is a circle
// swept against the segments and dropped onto the highest floor beneath it.
//
// This handles rotated buildings, doorways (which are simply gaps in the
// segment list), multi-storey interiors and rooftops with one representation.
// ---------------------------------------------------------------------------

import { clamp, distPointSeg, pointInPoly } from '../core/math.js';

const CELL = 8;

export class CollisionWorld {
  constructor(bounds) {
    this.segments = [];
    this.floors = [];
    this.segGrid = new Map();
    this.floorGrid = new Map();
    this.bounds = bounds;
    this.groundY = 0;
  }

  key(x, z) { return `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`; }

  addSegment(x1, z1, x2, z2, y0, y1, tag = 'wall') {
    const len = Math.hypot(x2 - x1, z2 - z1);
    if (len < 0.05 || y1 - y0 < 0.05) return;
    const seg = { x1, z1, x2, z2, y0, y1, tag, id: this.segments.length };
    this.segments.push(seg);
    const steps = Math.max(1, Math.ceil(len / CELL));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const k = this.key(x1 + (x2 - x1) * t, z1 + (z2 - z1) * t);
      let list = this.segGrid.get(k);
      if (!list) { list = []; this.segGrid.set(k, list); }
      if (list[list.length - 1] !== seg.id) list.push(seg.id);
    }
    return seg;
  }

  /** A walkable horizontal plate. `poly` is a convex-ish polygon in world XZ. */
  addFloor(poly, y, owner) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of poly) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
    const f = { poly, y, owner, minX, maxX, minZ, maxZ, id: this.floors.length };
    this.floors.push(f);
    for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) {
      for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
        const k = `${cx},${cz}`;
        let list = this.floorGrid.get(k);
        if (!list) { list = []; this.floorGrid.set(k, list); }
        list.push(f.id);
      }
    }
    return f;
  }

  nearbySegments(x, z, radius, out) {
    const res = out || [];
    res.length = 0;
    const r = Math.ceil(radius / CELL);
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    const seen = this._seen || (this._seen = new Set());
    seen.clear();
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const list = this.segGrid.get(`${cx + dx},${cz + dz}`);
        if (!list) continue;
        for (const id of list) {
          if (seen.has(id)) continue;
          seen.add(id);
          res.push(this.segments[id]);
        }
      }
    }
    return res;
  }

  /**
   * Highest walkable surface at (x,z) that an actor whose feet are at `feetY`
   * could stand on, allowing a step up of `step`.
   */
  floorAt(x, z, feetY, step = 0.6) {
    let best = this.groundY;
    const list = this.floorGrid.get(this.key(x, z));
    if (list) {
      for (const id of list) {
        const f = this.floors[id];
        if (f.y <= best) continue;
        if (f.y > feetY + step) continue;
        if (x < f.minX || x > f.maxX || z < f.minZ || z > f.maxZ) continue;
        if (!pointInPoly(f.poly, x, z)) continue;
        best = f.y;
      }
    }
    return best;
  }

  /** Lowest ceiling above `feetY` at (x,z) — used to stop upward movement. */
  ceilingAt(x, z, feetY) {
    let best = Infinity;
    const list = this.floorGrid.get(this.key(x, z));
    if (list) {
      for (const id of list) {
        const f = this.floors[id];
        if (f.y <= feetY + 0.15) continue;
        if (x < f.minX || x > f.maxX || z < f.minZ || z > f.maxZ) continue;
        if (!pointInPoly(f.poly, x, z)) continue;
        if (f.y < best) best = f.y;
      }
    }
    return best;
  }

  /**
   * Slide a circle through the world. Two resolution passes are enough to
   * handle inside corners without jitter.
   */
  moveCircle(x, z, dx, dz, radius, feetY, headY) {
    let nx = x + dx, nz = z + dz;
    const segs = this.nearbySegments(nx, nz, radius + Math.hypot(dx, dz) + 2);
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const s of segs) {
        if (s.y1 <= feetY + 0.35 || s.y0 >= headY) continue;   // step over / duck under
        const r = distPointSeg(nx, nz, s.x1, s.z1, s.x2, s.z2);
        if (r.dist >= radius) continue;
        const push = radius - r.dist;
        let ox = nx - r.x, oz = nz - r.z;
        const l = Math.hypot(ox, oz);
        if (l < 1e-5) {
          // Dead centre on the segment: push along its normal.
          const sx = s.x2 - s.x1, sz = s.z2 - s.z1;
          const sl = Math.hypot(sx, sz) || 1;
          ox = sz / sl; oz = -sx / sl;
        } else { ox /= l; oz /= l; }
        nx += ox * (push + 1e-4);
        nz += oz * (push + 1e-4);
        moved = true;
      }
      if (!moved) break;
    }
    return { x: nx, z: nz };
  }

  /** True if a circle at (x,z) would overlap anything solid. */
  isBlocked(x, z, radius, feetY, headY) {
    const segs = this.nearbySegments(x, z, radius + 1);
    for (const s of segs) {
      if (s.y1 <= feetY + 0.35 || s.y0 >= headY) continue;
      if (distPointSeg(x, z, s.x1, s.z1, s.x2, s.z2).dist < radius) return true;
    }
    return false;
  }

  /**
   * Ray against walls and floors. Returns the nearest hit or null.
   * Used for hitscan weapons and line-of-sight tests.
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let best = null;

    // Walls: 2D segment intersection, then check the vertical span.
    const steps = Math.max(1, Math.ceil(maxDist / CELL));
    const seen = new Set();
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * maxDist;
      const px = ox + dx * t, pz = oz + dz * t;
      const cx = Math.floor(px / CELL), cz = Math.floor(pz / CELL);
      for (let gz = -1; gz <= 1; gz++) {
        for (let gx = -1; gx <= 1; gx++) {
          const list = this.segGrid.get(`${cx + gx},${cz + gz}`);
          if (!list) continue;
          for (const id of list) {
            if (seen.has(id)) continue;
            seen.add(id);
            const s = this.segments[id];
            const ex = s.x2 - s.x1, ez = s.z2 - s.z1;
            const denom = dx * ez - dz * ex;
            if (Math.abs(denom) < 1e-9) continue;
            const tt = ((s.x1 - ox) * ez - (s.z1 - oz) * ex) / denom;
            const u = ((s.x1 - ox) * dz - (s.z1 - oz) * dx) / denom;
            if (tt < 0 || tt > maxDist || u < 0 || u > 1) continue;
            const hy = oy + dy * tt;
            if (hy < s.y0 || hy > s.y1) continue;
            if (!best || tt < best.dist) {
              const el = Math.hypot(ex, ez) || 1;
              best = {
                dist: tt, x: ox + dx * tt, y: hy, z: oz + dz * tt,
                nx: ez / el, ny: 0, nz: -ex / el, tag: s.tag, kind: 'wall',
              };
            }
          }
        }
      }
      if (best && best.dist < t) break;
    }

    // Floors and ceilings.
    if (Math.abs(dy) > 1e-6) {
      const checkPlane = (y) => {
        const t = (y - oy) / dy;
        if (t < 0 || t > maxDist || (best && t >= best.dist)) return;
        const px = ox + dx * t, pz = oz + dz * t;
        if (y === this.groundY) {
          best = { dist: t, x: px, y, z: pz, nx: 0, ny: 1, nz: 0, tag: 'ground', kind: 'floor' };
          return;
        }
        const list = this.floorGrid.get(this.key(px, pz));
        if (!list) return;
        for (const id of list) {
          const f = this.floors[id];
          if (Math.abs(f.y - y) > 1e-6) continue;
          if (pointInPoly(f.poly, px, pz)) {
            best = { dist: t, x: px, y, z: pz, nx: 0, ny: dy < 0 ? 1 : -1, nz: 0, tag: 'floor', kind: 'floor' };
            return;
          }
        }
      };
      // Candidate planes near the ray.
      const ys = new Set([this.groundY]);
      const mid = { x: ox + dx * maxDist * 0.5, z: oz + dz * maxDist * 0.5 };
      for (const k of [this.key(ox, oz), this.key(mid.x, mid.z), this.key(ox + dx * maxDist, oz + dz * maxDist)]) {
        const list = this.floorGrid.get(k);
        if (list) for (const id of list) ys.add(this.floors[id].y);
      }
      for (const y of ys) checkPlane(y);
    }
    return best;
  }

  /** Cheap occlusion test between two points. */
  lineOfSight(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.01) return true;
    const hit = this.raycast(ax, ay, az, dx / d, dy / d, dz / d, d - 0.15);
    return !hit;
  }

  get stats() {
    return { segments: this.segments.length, floors: this.floors.length };
  }
}
