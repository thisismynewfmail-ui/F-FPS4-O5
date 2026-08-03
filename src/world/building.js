// ---------------------------------------------------------------------------
// building.js — structures with real geometry.
//
// Rules this module implements literally rather than approximately:
//
//  * No fake facades. Every wall is a shell: an outer skin, an inner skin, and
//    reveals connecting them through each opening. You can stand in a doorway.
//  * Doors face the street. A building's local +Z axis is defined as "into the
//    lot", so the front wall is by construction the one on the frontage edge.
//  * Windows align with rooms. The floor plan is generated FIRST; each room
//    then claims the spans of exterior wall it actually touches, and windows are
//    placed only inside those spans, sized by what the room is for. Look through
//    a kitchen window and you are looking at the kitchen.
//  * Roofs match the footprint exactly, because they are generated from the
//    same rectangles the walls were, with a climate-appropriate pitch: this is
//    a cold wet town, so residential roofs are steep and deeply eaved, and flat
//    roofs get parapets and drainage.
//  * Foundations and trim exist on every structure to break the silhouette.
// ---------------------------------------------------------------------------

import { clamp, lerp, TAU } from '../core/math.js';
import { planFloor, furnishFloor, ROOM } from './interior.js';

const WALL_T = 0.30;          // exterior wall thickness
const PARTITION_T = 0.14;

// --- footprint -------------------------------------------------------------

const TYPE_MASSING = {
  house: { maxW: 13, depth: [8.5, 12.5], setback: [4.5, 9], side: [1.6, 4.0], wing: 0.55, porch: 0.6, garage: 0.35 },
  bungalow: { maxW: 14, depth: [8, 11], setback: [4.5, 8.5], side: [1.8, 4.2], wing: 0.35, porch: 0.5, garage: 0.3 },
  duplex: { maxW: 16, depth: [9, 12], setback: [4, 7.5], side: [1.4, 3.0], wing: 0.35, porch: 0.45 },
  rowhouse: { maxW: 8.5, depth: [10, 14], setback: [1.2, 3.0], side: [0.0, 0.35], wing: 0.2, porch: 0.25 },
  farmhouse: { maxW: 13, depth: [9, 12], setback: [8, 16], side: [4, 12], wing: 0.6, porch: 0.7 },
  barn: { maxW: 16, depth: [12, 18], setback: [6, 14], side: [3, 10], wing: 0.15 },
  shed: { maxW: 6.5, depth: [4, 6.5], setback: [3, 9], side: [1.5, 6] },

  shop: { maxW: 15, depth: [11, 17], setback: [0.2, 1.2], side: [0, 0.6], wing: 0.3 },
  diner: { maxW: 14, depth: [9, 13], setback: [1.0, 4.0], side: [0.5, 3.0], wing: 0.2 },
  bar: { maxW: 12, depth: [11, 15], setback: [0.2, 1.4], side: [0, 0.5], wing: 0.25 },
  office: { maxW: 20, depth: [13, 19], setback: [0.3, 2.0], side: [0, 1.2] },
  apartment: { maxW: 20, depth: [12, 18], setback: [0.6, 3.0], side: [0.2, 1.6], wing: 0.3 },
  hardware: { maxW: 16, depth: [12, 17], setback: [0.4, 2.0], side: [0, 1.0] },
  pharmacy: { maxW: 13, depth: [10, 14], setback: [0.3, 1.5], side: [0, 0.8] },
  laundromat: { maxW: 12, depth: [9, 13], setback: [0.4, 2.0], side: [0, 1.0] },

  library: { maxW: 22, depth: [15, 20], setback: [4, 9], side: [2, 6], wing: 0.5 },
  church: { maxW: 15, depth: [20, 27], setback: [5, 12], side: [3, 9], tower: true },
  townhall: { maxW: 22, depth: [14, 19], setback: [5, 11], side: [2, 6], tower: true },
  school: { maxW: 30, depth: [13, 18], setback: [8, 16], side: [3, 9], wing: 0.75 },
  clinic: { maxW: 17, depth: [12, 16], setback: [2.5, 6], side: [1.5, 4] },
  police: { maxW: 16, depth: [11, 15], setback: [2.0, 5], side: [1.5, 4] },
  firehouse: { maxW: 17, depth: [13, 17], setback: [2.5, 6], side: [1.5, 4], bay: true },
  supermarket: { maxW: 32, depth: [18, 26], setback: [3, 8], side: [1, 4] },
  bank: { maxW: 15, depth: [12, 16], setback: [0.4, 2.0], side: [0, 1.0] },
  motel: { maxW: 30, depth: [8, 11], setback: [6, 12], side: [2, 6] },
  cinema: { maxW: 18, depth: [16, 24], setback: [0.5, 2.5], side: [0, 1.2] },
  gasstation: { maxW: 11, depth: [7, 10], setback: [11, 17], side: [3, 9], canopy: true },

  warehouse: { maxW: 34, depth: [20, 30], setback: [5, 12], side: [2, 8] },
  factory: { maxW: 36, depth: [22, 32], setback: [6, 14], side: [3, 9], stack: true },
  workshop: { maxW: 16, depth: [11, 16], setback: [4, 10], side: [2, 6] },
  depot: { maxW: 14, depth: [10, 14], setback: [4, 10], side: [2, 6] },
};

const DEFAULT_MASSING = { maxW: 12, depth: [8, 12], setback: [3, 7], side: [1.5, 4] };

/**
 * Fit a building onto a lot. Returns masses in world space plus the local
 * frame, so the geometry pass can author everything in convenient local
 * coordinates.
 */
