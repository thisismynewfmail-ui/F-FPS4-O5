// ---------------------------------------------------------------------------
// props.js — everything that isn't a wall.
//
// Two families live here:
//
//  * Interior amenities. The brief asks for interiors that reflect the daily
//    lives of the people who left, so the residential set covers sleeping,
//    cooking, washing and sitting; the commercial set covers selling and
//    storing; the industrial set covers making and moving.
//  * Street-level infrastructure. Traffic signals, bus shelters, hydrants,
//    manholes, utility poles and their drooping wires. These are cheap in
//    polygons and they are what makes a street read as a street.
//
// Every prop is authored in local space (origin at its footprint centre, +Z
// forward) and placed through the mesh builder's transform stack. Solid props
// register collision through `ctx.solid`.
// ---------------------------------------------------------------------------

import { TAU, clamp, lerp } from '../core/math.js';

/**
 * Register an oriented box as collision, in world space.
 *
 * `y0`/`y1` are LOCAL to the mesh builder's current frame and are lifted by
 * its accumulated translation, exactly like the geometry they belong to. That
 * matters twice over: props now stand on sloping terrain rather than on the
 * datum, and a wardrobe on the second floor stops being a solid block sitting
 * in the hallway underneath it.
 *
 * Props shorter than head height are tagged `furniture` so the navigation grid
 * treats them as an obstruction to squeeze past rather than a wall — see
 * nav.js for why that distinction has to exist.
 */
export function solidBox(ctx, mb, cx, cz, w, d, y0, y1, yaw = 0, tag) {
  if (!ctx.collision) return;
  const hw = w / 2, hd = d / 2;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const base = mb.ty;
  const pts = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([lx, lz]) => {
    const rx = lx * c + lz * s, rz = -lx * s + lz * c;
    return mb.worldPoint(cx + rx, 0, cz + rz);
  });
  const t = tag || (y1 - y0 < 1.9 ? 'furniture' : 'prop');
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4];
    ctx.collision.addSegment(a.x, a.z, b.x, b.z, base + y0, base + y1, t);
  }
}

const M = (ctx, name, tile) => ctx.lib.m(name, tile);

// ---------------------------------------------------------------------------
// Residential
// ---------------------------------------------------------------------------

export function bed(mb, ctx, x, z, yaw, rng, o = {}) {
  const w = o.double ? 1.45 : 0.95, d = 2.02;
  const frame = M(ctx, rng.pick(['prop_wood', 'prop_wood_dark']), 1.0);
  const sheet = M(ctx, rng.pick(['prop_fabric_blue', 'prop_fabric_brown', 'prop_fabric_green', 'prop_white']), 1.6);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0.14, 0, w, 0.30, d, frame);                       // base
  mb.boxC(0, 0.44, 0, w - 0.06, 0.22, d - 0.10, sheet);          // mattress
  mb.boxC(0, 0.60, -d / 2 + 0.22, w * 0.62, 0.12, 0.34, M(ctx, 'prop_white', 0.8)); // pillow
  mb.boxC(0, 0.30, -d / 2 + 0.03, w, 0.62, 0.07, frame);         // headboard
  mb.boxC(0, 0.30, d / 2 - 0.03, w, 0.24, 0.07, frame);          // footboard
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    mb.boxC(sx * (w / 2 - 0.07), 0, sz * (d / 2 - 0.07), 0.08, 0.14, 0.08, frame);
  }
  mb.pop();
  solidBox(ctx, mb, x, z, w, d, 0, 0.66, yaw);
}

export function dresser(mb, ctx, x, z, yaw, rng) {
  const w = rng.range(0.9, 1.3), h = rng.range(0.8, 1.15), d = 0.48;
  const wood = M(ctx, rng.pick(['prop_wood', 'prop_wood_dark', 'prop_wood_pale']), 1.0);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0, w, h, d, wood);
  const drawers = Math.round(h / 0.26);
  for (let i = 0; i < drawers; i++) {
    const y = 0.06 + i * ((h - 0.12) / drawers);
    mb.boxC(0, y, -d / 2 - 0.015, w - 0.10, (h - 0.12) / drawers - 0.04, 0.03, M(ctx, 'prop_wood_dark', 0.7));
    mb.boxC(0, y + 0.06, -d / 2 - 0.03, 0.14, 0.03, 0.03, M(ctx, 'prop_chrome', 0.4));
  }
  mb.pop();
  solidBox(ctx, mb, x, z, w, d, 0, h, yaw);
  if (ctx.loot) ctx.loot.push({ p: mb.worldPoint(x, h + 0.05, z), kind: 'drawer' });
}

export function nightstand(mb, ctx, x, z, yaw, rng) {
  const wood = M(ctx, 'prop_wood', 0.8);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0.06, 0, 0.44, 0.52, 0.40, wood);
  mb.boxC(0, 0, 0, 0.36, 0.06, 0.34, wood);
  if (rng.chance(0.5)) tableLamp(mb, ctx, 0, 0.58, 0, rng);
  mb.pop();
  solidBox(ctx, mb, x, z, 0.46, 0.42, 0, 0.58, yaw);
}

export function tableLamp(mb, ctx, x, y, z, rng) {
  mb.boxC(x, y, z, 0.16, 0.03, 0.16, M(ctx, 'prop_darksteel', 0.4));
  mb.boxC(x, y + 0.03, z, 0.04, 0.22, 0.04, M(ctx, 'prop_chrome', 0.4));
  mb.boxC(x, y + 0.25, z, 0.26, 0.20, 0.26, M(ctx, 'prop_paper', 0.6));
}

export function wardrobe(mb, ctx, x, z, yaw, rng) {
  const w = rng.range(1.0, 1.4), h = 1.95, d = 0.58;
  const wood = M(ctx, rng.pick(['prop_wood_dark', 'prop_wood']), 1.2);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0, w, h, d, wood);
  mb.boxC(-w / 4, 0.12, -d / 2 - 0.02, w / 2 - 0.06, h - 0.24, 0.03, M(ctx, 'prop_wood_pale', 0.9));
  mb.boxC(w / 4, 0.12, -d / 2 - 0.02, w / 2 - 0.06, h - 0.24, 0.03, M(ctx, 'prop_wood_pale', 0.9));
  mb.boxC(-0.05, 1.0, -d / 2 - 0.04, 0.03, 0.12, 0.03, M(ctx, 'prop_chrome', 0.3));
  mb.boxC(0.05, 1.0, -d / 2 - 0.04, 0.03, 0.12, 0.03, M(ctx, 'prop_chrome', 0.3));
  mb.pop();
  solidBox(ctx, mb, x, z, w, d, 0, h, yaw);
  if (ctx.spawns) ctx.spawns.push({ p: mb.worldPoint(x, 0, z + 0.5), kind: 'closet' });
}

export function bookshelf(mb, ctx, x, z, yaw, rng, o = {}) {
  const w = o.w ?? rng.range(0.85, 1.25), h = o.h ?? rng.range(1.3, 2.05), d = 0.32;
  const wood = M(ctx, rng.pick(['prop_wood', 'prop_wood_dark']), 1.0);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0, w, h, d, wood, { skip: 'nz' });
  const shelves = Math.max(2, Math.round(h / 0.36));
  for (let i = 1; i < shelves; i++) {
    const y = (h / shelves) * i;
    mb.boxC(0, y, -d / 2 + 0.02, w - 0.06, 0.03, d - 0.04, wood);
    // Books, batched into a few blocks with gaps between them. Modelling each
    // spine individually cost more triangles than the entire building shell.
    let bx = -w / 2 + 0.06;
    const runs = rng.int(2, 4);
    for (let k = 0; k < runs && bx < w / 2 - 0.12; k++) {
      const bw = Math.min(rng.range(0.10, 0.34), w / 2 - 0.10 - bx);
      if (bw < 0.05) break;
      mb.boxC(bx + bw / 2, y + 0.03, -d / 2 + 0.13, bw, rng.range(0.16, 0.27), 0.20,
        M(ctx, rng.pick(['prop_red', 'prop_blue', 'prop_green', 'prop_wood_dark', 'prop_black', 'prop_yellow']), 0.5),
        { noTess: true });
      bx += bw + rng.range(0.03, 0.14);
    }
  }
  mb.pop();
  solidBox(ctx, mb, x, z, w, d, 0, h, yaw);
  if (ctx.loot) ctx.loot.push({ p: mb.worldPoint(x, 0.9, z), kind: 'shelf' });
}

export function sofa(mb, ctx, x, z, yaw, rng) {
  const w = rng.range(1.8, 2.2), d = 0.88;
  const fab = M(ctx, rng.pick(['prop_fabric_brown', 'prop_fabric_green', 'prop_fabric_blue', 'prop_fabric_red']), 1.4);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0.12, 0, w, 0.30, d, fab);
  mb.boxC(0, 0.42, 0.02, w - 0.30, 0.14, d - 0.22, fab);
  mb.boxC(0, 0.42, d / 2 - 0.12, w, 0.50, 0.24, fab);           // back
  mb.boxC(-w / 2 + 0.11, 0.42, 0, 0.22, 0.30, d, fab);          // arms
  mb.boxC(w / 2 - 0.11, 0.42, 0, 0.22, 0.30, d, fab);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    mb.boxC(sx * (w / 2 - 0.10), 0, sz * (d / 2 - 0.10), 0.07, 0.12, 0.07, M(ctx, 'prop_wood_dark', 0.4));
  }
  mb.pop();
  solidBox(ctx, mb, x, z, w, d, 0, 0.8, yaw);
}

export function armchair(mb, ctx, x, z, yaw, rng) {
  const fab = M(ctx, rng.pick(['prop_fabric_brown', 'prop_fabric_red', 'prop_fabric_green']), 1.2);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0.12, 0, 0.86, 0.28, 0.84, fab);
  mb.boxC(0, 0.40, 0.32, 0.86, 0.52, 0.20, fab);
  mb.boxC(-0.36, 0.40, 0, 0.16, 0.26, 0.84, fab);
  mb.boxC(0.36, 0.40, 0, 0.16, 0.26, 0.84, fab);
  mb.pop();
  solidBox(ctx, mb, x, z, 0.9, 0.88, 0, 0.8, yaw);
}

