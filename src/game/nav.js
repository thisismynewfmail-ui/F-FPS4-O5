// ---------------------------------------------------------------------------
// nav.js — a flow field over the whole town.
//
// A grid Dijkstra from the player's position, recomputed a few times a second,
// gives every one of a hundred infected a correct route through winding streets
// and open doorways for the cost of one array lookup each. Steering handles the
// last couple of metres, so they still shoulder past each other in doorways
// instead of walking in single file.
// ---------------------------------------------------------------------------

const RES = 1.0;         // metres per cell; must be finer than a doorway
const BLOCKED = 65535;

export class NavGrid {
  constructor(bounds) {
    this.minX = bounds.minX;
    this.minZ = bounds.minZ;
    this.w = Math.ceil((bounds.maxX - bounds.minX) / RES);
    this.h = Math.ceil((bounds.maxZ - bounds.minZ) / RES);
    this.blocked = new Uint8Array(this.w * this.h);
    this.cost = new Uint16Array(this.w * this.h);
    // Dijkstra re-pushes cells when a cheaper route is found, so the ring
    // buffer needs slack beyond one entry per cell.
    this.queue = new Int32Array(this.w * this.h * 2);
    this.res = RES;
    this.dirty = true;
  }

  idx(cx, cz) { return cz * this.w + cx; }
  cellX(x) { return Math.floor((x - this.minX) / RES); }
  cellZ(z) { return Math.floor((z - this.minZ) / RES); }
  inside(cx, cz) { return cx >= 0 && cz >= 0 && cx < this.w && cz < this.h; }