export function computeFootprint(lot, rng) {
  if (!lot.front || !lot.programme) return null;
  const prog = lot.programme;
  const spec = TYPE_MASSING[prog.type] || DEFAULT_MASSING;

  // Local frame: +Z runs from the street into the lot, +X along the frontage.
  const inward = { x: -lot.front.nx, z: -lot.front.nz };
  const yaw = Math.atan2(inward.x, inward.z);
  const ux = Math.cos(yaw), uz = -Math.sin(yaw);       // local +X in world
  const vx = Math.sin(yaw), vz = Math.cos(yaw);        // local +Z in world

  const R = lot.centroid;
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const p of lot.poly) {
    const dx = p.x - R.x, dz = p.z - R.z;
    const u = dx * ux + dz * uz;
    const v = dx * vx + dz * vz;
    if (u < uMin) uMin = u; if (u > uMax) uMax = u;
    if (v < vMin) vMin = v; if (v > vMax) vMax = v;
  }
  const fm = lot.front.mid;
  const vFront = (fm.x - R.x) * vx + (fm.z - R.z) * vz;

  const lotW = uMax - uMin;
  const lotD = vMax - vFront;
  if (lotW < 4.5 || lotD < 5.5) return null;

  let setback = rng.range(spec.setback[0], spec.setback[1]);
  let side = rng.range(spec.side[0], spec.side[1]);
  let depth = rng.range(spec.depth[0], spec.depth[1]);

  // Shrink to fit rather than refusing to build.
  let w = Math.min(spec.maxW, lotW - side * 2);
  if (w < 5) { side = Math.max(0, (lotW - 5) / 2); w = Math.min(spec.maxW, lotW - side * 2); }
  const rear = 1.6;
  if (setback + depth + rear > lotD) {
    setback = Math.max(0.4, Math.min(setback, lotD - depth - rear));
    if (setback + depth + rear > lotD) depth = Math.max(5.0, lotD - setback - rear);
  }
  if (w < 4.2 || depth < 4.8) return null;

  // Slide the mass along the frontage a little so neighbours don't line up.
  const slack = Math.max(0, lotW - w - side * 2);
  const u0 = uMin + side + rng.next() * slack;
  const v0 = vFront + setback;

  const O = {
    x: R.x + ux * u0 + vx * v0,
    z: R.z + uz * u0 + vz * v0,
  };
  const toWorld = (lx, lz) => ({ x: O.x + ux * lx + vx * lz, z: O.z + uz * lx + vz * lz });
  const cornersOf = (x0, z0, x1, z1) => [toWorld(x0, z0), toWorld(x1, z0), toWorld(x1, z1), toWorld(x0, z1)];

  const masses = [];
  const main = { x0: 0, z0: 0, x1: w, z1: depth, kind: 'main' };
  masses.push(main);

  // Secondary massing — the thing that stops every house being a box.
  const roomForRear = lotD - (setback + depth + rear);
  if (spec.wing && rng.chance(spec.wing) && roomForRear > 4.5 && w > 7) {
    const ww = rng.range(0.42, 0.75) * w;
    const wd = Math.min(rng.range(3.4, 6.4), roomForRear);
    const wx = rng.chance(0.5) ? 0 : w - ww;
    masses.push({ x0: wx, z0: depth, x1: wx + ww, z1: depth + wd, kind: 'wing' });
  }
  if (spec.garage && rng.chance(spec.garage) && lotW - w - side * 2 > 6.2) {
    const gw = rng.range(3.4, 5.4);
    const gd = rng.range(5.2, 6.8);
    const rightSide = u0 + w + gw + 0.8 < uMax;
    const gx = rightSide ? w + rng.range(0.6, 1.8) : -gw - rng.range(0.6, 1.8);
    const gz = rng.range(0.5, 2.5);
    masses.push({ x0: gx, z0: gz, x1: gx + gw, z1: gz + gd, kind: 'garage' });
  }
  if (spec.tower) {
    const tw = rng.range(3.2, 4.6);
    const tx = rng.chance(0.5) ? rng.range(0, Math.max(0.1, w - tw)) : (w - tw) / 2;
    masses.push({ x0: tx, z0: -rng.range(0.0, 0.8), x1: tx + tw, z1: rng.range(3.0, 4.4), kind: 'tower' });
  }
  if (spec.porch && rng.chance(spec.porch) && setback > 2.6) {
    const pw = rng.range(0.45, 0.95) * w;
    const px = rng.range(0, Math.max(0.1, w - pw));
    masses.push({ x0: px, z0: -rng.range(1.7, 2.6), x1: px + pw, z1: 0, kind: 'porch' });
  }

  for (const m of masses) {
    m.corners = cornersOf(m.x0, m.z0, m.x1, m.z1);
    m.w = m.x1 - m.x0;
    m.d = m.z1 - m.z0;
  }

  const doorLocal = { x: w * rng.range(0.28, 0.72), z: 0 };
  const fp = {
    masses, origin: { x: O.x, z: O.z }, yaw, ux, uz, vx, vz,
    w, depth, setback,
    doorLocal,
    lotExtent: { uMin, uMax, vMin, vMax, vFront, u0, v0 },
  };

  // The footprint stays mutable after this point. Siting has to be corrected
  // once every neighbour is known — a lot polygon can be a wedge, and a mass
  // that fits its own bounding box can still stand in next door's kitchen or
  // in the middle of the road. `reframe` is how the correction pass moves and
  // resizes masses without any of them losing track of where they are.
  fp.toWorld = (lx, lz) => ({
    x: fp.origin.x + fp.ux * lx + fp.vx * lz,
    z: fp.origin.z + fp.uz * lx + fp.vz * lz,
  });
  fp.rectCorners = (x0, z0, x1, z1) => [
    fp.toWorld(x0, z0), fp.toWorld(x1, z0), fp.toWorld(x1, z1), fp.toWorld(x0, z1),
  ];
  /** Recompute world corners for every mass from its local rectangle. */
  fp.reframe = () => {
    for (const m of fp.masses) {
      m.corners = fp.rectCorners(m.x0, m.z0, m.x1, m.z1);
      m.w = m.x1 - m.x0;
      m.d = m.z1 - m.z0;
    }
    const mainMass = fp.masses.find((mm) => mm.kind === 'main');
    if (mainMass) { fp.w = mainMass.w; fp.depth = mainMass.d; }
    fp.door = fp.toWorld(fp.doorLocal.x, fp.doorLocal.z - 0.1);
  };
  /**
   * Slide the whole frame by (du,dv) in local axes while leaving every mass
   * exactly where it is in the world. Used to shrink the main mass, which by
   * construction must keep its corner at local (0,0).
   */
  fp.shiftOrigin = (du, dv) => {
    fp.origin.x += fp.ux * du + fp.vx * dv;
    fp.origin.z += fp.uz * du + fp.vz * dv;
    for (const m of fp.masses) { m.x0 -= du; m.x1 -= du; m.z0 -= dv; m.z1 -= dv; }
    fp.doorLocal.x -= du;
    fp.doorLocal.z -= dv;
  };
  fp.reframe();
  return fp;
}

// --- wall shells with openings ---------------------------------------------

/**
 * A wall panel with rectangular holes cut through it, built as a grid of
 * quads over the union of every opening's edges. Emits the outer skin, the
 * inner skin, and the reveals (jambs, sill, head) that join them.
 *
 * Coordinates are local: the wall runs from (x0,z0) to (x1,z1) at floor `y0`,
 * `h` tall, with `nx,nz` pointing outward.
 */
function wallShell(mb, geo, openings, mats, opts = {}) {
  const { x0, z0, x1, z1, y0, h } = geo;
  const dx = x1 - x0, dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < 0.05) return;
  const ux = dx / len, uz = dz / len;
  const nx = uz, nz = -ux;                    // outward normal (CW footprint)
  const t = opts.thickness ?? WALL_T;
  const P = (u, y, off) => [x0 + ux * u + nx * off, y, z0 + uz * u + nz * off];

  // Build the cut grid.
  const us = new Set([0, len]);
  const ys = new Set([y0, y0 + h]);
  for (const o of openings) {
    us.add(clamp(o.u0, 0, len)); us.add(clamp(o.u1, 0, len));
    ys.add(clamp(o.y0, y0, y0 + h)); ys.add(clamp(o.y1, y0, y0 + h));
  }
  const uList = [...us].sort((a, b) => a - b);
  const yList = [...ys].sort((a, b) => a - b);

  const inside = (uc, yc) => openings.find((o) =>
    uc > o.u0 && uc < o.u1 && yc > o.y0 && yc < o.y1);

  const outMat = mats.outer, inMat = mats.inner;
  for (let i = 0; i < uList.length - 1; i++) {
    for (let j = 0; j < yList.length - 1; j++) {
      const ua = uList[i], ub = uList[i + 1];
      const ya = yList[j], yb = yList[j + 1];
      if (ub - ua < 1e-3 || yb - ya < 1e-3) continue;
      if (inside((ua + ub) / 2, (ya + yb) / 2)) continue;
      // Outer skin — UVs continuous across the whole wall so the bond lines up.
      mb.quadMat(P(ua, ya, 0), P(ub, ya, 0), P(ub, yb, 0), P(ua, yb, 0), outMat,
        [nx, 0, nz], { spanU: ub - ua, spanV: yb - ya, uvShift: [ua / (outMat.tile || 2), ya / (outMat.tile || 2)] });
      if (inMat) {
        // The inner skin is enclosed, so it bakes with the indoor light term.
        const env = mb.env;
        const prev = env ? env.indoor : 0;
        if (env) env.indoor = 1;
        mb.quadMat(P(ub, ya, t), P(ua, ya, t), P(ua, yb, t), P(ub, yb, t), inMat,
          [-nx, 0, -nz], { spanU: ub - ua, spanV: yb - ya, uvShift: [ua / (inMat.tile || 2), ya / (inMat.tile || 2)] });
        if (env) env.indoor = prev;
      }
    }
  }

  // Reveals and the panel that fills each opening.
  for (const o of openings) {
    const a = clamp(o.u0, 0, len), b = clamp(o.u1, 0, len);
    if (b - a < 0.05) continue;
    const ya = o.y0, yb = o.y1;
    const rev = o.reveal || mats.reveal || mats.outer;
    // jambs
    mb.quadMat(P(a, ya, 0), P(a, ya, t), P(a, yb, t), P(a, yb, 0), rev, [ux, 0, uz], { spanU: t, spanV: yb - ya });
    mb.quadMat(P(b, ya, t), P(b, ya, 0), P(b, yb, 0), P(b, yb, t), rev, [-ux, 0, -uz], { spanU: t, spanV: yb - ya });
    // head
    mb.quadMat(P(a, yb, 0), P(b, yb, 0), P(b, yb, t), P(a, yb, t), rev, [0, -1, 0], { spanU: b - a, spanV: t });
    // sill (skip for doorways so you can walk through)
    if (!o.threshold) {
      mb.quadMat(P(a, ya, t), P(b, ya, t), P(b, ya, 0), P(a, ya, 0), rev, [0, 1, 0], { spanU: b - a, spanV: t });
    }
    if (o.panel) {
      const off = o.panelOffset ?? t * 0.6;
      const inset = 0.02;
      // Outward-facing panel.
      mb.quadMat(P(a + inset, ya + inset, off), P(b - inset, ya + inset, off),
        P(b - inset, yb - inset, off), P(a + inset, yb - inset, off),
        o.panel, [nx, 0, nz], { spanU: b - a, spanV: yb - ya, noTess: o.panel.fit });
      // Inward-facing copy so the opening reads from inside too.
      mb.quadMat(P(b - inset, ya + inset, off + 0.01), P(a + inset, ya + inset, off + 0.01),
        P(a + inset, yb - inset, off + 0.01), P(b - inset, yb - inset, off + 0.01),
        o.panelInner || o.panel, [-nx, 0, -nz], { spanU: b - a, spanV: yb - ya, noTess: o.panel.fit });
    }
    if (o.trim) {
      // Casing: a flat band framing the opening on the outside.
      const cw = o.trimWidth ?? 0.14;
      const eps = 0.012;
      mb.quadMat(P(a - cw, ya - cw, eps), P(b + cw, ya - cw, eps), P(b + cw, ya, eps), P(a - cw, ya, eps),
        o.trim, [nx, 0, nz], { spanU: b - a + cw * 2, spanV: cw });
      mb.quadMat(P(a - cw, yb, eps), P(b + cw, yb, eps), P(b + cw, yb + cw, eps), P(a - cw, yb + cw, eps),
        o.trim, [nx, 0, nz], { spanU: b - a + cw * 2, spanV: cw });
      mb.quadMat(P(a - cw, ya, eps), P(a, ya, eps), P(a, yb, eps), P(a - cw, yb, eps),
        o.trim, [nx, 0, nz], { spanU: cw, spanV: yb - ya });
      mb.quadMat(P(b, ya, eps), P(b + cw, ya, eps), P(b + cw, yb, eps), P(b, yb, eps),
        o.trim, [nx, 0, nz], { spanU: cw, spanV: yb - ya });
    }
  }
}

