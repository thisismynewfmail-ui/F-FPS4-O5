// ---------------------------------------------------------------------------
// interior.js — navigable floor plans and the things people left in them.
//
// The plan is generated before any exterior geometry, because the brief
// requires windows to belong to rooms rather than to elevations. A plan is a
// binary subdivision of the footprint into rectangles, typed by where they sit:
// front rooms are public (living, retail, lobby), back rooms are service
// (kitchen, stock, workshop), and the smallest leftover becomes the bathroom.
//
// The fit-out then adds partitions with real doorways, furniture chosen for the
// room type, cover, loot points, dark places for the infected to be standing in
// when you open the door, and baked light spilling in from the windows.
// ---------------------------------------------------------------------------

import { TAU, clamp, lerp } from '../core/math.js';
import * as P from './props.js';

export const ROOM = {
  LIVING: 'living', KITCHEN: 'kitchen', BEDROOM: 'bedroom', BATH: 'bath',
  HALL: 'hall', DINING: 'dining', OFFICE: 'office', CLOSET: 'closet',
  RETAIL: 'retail', STOCK: 'stock', LOBBY: 'lobby', WORKFLOOR: 'workfloor',
  STAIR: 'stair', WARD: 'ward', NAVE: 'nave',
};

// --- plan generation -------------------------------------------------------

function splitRect(rect, rng, minSide, minArea, depth, out) {
  const w = rect.x1 - rect.x0, d = rect.z1 - rect.z0;
  const area = w * d;
  if (depth > 3 || area < minArea * 2 || (w < minSide * 2 && d < minSide * 2)) {
    out.push(rect);
    return out;
  }
  const splitX = w > d ? true : (d > w ? false : rng.chance(0.5));
  const span = splitX ? w : d;
  if (span < minSide * 2) { out.push(rect); return out; }
  const t = rng.range(minSide / span, 1 - minSide / span);
  if (splitX) {
    const xm = rect.x0 + span * t;
    splitRect({ x0: rect.x0, z0: rect.z0, x1: xm, z1: rect.z1 }, rng, minSide, minArea, depth + 1, out);
    splitRect({ x0: xm, z0: rect.z0, x1: rect.x1, z1: rect.z1 }, rng, minSide, minArea, depth + 1, out);
  } else {
    const zm = rect.z0 + span * t;
    splitRect({ x0: rect.x0, z0: rect.z0, x1: rect.x1, z1: zm }, rng, minSide, minArea, depth + 1, out);
    splitRect({ x0: rect.x0, z0: zm, x1: rect.x1, z1: rect.z1 }, rng, minSide, minArea, depth + 1, out);
  }
  return out;
}

const area = (r) => (r.x1 - r.x0) * (r.z1 - r.z0);
const centre = (r) => ({ x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 });

/**
 * Build the floor plan for one storey.
 * Local coords: x in [0,w] across the frontage, z in [0,d] from street to back.
 */