export function coffeeTable(mb, ctx, x, z, yaw, rng) {
  const wood = M(ctx, 'prop_wood', 0.8);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0.38, 0, 1.05, 0.06, 0.56, wood);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    mb.boxC(sx * 0.44, 0, sz * 0.22, 0.06, 0.38, 0.06, wood);
  }
  if (rng.chance(0.6)) mb.boxC(rng.range(-0.3, 0.3), 0.44, rng.range(-0.15, 0.15), 0.20, 0.02, 0.26, M(ctx, 'prop_paper', 0.4));
  mb.pop();
  solidBox(ctx, mb, x, z, 1.05, 0.56, 0, 0.44, yaw);
}

export function crtTV(mb, ctx, x, z, yaw, rng, o = {}) {
  const y = o.y ?? 0.62;
  mb.push(x, 0, z, yaw);
  mb.boxC(0, y, 0, 0.62, 0.50, 0.52, M(ctx, 'prop_black', 0.8));
  mb.boxC(0, y + 0.06, -0.27, 0.50, 0.36, 0.02, M(ctx, 'prop_screen'));
  mb.boxC(0.22, y + 0.06, -0.27, 0.05, 0.05, 0.03, M(ctx, 'prop_chrome', 0.3));
  if (!o.onStand) {
    mb.boxC(0, 0, 0, 0.72, y, 0.48, M(ctx, 'prop_wood_dark', 0.9));    // stand
  }
  mb.pop();
  solidBox(ctx, mb, x, z, 0.72, 0.52, 0, y + 0.5, yaw);
}

export function diningTable(mb, ctx, x, z, yaw, rng) {
  const w = rng.range(1.3, 1.9), d = rng.range(0.8, 1.0);
  const wood = M(ctx, rng.pick(['prop_wood', 'prop_wood_dark']), 1.0);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0.72, 0, w, 0.06, d, wood);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    mb.boxC(sx * (w / 2 - 0.10), 0, sz * (d / 2 - 0.10), 0.08, 0.72, 0.08, wood);
  }
  mb.pop();
  solidBox(ctx, mb, x, z, w, d, 0, 0.78, yaw);
  // Chairs around it — a couple knocked over.
  const n = rng.int(2, 4);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rng.range(-0.3, 0.3);
    const cx = x + Math.cos(a) * (w / 2 + 0.42);
    const cz = z + Math.sin(a) * (d / 2 + 0.42);
    chair(mb, ctx, cx, cz, a + Math.PI / 2, rng, { toppled: rng.chance(0.3) });
  }
}

export function chair(mb, ctx, x, z, yaw, rng, o = {}) {
  const wood = M(ctx, rng.pick(['prop_wood', 'prop_wood_dark']), 0.8);
  mb.push(x, 0, z, yaw);
  if (o.toppled) {
    mb.boxC(0, 0.05, 0, 0.42, 0.42, 0.05, wood);
    mb.boxC(0, 0.20, 0.20, 0.42, 0.05, 0.44, wood);
  } else {
    mb.boxC(0, 0.44, 0, 0.44, 0.05, 0.42, wood);
    mb.boxC(0, 0.49, 0.19, 0.42, 0.48, 0.05, wood);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      mb.boxC(sx * 0.18, 0, sz * 0.17, 0.05, 0.44, 0.05, wood);
    }
  }
  mb.pop();
  if (!o.toppled) solidBox(ctx, mb, x, z, 0.44, 0.42, 0, 0.5, yaw);
}

export function rug(mb, ctx, x, z, yaw, rng) {
  const w = rng.range(1.6, 2.6), d = rng.range(1.1, 1.8);
  const m = M(ctx, rng.pick(['floor_carpet_red', 'floor_carpet_green']), 1.6);
  mb.push(x, 0, z, yaw);
  mb.quadMat([-w / 2, 0.012, d / 2], [w / 2, 0.012, d / 2], [w / 2, 0.012, -d / 2], [-w / 2, 0.012, -d / 2],
    m, [0, 1, 0], { spanU: w, spanV: d });
  mb.pop();
}

// --- kitchen ---------------------------------------------------------------

export function counterRun(mb, ctx, x0, z0, x1, z1, rng, o = {}) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  if (len < 0.5) return;
  const yaw = Math.atan2(x1 - x0, z1 - z0);
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const body = M(ctx, rng.pick(['prop_wood', 'prop_white', 'prop_wood_pale']), 1.0);
  const top = M(ctx, 'prop_darksteel', 1.2);
  mb.push(cx, 0, cz, yaw);
  mb.boxC(0, 0, 0, 0.60, 0.86, len, body);
  mb.boxC(0, 0.86, 0, 0.64, 0.05, len + 0.02, top);
  mb.boxC(0, 0.91, 0.0, 0.06, 0.10, len + 0.02, body);       // splashback
  // Doors and handles.
  const n = Math.max(1, Math.round(len / 0.6));
  for (let i = 0; i < n; i++) {
    const lz = -len / 2 + (len / n) * (i + 0.5);
    mb.boxC(-0.31, 0.10, lz, 0.03, 0.68, (len / n) - 0.05, M(ctx, 'prop_wood_dark', 0.7));
    mb.boxC(-0.34, 0.66, lz, 0.03, 0.03, 0.14, M(ctx, 'prop_chrome', 0.3));
  }
  if (o.sink) {
    mb.boxC(0, 0.86, o.sinkAt ?? 0, 0.48, 0.03, 0.44, M(ctx, 'prop_chrome', 0.6));
    mb.boxC(0, 0.83, o.sinkAt ?? 0, 0.42, 0.04, 0.38, M(ctx, 'prop_darksteel', 0.5));
    mb.boxC(0.16, 0.91, o.sinkAt ?? 0, 0.04, 0.24, 0.04, M(ctx, 'prop_chrome', 0.3));
  }
  if (o.upper) {
    mb.boxC(0.02, 1.48, 0, 0.34, 0.72, len, body);
    for (let i = 0; i < n; i++) {
      const lz = -len / 2 + (len / n) * (i + 0.5);
      mb.boxC(-0.15, 1.52, lz, 0.03, 0.64, (len / n) - 0.05, M(ctx, 'prop_wood_dark', 0.7));
    }
  }
  mb.pop();
  solidBox(ctx, mb, cx, cz, 0.64, len, 0, 0.92, yaw);
  if (ctx.loot) ctx.loot.push({ p: mb.worldPoint(cx, 0.95, cz), kind: 'cabinet' });
}

export function fridge(mb, ctx, x, z, yaw, rng) {
  const m = M(ctx, rng.pick(['prop_white', 'prop_chrome']), 1.4);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0, 0.68, 1.72, 0.66, m);
  mb.boxC(0, 1.18, -0.34, 0.64, 0.50, 0.02, M(ctx, 'prop_chrome', 0.9));
  mb.boxC(0, 0.04, -0.34, 0.64, 1.10, 0.02, M(ctx, 'prop_chrome', 0.9));
  mb.boxC(0.24, 0.80, -0.36, 0.04, 0.30, 0.04, M(ctx, 'prop_darksteel', 0.3));
  mb.pop();
  solidBox(ctx, mb, x, z, 0.7, 0.68, 0, 1.72, yaw);
  if (ctx.loot) ctx.loot.push({ p: mb.worldPoint(x, 0.9, z), kind: 'fridge' });
}

export function stove(mb, ctx, x, z, yaw, rng) {
  const m = M(ctx, 'prop_white', 1.2);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0, 0.62, 0.88, 0.62, m);
  mb.boxC(0, 0.88, 0, 0.62, 0.04, 0.62, M(ctx, 'prop_black', 0.8));
  for (const sx of [-0.14, 0.14]) for (const sz of [-0.14, 0.14]) {
    mb.boxC(sx, 0.92, sz, 0.16, 0.015, 0.16, M(ctx, 'prop_darksteel', 0.2));
  }
  mb.boxC(0, 0.94, 0.24, 0.58, 0.20, 0.10, m);
  mb.boxC(0, 0.30, -0.32, 0.50, 0.42, 0.02, M(ctx, 'prop_screen'));
  mb.pop();
  solidBox(ctx, mb, x, z, 0.64, 0.64, 0, 1.14, yaw);
}

// --- bathroom --------------------------------------------------------------

export function toilet(mb, ctx, x, z, yaw, rng) {
  const p = M(ctx, 'prop_porcelain', 0.8);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0.02, 0.36, 0.38, 0.52, p);
  mb.boxC(0, 0.38, 0.02, 0.40, 0.06, 0.56, p);
  mb.boxC(0, 0, 0.30, 0.44, 0.78, 0.20, p);
  mb.pop();
  solidBox(ctx, mb, x, z, 0.44, 0.62, 0, 0.8, yaw);
}

export function basin(mb, ctx, x, z, yaw, rng) {
  const p = M(ctx, 'prop_porcelain', 0.8);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0.74, 0, 0.56, 0.18, 0.42, p);
  mb.boxC(0, 0.62, 0.10, 0.20, 0.12, 0.20, p);
  mb.boxC(0, 0.92, 0.14, 0.04, 0.16, 0.04, M(ctx, 'prop_chrome', 0.3));
  // Mirror cabinet above.
  mb.boxC(0, 1.30, 0.16, 0.56, 0.62, 0.16, M(ctx, 'prop_white', 0.8));
  mb.boxC(0, 1.34, 0.07, 0.48, 0.54, 0.02, M(ctx, 'prop_chrome', 1.2));
  mb.pop();
  solidBox(ctx, mb, x, z, 0.56, 0.42, 0.5, 0.92, yaw);
  if (ctx.loot) ctx.loot.push({ p: mb.worldPoint(x, 1.3, z), kind: 'medicine' });
}

export function bathtub(mb, ctx, x, z, yaw, rng) {
  const p = M(ctx, 'prop_porcelain', 1.4);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0, 0.72, 0.56, 1.62, p);
  mb.boxC(0, 0.50, 0, 0.60, 0.08, 1.48, M(ctx, 'prop_black', 1.0));  // dark water
  mb.boxC(0.0, 0.60, 0.74, 0.05, 0.18, 0.05, M(ctx, 'prop_chrome', 0.3));
  mb.pop();
  solidBox(ctx, mb, x, z, 0.74, 1.64, 0, 0.58, yaw);
}

// ---------------------------------------------------------------------------
// Commercial
// ---------------------------------------------------------------------------