  /**
   * Rasterise the collision world. Only ground-level obstructions matter: a
   * wall that starts above head height is walkable underneath.
   *
   * `doorways` must be supplied: a doorway is a ~1 m gap between two wall
   * segments, and rasterising walls alone reliably seals it because the
   * segments on either side each block their own cell. Carving the openings
   * open afterwards is what makes building interiors reachable at all.
   */
  build(collision, doorways, opts = {}) {
    this.blocked.fill(0);

    // Terrain first, so walls can overwrite it. A cliff is as solid as a wall
    // and a steep bank is expensive to cross but not impossible — which is
    // what makes the horde pour down the streets and around the hill rather
    // than straight over it.
    const terrain = opts.terrain;
    if (terrain) {
      const hard = opts.slopeImpassable ?? 1.05;
      const soft = opts.slopeSlow ?? 0.42;
      for (let cz = 0; cz < this.h; cz++) {
        const z = this.minZ + (cz + 0.5) * RES;
        for (let cx = 0; cx < this.w; cx++) {
          const x = this.minX + (cx + 0.5) * RES;
          const g = terrain.slopeAt(x, z);
          if (g > hard) this.blocked[this.idx(cx, cz)] = 1;
          else if (g > soft) this.blocked[this.idx(cx, cz)] = 2;
          else if (terrain.heightAt(x, z) < (opts.waterY ?? -1e9) + 0.35) this.blocked[this.idx(cx, cz)] = 1;
        }
      }
    }

    // Whether a segment obstructs is a question about its height ABOVE THE
    // GROUND AT THAT POINT, not about its absolute height. On a heightfield
    // those are different numbers, and using the absolute one silently
    // un-blocks every wall standing on high ground and blocks the sky over
    // low ground. Sampled per rasterisation step, so a wall running up a bank
    // is judged correctly along its whole length.
    const groundAt = (x, z) => collision.ground(x, z);

    for (const s of collision.segments) {
      if (s.off) continue;
      // Furniture is squeezed past, not routed around: a 1 m grid cannot tell
      // the difference between a wardrobe and a wall, and treating a sideboard
      // as solid fragments every room the horde is supposed to come out of.
      const soft = s.tag === 'furniture';
      const spreads = s.tag === 'wall' || s.tag === 'bounds' || s.tag.startsWith('cordon');
      const len = Math.hypot(s.x2 - s.x1, s.z2 - s.z1);
      const steps = Math.max(1, Math.ceil(len / (RES * (soft ? 0.7 : 0.5))));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = s.x1 + (s.x2 - s.x1) * t;
        const z = s.z1 + (s.z2 - s.z1) * t;
        const g = groundAt(x, z);
        if (s.y1 - g < 0.9 || s.y0 - g > 1.6) continue;   // step over / duck under
        const cx = this.cellX(x), cz = this.cellZ(z);
        if (soft) {
          if (this.inside(cx, cz) && !this.blocked[this.idx(cx, cz)]) this.blocked[this.idx(cx, cz)] = 2;
          continue;
        }
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, nz = cz + dz;
            if (!this.inside(nx, nz)) continue;
            // Centre cell always blocks; the ring blocks only for real walls so
            // doorways stay passable.
            if (dx === 0 && dz === 0) this.blocked[this.idx(nx, nz)] = 1;
            else if (spreads) {
              if (!this.blocked[this.idx(nx, nz)]) this.blocked[this.idx(nx, nz)] = 2;
            }
          }
        }
      }
    }
    // Soft ring cells (2) are passable but expensive; hard cells (1) are not.
    // Now punch the openings back open, and mark them permanently so nothing
    // can re-block them.
    if (doorways) {
      for (const d of doorways) {
        const r = Math.max(1, Math.ceil((d.r ?? 0.7) / RES));
        const cx = this.cellX(d.x), cz = this.cellZ(d.z);
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (dx * dx + dz * dz > r * r + 1) continue;
            const nx = cx + dx, nz = cz + dz;
            if (this.inside(nx, nz)) this.blocked[this.idx(nx, nz)] = 0;
          }
        }
      }
    }

    // The cordon goes on LAST and it wins.
    //
    // A cordon ring runs through buildings, and every building has doorways,
    // and the pass above exists precisely to carve doorways back open. Run in
    // that order the barricade in the corridor is opened again by the door at
    // the end of it, and the cordon quietly stops existing — the town looks
    // walled and is not. Re-rasterising it afterwards is the whole fix, and it
    // is also the reason a cordon segment is tagged rather than merely being a
    // wall: the tag is what makes it identifiable as "may not be carved".
    let cordonCells = 0;
    for (const s of collision.segments) {
      if (s.off || !s.tag.startsWith('cordon')) continue;
      const len = Math.hypot(s.x2 - s.x1, s.z2 - s.z1);
      const steps = Math.max(2, Math.ceil(len / (RES * 0.4)));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = s.x1 + (s.x2 - s.x1) * t;
        const z = s.z1 + (s.z2 - s.z1) * t;
        const g = groundAt(x, z);
        if (s.y1 - g < 0.9 || s.y0 - g > 1.6) continue;
        const cx = this.cellX(x), cz = this.cellZ(z);
        // Both the cell and its four neighbours: a 1 m grid cannot represent a
        // 2 m barricade as a line of single cells without diagonal leaks.
        for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, nz = cz + dz;
          if (this.inside(nx, nz) && this.blocked[this.idx(nx, nz)] !== 1) {
            this.blocked[this.idx(nx, nz)] = 1;
            cordonCells++;
          }
        }
      }
    }
    this.cordonCells = cordonCells;
    this.dirty = false;
  }

  /**
   * Dijkstra outward from a goal, filling `cost` in cells.
   *
   * `maxCost` bounds the flood. Without it a full-map solve costs ~13 ms, which
   * is a visible hitch several times a second; anything further away than this
   * is not chasing the player yet anyway and falls back to direct steering.
   */
  update(goalX, goalZ, maxCost = 1300) {
    const gx = this.cellX(goalX), gz = this.cellZ(goalZ);
    this.cost.fill(BLOCKED);
    if (!this.inside(gx, gz)) return;
    let head = 0, tail = 0;
    const q = this.queue;
    const push = (i, c) => { this.cost[i] = c; q[tail++] = i; if (tail >= q.length) tail = 0; };

    // If the goal itself is inside geometry, seed from the nearest open cell.
    let start = this.idx(gx, gz);
    if (this.blocked[start] === 1) {
      let found = -1;
      for (let r = 1; r < 8 && found < 0; r++) {
        for (let dz = -r; dz <= r && found < 0; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            const nx = gx + dx, nz = gz + dz;
            if (!this.inside(nx, nz)) continue;
            if (this.blocked[this.idx(nx, nz)] !== 1) { found = this.idx(nx, nz); break; }
          }
        }
      }
      if (found < 0) return;
      start = found;
    }
    push(start, 0);

    const w = this.w, h = this.h;
    let guard = 0;
    const maxCells = w * h;
    while (head !== tail && guard++ < maxCells * 2) {
      const i = q[head++];
      if (head >= q.length) head = 0;
      const c = this.cost[i];
      if (c >= maxCost) continue;
      const cx = i % w, cz = (i - cx) / w;
      for (let d = 0; d < 8; d++) {
        const dx = NEI[d * 2], dz = NEI[d * 2 + 1];
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const ni = nz * w + nx;
        const b = this.blocked[ni];
        if (b === 1) continue;
        // Diagonals may not cut a corner.
        if (dx && dz) {
          if (this.blocked[cz * w + nx] === 1 || this.blocked[nz * w + cx] === 1) continue;
        }
        const step = (dx && dz ? 14 : 10) + (b === 2 ? 22 : 0);
        const nc = c + step;
        if (nc >= this.cost[ni]) continue;
        push(ni, nc);
      }
    }
  }

  /** Downhill direction at a world position, or null if there is no route. */
  direction(x, z) {
    const cx = this.cellX(x), cz = this.cellZ(z);
    if (!this.inside(cx, cz)) return null;
    const here = this.cost[this.idx(cx, cz)];
    if (here === BLOCKED) return null;
    let best = here, bx = 0, bz = 0;
    for (let d = 0; d < 8; d++) {
      const dx = NEI[d * 2], dz = NEI[d * 2 + 1];
      const nx = cx + dx, nz = cz + dz;
      if (!this.inside(nx, nz)) continue;
      const c = this.cost[this.idx(nx, nz)];
      if (c < best) { best = c; bx = dx; bz = dz; }
    }
    if (!bx && !bz) return null;
    const l = Math.hypot(bx, bz);
    return { x: bx / l, z: bz / l, cost: here };
  }

  costAt(x, z) {
    const cx = this.cellX(x), cz = this.cellZ(z);
    if (!this.inside(cx, cz)) return BLOCKED;
    return this.cost[this.idx(cx, cz)];
  }

  isOpen(x, z) {
    const cx = this.cellX(x), cz = this.cellZ(z);
    return this.inside(cx, cz) && this.blocked[this.idx(cx, cz)] !== 1;
  }
}

const NEI = new Int8Array([1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1]);
export { BLOCKED };
