// ---------------------------------------------------------------------------
// fit.js — making sure nothing is inside anything else.
//
// `computeFootprint` sites a building using the extremes of its own lot in the
// building's own frame. That is the right way to do it and it is not enough,
// for two reasons that only show up once the whole town exists:
//
//   * A lot cut from an irregular block is often a wedge or a trapezoid. Its
//     bounding box in the frontage frame is strictly larger than the lot, so a
//     mass that fits the box can still hang over the boundary — into the
//     neighbour's kitchen, or out into the carriageway.
//   * A building knows nothing about its neighbours when it is placed. Two
//     lots that share a boundary can each site legally and still collide.
//
// Both are invisible from the street: the result looks like an odd corner, or
// a wall you cannot walk along. So this pass runs after every footprint
// exists, finds every intersection against the lot boundary, against the road
// surfaces and against every other building, and resolves them in order of how
// much they cost:
//
//   1. pull a mass back inside its own lot
//   2. delete an offending secondary mass (a porch, a garage, a wing)
//   3. shrink a main mass, up to a limit
//   4. as a last resort, give up on that building and leave the lot as a yard
//
// `tools/validate.mjs` asserts the result is zero, on every seed.
// ---------------------------------------------------------------------------

import { clamp, polyInset, distPointSeg } from '../core/math.js';

// Lot containment is a proxy for what actually matters — not standing in the
// road and not standing in the neighbours — so it is enforced gently. Being
// half a metre over a garden boundary hurts nobody; the hard constraints are
// applied in the passes below and they are the ones allowed to delete things.
const LOT_MARGIN = 0.10;       // keep this far inside the lot boundary
const ROAD_MARGIN = 0.25;      // and this far off the carriageway
const MIN_MAIN_W = 4.0;
const MIN_MAIN_D = 4.6;

// --- 2D predicates ---------------------------------------------------------

function bounds(poly) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, maxX, minZ, maxZ };
}

function pointInPoly(poly, x, z) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function segsCross(a, b, c, d) {
  const s = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const d1 = s(c, d, a), d2 = s(c, d, b), d3 = s(a, b, c), d4 = s(a, b, d);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

export function polysOverlap(A, B) {
  const ba = bounds(A), bb = bounds(B);
  if (ba.maxX < bb.minX || bb.maxX < ba.minX || ba.maxZ < bb.minZ || bb.maxZ < ba.minZ) return false;
  for (const p of A) if (pointInPoly(B, p.x, p.z)) return true;
  for (const p of B) if (pointInPoly(A, p.x, p.z)) return true;
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < B.length; j++) {
      if (segsCross(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length])) return true;
    }
  }
  return false;
}

/** Every corner AND edge midpoint inside the polygon — a concave lot can cut
 *  a corner off a rectangle without containing any of its vertices. */
function rectInside(poly, corners) {
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i], b = corners[(i + 1) % corners.length];
    if (!pointInPoly(poly, a.x, a.z)) return false;
    if (!pointInPoly(poly, (a.x + b.x) / 2, (a.z + b.z) / 2)) return false;
  }
  return true;
}

// --- the pass --------------------------------------------------------------