export function shelvingUnit(mb, ctx, x, z, yaw, rng, o = {}) {
  const len = o.len ?? rng.range(1.8, 3.4);
  const h = o.h ?? rng.range(1.6, 2.1);
  const frame = M(ctx, rng.pick(['prop_steel', 'prop_darksteel']), 1.2);
  mb.push(x, 0, z, yaw);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    mb.boxC(sx * 0.44, 0, sz * (len / 2 - 0.05), 0.06, h, 0.06, frame);
  }
  const shelves = Math.max(3, Math.round(h / 0.45));
  for (let i = 0; i < shelves; i++) {
    const y = 0.12 + i * ((h - 0.2) / shelves);
    mb.boxC(0, y, 0, 0.92, 0.04, len, frame);
    // Stock: a few grouped blocks per shelf, thinning out as the shelves were
    // stripped. Grouped rather than per-item, for the triangle budget.
    const density = o.stocked ?? 0.55;
    let lz = -len / 2 + 0.1;
    const runs = Math.max(1, Math.round(3 * density));
    for (let k = 0; k < runs && lz < len / 2 - 0.2; k++) {
      const bw = Math.min(rng.range(0.25, 0.75), len / 2 - 0.15 - lz);
      if (bw < 0.08) break;
      mb.boxC(rng.range(-0.12, 0.12), y + 0.04, lz + bw / 2, rng.range(0.3, 0.6), rng.range(0.14, 0.30), bw,
        M(ctx, rng.pick(['prop_crate', 'prop_paper', 'prop_red', 'prop_blue', 'prop_yellow', 'prop_white']), 0.6),
        { noTess: true });
      lz += bw + rng.range(0.10, 0.45);
    }
  }
  mb.pop();
  solidBox(ctx, mb, x, z, 0.95, len, 0, h, yaw);
  if (ctx.loot) ctx.loot.push({ p: mb.worldPoint(x, 1.0, z), kind: 'shelf' });
}

export function displayRack(mb, ctx, x, z, yaw, rng) {
  const frame = M(ctx, 'prop_chrome', 1.0);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0, 0.5, 0.06, 0.5, M(ctx, 'prop_darksteel', 0.5));
  mb.boxC(0, 0.06, 0, 0.06, 1.55, 0.06, frame);
  mb.boxC(0, 1.55, 0, 1.10, 0.05, 0.05, frame);
  const n = rng.int(3, 7);
  for (let i = 0; i < n; i++) {
    const lx = lerp(-0.5, 0.5, i / Math.max(1, n - 1));
    mb.boxC(lx, 0.95, 0, 0.16, 0.58, 0.10,
      M(ctx, rng.pick(['prop_fabric_red', 'prop_fabric_blue', 'prop_fabric_green', 'prop_fabric_brown']), 0.7));
  }
  mb.pop();
  solidBox(ctx, mb, x, z, 0.55, 0.55, 0, 1.6, yaw);
}

export function cashCounter(mb, ctx, x, z, yaw, rng) {
  const len = rng.range(1.8, 3.0);
  const body = M(ctx, rng.pick(['prop_wood_dark', 'prop_white']), 1.2);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0, 0.66, 1.02, len, body);
  mb.boxC(0, 1.02, 0, 0.76, 0.05, len + 0.08, M(ctx, 'prop_wood', 1.0));
  // Register.
  mb.boxC(0, 1.07, len * 0.22, 0.34, 0.22, 0.40, M(ctx, 'prop_darksteel', 0.6));
  mb.boxC(0, 1.29, len * 0.22 - 0.02, 0.28, 0.14, 0.24, M(ctx, 'prop_black', 0.5));
  mb.boxC(0, 1.30, len * 0.22 - 0.14, 0.22, 0.10, 0.02, M(ctx, 'prop_screen'));
  mb.pop();
  solidBox(ctx, mb, x, z, 0.78, len, 0, 1.08, yaw);
  if (ctx.loot) ctx.loot.push({ p: mb.worldPoint(x, 1.1, z), kind: 'register' });
}

export function mannequin(mb, ctx, x, z, yaw, rng) {
  const m = M(ctx, rng.pick(['prop_white', 'prop_paper']), 0.8);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0, 0.34, 0.05, 0.34, M(ctx, 'prop_darksteel', 0.4));
  mb.boxC(0, 0.05, 0, 0.06, 0.72, 0.06, M(ctx, 'prop_chrome', 0.3));
  mb.boxC(0, 0.77, 0, 0.34, 0.62, 0.22, m);
  mb.boxC(0, 1.39, 0, 0.14, 0.10, 0.14, m);
  mb.boxC(0, 1.49, 0, 0.18, 0.22, 0.20, m);
  if (rng.chance(0.6)) {
    mb.boxC(0, 0.80, 0, 0.38, 0.52, 0.26,
      M(ctx, rng.pick(['prop_fabric_red', 'prop_fabric_blue', 'prop_fabric_green']), 0.9));
  }
  mb.pop();
  solidBox(ctx, mb, x, z, 0.36, 0.36, 0, 1.7, yaw);
}

export function freezerChest(mb, ctx, x, z, yaw, rng) {
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0, 1.60, 0.92, 0.74, M(ctx, 'prop_white', 1.4));
  mb.boxC(0, 0.92, 0, 1.56, 0.06, 0.70, M(ctx, 'prop_chrome', 1.2));
  mb.pop();
  solidBox(ctx, mb, x, z, 1.62, 0.76, 0, 0.98, yaw);
  if (ctx.loot) ctx.loot.push({ p: mb.worldPoint(x, 1.0, z), kind: 'freezer' });
}

export function vendingMachine(mb, ctx, x, z, yaw, rng) {
  const body = M(ctx, rng.pick(['prop_red', 'prop_blue']), 1.2);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0, 0.94, 1.86, 0.72, body);
  mb.boxC(-0.12, 0.34, -0.36, 0.58, 1.28, 0.03, M(ctx, 'prop_black', 1.0));
  mb.boxC(0.32, 0.60, -0.37, 0.20, 0.70, 0.02, M(ctx, 'prop_darksteel', 0.5));
  mb.pop();
  solidBox(ctx, mb, x, z, 0.96, 0.74, 0, 1.86, yaw);
  if (ctx.loot) ctx.loot.push({ p: mb.worldPoint(x, 1.0, z), kind: 'vending' });
}

export function barCounter(mb, ctx, x, z, yaw, rng, o = {}) {
  const len = o.len ?? rng.range(3.5, 6.0);
  const wood = M(ctx, 'prop_wood_dark', 1.4);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0, 0.62, 1.08, len, wood);
  mb.boxC(0, 1.08, 0, 0.82, 0.06, len + 0.1, M(ctx, 'prop_wood', 1.2));
  mb.boxC(0, 0.10, -0.34, 0.06, 0.14, len, M(ctx, 'prop_chrome', 0.5));   // foot rail
  mb.pop();
  solidBox(ctx, mb, x, z, 0.84, len, 0, 1.14, yaw);
  for (let i = 0; i < Math.floor(len / 0.9); i++) {
    const lz = -len / 2 + 0.5 + i * 0.9;
    const p = rotate(0.85, lz, yaw);
    barStool(mb, ctx, x + p.x, z + p.z, yaw, rng);
  }
}

export function barStool(mb, ctx, x, z, yaw, rng) {
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0, 0.36, 0.04, 0.36, M(ctx, 'prop_darksteel', 0.4));
  mb.boxC(0, 0.04, 0, 0.08, 0.68, 0.08, M(ctx, 'prop_chrome', 0.4));
  mb.boxC(0, 0.72, 0, 0.38, 0.09, 0.38, M(ctx, 'prop_fabric_red', 0.6));
  mb.pop();
}

export function officeDesk(mb, ctx, x, z, yaw, rng) {
  const wood = M(ctx, rng.pick(['prop_wood', 'prop_darksteel']), 1.2);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0.70, 0, 1.55, 0.06, 0.78, wood);
  mb.boxC(-0.52, 0, 0, 0.44, 0.70, 0.72, wood);
  mb.boxC(0.62, 0, 0, 0.06, 0.70, 0.72, wood);
  if (rng.chance(0.7)) {
    mb.boxC(0.28, 0.76, 0.10, 0.42, 0.36, 0.36, M(ctx, 'prop_white', 0.7));
    mb.boxC(0.28, 0.80, -0.08, 0.34, 0.26, 0.02, M(ctx, 'prop_screen'));
  }
  if (rng.chance(0.8)) mb.boxC(-0.35, 0.76, -0.05, 0.28, 0.03, 0.34, M(ctx, 'prop_paper', 0.4));
  mb.pop();
  solidBox(ctx, mb, x, z, 1.55, 0.78, 0, 0.76, yaw);
  if (ctx.loot) ctx.loot.push({ p: mb.worldPoint(x, 0.8, z), kind: 'desk' });
}

export function filingCabinet(mb, ctx, x, z, yaw, rng) {
  const m = M(ctx, rng.pick(['prop_steel', 'prop_darksteel']), 1.0);
  const h = rng.chance(0.5) ? 1.32 : 0.72;
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0, 0.48, h, 0.62, m);
  const n = Math.round(h / 0.33);
  for (let i = 0; i < n; i++) {
    mb.boxC(0, 0.04 + i * (h / n), -0.32, 0.42, h / n - 0.05, 0.02, M(ctx, 'prop_darksteel', 0.5));
    mb.boxC(0, 0.10 + i * (h / n), -0.34, 0.12, 0.03, 0.03, M(ctx, 'prop_chrome', 0.2));
  }
  mb.pop();
  solidBox(ctx, mb, x, z, 0.5, 0.64, 0, h, yaw);
  if (ctx.loot) ctx.loot.push({ p: mb.worldPoint(x, h, z), kind: 'cabinet' });
}

export function lockerBank(mb, ctx, x, z, yaw, rng, o = {}) {
  const n = o.n ?? rng.int(3, 6);
  const m = M(ctx, rng.pick(['prop_blue', 'prop_green', 'prop_steel']), 1.2);
  mb.push(x, 0, z, yaw);
  for (let i = 0; i < n; i++) {
    const lz = (i - (n - 1) / 2) * 0.32;
    mb.boxC(0, 0, lz, 0.46, 1.82, 0.31, m);
    mb.boxC(-0.235, 0.05, lz, 0.02, 1.72, 0.27, M(ctx, 'prop_darksteel', 0.6));
    mb.boxC(-0.25, 1.05, lz + 0.08, 0.02, 0.10, 0.03, M(ctx, 'prop_chrome', 0.2));
  }
  mb.pop();
  solidBox(ctx, mb, x, z, 0.48, n * 0.32, 0, 1.82, yaw);
  if (ctx.loot) ctx.loot.push({ p: mb.worldPoint(x, 1.0, z), kind: 'locker' });
  if (ctx.spawns) ctx.spawns.push({ p: mb.worldPoint(x, 0, z), kind: 'locker' });
}