export function planFloor(w, d, storey, type, rng, opts = {}) {
  const openPlan = ['warehouse', 'factory', 'barn', 'supermarket', 'cinema', 'church'].includes(type);
  // Offices are laid out like commercial floors on every level, not just the
  // ground one; shops become flats upstairs, which is why they are separate.
  const commercialGround = ['office', 'depot'].includes(type)
    || (storey === 0 && ['shop', 'diner', 'bar', 'hardware', 'pharmacy', 'laundromat',
      'bank', 'library', 'townhall', 'clinic', 'police', 'firehouse', 'motel', 'school'].includes(type));

  let rooms;
  if (openPlan) {
    // One hall, with a small office or store carved off a back corner.
    rooms = [];
    if (w > 9 && d > 9 && !['church', 'cinema'].includes(type)) {
      const ow = Math.min(rng.range(3.2, 5.0), w * 0.36);
      const od = Math.min(rng.range(3.0, 4.6), d * 0.34);
      rooms.push({ x0: w - ow, z0: d - od, x1: w, z1: d, type: ROOM.OFFICE });
      rooms.push({ x0: 0, z0: 0, x1: w, z1: d - od, type: type === 'supermarket' ? ROOM.RETAIL : ROOM.WORKFLOOR });
      rooms.push({ x0: 0, z0: d - od, x1: w - ow, z1: d, type: ROOM.STOCK });
    } else {
      rooms = [{ x0: 0, z0: 0, x1: w, z1: d, type: type === 'church' ? ROOM.NAVE : ROOM.WORKFLOOR }];
    }
  } else {
    // Room sizes people actually live and work in. Splitting further produced
    // believable-looking plans full of 8 m² cupboards and tripled the cost of
    // every interior.
    const minSide = commercialGround ? 3.6 : 2.8;
    const minArea = commercialGround ? 28 : 18;
    rooms = splitRect({ x0: 0, z0: 0, x1: w, z1: d }, rng, minSide, minArea, 0, []);
    rooms.sort((a, b) => (a.z0 - b.z0) || (a.x0 - b.x0));
    assignRoomTypes(rooms, w, d, storey, type, commercialGround, rng);
  }

  // Circulation: the room nearest the front door is the entry.
  let entry = null;
  for (const r of rooms) {
    if (r.z0 > 0.4) continue;
    if (!entry || area(r) > area(entry)) entry = r;
  }
  if (!entry) entry = rooms[0];
  if (storey === 0) entry.entry = true;

  // Stairs, if the building has more than one storey.
  let stairs = null;
  if ((opts.storeys || 1) > 1) {
    const host = rooms.find((r) => r.type === ROOM.HALL)
      || rooms.find((r) => r.type === ROOM.LOBBY)
      || rooms.slice().sort((a, b) => area(b) - area(a))[0];
    const sw = 1.05, sd = Math.min(3.0, (host.z1 - host.z0) - 0.4);
    if (sd > 1.8 && (host.x1 - host.x0) > sw + 0.4) {
      const sx = host.x1 - sw - 0.2;
      const sz = host.z0 + 0.2;
      stairs = { x0: sx, z0: sz, x1: sx + sw, z1: sz + sd, room: host, up: true };
    }
  }

  // A fireplace on an exterior wall of the main living space.
  let fireplace = null;
  const living = rooms.find((r) => r.type === ROOM.LIVING);
  if (living && storey === 0) {
    if (living.x0 <= 0.3) fireplace = { x: 0.55, z: centre(living).z, face: 'left' };
    else if (living.x1 >= w - 0.3) fireplace = { x: w - 0.55, z: centre(living).z, face: 'right' };
    else if (living.z1 >= d - 0.3) fireplace = { x: centre(living).x, z: d - 0.55, face: 'back' };
  }

  const doors = planDoors(rooms, w, d, rng);
  return { rooms, doors, stairs, fireplace, w, d, storey, type };
}

function assignRoomTypes(rooms, w, d, storey, type, commercialGround, rng) {
  const bySize = rooms.slice().sort((a, b) => area(b) - area(a));
  const front = rooms.filter((r) => r.z0 <= 0.3);
  const back = rooms.filter((r) => r.z1 >= d - 0.3);

  for (const r of rooms) r.type = ROOM.BEDROOM;

  if (commercialGround) {
    const shopfront = front.sort((a, b) => area(b) - area(a))[0] || bySize[0];
    shopfront.type = ['library', 'townhall', 'clinic', 'police', 'motel', 'school'].includes(type)
      ? ROOM.LOBBY : ROOM.RETAIL;
    for (const r of rooms) {
      if (r === shopfront) continue;
      r.type = r.z0 > d * 0.45 ? ROOM.STOCK : ROOM.OFFICE;
    }
    const smallest = bySize[bySize.length - 1];
    if (smallest !== shopfront && area(smallest) < 7) smallest.type = ROOM.BATH;
    return;
  }

  if (storey === 0) {
    // Ground floor of a home: living at the front, kitchen at the back.
    const livingRoom = front.sort((a, b) => area(b) - area(a))[0] || bySize[0];
    livingRoom.type = ROOM.LIVING;
    const kitchen = back.filter((r) => r !== livingRoom).sort((a, b) => area(b) - area(a))[0]
      || bySize.find((r) => r !== livingRoom);
    if (kitchen) kitchen.type = ROOM.KITCHEN;
    // Everything else, smallest first: bathroom, then one hall, then the rooms
    // a household actually uses. A house with three hallways is not a house.
    const rest = rooms.filter((r) => r !== livingRoom && r !== kitchen);
    rest.sort((a, b) => area(a) - area(b));
    let hallPlaced = false;
    for (let i = 0; i < rest.length; i++) {
      const a = area(rest[i]);
      if (i === 0 && a < 9) { rest[i].type = ROOM.BATH; continue; }
      if (!hallPlaced && a < 14) { rest[i].type = ROOM.HALL; hallPlaced = true; continue; }
      rest[i].type = i === rest.length - 1 ? ROOM.DINING
        : (rng.chance(0.55) ? ROOM.BEDROOM : ROOM.OFFICE);
    }
    if (!rooms.some((r) => r.type === ROOM.BATH) && rest.length) rest[0].type = ROOM.BATH;
  } else {
    // Upstairs: bedrooms, one bathroom, a landing.
    const small = bySize[bySize.length - 1];
    small.type = ROOM.BATH;
    const landing = bySize.find((r) => r !== small && area(r) < 11) || bySize[bySize.length - 2];
    if (landing && landing !== small) landing.type = ROOM.HALL;
    for (const r of rooms) {
      if (r.type !== ROOM.BATH && r.type !== ROOM.HALL) {
        r.type = area(r) < 5.5 ? ROOM.CLOSET : ROOM.BEDROOM;
      }
    }
  }
}