// --- roofs -----------------------------------------------------------------

/**
 * Gable roof over a local rectangle. The ridge runs along the longer side,
 * which is what makes rain and snow shed off the eaves rather than into the
 * neighbour's lot.
 */
function gableRoof(mb, m, y, pitchDeg, mats, opts = {}) {
  const eave = opts.eave ?? 0.5;
  const x0 = m.x0 - eave, x1 = m.x1 + eave, z0 = m.z0 - eave, z1 = m.z1 + eave;
  const w = x1 - x0, d = z1 - z0;
  const alongX = (m.x1 - m.x0) >= (m.z1 - m.z0);
  const run = (alongX ? d : w) / 2;
  const rise = run * Math.tan(pitchDeg * Math.PI / 180);
  const top = y + rise;
  const fascia = opts.fascia ?? 0.22;

  if (alongX) {
    const zm = (z0 + z1) / 2;
    mb.slope([x0, y, z0], [x1, y, z0], [x1, top, zm], [x0, top, zm], mats.roof);
    mb.slope([x1, y, z1], [x0, y, z1], [x0, top, zm], [x1, top, zm], mats.roof);
    // Gable ends.
    mb.triangle([x0, y, z0], [x0, y, z1], [x0, top, zm], mats.gable || mats.wall, [-1, 0, 0]);
    mb.triangle([x1, y, z1], [x1, y, z0], [x1, top, zm], mats.gable || mats.wall, [1, 0, 0]);
    // Fascia boards along the two eaves.
    mb.box(x0, y - fascia, z0 - 0.04, x1, y, z0 + 0.02, mats.trim, { skip: 'top bottom', noTess: true });
    mb.box(x0, y - fascia, z1 - 0.02, x1, y, z1 + 0.04, mats.trim, { skip: 'top bottom', noTess: true });
    // Soffits.
    mb.quadMat([x0, y - fascia, z0], [x1, y - fascia, z0], [x1, y - fascia, m.z0], [x0, y - fascia, m.z0],
      mats.trim, [0, -1, 0], { spanU: w, spanV: eave });
    mb.quadMat([x0, y - fascia, m.z1], [x1, y - fascia, m.z1], [x1, y - fascia, z1], [x0, y - fascia, z1],
      mats.trim, [0, -1, 0], { spanU: w, spanV: eave });
    return { top, ridge: { x0, x1, z: zm, y: top }, alongX, rise };
  }
  const xm = (x0 + x1) / 2;
  mb.slope([x1, y, z0], [x1, y, z1], [xm, top, z1], [xm, top, z0], mats.roof);
  mb.slope([x0, y, z1], [x0, y, z0], [xm, top, z0], [xm, top, z1], mats.roof);
  mb.triangle([x0, y, z0], [x1, y, z0], [xm, top, z0], mats.gable || mats.wall, [0, 0, -1]);
  mb.triangle([x1, y, z1], [x0, y, z1], [xm, top, z1], mats.gable || mats.wall, [0, 0, 1]);
  mb.box(x0 - 0.04, y - fascia, z0, x0 + 0.02, y, z1, mats.trim, { skip: 'top bottom', noTess: true });
  mb.box(x1 - 0.02, y - fascia, z0, x1 + 0.04, y, z1, mats.trim, { skip: 'top bottom', noTess: true });
  return { top, ridge: { z0, z1, x: xm, y: top }, alongX, rise };
}

/** Hipped roof — four slopes, no gable ends. Common on the older houses. */
function hipRoof(mb, m, y, pitchDeg, mats, opts = {}) {
  const eave = opts.eave ?? 0.5;
  const x0 = m.x0 - eave, x1 = m.x1 + eave, z0 = m.z0 - eave, z1 = m.z1 + eave;
  const w = x1 - x0, d = z1 - z0;
  const alongX = w >= d;
  const run = Math.min(w, d) / 2;
  const rise = run * Math.tan(pitchDeg * Math.PI / 180);
  const top = y + rise;
  const fascia = opts.fascia ?? 0.22;

  let rx0, rx1, rz0, rz1;
  if (alongX) { rx0 = x0 + run; rx1 = x1 - run; rz0 = rz1 = (z0 + z1) / 2; }
  else { rz0 = z0 + run; rz1 = z1 - run; rx0 = rx1 = (x0 + x1) / 2; }

  mb.slope([x0, y, z0], [x1, y, z0], [rx1, top, rz0], [rx0, top, rz0], mats.roof);
  mb.slope([x1, y, z1], [x0, y, z1], [rx0, top, rz1], [rx1, top, rz1], mats.roof);
  mb.slope([x1, y, z0], [x1, y, z1], [rx1, top, rz1], [rx1, top, rz0], mats.roof);
  mb.slope([x0, y, z1], [x0, y, z0], [rx0, top, rz0], [rx0, top, rz1], mats.roof);

  mb.box(x0, y - fascia, z0 - 0.04, x1, y, z0 + 0.02, mats.trim, { skip: 'top bottom', noTess: true });
  mb.box(x0, y - fascia, z1 - 0.02, x1, y, z1 + 0.04, mats.trim, { skip: 'top bottom', noTess: true });
  mb.box(x0 - 0.04, y - fascia, z0, x0 + 0.02, y, z1, mats.trim, { skip: 'top bottom', noTess: true });
  mb.box(x1 - 0.02, y - fascia, z0, x1 + 0.04, y, z1, mats.trim, { skip: 'top bottom', noTess: true });
  return { top, rise, alongX, hip: { rx0, rx1, rz0, rz1 } };
}