// ---------------------------------------------------------------------------
// Industrial
// ---------------------------------------------------------------------------

export function crate(mb, ctx, x, z, yaw, rng, o = {}) {
  const s = o.size ?? rng.range(0.6, 1.15);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0, s, s * rng.range(0.7, 1.05), s, M(ctx, 'prop_crate', 0.9));
  mb.pop();
  solidBox(ctx, mb, x, z, s, s, 0, s, yaw);
  if (ctx.loot && rng.chance(0.4)) ctx.loot.push({ p: mb.worldPoint(x, s, z), kind: 'crate' });
}

export function palletStack(mb, ctx, x, z, yaw, rng) {
  const pw = 1.15, pd = 0.95;
  const layers = rng.int(1, 4);
  mb.push(x, 0, z, yaw);
  let y = 0;
  for (let i = 0; i < layers; i++) {
    mb.boxC(0, y, 0, pw, 0.14, pd, M(ctx, 'prop_wood_pale', 0.7));
    y += 0.14;
    if (rng.chance(0.75)) {
      const h = rng.range(0.35, 0.85);
      mb.boxC(rng.range(-0.06, 0.06), y, rng.range(-0.05, 0.05), pw - 0.12, h, pd - 0.12,
        M(ctx, rng.pick(['prop_crate', 'prop_paper', 'prop_white']), 0.8));
      y += h;
    }
  }
  mb.pop();
  solidBox(ctx, mb, x, z, pw, pd, 0, y, yaw);
  if (ctx.loot) ctx.loot.push({ p: mb.worldPoint(x, y, z), kind: 'crate' });
}

export function barrel(mb, ctx, x, z, yaw, rng, o = {}) {
  const m = M(ctx, o.hazard ? 'prop_yellow' : rng.pick(['prop_rust', 'prop_blue', 'prop_green', 'prop_dirtmetal']), 1.0);
  mb.push(x, 0, z, yaw);
  if (o.toppled) {
    mb.cylinder(0, 0.28, 0, 0.28, 0.88, 8, m, { capTop: true });
  } else {
    mb.cylinder(0, 0, 0, 0.30, 0.88, 8, m, { capTop: true });
    mb.cylinder(0, 0.24, 0, 0.315, 0.06, 8, m, { capTop: false });
    mb.cylinder(0, 0.58, 0, 0.315, 0.06, 8, m, { capTop: false });
    if (o.hazard) {
      const s = M(ctx, 'sign_hazard');
      mb.quadMat([-0.18, 0.30, -0.31], [0.18, 0.30, -0.31], [0.18, 0.62, -0.31], [-0.18, 0.62, -0.31],
        s, [0, 0, -1], { noTess: true });
    }
  }
  mb.pop();
  solidBox(ctx, mb, x, z, 0.62, 0.62, 0, 0.88, yaw);
}

export function toolbench(mb, ctx, x, z, yaw, rng) {
  const len = rng.range(1.8, 2.8);
  const wood = M(ctx, 'prop_wood_dark', 1.2);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0.86, 0, 0.72, 0.08, len, wood);
  for (const sz of [-1, 1]) {
    mb.boxC(0, 0, sz * (len / 2 - 0.12), 0.66, 0.86, 0.10, M(ctx, 'prop_steel', 0.8));
  }
  mb.boxC(0.02, 0.30, 0, 0.60, 0.42, len - 0.4, M(ctx, 'prop_steel', 1.0));
  // Pegboard with tools.
  mb.boxC(0.34, 0.94, 0, 0.04, 0.90, len - 0.2, M(ctx, 'prop_paper', 1.0));
  for (let i = 0; i < rng.int(2, 5); i++) {
    mb.boxC(0.30, 1.05 + rng.range(0, 0.6), rng.range(-len / 2 + 0.2, len / 2 - 0.2),
      0.03, rng.range(0.12, 0.3), rng.range(0.04, 0.12), M(ctx, 'prop_darksteel', 0.3));
  }
  mb.pop();
  solidBox(ctx, mb, x, z, 0.74, len, 0, 0.94, yaw);
  if (ctx.loot) ctx.loot.push({ p: mb.worldPoint(x, 0.98, z), kind: 'tools' });
}

export function machine(mb, ctx, x, z, yaw, rng) {
  const w = rng.range(1.4, 2.6), d = rng.range(1.0, 1.8), h = rng.range(1.4, 2.4);
  const body = M(ctx, rng.pick(['prop_green', 'prop_blue', 'prop_steel', 'prop_orange']), 1.4);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0, w, h * 0.72, d, body);
  mb.boxC(0, h * 0.72, 0, w * 0.6, h * 0.28, d * 0.6, M(ctx, 'prop_darksteel', 1.0));
  mb.boxC(-w * 0.3, h * 0.42, -d / 2 - 0.02, 0.30, 0.40, 0.04, M(ctx, 'prop_screen'));
  for (let i = 0; i < 3; i++) {
    mb.boxC(-w * 0.3 + 0.12 * i, h * 0.30, -d / 2 - 0.03, 0.06, 0.06, 0.05,
      M(ctx, rng.pick(['prop_red', 'prop_yellow', 'prop_green']), 0.2));
  }
  mb.cylinder(w * 0.3, h * 0.72, 0, 0.14, h * 0.5, 6, M(ctx, 'prop_rust', 0.8));
  mb.pop();
  solidBox(ctx, mb, x, z, w, d, 0, h, yaw);
}

export function chainLinkFence(mb, ctx, pts, h, rng, o = {}) {
  const mesh = M(ctx, o.rusty ? 'chainlink_rust' : 'chainlink', 2.0);
  const post = M(ctx, o.rusty ? 'prop_rust' : 'prop_steel', 0.6);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 0.1) continue;
    const ux = (b.x - a.x) / len, uz = (b.z - a.z) / len;
    const nx = uz, nz = -ux;
    mb.quad([a.x, 0, a.z], [b.x, 0, b.z], [b.x, h, b.z], [a.x, h, a.z],
      [0, 0, len / 2, h / 2], mesh.layer, [nx, 0, nz], { maxEdge: 3 });
    mb.quad([b.x, 0, b.z], [a.x, 0, a.z], [a.x, h, a.z], [b.x, h, b.z],
      [0, 0, len / 2, h / 2], mesh.layer, [-nx, 0, -nz], { maxEdge: 3 });
    // Top rail.
    mb.box(Math.min(a.x, b.x) - 0.03, h - 0.05, Math.min(a.z, b.z) - 0.03,
      Math.max(a.x, b.x) + 0.03, h, Math.max(a.z, b.z) + 0.03, post, { skip: 'top bottom' });
    const posts = Math.max(1, Math.round(len / 2.6));
    for (let k = 0; k <= posts; k++) {
      const t = k / posts;
      mb.boxC(a.x + (b.x - a.x) * t, 0, a.z + (b.z - a.z) * t, 0.08, h + 0.06, 0.08, post);
    }
    if (ctx.collision && !o.noCollide) {
      const wa = mb.worldPoint(a.x, 0, a.z), wb = mb.worldPoint(b.x, 0, b.z);
      ctx.collision.addSegment(wa.x, wa.z, wb.x, wb.z, mb.ty, mb.ty + h, 'fence');
    }
  }
}

// ---------------------------------------------------------------------------
// Civic / special
// ---------------------------------------------------------------------------

export function pew(mb, ctx, x, z, yaw, rng, o = {}) {
  const len = o.len ?? rng.range(2.4, 3.6);
  const wood = M(ctx, 'prop_wood_dark', 1.4);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0.42, 0, 0.44, 0.06, len, wood);
  mb.boxC(0.20, 0.48, 0, 0.06, 0.52, len, wood);
  for (const sz of [-1, 1]) mb.boxC(0, 0, sz * (len / 2 - 0.12), 0.40, 0.42, 0.07, wood);
  mb.pop();
  solidBox(ctx, mb, x, z, 0.5, len, 0, 0.5, yaw);
}

export function libraryStack(mb, ctx, x, z, yaw, rng, o = {}) {
  const len = o.len ?? rng.range(3.0, 5.0);
  mb.push(x, 0, z, yaw);
  bookshelf(mb, { ...ctx, collision: null }, 0, -len / 4, 0, rng, { w: len / 2 - 0.05, h: 2.0 });
  bookshelf(mb, { ...ctx, collision: null }, 0, len / 4, 0, rng, { w: len / 2 - 0.05, h: 2.0 });
  mb.pop();
  solidBox(ctx, mb, x, z, 0.4, len, 0, 2.0, yaw);
}

export function gasPump(mb, ctx, x, z, yaw, rng) {
  const body = M(ctx, rng.pick(['prop_red', 'prop_white', 'prop_yellow']), 1.0);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0, 0.52, 0.30, 0.72, M(ctx, 'prop_darksteel', 0.6));
  mb.boxC(0, 0.30, 0, 0.46, 1.42, 0.62, body);
  mb.boxC(0, 1.00, -0.32, 0.34, 0.34, 0.03, M(ctx, 'prop_screen'));
  mb.boxC(0, 1.00, 0.32, 0.34, 0.34, 0.03, M(ctx, 'prop_screen'));
  mb.boxC(0, 1.72, 0, 0.50, 0.16, 0.66, M(ctx, 'prop_white', 0.6));
  mb.boxC(0.26, 0.80, 0.10, 0.08, 0.26, 0.10, M(ctx, 'prop_black', 0.3));   // nozzle
  mb.pop();
  solidBox(ctx, mb, x, z, 0.54, 0.74, 0, 1.9, yaw);
}