/**
 * Doorways between adjacent rooms. A spanning pass guarantees every room is
 * reachable — which matters for enemy pathfinding as much as for the player —
 * and a few extra openings create loops so combat has flanking routes.
 */
function planDoors(rooms, w, d, rng) {
  const doors = [];
  const adj = [];
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i], b = rooms[j];
      // Vertical shared wall.
      if (Math.abs(a.x1 - b.x0) < 0.05 || Math.abs(b.x1 - a.x0) < 0.05) {
        const z0 = Math.max(a.z0, b.z0), z1 = Math.min(a.z1, b.z1);
        if (z1 - z0 > 1.15) adj.push({ i, j, axis: 'x', at: Math.abs(a.x1 - b.x0) < 0.05 ? a.x1 : b.x1, lo: z0, hi: z1 });
      }
      // Horizontal shared wall.
      if (Math.abs(a.z1 - b.z0) < 0.05 || Math.abs(b.z1 - a.z0) < 0.05) {
        const x0 = Math.max(a.x0, b.x0), x1 = Math.min(a.x1, b.x1);
        if (x1 - x0 > 1.15) adj.push({ i, j, axis: 'z', at: Math.abs(a.z1 - b.z0) < 0.05 ? a.z1 : b.z1, lo: x0, hi: x1 });
      }
    }
  }
  rng.shuffle(adj);

  // Union-find to build a spanning set first.
  const parent = rooms.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra === rb) return false; parent[ra] = rb; return true; };

  const place = (e) => {
    const width = Math.min(0.95, (e.hi - e.lo) - 0.3);
    if (width < 0.7) return false;
    const c = lerp(e.lo + width / 2 + 0.1, e.hi - width / 2 - 0.1, rng.range(0.25, 0.75));
    doors.push({ axis: e.axis, at: e.at, c0: c - width / 2, c1: c + width / 2, rooms: [e.i, e.j] });
    return true;
  };

  for (const e of adj) if (union(e.i, e.j)) place(e);
  for (const e of adj) {
    if (rng.chance(0.22) && !doors.some((dd) => dd.axis === e.axis && Math.abs(dd.at - e.at) < 0.05
      && dd.c0 < e.hi && dd.c1 > e.lo)) place(e);
  }
  return doors;
}

// --- fit-out ---------------------------------------------------------------

const FLOOR_MAT = {
  [ROOM.LIVING]: ['floor_wood', 'floor_carpet_red', 'floor_carpet_green'],
  [ROOM.DINING]: ['floor_wood', 'floor_wood_dark'],
  [ROOM.BEDROOM]: ['floor_carpet_red', 'floor_carpet_green', 'floor_wood'],
  [ROOM.KITCHEN]: ['floor_lino', 'floor_lino_check', 'floor_tile_small'],
  [ROOM.BATH]: ['floor_tile_small', 'floor_lino_check'],
  [ROOM.HALL]: ['floor_wood', 'floor_lino', 'floor_carpet_green'],
  [ROOM.CLOSET]: ['floor_wood'],
  [ROOM.OFFICE]: ['floor_carpet_green', 'floor_lino', 'floor_wood_dark'],
  [ROOM.RETAIL]: ['floor_lino_check', 'floor_lino', 'floor_tile_small'],
  [ROOM.LOBBY]: ['floor_tile_small', 'floor_lino_check', 'floor_wood_dark'],
  [ROOM.STOCK]: ['floor_concrete', 'floor_lino'],
  [ROOM.WORKFLOOR]: ['floor_concrete'],
  [ROOM.NAVE]: ['floor_wood_dark', 'floor_tile_small'],
};