/** Flat roof with a parapet — every commercial and industrial block. */
function flatRoof(mb, m, y, mats, opts = {}) {
  const par = opts.parapet ?? 0.85;
  const lip = opts.lip ?? 0.22;
  const x0 = m.x0, x1 = m.x1, z0 = m.z0, z1 = m.z1;
  mb.quadMat([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], mats.roof, [0, 1, 0],
    { spanU: x1 - x0, spanV: z1 - z0 });
  if (par > 0.05) {
    // Parapet: outer face continues the wall, inner face and coping cap.
    const o = lip;
    mb.box(x0 - o, y, z0 - o, x1 + o, y + par, z0, mats.wall, { skip: 'bottom' });
    mb.box(x0 - o, y, z1, x1 + o, y + par, z1 + o, mats.wall, { skip: 'bottom' });
    mb.box(x0 - o, y, z0, x0, y + par, z1, mats.wall, { skip: 'bottom' });
    mb.box(x1, y, z0, x1 + o, y + par, z1, mats.wall, { skip: 'bottom' });
    // Coping stone on top of the parapet.
    const c = mats.coping || mats.trim;
    mb.box(x0 - o - 0.04, y + par, z0 - o - 0.04, x1 + o + 0.04, y + par + 0.09, z0, c, { skip: 'bottom' });
    mb.box(x0 - o - 0.04, y + par, z1, x1 + o + 0.04, y + par + 0.09, z1 + o + 0.04, c, { skip: 'bottom' });
    mb.box(x0 - o - 0.04, y + par, z0, x0, y + par + 0.09, z1, c, { skip: 'bottom' });
    mb.box(x1, y + par, z0, x1 + o + 0.04, y + par + 0.09, z1, c, { skip: 'bottom' });
  }
  return { top: y + par, flat: true };
}

/** Low-slope shed roof — workshops, lean-tos, garages. */
function shedRoof(mb, m, y, pitchDeg, mats, opts = {}) {
  const eave = opts.eave ?? 0.35;
  const x0 = m.x0 - eave, x1 = m.x1 + eave, z0 = m.z0 - eave, z1 = m.z1 + eave;
  const rise = (z1 - z0) * Math.tan(pitchDeg * Math.PI / 180);
  const top = y + rise;
  mb.slope([x0, y, z1], [x1, y, z1], [x1, top, z0], [x0, top, z0], mats.roof);
  mb.triangle([x0, y, z1], [x0, top, z0], [x0, y, z0], mats.gable || mats.wall, [-1, 0, 0]);
  mb.triangle([x1, y, z0], [x1, top, z0], [x1, y, z1], mats.gable || mats.wall, [1, 0, 0]);
  mb.box(x0, y - 0.2, z1 - 0.03, x1, y, z1 + 0.04, mats.trim, { skip: 'top bottom', noTess: true });
  return { top, rise, shed: true };
}

// --- roof furniture --------------------------------------------------------

function chimney(mb, x, z, baseY, topY, mats, rng) {
  const w = rng.range(0.75, 1.05);
  mb.box(x - w / 2, baseY, z - w / 2, x + w / 2, topY, z + w / 2, mats.chimney, { skip: 'bottom' });
  mb.box(x - w / 2 - 0.08, topY, z - w / 2 - 0.08, x + w / 2 + 0.08, topY + 0.12, z + w / 2 + 0.08, mats.coping, { skip: 'bottom' });
  // Flue pots.
  const pot = rng.int(1, 2);
  for (let i = 0; i < pot; i++) {
    const px = x + (i - (pot - 1) / 2) * 0.34;
    mb.cylinder(px, topY + 0.12, z, 0.12, rng.range(0.2, 0.42), 6, mats.chimneyPot);
  }
}

function hvacUnit(mb, x, z, y, mats, rng) {
  const w = rng.range(1.1, 1.9), d = rng.range(0.9, 1.5), h = rng.range(0.7, 1.15);
  mb.box(x - w / 2, y + 0.12, z - d / 2, x + w / 2, y + 0.12 + h, z + d / 2, mats.hvac, { skip: 'bottom' });
  // Skid frame and fan grille.
  mb.box(x - w / 2 - 0.06, y, z - d / 2 - 0.06, x + w / 2 + 0.06, y + 0.12, z + d / 2 + 0.06, mats.metalDark);
  mb.box(x - w * 0.28, y + 0.12 + h, z - d * 0.28, x + w * 0.28, y + 0.12 + h + 0.06, z + d * 0.28, mats.metalDark, { skip: 'bottom' });
}

function roofVent(mb, x, z, y, mats, rng) {
  const r = rng.range(0.16, 0.28);
  mb.cylinder(x, y, z, r, rng.range(0.35, 0.7), 6, mats.metalDark);
  mb.cylinder(x, y + 0.35, z, r * 1.5, 0.1, 6, mats.metalDark);
}

/** Gutters along the eaves plus downspouts at the corners. */
function guttering(mb, m, y, mats, alongX) {
  const g = 0.11;
  const eave = 0.5;
  const x0 = m.x0 - eave, x1 = m.x1 + eave, z0 = m.z0 - eave, z1 = m.z1 + eave;
  if (alongX) {
    mb.box(x0, y - 0.30, z0 - 0.06, x1, y - 0.30 + g, z0 + 0.06, mats.gutter, { skip: 'top', noTess: true });
    mb.box(x0, y - 0.30, z1 - 0.06, x1, y - 0.30 + g, z1 + 0.06, mats.gutter, { skip: 'top', noTess: true });
  } else {
    mb.box(x0 - 0.06, y - 0.30, z0, x0 + 0.06, y - 0.30 + g, z1, mats.gutter, { skip: 'top', noTess: true });
    mb.box(x1 - 0.06, y - 0.30, z0, x1 + 0.06, y - 0.30 + g, z1, mats.gutter, { skip: 'top', noTess: true });
  }
  // Downspouts hugging two corners.
  for (const [dx, dz] of [[m.x0 + 0.06, m.z0 + 0.06], [m.x1 - 0.06, m.z1 - 0.06]]) {
    mb.box(dx - 0.055, 0, dz - 0.055, dx + 0.055, y - 0.24, dz + 0.055, mats.gutter, { skip: 'top bottom', noTess: true });
  }
}

// ---------------------------------------------------------------------------
// The main entry point
// ---------------------------------------------------------------------------

/**
 * Emit a complete building. `ctx` carries the material library, the collision /
 * nav / spawn sinks, and the random source.
 */