/** The forecourt canopy every filling station has. */
export function pumpCanopy(mb, ctx, x, z, yaw, w, d, rng) {
  const post = M(ctx, 'prop_white', 1.0);
  const deck = M(ctx, 'prop_steel', 2.0);
  const h = 4.4;
  mb.push(x, 0, z, yaw);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const px = sx * (w / 2 - 0.6), pz = sz * (d / 2 - 0.6);
    mb.boxC(px, 0, pz, 0.34, h, 0.34, post);
    solidBox(ctx, mb, x + px, z + pz, 0.36, 0.36, 0, h, yaw);
  }
  mb.boxC(0, h, 0, w, 0.55, d, deck);
  mb.boxC(0, h + 0.55, 0, w + 0.1, 0.12, d + 0.1, M(ctx, 'prop_red', 1.4));
  mb.pop();
}

export function statue(mb, ctx, x, z, yaw, rng) {
  const stone = M(ctx, 'found_stone', 1.4);
  const bronze = M(ctx, 'prop_rust', 0.8);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0, 2.2, 0.30, 2.2, stone);
  mb.boxC(0, 0.30, 0, 1.6, 0.28, 1.6, stone);
  mb.boxC(0, 0.58, 0, 1.15, 1.55, 1.15, stone);
  mb.boxC(0, 2.13, 0, 0.9, 0.16, 0.9, stone);
  // Figure.
  mb.boxC(0, 2.29, 0, 0.30, 0.20, 0.24, bronze);
  mb.boxC(-0.09, 2.49, 0, 0.14, 0.86, 0.16, bronze);
  mb.boxC(0.09, 2.49, 0, 0.14, 0.86, 0.16, bronze);
  mb.boxC(0, 3.35, 0, 0.44, 0.70, 0.30, bronze);
  mb.boxC(-0.30, 3.45, 0.02, 0.14, 0.58, 0.14, bronze);
  mb.boxC(0.30, 3.60, -0.10, 0.14, 0.50, 0.14, bronze);
  mb.boxC(0, 4.05, 0, 0.26, 0.30, 0.26, bronze);
  mb.pop();
  solidBox(ctx, mb, x, z, 2.2, 2.2, 0, 2.2, yaw);
}

export function waterTower(mb, ctx, x, z, rng) {
  const leg = M(ctx, 'prop_rust', 1.0);
  const tank = M(ctx, 'prop_white', 2.4);
  const h = 16;
  const r = 3.6;
  mb.push(x, 0, z, 0);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4;
    const lx = Math.cos(a) * r, lz = Math.sin(a) * r;
    // Splayed legs.
    const bx = Math.cos(a) * (r + 1.9), bz = Math.sin(a) * (r + 1.9);
    mb.quadMat([bx - 0.16, 0, bz], [bx + 0.16, 0, bz], [lx + 0.16, h, lz], [lx - 0.16, h, lz], leg, [0, 0, -1], { spanU: 0.32, spanV: h });
    mb.quadMat([bx + 0.16, 0, bz], [bx - 0.16, 0, bz], [lx - 0.16, h, lz], [lx + 0.16, h, lz], leg, [0, 0, 1], { spanU: 0.32, spanV: h });
    solidBox(ctx, mb, bx, bz, 0.5, 0.5, 0, 4, 0);
  }
  for (const y of [5, 10]) {
    for (let i = 0; i < 4; i++) {
      const a0 = (i / 4) * TAU + Math.PI / 4, a1 = ((i + 1) / 4) * TAU + Math.PI / 4;
      const rr = r + 1.9 * (1 - y / h);
      mb.box(Math.min(Math.cos(a0), Math.cos(a1)) * rr, y, Math.min(Math.sin(a0), Math.sin(a1)) * rr,
        Math.max(Math.cos(a0), Math.cos(a1)) * rr + 0.14, y + 0.14, Math.max(Math.sin(a0), Math.sin(a1)) * rr + 0.14, leg);
    }
  }
  mb.cylinder(0, h, 0, 4.4, 6.5, 12, tank);
  mb.cylinder(0, h + 6.5, 0, 3.0, 1.4, 12, tank);
  mb.cylinder(0, h - 0.9, 0, 4.4, 0.9, 12, leg, { capTop: false });
  // Faded lettering band.
  mb.cylinder(0, h + 2.6, 0, 4.45, 1.9, 12, M(ctx, 'sign_shop2'), { capTop: false });
  mb.pop();
}

// ---------------------------------------------------------------------------
// Street-level infrastructure
// ---------------------------------------------------------------------------

export function streetLamp(mb, ctx, x, z, yaw, rng, o = {}) {
  const m = M(ctx, o.rusty ? 'prop_rust' : 'prop_darksteel', 1.2);
  const h = o.h ?? rng.range(6.2, 7.4);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0, 0.42, 0.22, 0.42, M(ctx, 'found_poured', 0.6));
  mb.cylinder(0, 0.22, 0, 0.10, h, 6, m);
  // Cranked arm.
  mb.box(-0.06, h, -0.06, 1.35, h + 0.12, 0.06, m);
  mb.box(1.20, h - 0.30, -0.16, 1.52, h, 0.16, m);
  mb.boxC(1.36, h - 0.42, 0, 0.42, 0.16, 0.26, M(ctx, o.lit ? 'light_panel' : 'prop_darksteel', 0.5));
  mb.pop();
  solidBox(ctx, mb, x, z, 0.24, 0.24, 0, h, yaw);
  if (o.lit && ctx.lights) {
    ctx.lights.push({ p: mb.worldPoint(x + Math.sin(yaw) * 0 + 1.36 * Math.cos(yaw), h - 0.5, z - 1.36 * Math.sin(yaw)), r: 12, c: [0.55, 0.45, 0.28], flicker: rng.chance(0.4) });
  }
}

export function trafficLight(mb, ctx, x, z, yaw, rng) {
  const m = M(ctx, 'prop_darksteel', 1.0);
  const h = 6.0;
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0, 0.46, 0.20, 0.46, M(ctx, 'found_poured', 0.6));
  mb.cylinder(0, 0.20, 0, 0.09, h, 6, m);
  mb.box(-0.05, h - 0.10, -0.05, 3.1, h + 0.02, 0.05, m);
  // Two dead signal heads on the mast arm.
  for (const d of [1.7, 2.9]) {
    mb.box(d - 0.16, h - 1.10, -0.16, d + 0.16, h - 0.10, 0.16, M(ctx, 'prop_yellow', 0.5));
    for (let i = 0; i < 3; i++) {
      mb.boxC(d, h - 1.02 + i * 0.30, -0.17, 0.20, 0.20, 0.03,
        M(ctx, ['prop_black', 'prop_black', 'prop_black'][i], 0.2));
    }
  }
  mb.pop();
  solidBox(ctx, mb, x, z, 0.22, 0.22, 0, h, yaw);
}

export function streetSign(mb, ctx, x, z, yaw, rng, o = {}) {
  const post = M(ctx, o.rusty ? 'prop_rust' : 'prop_steel', 0.8);
  const face = M(ctx, o.kind === 'stop' ? 'sign_stopsign' : 'sign_road');
  const h = o.kind === 'stop' ? 2.4 : 2.9;
  mb.push(x, 0, z, yaw + (o.lean || 0));
  mb.cylinder(0, 0, 0, 0.045, h, 5, post);
  if (o.kind === 'stop') {
    mb.boxC(0, h - 0.75, 0.01, 0.66, 0.66, 0.03, face);
    mb.boxC(0, h - 0.75, -0.01, 0.66, 0.66, 0.03, face);
  } else {
    mb.boxC(0, h - 0.28, 0.015, 0.90, 0.24, 0.03, face);
    if (rng.chance(0.6)) {
      mb.push(0, 0, 0, Math.PI / 2);
      mb.boxC(0, h - 0.56, 0.015, 0.90, 0.24, 0.03, face);
      mb.pop();
    }
  }
  mb.pop();
  solidBox(ctx, mb, x, z, 0.12, 0.12, 0, h, yaw);
}

export function fireHydrant(mb, ctx, x, z, yaw, rng, o = {}) {
  const m = M(ctx, o.broken ? 'prop_rust' : rng.pick(['prop_red', 'prop_yellow']), 0.6);
  mb.push(x, 0, z, yaw + (o.knocked ? 1.4 : 0));
  if (o.knocked) {
    mb.cylinder(0, 0.16, 0, 0.16, 0.72, 6, m, { capTop: true });
    mb.boxC(0, 0.10, 0, 0.44, 0.12, 0.44, M(ctx, 'prop_darksteel', 0.4));
  } else {
    mb.cylinder(0, 0, 0, 0.20, 0.14, 8, m);
    mb.cylinder(0, 0.14, 0, 0.155, 0.52, 8, m);
    mb.cylinder(0, 0.66, 0, 0.185, 0.10, 8, m);
    mb.cylinder(0, 0.76, 0, 0.10, 0.14, 6, m);
    for (const sx of [-1, 1]) {
      mb.boxC(sx * 0.19, 0.34, 0, 0.10, 0.16, 0.16, m);
    }
    mb.boxC(0, 0.30, -0.19, 0.14, 0.14, 0.10, m);
  }
  mb.pop();
  solidBox(ctx, mb, x, z, 0.42, 0.42, 0, 0.9, yaw);
}

export function manhole(mb, ctx, x, z, rng, o = {}) {
  const m = M(ctx, o.glow ? 'prop_rust' : 'prop_dirtmetal', 1.0);
  mb.push(x, 0, z, rng.next() * TAU);
  if (o.displaced) {
    // Lid dragged aside, hole open — light leaking from the sewer below.
    mb.cylinder(0, 0.005, 0, 0.42, 0.02, 10, M(ctx, 'black', 1.0));
    mb.push(0.62, 0, 0.24, 0.5);
    mb.cylinder(0, 0.02, 0, 0.40, 0.07, 10, m);
    mb.pop();
    if (ctx.lights && o.glow) ctx.lights.push({ p: mb.worldPoint(0, 0.1, 0), r: 4.5, c: [0.16, 0.26, 0.20], flicker: false });
  } else {
    mb.cylinder(0, 0.005, 0, 0.42, 0.035, 10, m);
    mb.cylinder(0, 0.04, 0, 0.34, 0.012, 10, M(ctx, 'prop_darksteel', 0.4));
  }
  mb.pop();
}