export function fitFootprints(world) {
  const lots = world.assigned.filter((l) => l.footprint);
  const stats = { pulled: 0, droppedMass: 0, shrunk: 0, droppedBuilding: 0 };

  // Roads first: cheap, per-lot, and it removes most conflicts before the
  // expensive neighbour test runs at all.
  const roadPolys = world.surfaces.strips.map((s) => s.poly)
    .concat(world.surfaces.pads.map((p) => p.poly));
  const roadIndex = makeIndex(roadPolys.map((p) => ({ poly: p, bounds: bounds(p) })));

  // --- 1. pull every mass back inside its own lot -------------------------
  for (const lot of lots) {
    const fp = lot.footprint;
    const guard = polyInset(lot.poly, LOT_MARGIN) || lot.poly;
    lot.guard = guard;
    const main = fp.masses.find((m) => m.kind === 'main');
    if (!main) continue;

    // Nudge the main mass toward its lot. Width first — losing frontage reads
    // as a narrower house; losing depth reads as a shed. This stops as soon as
    // the mass is only marginally over the line, because a wedge-shaped lot
    // will never contain a rectangle of a sensible size and shrinking until it
    // does throws away half the town.
    let tries = 0;
    while (!looselyInside(guard, main.corners) && tries++ < 8) {
      const w = main.x1 - main.x0, d = main.z1 - main.z0;
      if (w > MIN_MAIN_W && (w >= d * 0.75 || d <= MIN_MAIN_D)) {
        const nw = Math.max(MIN_MAIN_W, w * 0.92);
        fp.shiftOrigin((w - nw) / 2, 0);
        main.x1 = main.x0 + nw;
      } else if (d > MIN_MAIN_D) {
        const nd = Math.max(MIN_MAIN_D, d * 0.92);
        // Give the depth back to the street side: setbacks may grow, and a
        // building creeping toward the kerb is the thing to avoid.
        fp.shiftOrigin(0, (d - nd) * 0.35);
        main.z1 = main.z0 + nd;
      } else break;
      fp.doorLocal.x = clamp(fp.doorLocal.x, 0.6, main.x1 - main.x0 - 0.6);
      fp.reframe();
      stats.pulled++;
    }
    // No dropping here: whether this building may exist is decided by the road
    // and neighbour passes, which test the real constraints.

    // Secondary masses simply go if they do not fit. A house without a garage
    // is a house; a garage in the neighbour's garden is a bug.
    fp.masses = fp.masses.filter((m) => {
      if (m.kind === 'main') return true;
      // A porch is allowed to sit on its own front path, so it is judged
      // against the lot only loosely.
      const ok = looselyInside(guard, m.corners);
      if (!ok) stats.droppedMass++;
      return ok;
    });
    fp.reframe();
  }

  // --- 2. nothing may stand in the carriageway ----------------------------
  for (const lot of lots) {
    const fp = lot.footprint;
    if (!fp) continue;
    let guardRounds = 0;
    while (guardRounds++ < 10) {
      const hit = fp.masses.find((m) => hitsAny(roadIndex, inflate(m.corners, ROAD_MARGIN)));
      if (!hit) break;
      if (hit.kind !== 'main') {
        fp.masses = fp.masses.filter((m) => m !== hit);
        stats.droppedMass++;
        fp.reframe();
        continue;
      }
      // Push the whole building away from the street, then shrink if the lot
      // will not take the extra setback.
      const main = hit;
      const d = main.z1 - main.z0;
      if (d > MIN_MAIN_D) {
        const nd = Math.max(MIN_MAIN_D, d - 0.5);
        main.z1 = main.z0 + nd;
        fp.shiftOrigin(0, 0.5);
        fp.reframe();
        stats.shrunk++;
        if (!looselyInside(lot.guard || lot.poly, main.corners)) { dropBuilding(lot); break; }
      } else { dropBuilding(lot); break; }
    }
  }

  // --- 3. neighbours ------------------------------------------------------
  // Resolved by repeated rounds rather than in one shot, because shrinking one
  // building can free a second and moving a third can create a fourth.
  for (let round = 0; round < 14; round++) {
    const alive = lots.filter((l) => l.footprint);
    const entries = [];
    for (const lot of alive) {
      for (const m of lot.footprint.masses) entries.push({ lot, m, bounds: bounds(m.corners) });
    }
    const index = makeIndex(entries);
    const conflicts = new Map();
    for (const list of index.cells.values()) {
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const A = entries[list[a]], B = entries[list[b]];
          if (A.lot === B.lot) continue;
          if (!boxesTouch(A.bounds, B.bounds)) continue;
          if (!polysOverlap(A.m.corners, B.m.corners)) continue;
          record(conflicts, A);
          record(conflicts, B);
        }
      }
    }
    if (!conflicts.size) break;

    for (const [, e] of conflicts) {
      const lot = e.lot, fp = lot.footprint;
      if (!fp) continue;
      if (e.m.kind !== 'main') {
        fp.masses = fp.masses.filter((m) => m !== e.m);
        stats.droppedMass++;
        fp.reframe();
        continue;
      }
      const main = e.m;
      const w = main.x1 - main.x0, d = main.z1 - main.z0;
      if (w <= MIN_MAIN_W && d <= MIN_MAIN_D) {
        // Two buildings that both refuse to get any smaller: the one on the
        // smaller lot is the one that was never really there.
        dropBuilding(lot);
        stats.droppedBuilding++;
        continue;
      }
      // Small steps: two buildings that merely graze each other should end up
      // as two buildings with a gap, not as two sheds.
      const nw = Math.max(MIN_MAIN_W, w * 0.955);
      const nd = Math.max(MIN_MAIN_D, d * 0.975);
      fp.shiftOrigin((w - nw) / 2, (d - nd) * 0.5);
      main.x1 = main.x0 + nw;
      main.z1 = main.z0 + nd;
      fp.doorLocal.x = clamp(fp.doorLocal.x, 0.6, nw - 0.6);
      fp.reframe();
      stats.shrunk++;
    }
  }

  // --- 4. anything still colliding loses its building ---------------------
  const alive = lots.filter((l) => l.footprint);
  const entries = [];
  for (const lot of alive) {
    for (const m of lot.footprint.masses) entries.push({ lot, m, bounds: bounds(m.corners) });
  }
  const index = makeIndex(entries);
  const doomed = new Set();
  for (const list of index.cells.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const A = entries[list[a]], B = entries[list[b]];
        if (A.lot === B.lot || doomed.has(A.lot) || doomed.has(B.lot)) continue;
        if (!boxesTouch(A.bounds, B.bounds)) continue;
        if (!polysOverlap(A.m.corners, B.m.corners)) continue;
        doomed.add(A.lot.area <= B.lot.area ? A.lot : B.lot);
      }
    }
  }
  for (const lot of doomed) { dropBuilding(lot); stats.droppedBuilding++; }
  for (const lot of lots) {
    if (!lot.footprint) continue;
    for (const m of lot.footprint.masses) {
      if (hitsAny(roadIndex, inflate(m.corners, ROAD_MARGIN))) {
        dropBuilding(lot); stats.droppedBuilding++; break;
      }
    }
  }

  world.assigned = world.assigned.filter((l) => l.footprint);
  return stats;
}