export function buildBuilding(lot, ctx) {
  const fp = lot.footprint;
  if (!fp) return null;
  const { mb, lib, rng, kit } = ctx;
  const prog = lot.programme;
  const decay = lot.decay;
  const worn = decay > 0.48;
  const sfx = worn ? '#w' : '';

  const M = {
    wall: lib.m(kit.wall + sfx),
    trim: lib.m(kit.trim + sfx),
    trimAlt: lib.m(kit.trimAlt + sfx),
    roof: lib.m(kit.roof + sfx),
    foundation: lib.m(kit.foundation + sfx),
    coping: lib.m(kit.trim + sfx, 1.6),
    gutter: lib.m(worn ? 'prop_rust' : 'prop_steel', 0.8),
    chimney: lib.m(worn ? 'brick_deep#w' : 'brick_deep'),
    chimneyPot: lib.m('prop_rust', 0.5),
    hvac: lib.m('prop_steel', 1.2),
    metalDark: lib.m('prop_darksteel', 0.9),
    glass: lib.m(worn ? 'glass_broken' : 'glass_dirty'),
  };

  const storeys = Array.isArray(prog.storeys)
    ? rng.int(prog.storeys[0], prog.storeys[1])
    : (prog.storeys || 1);
  const commercial = ['shop', 'office', 'apartment', 'bank', 'cinema', 'diner', 'bar',
    'hardware', 'pharmacy', 'laundromat', 'supermarket', 'library', 'townhall',
    'clinic', 'police', 'firehouse', 'motel', 'school'].includes(prog.type);
  const industrial = ['warehouse', 'factory', 'workshop', 'depot', 'barn'].includes(prog.type);
  const sh = industrial ? rng.range(5.2, 7.4)
    : commercial ? ctx.cfg.commercialStoreyHeight * rng.range(0.94, 1.08)
      : ctx.cfg.storeyHeight * rng.range(0.95, 1.06);

  const plinth = industrial ? 0.22 : commercial ? 0.28 : rng.range(0.35, 0.72);
  const eaveY = plinth + sh * storeys;

  // Everything in this function is authored in the building's own frame, with
  // y=0 at the level of its pad. `baseY` is where that pad sits on the
  // heightfield; the mesh builder carries it, and every collision, floor,
  // doorway and spawn registration below adds it back explicitly.
  const baseY = ctx.baseY || 0;
  // How far the natural ground falls away under the footprint. On the hill
  // streets this is what you actually see: a house whose front step is at
  // pavement level and whose back wall stands on two metres of stonework.
  const foundDrop = clamp(lot.foundDrop ?? 0.5, 0.4, 4.2);

  const record = {
    lot, prog, storeys, storeyHeight: sh, plinth, eaveY, baseY, foundDrop,
    origin: fp.origin, yaw: fp.yaw, masses: fp.masses,
    label: prog.label, interiors: [], enterable: true,
    aabb: null,
  };

  mb.push(fp.origin.x, baseY, fp.origin.z, fp.yaw);
  const main = fp.masses.find((m) => m.kind === 'main');

  // --- foundation ---------------------------------------------------------
  for (const m of fp.masses) {
    if (m.kind === 'porch') continue;
    const o = 0.12;
    mb.box(m.x0 - o, -foundDrop, m.z0 - o, m.x1 + o, plinth, m.z1 + o, M.foundation, { skip: 'bottom top', vAlign: true, maxEdge: 5 });
    mb.quadMat([m.x0 - o, plinth, m.z1 + o], [m.x1 + o, plinth, m.z1 + o],
      [m.x1 + o, plinth, m.z0 - o], [m.x0 - o, plinth, m.z0 - o], M.foundation, [0, 1, 0],
      { spanU: m.w + o * 2, spanV: m.d + o * 2 });
  }

  // --- interiors and openings --------------------------------------------
  // The plan comes first; the windows follow the rooms, never the other way.
  const plans = [];
  for (let s = 0; s < storeys; s++) {
    const plan = planFloor(main.w, main.d, s, prog.type, rng, { storeys });
    plans.push(plan);
  }
  record.plans = plans;

  const openingsByFace = { front: [], back: [], left: [], right: [] };
  const faceOf = {
    front: { fixed: 'z', at: 0, span: [0, main.w] },
    back: { fixed: 'z', at: main.d, span: [0, main.w] },
    left: { fixed: 'x', at: 0, span: [0, main.d] },
    right: { fixed: 'x', at: main.w, span: [0, main.d] },
  };

  const winStyle = kit.window + sfx;
  const brokenWin = worn && rng.chance(0.5) ? (commercial ? 'win_broken_shop' : 'win_broken') : null;
  const boardedWin = worn && rng.chance(0.3) ? (commercial ? 'win_boarded_shop' : 'win_boarded') : null;

  const pickWindowMat = () => {
    if (boardedWin && rng.chance(0.34)) return lib.m(boardedWin + sfx);
    if (brokenWin && rng.chance(0.46)) return lib.m(brokenWin + sfx);
    return lib.m(winStyle);
  };

  for (let s = 0; s < storeys; s++) {
    const plan = plans[s];
    const yBase = plinth + s * sh;
    for (const faceName of ['front', 'back', 'left', 'right']) {
      const face = faceOf[faceName];
      const spans = roomSpansOnFace(plan, faceName, main.w, main.d);
      for (const span of spans) {
        const room = span.room;
        const cfgWin = windowSpecFor(room.type, prog.type, s, commercial, industrial);
        if (!cfgWin) continue;
        const usable = span.b - span.a - 1.1;
        if (usable < cfgWin.w) continue;
        let n = clamp(Math.floor(usable / (cfgWin.w + cfgWin.gap)), 1, cfgWin.max);
        if (room.type === ROOM.BATH || room.type === ROOM.CLOSET) n = 1;
        const total = n * cfgWin.w + (n - 1) * cfgWin.gap;
        const start = span.a + (span.b - span.a - total) / 2;
        for (let i = 0; i < n; i++) {
          const u0 = start + i * (cfgWin.w + cfgWin.gap);
          openingsByFace[faceName].push({
            u0, u1: u0 + cfgWin.w,
            y0: yBase + cfgWin.sill, y1: yBase + cfgWin.sill + cfgWin.h,
            panel: pickWindowMat(),
            trim: M.trimAlt, trimWidth: 0.13,
            room, storey: s,
          });
        }
      }
    }
  }

  // The entrance: always on the front wall, always in the room the plan marked
  // as the entry, so it opens into circulation space rather than a bedroom.
  const entryRoom = plans[0].rooms.find((r) => r.entry) || plans[0].rooms[0];
  const doorW = commercial ? 1.65 : 1.02;
  const doorH = commercial ? 2.35 : 2.10;
  const eSpan = [Math.max(0.35, entryRoom.x0), Math.min(main.w - 0.35, entryRoom.x1)];
  let doorU = (eSpan[0] + eSpan[1]) / 2 - doorW / 2;
  doorU = clamp(doorU, 0.35, main.w - doorW - 0.35);
  const doorMat = lib.m(kit.door + sfx);
  openingsByFace.front.push({
    u0: doorU, u1: doorU + doorW, y0: plinth, y1: plinth + doorH,
    panel: doorMat, threshold: true, trim: M.trimAlt, trimWidth: 0.16, isDoor: true,
  });
  record.doorLocal = { x: doorU + doorW / 2, z: 0 };
  record.doorWorld = fp.toWorld(record.doorLocal.x, -0.6);

  // A back door on most buildings gives the infected a second way in.
  if (rng.chance(commercial || industrial ? 0.8 : 0.45)) {
    const bu = clamp(rng.range(0.2, 0.8) * main.w, 0.4, main.w - 1.4);
    openingsByFace.back.push({
      u0: bu, u1: bu + 1.0, y0: plinth, y1: plinth + 2.05,
      panel: lib.m((industrial ? 'door_metal' : 'door_wood_brown') + sfx),
      threshold: true, trim: M.trimAlt, isDoor: true, back: true,
    });
    record.backDoorWorld = fp.toWorld(bu + 0.5, main.d + 0.6);
  }

  // --- exterior shell ------------------------------------------------------
  const innerWallMat = lib.m(interiorWallFor(prog.type, rng));
  const faces = [
    { name: 'front', x0: 0, z0: 0, x1: main.w, z1: 0 },
    { name: 'right', x0: main.w, z0: 0, x1: main.w, z1: main.d },
    { name: 'back', x0: main.w, z0: main.d, x1: 0, z1: main.d },
    { name: 'left', x0: 0, z0: main.d, x1: 0, z1: 0 },
  ];
  for (const f of faces) {
    // Openings are stored in each face's own left-to-right parameter; the back
    // and left faces run the opposite way, so flip them into wall space.
    const len = Math.hypot(f.x1 - f.x0, f.z1 - f.z0);
    const list = openingsByFace[f.name].map((o) => {
      const flip = (f.name === 'back' || f.name === 'left');
      return flip ? Object.assign({}, o, { u0: len - o.u1, u1: len - o.u0 }) : o;
    });
    wallShell(mb, { x0: f.x0, z0: f.z0, x1: f.x1, z1: f.z1, y0: plinth, h: sh * storeys },
      list, { outer: M.wall, inner: innerWallMat, reveal: M.trim });
  }

  // --- storey bands, corner boards, water table ---------------------------
  const cb = 0.14;
  for (const [cx, cz] of [[0, 0], [main.w, 0], [0, main.d], [main.w, main.d]]) {
    mb.box(cx - cb, plinth, cz - cb, cx + cb, eaveY, cz + cb, M.trim, { skip: 'top bottom', vAlign: true, maxEdge: 5 });
  }
  mb.box(-0.06, plinth, -0.06, main.w + 0.06, plinth + 0.20, main.d + 0.06, M.trim, { skip: 'top bottom', noTess: true });
  if (commercial && storeys > 1) {
    for (let s = 1; s < storeys; s++) {
      const y = plinth + s * sh;
      mb.box(-0.09, y - 0.16, -0.09, main.w + 0.09, y + 0.06, main.d + 0.09, M.trimAlt, { skip: 'top bottom', noTess: true });
    }
  }

  // --- roof ----------------------------------------------------------------
  const roofMats = { roof: M.roof, wall: M.wall, trim: M.trim, coping: M.coping, gable: M.wall };
  let roofInfo;
  const style = roofStyleFor(prog.type, commercial, industrial, rng);
  if (style === 'flat') {
    roofInfo = flatRoof(mb, main, eaveY, roofMats, { parapet: rng.range(0.7, 1.25) });
    const n = Math.max(1, Math.round((main.w * main.d) / 90));
    for (let i = 0; i < n; i++) {
      hvacUnit(mb, rng.range(main.x0 + 1.4, main.x1 - 1.4), rng.range(main.z0 + 1.4, main.z1 - 1.4), eaveY, roofMats2(M), rng);
    }
    for (let i = 0; i < rng.int(1, 3); i++) {
      roofVent(mb, rng.range(main.x0 + 1, main.x1 - 1), rng.range(main.z0 + 1, main.z1 - 1), eaveY, roofMats2(M), rng);
    }
    // Roof access hatch — the reason a rooftop is worth reaching.
    mb.box(main.x1 - 2.4, eaveY, main.z1 - 2.4, main.x1 - 1.2, eaveY + 0.9, main.z1 - 1.2, M.metalDark, { skip: 'bottom' });
  } else if (style === 'shed') {
    roofInfo = shedRoof(mb, main, eaveY, rng.range(8, 15), roofMats);
  } else if (style === 'hip') {
    roofInfo = hipRoof(mb, main, eaveY, rng.range(ctx.cfg.roofPitchMin, ctx.cfg.roofPitchMax), roofMats);
    guttering(mb, main, eaveY, M, roofInfo.alongX);
  } else {
    roofInfo = gableRoof(mb, main, eaveY, rng.range(ctx.cfg.roofPitchMin, ctx.cfg.roofPitchMax), roofMats);
    guttering(mb, main, eaveY, M, roofInfo.alongX);
  }
  record.roofTop = roofInfo.top;
  record.roofFlat = !!roofInfo.flat;

  // Chimney, positioned over the fireplace the plan reserved (or a gable end).
  if (!industrial && rng.chance(commercial ? 0.35 : 0.85)) {
    const fire = plans[0].fireplace;
    const cx = fire ? fire.x : (rng.chance(0.5) ? main.x0 + 0.9 : main.x1 - 0.9);
    const cz = fire ? fire.z : main.d * rng.range(0.3, 0.7);
    const baseY = eaveY - 0.3;
    chimney(mb, clamp(cx, main.x0 + 0.7, main.x1 - 0.7), clamp(cz, main.z0 + 0.7, main.z1 - 0.7),
      baseY, roofInfo.top + rng.range(0.7, 1.5), M, rng);
  }

  // --- secondary masses ---------------------------------------------------
  for (const m of fp.masses) {
    if (m.kind === 'main') continue;
    if (m.kind === 'porch') { buildPorch(mb, m, plinth, M, lib, rng, foundDrop); continue; }
    if (m.kind === 'tower') { buildTower(mb, m, plinth, eaveY, prog.type, M, lib, rng, ctx); continue; }
    const mh = m.kind === 'garage' ? rng.range(2.5, 3.1) : sh * Math.min(storeys, m.kind === 'wing' ? 1 : storeys);
    const top = plinth + mh;
    const wingFaces = [
      { x0: m.x0, z0: m.z0, x1: m.x1, z1: m.z0 },
      { x0: m.x1, z0: m.z0, x1: m.x1, z1: m.z1 },
      { x0: m.x1, z0: m.z1, x1: m.x0, z1: m.z1 },
      { x0: m.x0, z0: m.z1, x1: m.x0, z1: m.z0 },
    ];
    const wingOpenings = [[], [], [], []];
    if (m.kind === 'garage') {
      const gw = Math.min(2.7, m.w - 0.7);
      wingOpenings[0].push({
        u0: (m.w - gw) / 2, u1: (m.w + gw) / 2, y0: plinth, y1: plinth + Math.min(2.25, mh - 0.35),
        panel: lib.m('door_garage' + sfx), threshold: true, trim: M.trimAlt,
      });
    } else {
      // A wing still gets windows, one per exterior face that is wide enough.
      for (let i = 0; i < 4; i++) {
        const len = i % 2 === 0 ? m.w : m.d;
        if (len < 2.6 || (i === 0 && m.kind === 'wing')) continue;
        wingOpenings[i].push({
          u0: len / 2 - 0.55, u1: len / 2 + 0.55, y0: plinth + 1.0, y1: plinth + 2.2,
          panel: pickWindowMat(), trim: M.trimAlt,
        });
      }
    }
    for (let i = 0; i < 4; i++) {
      wallShell(mb, { ...wingFaces[i], y0: plinth, h: mh }, wingOpenings[i],
        { outer: M.wall, inner: innerWallMat, reveal: M.trim });
    }
    if (m.kind === 'garage' || rng.chance(0.4)) shedRoof(mb, m, top, rng.range(10, 18), roofMats);
    else gableRoof(mb, m, top, rng.range(28, 40), roofMats, { eave: 0.38 });
  }

  // --- shopfront dressing --------------------------------------------------
  if (commercial && ['shop', 'diner', 'bar', 'hardware', 'pharmacy', 'laundromat', 'bank'].includes(prog.type)) {
    const signMat = lib.m(rng.pick(['sign_shop', 'sign_shop2']) + '');
    const y = plinth + sh - 0.95;
    mb.box(0.35, y, -0.34, main.w - 0.35, y + 0.72, -0.16, signMat, { skip: 'bottom' });
    mb.box(0.30, y - 0.06, -0.40, main.w - 0.30, y, -0.10, M.trimAlt, { skip: 'top' });
    // Awning over the pavement.
    if (rng.chance(0.55)) {
      const aw = rng.range(1.0, 1.6);
      const fabric = lib.m(rng.pick(['prop_fabric_red', 'prop_fabric_blue', 'prop_fabric_green']), 1.4);
      mb.slope([0.4, plinth + 2.9, 0], [main.w - 0.4, plinth + 2.9, 0],
        [main.w - 0.4, plinth + 2.45, -aw], [0.4, plinth + 2.45, -aw], fabric);
      mb.slope([0.4, plinth + 2.45, -aw], [main.w - 0.4, plinth + 2.45, -aw],
        [main.w - 0.4, plinth + 2.9, 0], [0.4, plinth + 2.9, 0], fabric, { flip: true });
      mb.box(0.4, plinth + 2.30, -aw - 0.04, main.w - 0.4, plinth + 2.45, -aw + 0.04, M.trimAlt);
    }
  }

  // --- posted notices and graffiti ----------------------------------------
  if (rng.chance(0.5)) {
    const sm = lib.m(rng.pick(['sign_notice', 'sign_poster']));
    const px = clamp(doorU + rng.range(-1.6, 1.9), 0.3, main.w - 0.9);
    mb.quadMat([px, plinth + 1.3, -0.02], [px + 0.55, plinth + 1.3, -0.02],
      [px + 0.55, plinth + 2.05, -0.02], [px, plinth + 2.05, -0.02], sm, [0, 0, -1], { noTess: true });
  }

  mb.pop();

  // --- collision, floors, nav, spawns -------------------------------------
  registerBuildingCollision(record, ctx, openingsByFace, main, innerWallMat);

  // --- interior fit-out ----------------------------------------------------
  // Daylight leaks in through every opening. Baking a small point light just
  // inside each one is what makes rooms brighten toward their windows and go
  // black in the middle of the plan.
  const env = ctx.env;
  const prevLights = env ? env.lights : null;
  const prevIndoor = env ? env.indoor : 0;
  if (env) {
    const wl = [];
    const faceOrigin = {
      front: (u) => ({ x: u, z: 0.45 }),
      back: (u) => ({ x: u, z: main.d - 0.45 }),
      left: (u) => ({ x: 0.45, z: u }),
      right: (u) => ({ x: main.w - 0.45, z: u }),
    };
    for (const name of ['front', 'back', 'left', 'right']) {
      for (const o of openingsByFace[name]) {
        const l = faceOrigin[name]((o.u0 + o.u1) / 2);
        const p = fp.toWorld(l.x, l.z);
        const strength = o.isDoor ? 0.95 : 0.72;
        wl.push({
          x: p.x, y: (o.y0 + o.y1) / 2, z: p.z,
          r: o.isDoor ? 7.5 : 6.2,
          c: [0.46 * strength, 0.49 * strength, 0.55 * strength],
        });
      }
    }
    env.lights = wl;
    env.indoor = 1;
    record.windowLights = wl;
  }

  mb.push(fp.origin.x, baseY, fp.origin.z, fp.yaw);
  for (let s = 0; s < storeys; s++) {
    furnishFloor(plans[s], {
      ...ctx, record, storey: s, y: plinth + s * sh, storeyHeight: sh,
      mass: main, decay, prog, commercial, industrial,
      wallMat: innerWallMat, isTop: s === storeys - 1,
    });
  }
  mb.pop();
  if (env) { env.lights = prevLights; env.indoor = prevIndoor; }

  return record;
}