export function utilityPole(mb, ctx, x, z, yaw, rng, o = {}) {
  const wood = M(ctx, 'prop_wood_dark', 1.6);
  const h = o.h ?? rng.range(9, 11.5);
  mb.push(x, 0, z, yaw + rng.range(-0.05, 0.05));
  mb.cylinder(0, 0, 0, 0.17, h, 7, wood);
  for (const cy of [h - 0.7, h - 1.7]) {
    mb.box(-1.35, cy, -0.09, 1.35, cy + 0.16, 0.09, wood);
    for (const sx of [-1.15, -0.55, 0.55, 1.15]) {
      mb.boxC(sx, cy + 0.16, 0, 0.09, 0.22, 0.09, M(ctx, 'prop_chrome', 0.2));
    }
  }
  // Transformer can.
  if (rng.chance(0.4)) mb.cylinder(0.34, h - 3.4, 0, 0.30, 0.85, 8, M(ctx, 'prop_steel', 0.8));
  mb.pop();
  solidBox(ctx, mb, x, z, 0.4, 0.4, 0, h, yaw);
  return { x, z, h, yaw };
}

/** Catenary between two poles — the drooping wires the brief asks for. */
export function powerLine(mb, ctx, a, b, rng) {
  const m = M(ctx, 'prop_black', 1.0);
  const dx = b.x - a.x, dz = b.z - a.z;
  const span = Math.hypot(dx, dz);
  if (span < 2 || span > 46) return;
  const segs = Math.max(4, Math.round(span / 4));
  const sag = clamp(span * 0.055, 0.3, 1.9);
  for (const [offA, offB, yOff] of [[-1.15, -1.15, 0.7], [1.15, 1.15, 0.7], [-0.55, -0.55, 1.7], [0.55, 0.55, 1.7]]) {
    const pa = { x: a.x + Math.cos(a.yaw) * offA, y: a.h - yOff + 0.2, z: a.z - Math.sin(a.yaw) * offA };
    const pb = { x: b.x + Math.cos(b.yaw) * offB, y: b.h - yOff + 0.2, z: b.z - Math.sin(b.yaw) * offB };
    let prev = null;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const p = {
        x: lerp(pa.x, pb.x, t),
        y: lerp(pa.y, pb.y, t) - Math.sin(t * Math.PI) * sag,
        z: lerp(pa.z, pb.z, t),
      };
      if (prev) {
        const ex = p.x - prev.x, ey = p.y - prev.y, ez = p.z - prev.z;
        const l = Math.hypot(ex, ey, ez);
        const nx = ez / l, nz = -ex / l;
        const t2 = 0.035;
        mb.quad([prev.x, prev.y - t2, prev.z], [p.x, p.y - t2, p.z], [p.x, p.y + t2, p.z], [prev.x, prev.y + t2, prev.z],
          [0, 0, l / 2, 0.05], m.layer, [nx, 0, nz], { noTess: true });
        mb.quad([prev.x - nx * t2, prev.y, prev.z - nz * t2], [p.x - nx * t2, p.y, p.z - nz * t2],
          [p.x + nx * t2, p.y, p.z + nz * t2], [prev.x + nx * t2, prev.y, prev.z + nz * t2],
          [0, 0, l / 2, 0.05], m.layer, [0, 1, 0], { noTess: true });
      }
      prev = p;
    }
  }
}

export function busShelter(mb, ctx, x, z, yaw, rng) {
  const frame = M(ctx, 'prop_steel', 1.0);
  const glass = M(ctx, rng.chance(0.6) ? 'glass_broken' : 'glass_dirty', 1.6);
  const w = 3.6, d = 1.5, h = 2.45;
  mb.push(x, 0, z, yaw);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    mb.boxC(sx * (w / 2 - 0.07), 0, sz * (d / 2 - 0.07), 0.10, h, 0.10, frame);
  }
  mb.boxC(0, h, 0, w + 0.2, 0.12, d + 0.25, frame);
  // Back and one end panel; the other end is where the glass went.
  mb.boxC(0, 0.35, d / 2 - 0.04, w - 0.2, h - 0.5, 0.03, glass);
  if (rng.chance(0.6)) mb.boxC(-(w / 2 - 0.05), 0.35, 0, 0.03, h - 0.5, d - 0.2, glass);
  // Rotting bench.
  const wood = M(ctx, 'prop_wood_dark', 0.8);
  mb.boxC(0, 0.44, d / 2 - 0.30, w - 0.6, 0.05, 0.42, wood);
  for (const sx of [-1, 1]) mb.boxC(sx * (w / 2 - 0.5), 0, d / 2 - 0.30, 0.10, 0.44, 0.36, frame);
  // Advertising panel.
  mb.boxC(w / 2 - 0.06, 0.45, 0, 0.05, 1.7, d - 0.3, M(ctx, 'sign_poster', 1.0));
  mb.pop();
  solidBox(ctx, mb, x, z, w, d, 0, h, yaw);
}

export function bench(mb, ctx, x, z, yaw, rng) {
  const wood = M(ctx, rng.pick(['prop_wood_dark', 'prop_wood']), 0.8);
  const iron = M(ctx, 'prop_darksteel', 0.6);
  mb.push(x, 0, z, yaw);
  for (const sz of [-1, 1]) {
    mb.boxC(0, 0, sz * 0.72, 0.52, 0.44, 0.07, iron);
    mb.boxC(0.16, 0.44, sz * 0.72, 0.09, 0.48, 0.07, iron);
  }
  for (let i = 0; i < 3; i++) mb.boxC(-0.16 + i * 0.16, 0.44, 0, 0.14, 0.05, 1.6, wood);
  for (let i = 0; i < 3; i++) mb.boxC(0.20, 0.56 + i * 0.16, 0, 0.05, 0.13, 1.6, wood);
  mb.pop();
  solidBox(ctx, mb, x, z, 0.55, 1.6, 0, 0.5, yaw);
}

export function trashCan(mb, ctx, x, z, yaw, rng, o = {}) {
  const m = M(ctx, o.city ? 'prop_green' : rng.pick(['prop_dirtmetal', 'prop_steel']), 0.8);
  mb.push(x, 0, z, yaw);
  if (o.toppled) {
    mb.cylinder(0, 0.30, 0, 0.30, 0.86, 8, m);
  } else {
    mb.cylinder(0, 0, 0, 0.30, 0.88, 8, m, { capTop: false });
    mb.cylinder(0, 0.02, 0, 0.27, 0.80, 8, M(ctx, 'black', 1.0), { capTop: true });
    if (rng.chance(0.5)) mb.cylinder(0, 0.88, 0, 0.33, 0.07, 8, m);
  }
  mb.pop();
  solidBox(ctx, mb, x, z, 0.62, 0.62, 0, 0.9, yaw);
}

export function dumpster(mb, ctx, x, z, yaw, rng) {
  const m = M(ctx, rng.pick(['prop_green', 'prop_blue', 'prop_rust']), 1.2);
  const w = 1.9, d = 1.25, h = 1.28;
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0.14, 0, w, h, d, m, { skip: 'top' });
  mb.boxC(0, h + 0.14, 0, w + 0.04, 0.07, d * 0.55, M(ctx, 'prop_darksteel', 1.0));
  mb.slope([-w / 2, h + 0.14, d * 0.28], [w / 2, h + 0.14, d * 0.28],
    [w / 2, h + 0.30, d / 2], [-w / 2, h + 0.30, d / 2], M(ctx, 'prop_darksteel', 1.4));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    mb.cylinder(sx * (w / 2 - 0.2), 0, sz * (d / 2 - 0.16), 0.13, 0.14, 6, M(ctx, 'prop_black', 0.3));
  }
  mb.pop();
  solidBox(ctx, mb, x, z, w, d, 0, h + 0.3, yaw);
  if (ctx.spawns) ctx.spawns.push({ p: mb.worldPoint(x, 0, z + 1.4), kind: 'alley' });
}

export function mailbox(mb, ctx, x, z, yaw, rng) {
  const m = M(ctx, 'prop_steel', 0.5);
  mb.push(x, 0, z, yaw);
  mb.cylinder(0, 0, 0, 0.055, 1.05, 5, M(ctx, 'prop_wood_dark', 0.5));
  mb.boxC(0, 1.05, 0, 0.24, 0.26, 0.46, m);
  mb.boxC(0.13, 1.16, -0.1, 0.03, 0.03, 0.16, M(ctx, 'prop_red', 0.2));
  mb.pop();
}

export function parkingMeter(mb, ctx, x, z, yaw, rng) {
  const m = M(ctx, 'prop_darksteel', 0.5);
  mb.push(x, 0, z, yaw);
  mb.cylinder(0, 0, 0, 0.05, 1.05, 6, m);
  mb.boxC(0, 1.05, 0, 0.18, 0.34, 0.14, m);
  mb.boxC(0, 1.16, -0.08, 0.12, 0.14, 0.02, M(ctx, 'prop_screen'));
  mb.pop();
}

export function bollard(mb, ctx, x, z, rng) {
  mb.cylinder(x, 0, z, 0.11, 0.95, 6, M(ctx, 'prop_darksteel', 0.5));
  mb.cylinder(x, 0.78, z, 0.125, 0.08, 6, M(ctx, 'prop_yellow', 0.3));
  solidBox(ctx, mb, x, z, 0.24, 0.24, 0, 0.95, 0);
}

export function jerseyBarrier(mb, ctx, x, z, yaw, rng) {
  const m = M(ctx, 'found_poured', 1.2);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0, 0.62, 0.22, 2.4, m);
  mb.boxC(0, 0.22, 0, 0.40, 0.50, 2.4, m);
  mb.boxC(0, 0.72, 0, 0.26, 0.22, 2.4, m);
  mb.pop();
  solidBox(ctx, mb, x, z, 0.62, 2.4, 0, 0.94, yaw);
}

export function planter(mb, ctx, x, z, yaw, rng) {
  const m = M(ctx, 'found_poured', 1.0);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0, 1.2, 0.55, 1.2, m, { skip: 'top' });
  mb.boxC(0, 0.42, 0, 1.06, 0.13, 1.06, M(ctx, 'dirt', 0.8));
  for (let i = 0; i < rng.int(2, 6); i++) {
    mb.cross(rng.range(-0.4, 0.4), 0.5, rng.range(-0.4, 0.4), rng.range(0.5, 0.9), rng.range(0.5, 1.1),
      M(ctx, rng.pick(['foliage_weed', 'foliage_dead'])), { yaw: rng.next() * TAU });
  }
  mb.pop();
  solidBox(ctx, mb, x, z, 1.2, 1.2, 0, 0.55, yaw);
}