/** Emit floors, ceilings, partitions and contents for one storey. */
export function furnishFloor(plan, ctx) {
  const { mb, lib, rng, y, storeyHeight: sh, mass, decay, prog, industrial, isTop } = ctx;
  const top = y + sh;
  const ceilH = top - 0.14;

  // --- floor & ceiling ----------------------------------------------------
  for (const room of plan.rooms) {
    const opts = FLOOR_MAT[room.type] || ['floor_wood'];
    const fm = lib.m(rng.pick(opts));
    mb.quadMat([room.x0, y + 0.02, room.z1], [room.x1, y + 0.02, room.z1],
      [room.x1, y + 0.02, room.z0], [room.x0, y + 0.02, room.z0], fm, [0, 1, 0],
      { spanU: room.x1 - room.x0, spanV: room.z1 - room.z0, maxEdge: 3.4,
        uvShift: [room.x0 / fm.tile, room.z0 / fm.tile] });
    // Skirting boards.
    const sk = lib.m('prop_wood_dark', 0.8);
    if (!industrial) {
      const h = 0.11;
      mb.box(room.x0, y + 0.02, room.z0, room.x1, y + 0.02 + h, room.z0 + 0.03, sk, { skip: 'top bottom', noTess: true });
      mb.box(room.x0, y + 0.02, room.z1 - 0.03, room.x1, y + 0.02 + h, room.z1, sk, { skip: 'top bottom', noTess: true });
    }
  }
  const cm = lib.m(industrial ? 'ceiling_ind' : (rng.chance(0.5) ? 'ceiling_tile' : 'ceiling_plaster'));
  mb.quadMat([0, ceilH, 0], [mass.w, ceilH, 0], [mass.w, ceilH, mass.d], [0, ceilH, mass.d],
    cm, [0, -1, 0], { spanU: mass.w, spanV: mass.d, maxEdge: 4.5 });

  // --- partitions with doorways ------------------------------------------
  const pw = lib.m(ctx.wallMat.name, ctx.wallMat.tile);
  const t = 0.13;
  const drawPartition = (axis, at, lo, hi, gaps) => {
    const ranges = [[lo, hi]];
    for (const g of gaps) {
      for (let i = ranges.length - 1; i >= 0; i--) {
        const [a, b] = ranges[i];
        if (g[1] <= a || g[0] >= b) continue;
        ranges.splice(i, 1);
        if (g[0] > a) ranges.push([a, g[0]]);
        if (g[1] < b) ranges.push([g[1], b]);
      }
    }
    for (const [a, b] of ranges) {
      if (b - a < 0.04) continue;
      if (axis === 'x') mb.box(at - t / 2, y + 0.02, a, at + t / 2, ceilH, b, pw, { skip: 'top bottom', maxEdge: 4 });
      else mb.box(a, y + 0.02, at - t / 2, b, ceilH, at + t / 2, pw, { skip: 'top bottom', maxEdge: 4 });
      const wa = axis === 'x' ? mb.worldPoint(at, 0, a) : mb.worldPoint(a, 0, at);
      const wb = axis === 'x' ? mb.worldPoint(at, 0, b) : mb.worldPoint(b, 0, at);
      if (ctx.collision) ctx.collision.addSegment(wa.x, wa.z, wb.x, wb.z, y, ceilH, 'partition');
    }
    // Door head over each gap so the opening reads as a doorway.
    for (const g of gaps) {
      if (axis === 'x') mb.box(at - t / 2, y + 2.06, g[0], at + t / 2, ceilH, g[1], pw, { skip: 'top bottom' });
      else mb.box(g[0], y + 2.06, at - t / 2, g[1], ceilH, at + t / 2, pw, { skip: 'top bottom' });
    }
  };

  // Collect unique interior wall lines from room boundaries.
  const walls = new Map();
  for (const r of plan.rooms) {
    for (const [axis, at, lo, hi] of [
      ['x', r.x0, r.z0, r.z1], ['x', r.x1, r.z0, r.z1],
      ['z', r.z0, r.x0, r.x1], ['z', r.z1, r.x0, r.x1],
    ]) {
      const outer = axis === 'x' ? (at < 0.05 || at > mass.w - 0.05) : (at < 0.05 || at > mass.d - 0.05);
      if (outer) continue;
      const key = `${axis}:${at.toFixed(2)}`;
      let w = walls.get(key);
      if (!w) { w = { axis, at, segs: [] }; walls.set(key, w); }
      w.segs.push([lo, hi]);
    }
  }
  for (const w of walls.values()) {
    // Merge overlapping spans.
    w.segs.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const s of w.segs) {
      const last = merged[merged.length - 1];
      if (last && s[0] <= last[1] + 0.01) last[1] = Math.max(last[1], s[1]);
      else merged.push(s.slice());
    }
    const gaps = plan.doors
      .filter((dd) => dd.axis === w.axis && Math.abs(dd.at - w.at) < 0.05)
      .map((dd) => [dd.c0, dd.c1]);
    for (const [a, b] of merged) drawPartition(w.axis, w.at, a, b, gaps);
  }

  // --- stairs -------------------------------------------------------------
  if (plan.stairs && !isTop) {
    const s = plan.stairs;
    const steps = Math.max(10, Math.round(sh / 0.19));
    const runY = sh / steps;
    const runZ = (s.z1 - s.z0) / steps;
    const wood = lib.m('prop_wood_dark', 1.0);
    for (let i = 0; i < steps; i++) {
      mb.box(s.x0, y + i * runY, s.z0 + i * runZ, s.x1, y + (i + 1) * runY, s.z0 + (i + 1) * runZ + 0.02, wood, { skip: 'bottom' });
    }
    // Handrail.
    mb.box(s.x1 - 0.06, y + 0.9, s.z0, s.x1, y + 0.98, s.z1, wood, { skip: 'top bottom' });
    if (ctx.record) {
      ctx.record.stairs = ctx.record.stairs || [];
      ctx.record.stairs.push({
        bottom: mb.worldPoint((s.x0 + s.x1) / 2, y, s.z0 - 0.5),
        top: mb.worldPoint((s.x0 + s.x1) / 2, y + sh, s.z1 + 0.5),
        storey: ctx.storey,
      });
    }
  }

  // --- baked window light --------------------------------------------------
  // Rooms with exterior walls get a pool of daylight; deep rooms stay dark.
  // The renderer bakes this by probing the light list the world assembles.

  // --- contents -----------------------------------------------------------
  for (const room of plan.rooms) {
    furnishRoom(room, plan, ctx);
  }

  // Ceiling fixtures over the bigger rooms.
  for (const room of plan.rooms) {
    if (area(room) < 7) continue;
    const c = centre(room);
    const on = !industrial && rng.chance(0.22 - decay * 0.14);
    if (rng.chance(0.75)) {
      if (industrial || room.type === ROOM.RETAIL || room.type === ROOM.WORKFLOOR || room.type === ROOM.STOCK) {
        P.ceilingLight(mb, ctx, c.x, ceilH, c.z, rng, { on, flicker: true, r: 9 });
      } else {
        P.pendantLight(mb, ctx, c.x, ceilH, c.z, rng, { on, flicker: true });
      }
    }
  }

  // Signs of what happened here.
  const goreCount = Math.round(1 + decay * 4);
  for (let i = 0; i < goreCount; i++) {
    if (!rng.chance(0.55)) continue;
    const room = rng.pick(plan.rooms);
    P.bloodDecal(mb, ctx, rng.range(room.x0 + 0.4, room.x1 - 0.4), y + 0.03,
      rng.range(room.z0 + 0.4, room.z1 - 0.4), rng);
  }
}