function roofMats2(M) {
  return { hvac: M.hvac, metalDark: M.metalDark };
}

function roofStyleFor(type, commercial, industrial, rng) {
  if (industrial) return rng.chance(0.55) ? 'flat' : 'shed';
  if (type === 'church' || type === 'barn' || type === 'farmhouse') return 'gable';
  if (type === 'library' || type === 'townhall' || type === 'school') return rng.chance(0.5) ? 'hip' : 'flat';
  if (commercial) return rng.chance(0.82) ? 'flat' : 'gable';
  return rng.chance(0.42) ? 'hip' : 'gable';
}

function interiorWallFor(type, rng) {
  if (['warehouse', 'factory', 'workshop', 'depot', 'barn'].includes(type)) return 'wall_ind';
  if (['shop', 'office', 'bank', 'pharmacy', 'laundromat', 'supermarket', 'hardware'].includes(type)) {
    return rng.pick(['wall_shop', 'wall_plaster']);
  }
  if (['library', 'townhall', 'church'].includes(type)) return rng.pick(['wall_panel_wood', 'wall_plaster']);
  return rng.pick(['wall_paper_floral', 'wall_paper_stripe', 'wall_paper_blue', 'wall_plaster']);
}

/** Window dimensions by what the room is actually for. */
function windowSpecFor(roomType, progType, storey, commercial, industrial) {
  if (roomType === ROOM.CLOSET || roomType === ROOM.STAIR) return null;
  if (industrial) return { w: 1.5, h: 1.5, sill: 2.6, gap: 1.5, max: 4 };
  if (commercial && storey === 0 && (roomType === ROOM.RETAIL || roomType === ROOM.LOBBY)) {
    return { w: 2.3, h: 2.15, sill: 0.72, gap: 0.42, max: 3 };
  }
  switch (roomType) {
    case ROOM.BATH: return { w: 0.62, h: 0.72, sill: 1.62, gap: 0.9, max: 1 };
    case ROOM.KITCHEN: return { w: 1.15, h: 1.05, sill: 1.20, gap: 0.9, max: 2 };
    case ROOM.LIVING: return { w: 1.45, h: 1.45, sill: 0.88, gap: 0.75, max: 2 };
    case ROOM.BEDROOM: return { w: 1.15, h: 1.30, sill: 0.95, gap: 0.85, max: 2 };
    case ROOM.OFFICE: return { w: 1.30, h: 1.50, sill: 0.92, gap: 0.7, max: 3 };
    case ROOM.STOCK: return { w: 0.8, h: 0.8, sill: 2.1, gap: 1.2, max: 2 };
    case ROOM.HALL: return { w: 0.85, h: 1.35, sill: 1.0, gap: 1.0, max: 1 };
    case ROOM.RETAIL: return { w: 1.6, h: 1.6, sill: 0.95, gap: 0.7, max: 2 };
    case ROOM.LOBBY: return { w: 1.4, h: 1.6, sill: 0.9, gap: 0.7, max: 2 };
    case ROOM.WORKFLOOR: return { w: 1.5, h: 1.4, sill: 2.2, gap: 1.4, max: 3 };
    default: return { w: 1.15, h: 1.35, sill: 0.95, gap: 0.85, max: 2 };
  }
}