export function phoneBooth(mb, ctx, x, z, yaw, rng) {
  const frame = M(ctx, rng.pick(['prop_red', 'prop_blue']), 1.0);
  const glass = M(ctx, 'glass_broken', 1.2);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0, 1.0, 0.12, 1.0, M(ctx, 'found_poured', 0.6));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) mb.boxC(sx * 0.44, 0.12, sz * 0.44, 0.12, 2.3, 0.12, frame);
  mb.boxC(0, 2.42, 0, 1.05, 0.22, 1.05, frame);
  mb.boxC(0, 0.2, 0.44, 0.8, 2.2, 0.03, glass);
  mb.boxC(-0.44, 0.2, 0, 0.03, 2.2, 0.8, glass);
  mb.boxC(0, 1.1, -0.40, 0.28, 0.42, 0.16, M(ctx, 'prop_black', 0.4));
  mb.pop();
  solidBox(ctx, mb, x, z, 1.0, 1.0, 0, 2.5, yaw);
}

export function newspaperBox(mb, ctx, x, z, yaw, rng) {
  const m = M(ctx, rng.pick(['prop_blue', 'prop_red', 'prop_yellow']), 0.6);
  mb.push(x, 0, z, yaw);
  mb.boxC(0, 0, 0, 0.42, 0.34, 0.36, M(ctx, 'prop_darksteel', 0.3));
  mb.boxC(0, 0.34, 0, 0.46, 0.78, 0.40, m);
  mb.boxC(0, 0.62, -0.21, 0.34, 0.34, 0.02, M(ctx, 'prop_screen'));
  mb.pop();
  solidBox(ctx, mb, x, z, 0.48, 0.42, 0, 1.12, yaw);
}

// --- vegetation ------------------------------------------------------------

// Sway allowances, in metres of horizontal travel at the top of the card.
// Anything above about 0.35 stops reading as wind and starts reading as a
// physics bug, so the whole scale lives inside a third of a metre.
const SWAY = { canopy: 0.30, pine: 0.13, bush: 0.14, weed: 0.10, grass: 0.16, ivy: 0.05 };

export function tree(mb, ctx, x, z, rng, o = {}) {
  const h = o.h ?? rng.range(5, 9.5);
  const trunk = M(ctx, 'prop_wood_dark', 1.4);
  const leaf = M(ctx, o.dead ? 'foliage_dead' : (o.pine ? 'foliage_pine' : 'foliage_hedge'));
  mb.push(x, 0, z, rng.next() * TAU);
  mb.cylinder(0, 0, 0, h * 0.045, h * (o.pine ? 0.42 : 0.55), 6, trunk, { capTop: false });
  // A few boughs.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + rng.range(-0.4, 0.4);
    const bl = h * rng.range(0.16, 0.30);
    const y0 = h * rng.range(0.34, 0.52);
    mb.quadMat([0, y0, 0], [Math.cos(a) * bl, y0 + bl * 0.7, Math.sin(a) * bl],
      [Math.cos(a) * bl, y0 + bl * 0.7 + 0.12, Math.sin(a) * bl], [0, y0 + 0.12, 0], trunk, [0, 1, 0], { noTess: true });
  }
  if (o.pine) {
    // Conifer: three tapering whorls. Stiffer in the wind than a broadleaf.
    const cr = h * rng.range(0.20, 0.28);
    for (let i = 0; i < 3; i++) {
      const t = i / 3;
      mb.cross(0, h * (0.28 + t * 0.42), 0, cr * 2.0 * (1 - t * 0.55), h * 0.34, leaf,
        { yaw: rng.next() * TAU, sway: SWAY.pine * (0.4 + t) });
    }
  } else if (!o.dead) {
    const cr = h * rng.range(0.30, 0.44);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU;
      mb.cross(Math.cos(a) * cr * 0.4, h * 0.42, Math.sin(a) * cr * 0.4, cr * 1.7, cr * 1.5, leaf,
        { yaw: a, sway: SWAY.canopy });
    }
    mb.cross(0, h * 0.52, 0, cr * 2.0, cr * 1.7, leaf, { yaw: 0.6, sway: SWAY.canopy * 1.15 });
  } else {
    // Dead trees still move — bare branches whip more, not less.
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU;
      mb.cross(Math.cos(a) * h * 0.12, h * 0.5, Math.sin(a) * h * 0.12, h * 0.30, h * 0.34,
        M(ctx, 'foliage_dead'), { yaw: a, sway: SWAY.canopy * 0.7 });
    }
  }
  mb.pop();
  solidBox(ctx, mb, x, z, h * 0.11, h * 0.11, 0, h, 0, 'prop');
}

export function bush(mb, ctx, x, z, rng, o = {}) {
  const m = M(ctx, o.dead ? 'foliage_dead' : 'foliage_hedge');
  const s = o.s ?? rng.range(0.9, 1.7);
  mb.cross(x, 0, z, s * 1.5, s, m, { yaw: rng.next() * TAU, sway: SWAY.bush });
  mb.cross(x + rng.range(-0.3, 0.3), 0, z + rng.range(-0.3, 0.3), s * 1.2, s * 0.8, m,
    { yaw: rng.next() * TAU, sway: SWAY.bush * 0.8 });
}

/**
 * Weeds and long grass. `tall` is the overgrown-lot variant that signals
 * unexplored ground; `crack` is the tuft that has come up through a paving
 * joint, which is the same prop at a quarter of the size.
 */
export function weeds(mb, ctx, x, z, rng, n = 3, spread = 1.2, o = {}) {
  const m = M(ctx, o.tall ? 'foliage_grass' : rng.pick(['foliage_weed', 'foliage_dead', 'foliage_grass']));
  const hi = o.tall ? 1.45 : o.crack ? 0.42 : 0.9;
  const lo = o.tall ? 0.7 : o.crack ? 0.16 : 0.3;
  for (let i = 0; i < n; i++) {
    const h = rng.range(lo, hi);
    mb.cross(x + rng.gauss() * spread, 0, z + rng.gauss() * spread,
      rng.range(0.4, 0.9) * (o.tall ? 1.4 : 1), h, m,
      { yaw: rng.next() * TAU, sway: (o.tall ? SWAY.grass : SWAY.weed) * (h / hi) });
  }
}

/**
 * Ivy on a wall. Placed on north-facing elevations by the caller, where the
 * damp actually sits. `up` is the wall's outward normal in world XZ.
 */
export function vines(mb, ctx, x, z, nx, nz, w, h, rng) {
  const m = M(ctx, 'foliage_ivy');
  const n = Math.max(1, Math.round(w / 1.1));
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const px = x + (-nz) * (t - 0.5) * w, pz = z + nx * (t - 0.5) * w;
    const hh = h * rng.range(0.45, 1.0);
    // A flat card hugging the wall, not a crossed billboard: it has to sit
    // against the brick, and crossing it would push half of it inside.
    mb.quad([px - (-nz) * 0.55 + nx * 0.06, 0, pz - nx * 0.55 + nz * 0.06],
      [px + (-nz) * 0.55 + nx * 0.06, 0, pz + nx * 0.55 + nz * 0.06],
      [px + (-nz) * 0.55 + nx * 0.06, hh, pz + nx * 0.55 + nz * 0.06],
      [px - (-nz) * 0.55 + nx * 0.06, hh, pz - nx * 0.55 + nz * 0.06],
      [0, 0, 1, 1], m.layer, [nx, 0, nz], { noTess: true, wind: [0, SWAY.ivy] });
  }
}

/** Broken paving heaved up around something that grew through it. */
export function rubbleRing(mb, ctx, x, z, rng, r = 1.4) {
  const slab = M(ctx, 'road_concrete', 1.2);
  const n = rng.int(5, 9);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rng.range(-0.3, 0.3);
    const d = r * rng.range(0.45, 1.0);
    mb.push(x + Math.cos(a) * d, 0, z + Math.sin(a) * d, a + rng.range(-0.5, 0.5));
    mb.boxC(0, 0, 0, rng.range(0.3, 0.7), rng.range(0.05, 0.16), rng.range(0.25, 0.6), slab);
    mb.pop();
  }
  weeds(mb, ctx, x, z, rng, 3, r * 0.5, { crack: true });
}

/** A market stall: bare frame, torn canopy, an upturned crate or two. */
export function marketStall(mb, ctx, x, z, yaw, rng) {
  const frame = M(ctx, 'prop_steel', 0.8);
  const canvas = M(ctx, rng.pick(['prop_fabric_red', 'prop_fabric_blue', 'prop_fabric_green']), 1.6);
  const board = M(ctx, 'prop_wood_pale', 1.0);
  const w = rng.range(2.2, 3.2), d = rng.range(1.6, 2.2), h = 2.15;
  mb.push(x, 0, z, yaw);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      mb.boxC(sx * (w / 2 - 0.06), 0, sz * (d / 2 - 0.06), 0.06, h, 0.06, frame);
    }
  }
  mb.box(-w / 2, h, -d / 2, w / 2, h + 0.06, d / 2, frame, { skip: 'bottom' });
  // The canopy has given way on one side, which is what makes it read as
  // abandoned rather than as closed for the night.
  const sag = rng.range(0.15, 0.55);
  mb.slope([-w / 2 - 0.2, h + 0.1, -d / 2 - 0.2], [w / 2 + 0.2, h + 0.1 - sag, -d / 2 - 0.2],
    [w / 2 + 0.2, h + 0.1 - sag, d / 2 + 0.2], [-w / 2 - 0.2, h + 0.1, d / 2 + 0.2], canvas);
  // Trestle table.
  if (rng.chance(0.7)) {
    mb.box(-w / 2 + 0.1, 0.78, -0.3, w / 2 - 0.1, 0.86, 0.3, board, { skip: 'bottom' });
    for (const sx of [-1, 1]) mb.boxC(sx * (w / 2 - 0.3), 0, 0, 0.07, 0.78, 0.5, board);
    if (ctx.loot) ctx.loot.push({ p: mb.worldPoint(0, 0.9, 0), kind: 'crate' });
  }
  mb.pop();
  solidBox(ctx, mb, x, z, w, d, 0, 0.9, yaw, 'furniture');
}