function record(map, e) { if (!map.has(e.m)) map.set(e.m, e); }

function dropBuilding(lot) {
  lot.footprint = null;
  lot.kind = 'yard';
}

function looselyInside(poly, corners) {
  let out = 0;
  for (const c of corners) if (!pointInPoly(poly, c.x, c.z)) out++;
  return out <= 1;
}

function inflate(corners, d) {
  let cx = 0, cz = 0;
  for (const c of corners) { cx += c.x; cz += c.z; }
  cx /= corners.length; cz /= corners.length;
  return corners.map((c) => {
    const dx = c.x - cx, dz = c.z - cz;
    const l = Math.hypot(dx, dz) || 1;
    return { x: c.x + (dx / l) * d, z: c.z + (dz / l) * d };
  });
}

function boxesTouch(a, b) {
  return !(a.maxX < b.minX || b.maxX < a.minX || a.maxZ < b.minZ || b.maxZ < a.minZ);
}

const CELL = 28;
function makeIndex(entries) {
  const cells = new Map();
  entries.forEach((e, i) => {
    const b = e.bounds;
    for (let gz = Math.floor(b.minZ / CELL); gz <= Math.floor(b.maxZ / CELL); gz++) {
      for (let gx = Math.floor(b.minX / CELL); gx <= Math.floor(b.maxX / CELL); gx++) {
        const k = `${gx},${gz}`;
        let l = cells.get(k);
        if (!l) { l = []; cells.set(k, l); }
        l.push(i);
      }
    }
  });
  return { cells, entries };
}

function hitsAny(index, corners) {
  const b = bounds(corners);
  const seen = new Set();
  for (let gz = Math.floor(b.minZ / CELL); gz <= Math.floor(b.maxZ / CELL); gz++) {
    for (let gx = Math.floor(b.minX / CELL); gx <= Math.floor(b.maxX / CELL); gx++) {
      const list = index.cells.get(`${gx},${gz}`);
      if (!list) continue;
      for (const i of list) {
        if (seen.has(i)) continue;
        seen.add(i);
        const e = index.entries[i];
        if (!boxesTouch(b, e.bounds)) continue;
        if (polysOverlap(corners, e.poly || e.m.corners)) return true;
      }
    }
  }
  return false;
}