/**
 * Which stretches of a given exterior face belong to which room. This is the
 * link that makes fenestration honest.
 */
function roomSpansOnFace(plan, faceName, w, d, eps = 0.25) {
  const spans = [];
  for (const room of plan.rooms) {
    if (room.type === ROOM.STAIR) continue;
    let a, b, touches = false;
    if (faceName === 'front') { touches = room.z0 <= eps; a = room.x0; b = room.x1; }
    else if (faceName === 'back') { touches = room.z1 >= d - eps; a = room.x0; b = room.x1; }
    else if (faceName === 'left') { touches = room.x0 <= eps; a = room.z0; b = room.z1; }
    else { touches = room.x1 >= w - eps; a = room.z0; b = room.z1; }
    if (!touches) continue;
    if (b - a < 1.4) continue;
    spans.push({ a, b, room });
  }
  return spans;
}

// --- porches, towers -------------------------------------------------------

function buildPorch(mb, m, plinth, M, lib, rng, drop = 0.5) {
  const deckY = plinth;
  const h = rng.range(2.5, 2.9);
  // Deck.
  mb.box(m.x0, deckY - 0.18, m.z0, m.x1, deckY, m.z1, M.trim, { skip: 'bottom' });
  // Skirt, carried down to the same depth as the foundation so a porch on a
  // falling site does not hang in the air.
  mb.box(m.x0, -drop, m.z0, m.x1, deckY - 0.18, m.z1, M.foundation, { skip: 'top bottom' });
  // Posts.
  const n = Math.max(2, Math.round(m.w / 2.4));
  for (let i = 0; i <= n; i++) {
    const x = m.x0 + (m.w * i) / n;
    mb.box(x - 0.075, deckY, m.z0 + 0.06, x + 0.075, deckY + h, m.z0 + 0.21, M.trim, { skip: 'top bottom' });
  }
  // Railing.
  mb.box(m.x0, deckY + 0.85, m.z0 + 0.06, m.x1, deckY + 0.96, m.z0 + 0.18, M.trim);
  for (let x = m.x0 + 0.2; x < m.x1 - 0.1; x += 0.24) {
    mb.box(x, deckY, m.z0 + 0.10, x + 0.05, deckY + 0.85, m.z0 + 0.15, M.trim, { skip: 'top bottom' });
  }
  // Porch roof.
  mb.slope([m.x0 - 0.25, deckY + h, m.z0 - 0.25], [m.x1 + 0.25, deckY + h, m.z0 - 0.25],
    [m.x1 + 0.25, deckY + h + 0.55, m.z1], [m.x0 - 0.25, deckY + h + 0.55, m.z1], M.roof);
  mb.box(m.x0 - 0.25, deckY + h - 0.2, m.z0 - 0.3, m.x1 + 0.25, deckY + h, m.z0 - 0.2, M.trim, { skip: 'top bottom' });
  // Steps down to the path.
  const steps = 3;
  for (let i = 0; i < steps; i++) {
    const y = deckY - (deckY / steps) * (i + 1);
    mb.box(m.x0 + m.w * 0.3, y, m.z0 - 0.32 * (i + 1), m.x0 + m.w * 0.3 + 1.3, y + deckY / steps, m.z0 - 0.32 * i,
      M.foundation, { skip: 'bottom' });
  }
}