export function hedgeRow(mb, ctx, pts, rng, h = 1.2) {
  const m = M(ctx, 'foliage_hedge');
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.round(len / 0.7));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      mb.cross(lerp(a.x, b.x, t), 0, lerp(a.z, b.z, t), 1.1, h * rng.range(0.85, 1.15), m,
        { yaw: rng.next() * TAU, sway: SWAY.bush * 0.6 });
    }
    if (ctx.collision) {
      const wa = mb.worldPoint(a.x, 0, a.z), wb = mb.worldPoint(b.x, 0, b.z);
      ctx.collision.addSegment(wa.x, wa.z, wb.x, wb.z, mb.ty, mb.ty + h * 0.8, 'hedge');
    }
  }
}

export function picketFence(mb, ctx, pts, rng, h = 1.05) {
  const m = M(ctx, rng.pick(['prop_white', 'prop_wood_pale']), 0.7);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 0.2) continue;
    const n = Math.max(1, Math.round(len / 0.16));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      if (rng.chance(0.10)) continue;          // missing pickets
      const px = lerp(a.x, b.x, t), pz = lerp(a.z, b.z, t);
      mb.boxC(px, 0, pz, 0.09, h * rng.range(0.9, 1.0), 0.035, m);
    }
    for (const y of [h * 0.3, h * 0.72]) {
      const ux = (b.x - a.x) / len, uz = (b.z - a.z) / len;
      const nx = uz * 0.02, nz = -ux * 0.02;
      mb.quadMat([a.x + nx, y, a.z + nz], [b.x + nx, y, b.z + nz],
        [b.x + nx, y + 0.09, b.z + nz], [a.x + nx, y + 0.09, a.z + nz], m, [uz, 0, -ux], { spanU: len, spanV: 0.09 });
    }
    if (ctx.collision) {
      const wa = mb.worldPoint(a.x, 0, a.z), wb = mb.worldPoint(b.x, 0, b.z);
      ctx.collision.addSegment(wa.x, wa.z, wb.x, wb.z, mb.ty, mb.ty + h, 'fence');
    }
  }
}

// --- vehicles --------------------------------------------------------------

export function car(mb, ctx, x, z, yaw, rng, o = {}) {
  const body = M(ctx, o.color || rng.pick(['prop_red', 'prop_blue', 'prop_white', 'prop_green', 'prop_black', 'prop_rust', 'prop_yellow']), 1.6);
  const glass = M(ctx, rng.chance(0.6) ? 'glass_broken' : 'glass_dirty', 1.2);
  const tyre = M(ctx, 'prop_black', 0.5);
  const L = rng.range(4.2, 4.9), W = 1.82;
  mb.push(x, o.y || 0, z, yaw);
  mb.boxC(0, 0.42, 0, W, 0.52, L, body);                            // main body
  mb.boxC(0, 0.30, 0, W + 0.06, 0.16, L - 0.5, M(ctx, 'prop_darksteel', 0.8));
  // Cabin.
  const cabL = L * 0.44;
  mb.boxC(0, 0.94, -L * 0.04, W - 0.20, 0.46, cabL, body, { skip: 'bottom' });
  mb.boxC(0, 0.98, -L * 0.04 - cabL / 2 + 0.02, W - 0.30, 0.36, 0.03, glass);
  mb.boxC(0, 0.98, -L * 0.04 + cabL / 2 - 0.02, W - 0.30, 0.36, 0.03, glass);
  for (const sx of [-1, 1]) mb.boxC(sx * (W / 2 - 0.11), 0.98, -L * 0.04, 0.03, 0.34, cabL - 0.3, glass);
  // Lights and plate.
  for (const sx of [-1, 1]) {
    mb.boxC(sx * 0.55, 0.52, -L / 2 - 0.01, 0.34, 0.16, 0.03, M(ctx, 'prop_white', 0.3));
    mb.boxC(sx * 0.55, 0.52, L / 2 + 0.01, 0.30, 0.14, 0.03, M(ctx, 'prop_red', 0.3));
  }
  // Wheels.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const wx = sx * (W / 2 - 0.06), wz = sz * (L / 2 - 0.95);
    mb.push(wx, 0, wz, Math.PI / 2);
    mb.cylinder(0, 0.30, 0, 0.31, 0.22, 8, tyre);
    mb.pop();
    mb.boxC(wx, 0.30, wz, 0.24, 0.30, 0.62, tyre);
  }
  if (o.wrecked) {
    mb.boxC(rng.range(-0.4, 0.4), 1.20, rng.range(-0.6, 0.6), 0.7, 0.06, 0.7, M(ctx, 'prop_dirtmetal', 0.6));
  }
  mb.pop();
  solidBox(ctx, mb, x, z, W + 0.1, L, 0, 1.4, yaw);
  if (ctx.spawns && rng.chance(0.25)) ctx.spawns.push({ p: mb.worldPoint(x, 0, z), kind: 'street' });
}

export function truck(mb, ctx, x, z, yaw, rng, o = {}) {
  const cabC = M(ctx, rng.pick(['prop_blue', 'prop_red', 'prop_white', 'prop_rust']), 1.6);
  const boxC = M(ctx, o.box || 'prop_white', 2.2);
  const tyre = M(ctx, 'prop_black', 0.5);
  const L = rng.range(7.5, 9.5), W = 2.4;
  mb.push(x, o.y || 0, z, yaw);
  mb.boxC(0, 0.55, -L / 2 + 1.3, W, 1.55, 2.5, cabC);
  mb.boxC(0, 1.35, -L / 2 + 0.15, W - 0.3, 0.75, 0.06, M(ctx, 'glass_dirty', 1.4));
  mb.boxC(0, 0.62, L / 2 - (L - 2.8) / 2, W + 0.1, 2.5, L - 2.8, boxC);
  mb.boxC(0, 0.40, 0, W - 0.2, 0.24, L - 0.4, M(ctx, 'prop_darksteel', 1.0));
  for (const sx of [-1, 1]) for (const sz of [-L / 2 + 1.5, 0.6, 2.0]) {
    mb.push(sx * (W / 2 - 0.05), 0, sz, Math.PI / 2);
    mb.cylinder(0, 0.44, 0, 0.45, 0.30, 8, tyre);
    mb.pop();
  }
  mb.pop();
  solidBox(ctx, mb, x, z, W + 0.2, L, 0, 3.2, yaw);
}

export function shippingContainer(mb, ctx, x, z, yaw, rng, o = {}) {
  const m = M(ctx, o.color || rng.pick(['prop_rust', 'prop_blue', 'prop_green', 'prop_red', 'prop_orange']), 2.0);
  const L = 6.05, W = 2.44, H = 2.59;
  mb.push(x, o.y || 0, z, yaw);
  mb.boxC(0, 0, 0, W, H, L, m);
  for (let i = -L / 2 + 0.3; i < L / 2; i += 0.32) {
    mb.boxC(0, 0.1, i, W + 0.03, H - 0.25, 0.06, m);
  }
  mb.boxC(0, 0.1, -L / 2 - 0.02, W - 0.1, H - 0.3, 0.05, M(ctx, 'prop_darksteel', 1.0));
  mb.pop();
  solidBox(ctx, mb, x, z, W, L, o.y || 0, (o.y || 0) + H, yaw);
}

// --- misc ------------------------------------------------------------------

export function cardboardBoxes(mb, ctx, x, z, yaw, rng, n = 3) {
  mb.push(x, 0, z, yaw);
  let y = 0;
  for (let i = 0; i < n; i++) {
    const s = rng.range(0.35, 0.7);
    mb.boxC(rng.range(-0.2, 0.2), y, rng.range(-0.2, 0.2), s, s * 0.8, s, M(ctx, 'prop_crate', 0.7));
    y += s * 0.8;
  }
  mb.pop();
  solidBox(ctx, mb, x, z, 0.8, 0.8, 0, y, yaw);
}

export function junkPile(mb, ctx, x, z, rng, r = 1.4) {
  for (let i = 0; i < rng.int(3, 6); i++) {
    const a = rng.next() * TAU, d = rng.next() * r;
    const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
    const s = rng.range(0.15, 0.5);
    mb.push(px, 0, pz, rng.next() * TAU);
    mb.boxC(0, 0, 0, s, s * rng.range(0.3, 1.0), s * rng.range(0.5, 1.6),
      M(ctx, rng.pick(['prop_dirtmetal', 'prop_crate', 'prop_wood_dark', 'prop_rust', 'prop_paper']), 0.6));
    mb.pop();
  }
  weeds(mb, ctx, x, z, rng, 3, r * 0.8);
}

export function ceilingLight(mb, ctx, x, y, z, rng, o = {}) {
  const on = o.on ?? false;
  mb.boxC(x, y - 0.10, z, 1.15, 0.10, 0.30, M(ctx, on ? 'light_panel' : 'prop_white', 1.0));
  mb.boxC(x, y - 0.03, z, 1.22, 0.04, 0.36, M(ctx, 'prop_steel', 0.8));
  if (on && ctx.lights) ctx.lights.push({ p: mb.worldPoint(x, y - 0.2, z), r: o.r || 7, c: o.c || [0.42, 0.40, 0.32], flicker: o.flicker ?? true });
}

export function pendantLight(mb, ctx, x, y, z, rng, o = {}) {
  mb.boxC(x, y - 0.5, z, 0.03, 0.5, 0.03, M(ctx, 'prop_black', 0.3));
  mb.boxC(x, y - 0.62, z, 0.30, 0.14, 0.30, M(ctx, o.on ? 'light_panel' : 'prop_white', 0.6));
  if (o.on && ctx.lights) ctx.lights.push({ p: mb.worldPoint(x, y - 0.7, z), r: o.r || 5.5, c: o.c || [0.40, 0.34, 0.24], flicker: o.flicker ?? true });
}

/** Blood decal on the floor. */
export function bloodDecal(mb, ctx, x, y, z, rng, o = {}) {
  const m = M(ctx, rng.pick(['blood_pool', 'blood_splat', 'blood_old']));
  const s = o.s ?? rng.range(0.8, 2.2);
  const a = rng.next() * TAU;
  const c = Math.cos(a) * s / 2, sn = Math.sin(a) * s / 2;
  mb.quad([x - c + sn, y, z - sn - c], [x + c + sn, y, z + sn - c],
    [x + c - sn, y, z + sn + c], [x - c - sn, y, z - sn + c],
    [0, 0, 1, 1], m.layer, [0, 1, 0], { noTess: true });
}

function rotate(x, z, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return { x: x * c + z * s, z: -x * s + z * c };
}