function furnishRoom(room, plan, ctx) {
  const { mb, rng, y, mass, decay } = ctx;
  const w = room.x1 - room.x0, d = room.z1 - room.z0;
  const c = centre(room);
  if (w < 1.2 || d < 1.2) return;

  // A local frame at floor level keeps prop authoring simple.
  mb.push(0, y + 0.02, 0, 0);
  const clutter = clamp(0.25 + decay * 0.6, 0, 0.95);

  // Which walls of this room are interior-facing (safe to place against)?
  const alongWall = (edge, inset) => {
    switch (edge) {
      case 'left': return { x: room.x0 + inset, z: rng.range(room.z0 + 0.8, room.z1 - 0.8), yaw: Math.PI / 2 };
      case 'right': return { x: room.x1 - inset, z: rng.range(room.z0 + 0.8, room.z1 - 0.8), yaw: -Math.PI / 2 };
      case 'front': return { x: rng.range(room.x0 + 0.8, room.x1 - 0.8), z: room.z0 + inset, yaw: 0 };
      default: return { x: rng.range(room.x0 + 0.8, room.x1 - 0.8), z: room.z1 - inset, yaw: Math.PI };
    }
  };
  const edges = ['left', 'right', 'front', 'back'];

  switch (room.type) {
    case ROOM.LIVING: {
      const e = rng.pick(edges);
      const p = alongWall(e, 0.55);
      P.sofa(mb, ctx, p.x, p.z, p.yaw, rng);
      P.rug(mb, ctx, c.x, c.z, rng.range(-0.3, 0.3), rng);
      if (w > 3 && d > 3) P.coffeeTable(mb, ctx, c.x, c.z, rng.range(-0.2, 0.2), rng);
      const opp = alongWall(e === 'front' ? 'back' : e === 'back' ? 'front' : (e === 'left' ? 'right' : 'left'), 0.5);
      P.crtTV(mb, ctx, opp.x, opp.z, opp.yaw + Math.PI, rng);
      if (rng.chance(0.5)) { const q = alongWall(rng.pick(edges), 0.35); P.bookshelf(mb, ctx, q.x, q.z, q.yaw, rng); }
      if (rng.chance(0.4)) { const q = alongWall(rng.pick(edges), 0.6); P.armchair(mb, ctx, q.x, q.z, q.yaw, rng); }
      if (plan.fireplace && room.x0 <= plan.fireplace.x && plan.fireplace.x <= room.x1) buildFireplace(mb, ctx, plan.fireplace, room);
      break;
    }
    case ROOM.DINING: {
      P.diningTable(mb, ctx, c.x, c.z, rng.range(0, TAU), rng);
      if (rng.chance(0.5)) { const q = alongWall(rng.pick(edges), 0.35); P.dresser(mb, ctx, q.x, q.z, q.yaw, rng); }
      break;
    }
    case ROOM.BEDROOM: {
      const e = rng.pick(edges);
      const p = alongWall(e, 1.15);
      P.bed(mb, ctx, p.x, p.z, p.yaw, rng, { double: w * d > 11 });
      const q = alongWall(rng.pick(edges.filter((x) => x !== e)), 0.32);
      P.dresser(mb, ctx, q.x, q.z, q.yaw, rng);
      if (w * d > 9 && rng.chance(0.7)) {
        const r = alongWall(rng.pick(edges), 0.35);
        P.wardrobe(mb, ctx, r.x, r.z, r.yaw, rng);
      }
      P.nightstand(mb, ctx, clamp(p.x + Math.cos(p.yaw + Math.PI / 2) * 0.8, room.x0 + 0.3, room.x1 - 0.3),
        clamp(p.z + Math.sin(p.yaw + Math.PI / 2) * 0.8, room.z0 + 0.3, room.z1 - 0.3), p.yaw, rng);
      if (rng.chance(0.4)) P.rug(mb, ctx, c.x, c.z, rng.range(0, 1), rng);
      break;
    }
    case ROOM.KITCHEN: {
      // Counters run along the longest clear wall, with the sink under a window.
      const runLen = Math.max(1.4, Math.min(w, d) * 0.8);
      if (w >= d) {
        P.counterRun(mb, ctx, room.x0 + 0.35, room.z0 + 0.6, room.x0 + 0.35, room.z0 + 0.6 + runLen, rng, { sink: true, upper: rng.chance(0.7) });
      } else {
        P.counterRun(mb, ctx, room.x0 + 0.6, room.z0 + 0.35, room.x0 + 0.6 + runLen, room.z0 + 0.35, rng, { sink: true, upper: rng.chance(0.7) });
      }
      const f = alongWall(rng.pick(edges), 0.4);
      P.fridge(mb, ctx, f.x, f.z, f.yaw, rng);
      const s = alongWall(rng.pick(edges), 0.38);
      P.stove(mb, ctx, s.x, s.z, s.yaw, rng);
      if (w > 3.2 && d > 3.2 && rng.chance(0.55)) P.diningTable(mb, ctx, c.x, c.z, rng.range(0, TAU), rng);
      break;
    }
    case ROOM.BATH: {
      const t1 = alongWall('back', 0.42); P.toilet(mb, ctx, t1.x, t1.z, t1.yaw, rng);
      const b1 = alongWall('left', 0.32); P.basin(mb, ctx, b1.x, b1.z, b1.yaw, rng);
      if (Math.max(w, d) > 2.4) {
        const tub = alongWall('right', 0.42);
        P.bathtub(mb, ctx, tub.x, tub.z, tub.yaw, rng);
      }
      break;
    }
    case ROOM.HALL: {
      if (rng.chance(0.5)) { const q = alongWall(rng.pick(edges), 0.3); P.bookshelf(mb, ctx, q.x, q.z, q.yaw, rng, { h: 1.1 }); }
      if (rng.chance(0.35)) { const q = alongWall(rng.pick(edges), 0.35); P.dresser(mb, ctx, q.x, q.z, q.yaw, rng); }
      break;
    }
    case ROOM.CLOSET: {
      if (rng.chance(0.6)) P.cardboardBoxes(mb, ctx, c.x, c.z, rng.range(0, TAU), rng, rng.int(1, 3));
      if (ctx.spawns) ctx.spawns.push({ p: mb.worldPoint(c.x, 0, c.z), kind: 'closet' });
      break;
    }
    case ROOM.OFFICE: {
      P.officeDesk(mb, ctx, c.x, c.z, rng.range(0, TAU), rng);
      const q = alongWall(rng.pick(edges), 0.35);
      P.filingCabinet(mb, ctx, q.x, q.z, q.yaw, rng);
      if (rng.chance(0.5)) { const r = alongWall(rng.pick(edges), 0.3); P.bookshelf(mb, ctx, r.x, r.z, r.yaw, rng); }
      break;
    }
    case ROOM.RETAIL: {
      // Aisles of shelving running front-to-back, with cover at the ends.
      const aisles = clamp(Math.floor(w / 2.6), 1, 5);
      for (let i = 0; i < aisles; i++) {
        const ax = room.x0 + (w / (aisles + 1)) * (i + 1);
        const len = Math.min(d - 2.2, rng.range(2.6, 5.5));
        if (len < 1.6) continue;
        P.shelvingUnit(mb, ctx, ax, c.z, 0, rng, { len, stocked: clamp(0.75 - decay * 0.5, 0.05, 0.9) });
      }
      const cc = alongWall('front', 1.2);
      P.cashCounter(mb, ctx, clamp(cc.x, room.x0 + 1, room.x1 - 1), room.z0 + 1.1, Math.PI / 2, rng);
      if (rng.chance(0.5)) P.displayRack(mb, ctx, rng.range(room.x0 + 0.8, room.x1 - 0.8), room.z0 + 1.9, rng.range(0, TAU), rng);
      if (rng.chance(0.35)) P.mannequin(mb, ctx, rng.range(room.x0 + 0.7, room.x1 - 0.7), room.z0 + 1.2, rng.range(0, TAU), rng);
      if (rng.chance(0.4)) { const q = alongWall('back', 0.5); P.vendingMachine(mb, ctx, q.x, q.z, q.yaw, rng); }
      break;
    }
    case ROOM.LOBBY: {
      if (rng.chance(0.8)) P.cashCounter(mb, ctx, c.x, room.z1 - 1.0, Math.PI, rng);
      for (let i = 0; i < rng.int(1, 3); i++) {
        const q = alongWall(rng.pick(edges), 0.7);
        P.chair(mb, ctx, q.x, q.z, q.yaw, rng, {});
      }
      if (rng.chance(0.5)) P.rug(mb, ctx, c.x, c.z, 0, rng);
      break;
    }
    case ROOM.STOCK: {
      for (let i = 0; i < rng.int(2, 5); i++) {
        const q = alongWall(rng.pick(edges), 0.6);
        P.shelvingUnit(mb, ctx, q.x, q.z, q.yaw, rng, { len: rng.range(1.6, 2.6), stocked: 0.5 });
      }
      for (let i = 0; i < rng.int(1, 4); i++) {
        P.palletStack(mb, ctx, rng.range(room.x0 + 0.9, room.x1 - 0.9), rng.range(room.z0 + 0.9, room.z1 - 0.9), rng.range(0, TAU), rng);
      }
      if (ctx.spawns) ctx.spawns.push({ p: mb.worldPoint(c.x, 0, c.z), kind: 'stock' });
      break;
    }
    case ROOM.WORKFLOOR: {
      const n = Math.floor((w * d) / 58);
      for (let i = 0; i < n; i++) {
        const px = rng.range(room.x0 + 1.6, room.x1 - 1.6), pz = rng.range(room.z0 + 1.6, room.z1 - 1.6);
        const r = rng.next();
        if (r < 0.32) P.machine(mb, ctx, px, pz, rng.range(0, TAU), rng);
        else if (r < 0.5) P.palletStack(mb, ctx, px, pz, rng.range(0, TAU), rng);
        else if (r < 0.66) P.toolbench(mb, ctx, px, pz, rng.range(0, TAU), rng);
        else if (r < 0.84) P.crate(mb, ctx, px, pz, rng.range(0, TAU), rng, { size: rng.range(0.8, 1.4) });
        else P.barrel(mb, ctx, px, pz, rng.range(0, TAU), rng, { hazard: rng.chance(0.4) });
      }
      if (w > 6 && d > 6) {
        const q = alongWall('left', 0.4);
        P.lockerBank(mb, ctx, q.x, q.z, q.yaw, rng);
      }
      if (ctx.spawns) ctx.spawns.push({ p: mb.worldPoint(c.x, 0, c.z), kind: 'floor' });
      break;
    }
    case ROOM.NAVE: {
      const rows = Math.floor((d - 3.5) / 1.1);
      for (let i = 0; i < rows; i++) {
        const pz = room.z0 + 2.2 + i * 1.1;
        const pl = (w - 2.2) / 2 - 0.4;
        if (pl < 1.2) break;
        P.pew(mb, ctx, room.x0 + 0.6 + pl / 2, pz, Math.PI / 2, rng, { len: pl });
        P.pew(mb, ctx, room.x1 - 0.6 - pl / 2, pz, Math.PI / 2, rng, { len: pl });
      }
      // Altar and lectern at the far end.
      mb.boxC(c.x, 0, room.z1 - 1.6, 2.0, 1.0, 0.8, ctx.lib.m('prop_wood_dark', 1.2));
      mb.boxC(c.x - 1.9, 0, room.z1 - 2.4, 0.5, 1.15, 0.5, ctx.lib.m('prop_wood_dark', 0.8));
      break;
    }
    default: break;
  }

  // Generic decay clutter: knocked-over furniture, debris, blood.
  if (rng.chance(clutter)) {
    P.junkPile(mb, ctx, rng.range(room.x0 + 0.6, room.x1 - 0.6), rng.range(room.z0 + 0.6, room.z1 - 0.6), rng, 0.9);
  }
  if (rng.chance(clutter * 0.7)) {
    P.cardboardBoxes(mb, ctx, rng.range(room.x0 + 0.6, room.x1 - 0.6), rng.range(room.z0 + 0.6, room.z1 - 0.6), rng.range(0, TAU), rng, rng.int(1, 3));
  }

  // Dark corners are where the infected wait.
  if (ctx.spawns && area(room) > 6 && rng.chance(0.5)) {
    ctx.spawns.push({ p: mb.worldPoint(rng.range(room.x0 + 0.5, room.x1 - 0.5), 0, rng.range(room.z0 + 0.5, room.z1 - 0.5)), kind: 'room' });
  }
  if (ctx.loot && rng.chance(0.35)) {
    ctx.loot.push({ p: mb.worldPoint(c.x, 0.1, c.z), kind: 'floor' });
  }

  mb.pop();
}

function buildFireplace(mb, ctx, fp, room) {
  const { lib, rng } = ctx;
  const brick = lib.m('brick_deep', 1.2);
  const mantel = lib.m('prop_wood_dark', 0.9);
  const yaw = fp.face === 'left' ? Math.PI / 2 : fp.face === 'right' ? -Math.PI / 2 : Math.PI;
  mb.push(fp.x, 0, fp.z, yaw);
  mb.boxC(0, 0, 0, 1.7, 2.3, 0.5, brick);
  mb.boxC(0, 0.05, -0.28, 0.95, 1.0, 0.06, lib.m('black', 1.0));
  mb.boxC(0, 1.16, -0.34, 1.9, 0.10, 0.30, mantel);
  if (rng.chance(0.5)) mb.boxC(0, 1.26, -0.32, 0.5, 0.36, 0.05, lib.m('prop_paper', 0.5));
  mb.pop();
  P.solidBox(ctx, mb, fp.x, fp.z, 1.7, 0.5, 0, 2.3, yaw);
}