function buildTower(mb, m, plinth, eaveY, type, M, lib, rng, ctx) {
  const isChurch = type === 'church';
  const h = isChurch ? eaveY + rng.range(7, 11) : eaveY + rng.range(3.2, 5.5);
  const faces = [
    { x0: m.x0, z0: m.z0, x1: m.x1, z1: m.z0 },
    { x0: m.x1, z0: m.z0, x1: m.x1, z1: m.z1 },
    { x0: m.x1, z0: m.z1, x1: m.x0, z1: m.z1 },
    { x0: m.x0, z0: m.z1, x1: m.x0, z1: m.z0 },
  ];
  const louvre = lib.m(isChurch ? 'win_church' : 'win_office');
  for (let i = 0; i < 4; i++) {
    const len = i % 2 === 0 ? m.w : m.d;
    const ops = [];
    if (len > 1.8) {
      ops.push({ u0: len / 2 - 0.45, u1: len / 2 + 0.45, y0: h - 2.6, y1: h - 1.1, panel: louvre, trim: M.trimAlt });
      if (isChurch) ops.push({ u0: len / 2 - 0.5, u1: len / 2 + 0.5, y0: plinth + 3.4, y1: plinth + 5.4, panel: louvre, trim: M.trimAlt });
    }
    if (i === 0 && isChurch) {
      ops.push({ u0: len / 2 - 0.9, u1: len / 2 + 0.9, y0: plinth, y1: plinth + 2.6, panel: lib.m('door_wood_brown'), threshold: true, trim: M.trimAlt });
    }
    wallShell(mb, { ...faces[i], y0: plinth, h: h - plinth }, ops, { outer: M.wall, inner: M.wall, reveal: M.trim });
  }
  // Clock face on the two street-facing sides — the town's wayfinding landmark.
  if (!isChurch) {
    const cm = lib.m('sign_notice');
    mb.quadMat([m.x0 + 0.4, h - 2.4, m.z0 - 0.03], [m.x1 - 0.4, h - 2.4, m.z0 - 0.03],
      [m.x1 - 0.4, h - 0.7, m.z0 - 0.03], [m.x0 + 0.4, h - 0.7, m.z0 - 0.03], cm, [0, 0, -1], { noTess: true });
  }
  // Cap: a spire for the church, a pyramid cap otherwise.
  const capH = isChurch ? rng.range(5.5, 8) : 1.6;
  const cx = (m.x0 + m.x1) / 2, cz = (m.z0 + m.z1) / 2;
  const o = 0.28;
  const rm = isChurch ? M.roof : M.roof;
  mb.slope([m.x0 - o, h, m.z0 - o], [m.x1 + o, h, m.z0 - o], [cx, h + capH, cz], [cx, h + capH, cz], rm);
  mb.slope([m.x1 + o, h, m.z1 + o], [m.x0 - o, h, m.z1 + o], [cx, h + capH, cz], [cx, h + capH, cz], rm);
  mb.slope([m.x1 + o, h, m.z0 - o], [m.x1 + o, h, m.z1 + o], [cx, h + capH, cz], [cx, h + capH, cz], rm);
  mb.slope([m.x0 - o, h, m.z1 + o], [m.x0 - o, h, m.z0 - o], [cx, h + capH, cz], [cx, h + capH, cz], rm);
  if (isChurch) {
    mb.box(cx - 0.06, h + capH, cz - 0.06, cx + 0.06, h + capH + 1.5, cz + 0.06, M.metalDark);
    mb.box(cx - 0.35, h + capH + 0.95, cz - 0.05, cx + 0.35, h + capH + 1.05, cz + 0.05, M.metalDark);
  }
  return h + capH;
}

// --- collision -------------------------------------------------------------

/**
 * Register solid geometry with the physics world: wall segments split around
 * doorways, floor plates per storey, and the roof deck if it is flat.
 */
function registerBuildingCollision(record, ctx, openingsByFace, main, innerWallMat) {
  const { collision, cfg } = ctx;
  const fp = record.lot.footprint;
  const toW = fp.toWorld;
  const doorways = ctx.doorways;
  const baseY = record.baseY || 0;

  // Every doorway is registered for the navigation grid. Wall rasterisation
  // alone closes a 1 m gap, so these have to be carved back open explicitly.
  const noteDoor = (lx, lz, w) => {
    if (!doorways) return;
    const p = toW(lx, lz);
    doorways.push({ x: p.x, z: p.z, r: Math.max(0.8, w * 0.6) });
  };
  const face = { front: (u) => [u, 0], back: (u) => [u, main.d], left: () => null, right: () => null };
  for (const name of ['front', 'back']) {
    for (const o of openingsByFace[name]) {
      if (!o.isDoor) continue;
      const u = (o.u0 + o.u1) / 2;
      const l = face[name](u);
      // Three points through the opening so the corridor of open cells is
      // continuous from outside to inside.
      const inward = name === 'front' ? 1 : -1;
      for (const off of [-1.1, 0, 1.3]) noteDoor(l[0], l[1] + off * inward, o.u1 - o.u0);
    }
  }
  const top = record.plinth + record.storeyHeight * record.storeys;

  const addWall = (lx0, lz0, lx1, lz1, y0, y1, gaps) => {
    const len = Math.hypot(lx1 - lx0, lz1 - lz0);
    const ranges = [[0, len]];
    for (const g of gaps || []) {
      for (let i = ranges.length - 1; i >= 0; i--) {
        const [a, b] = ranges[i];
        if (g.u1 <= a || g.u0 >= b) continue;
        ranges.splice(i, 1);
        if (g.u0 > a) ranges.push([a, g.u0]);
        if (g.u1 < b) ranges.push([g.u1, b]);
      }
    }
    for (const [a, b] of ranges) {
      if (b - a < 0.06) continue;
      const t0 = a / len, t1 = b / len;
      const p = toW(lerp(lx0, lx1, t0), lerp(lz0, lz1, t0));
      const q = toW(lerp(lx0, lx1, t1), lerp(lz0, lz1, t1));
      collision.addSegment(p.x, p.z, q.x, q.z, baseY + y0, baseY + y1, 'wall');
    }
  };

  // Doorways are the only gaps you can walk through; windows are not.
  const doorGaps = (name) => openingsByFace[name]
    .filter((o) => o.isDoor)
    .map((o) => ({ u0: o.u0 - 0.02, u1: o.u1 + 0.02 }));

  const w = main.w, d = main.d;
  // Walls start at -foundDrop so a building cut into a hillside is still solid
  // where its uphill wall is buried.
  const wallBase = -record.foundDrop;
  addWall(0, 0, w, 0, wallBase, top, doorGaps('front'));
  addWall(w, 0, w, d, wallBase, top, []);
  addWall(w, d, 0, d, wallBase, top, doorGaps('back').map((g) => ({ u0: w - g.u1, u1: w - g.u0 })));
  addWall(0, d, 0, 0, wallBase, top, []);

  for (const m of record.masses) {
    if (m.kind === 'main' || m.kind === 'porch') continue;
    const c = m.corners;
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4];
      collision.addSegment(a.x, a.z, b.x, b.z, baseY + wallBase, baseY + record.plinth + 3.0, 'wall');
    }
  }

  // Floor plates.
  const poly = main.corners;
  for (let s = 0; s <= record.storeys; s++) {
    const y = baseY + record.plinth + s * record.storeyHeight;
    if (s === record.storeys && !record.roofFlat) break;
    collision.addFloor(poly, y, record.id);
  }
  record.aabb = aabbOf(record.masses);
}

function aabbOf(masses) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const m of masses) {
    for (const c of m.corners) {
      if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x;
      if (c.z < minZ) minZ = c.z; if (c.z > maxZ) maxZ = c.z;
    }
  }
  return { minX, maxX, minZ, maxZ };
}

export { wallShell, gableRoof, hipRoof, flatRoof, shedRoof, chimney, hvacUnit, roofVent };
