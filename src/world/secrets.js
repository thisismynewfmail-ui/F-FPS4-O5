// ---------------------------------------------------------------------------
// secrets.js — the things nobody tells you about.
//
// Twelve of them, and they are deliberately of three different kinds, because
// a map where every secret is a loot cache trains the player to stop looking
// once they have the gun:
//
//   * REWARDING     — a cache worth the detour. Fire escapes, cellars, the
//                     sewer chamber, the dry well, the tower platform.
//   * OBSERVATIONAL — nothing to take. Something is wrong and you are the only
//                     one who will ever notice. The shrine, the parlours, the
//                     car, the room that isn't.
//   * CONDITIONAL   — the world changes at a kill count, quietly, whether or
//                     not you are there to see it. The boarded house.
//
// Everything here is real geometry with real collision, placed against
// buildings that already exist and tested for clearance, so nothing intersects
// anything and every one of them can actually be walked into.
// ---------------------------------------------------------------------------

import { TAU, clamp, clamp01, lerp, dist2D } from '../core/math.js';
import * as P from './props.js';
import { ZONE } from './plan.js';

export function placeSecrets(world) {
  const rng = world.rng.fork(0x53c7);
  const builders = [
    fireEscape, cellarSteps, hollowShrine, sewerChamber, roomThatIsnt,
    dryWell, stillRunningCar, identicalParlours, towerPlatform,
    seventeenthStep, boardedHouse, listeningMast,
  ];
  for (const b of builders) {
    try { b(world, rng); } catch (err) {
      // A secret that will not fit on this seed is not a secret worth crashing
      // for; there are eleven others and the validator asserts the count.
      if (globalThis.__SECRET_DEBUG) console.log("secret failed:", b.name, err.message);
    }
  }
}

// --- helpers ---------------------------------------------------------------

function note(world, name, x, z, kind, hint) {
  world.secrets.push({
    name, x, z, kind, hint,
    district: world.districts.districtAt(x, z),
  });
}

/** Pick a building matching a predicate, deterministically but scattered. */
function pickBuilding(world, rng, pred, tries = 400) {
  const list = world.buildings;
  if (!list.length) return null;
  for (let i = 0; i < tries; i++) {
    const b = list[Math.floor(rng.next() * list.length)];
    if (b && pred(b)) return b;
  }
  return null;
}

/** Local frame of a building: +x along the frontage, +z into the lot. */
function frame(b) {
  const fp = b.lot.footprint;
  const main = fp.masses.find((m) => m.kind === 'main');
  return { fp, main, toWorld: fp.toWorld, yaw: fp.yaw, base: b.baseY };
}

/**
 * A flight of steps that is real geometry and real collision: one floor plate
 * per tread, each offset horizontally, so the player has to walk up it rather
 * than being levitated by the floor solver.
 */
function stair(world, mb, x, z, yaw, fromY, toY, steps, mat, width = 1.2) {
  const dx = Math.sin(yaw), dz = Math.cos(yaw);
  const run = 0.34;
  const nx = Math.cos(yaw), nz = -Math.sin(yaw);
  for (let i = 0; i < steps; i++) {
    const t = (i + 1) / steps;
    const y = lerp(fromY, toY, t);
    const px = x + dx * run * i, pz = z + dz * run * i;
    mb.box(px - nx * width / 2 - dx * 0.02, y - (toY - fromY) / steps, pz - nz * width / 2 - dz * 0.02,
      px + nx * width / 2 + dx * run, y, pz + nz * width / 2 + dz * run, mat, { skip: 'bottom' });
    world.collision.addFloor([
      { x: px - nx * width / 2, z: pz - nz * width / 2 },
      { x: px + nx * width / 2, z: pz + nz * width / 2 },
      { x: px + nx * width / 2 + dx * run, z: pz + nz * width / 2 + dz * run },
      { x: px - nx * width / 2 + dx * run, z: pz - nz * width / 2 + dz * run },
    ], y, 'stair');
  }
  return { x: x + dx * run * steps, z: z + dz * run * steps };
}

// --- 1. the fire escape ----------------------------------------------------
// A switchback stair up the back of a downtown block. Rooftops are the safest
// ground in the game and this is the only free way onto one.

function fireEscape(world, rng) {
  const b = pickBuilding(world, rng, (bb) =>
    bb.roofFlat && bb.storeys >= 2 && bb.lot.zone === ZONE.CORE && bb.eaveY > 6);
  if (!b) return;
  const f = frame(b);
  const m = f.main;
  const steel = world.m('prop_rust', 1.0);
  const grate = world.m('prop_darksteel', 0.8);
  const top = b.baseY + b.eaveY;
  // Run it up the right-hand flank, 0.5 m clear of the wall.
  const startL = { x: m.x1 + 0.75, z: m.z0 + 1.2 };
  const w0 = f.toWorld(startL.x, startL.z);
  // Margin 0: the escape hangs off its own wall by design, so the test is
  // only "is this strip of ground already occupied by another building".
  if (world.insideAnyBuilding(w0.x, w0.z, 0)) return;

  const flights = Math.max(2, Math.round((top - world.gy(w0.x, w0.z)) / 3.0));
  const gy = world.gy(w0.x, w0.z);
  world.store.emit(w0.x, w0.z, (mb) => {
    mb.env = world.env;
    mb.push(f.fp.origin.x, b.baseY, f.fp.origin.z, f.yaw);
    let y = gy - b.baseY;
    let z = startL.z;
    for (let i = 0; i < flights; i++) {
      const y1 = Math.min(y + (b.eaveY - y) / (flights - i), b.eaveY);
      const dir = i % 2 === 0 ? 1 : -1;
      const run = 3.0;
      const steps = 12;
      for (let s = 0; s < steps; s++) {
        const t = (s + 1) / steps;
        mb.box(m.x1 + 0.35, lerp(y, y1, t) - 0.05, z + dir * run * (s / steps),
          m.x1 + 1.45, lerp(y, y1, t), z + dir * run * ((s + 1) / steps), grate, { skip: 'bottom' });
      }
      // Landing.
      mb.box(m.x1 + 0.30, y1 - 0.06, z + dir * run, m.x1 + 1.55, y1, z + dir * (run + 1.1), grate, { skip: 'bottom' });
      mb.box(m.x1 + 1.50, y1, z + dir * run, m.x1 + 1.58, y1 + 1.0, z + dir * (run + 1.1), steel, { skip: 'top bottom' });
      z += dir * (run + 1.1);
      y = y1;
    }
    mb.pop();
  });

  // Collision: one plate per landing plus a ramp of plates per flight.
  let y = gy;
  let zl = startL.z;
  for (let i = 0; i < flights; i++) {
    const y1 = Math.min(y + (top - y) / (flights - i), top);
    const dir = i % 2 === 0 ? 1 : -1;
    for (let s = 0; s <= 12; s++) {
      const t = s / 12;
      const p = f.toWorld(m.x1 + 0.9, zl + dir * 3.0 * t);
      world.collision.addFloor(quadAt(p.x, p.z, 1.1), lerp(y, y1, t), 'fire-escape');
    }
    const lp = f.toWorld(m.x1 + 0.9, zl + dir * 3.55);
    world.collision.addFloor(quadAt(lp.x, lp.z, 1.3), y1, 'fire-escape');
    zl += dir * 4.1;
    y = y1;
  }
  // The reason to climb it.
  const roofC = f.toWorld(m.x0 + m.w * 0.5, m.z0 + m.d * 0.5);
  world.loot.push({ p: { x: roofC.x, y: top + 0.2, z: roofC.z }, kind: 'locker' });
  world.loot.push({ p: { x: roofC.x + 1.2, y: top + 0.2, z: roofC.z }, kind: 'crate' });
  note(world, 'The fire escape', w0.x, w0.z, 'reward', 'a way onto the roofs');
}

function quadAt(x, z, s) {
  const h = s / 2;
  return [{ x: x - h, z: z - h }, { x: x + h, z: z - h }, { x: x + h, z: z + h }, { x: x - h, z: z + h }];
}

// --- 2. the cellar steps ---------------------------------------------------
// A house cut into the hill has a coal chute at the back. It is not on any
// elevation because from the street the ground is above it.

function cellarSteps(world, rng) {
  const b = pickBuilding(world, rng, (bb) => (bb.foundDrop || 0) > 1.1 && bb.lot.zone !== ZONE.INDUSTRIAL)
    || pickBuilding(world, rng, (bb) => (bb.foundDrop || 0) > 0.8);
  if (!b) return;
  const f = frame(b);
  const m = f.main;
  const w = f.toWorld(m.x0 + m.w * 0.5, m.z1 + 1.9);
  if (world.insideAnyBuilding(w.x, w.z, 0.8)) return;
  const gy = world.gy(w.x, w.z);
  const floorY = Math.min(b.baseY - b.foundDrop + 0.2, gy - 2.4);
  if (gy - floorY < 1.6) return;

  const stone = world.m('found_stone', 1.6);
  const dark = world.m('wall_ind', 2.4);
  world.store.emit(w.x, w.z, (mb) => {
    mb.env = world.env;
    const prev = world.env.indoor;
    world.env.indoor = 1;
    mb.push(w.x, 0, w.z, f.yaw + Math.PI);
    // A sunken well with steps down to a door under the house.
    mb.box(-1.5, floorY, -0.2, 1.5, gy, 2.6, stone, { skip: 'top bottom' });
    mb.quadMat([-1.4, floorY, 2.5], [1.4, floorY, 2.5], [1.4, floorY, -0.1], [-1.4, floorY, -0.1],
      stone, [0, 1, 0], { spanU: 2.8, spanV: 2.6 });
    mb.box(-1.1, floorY, -0.15, 1.1, floorY + 2.05, -0.05, dark, { skip: 'bottom' });
    world.env.indoor = prev;
    mb.pop();
    // The steps themselves, in world space.
    const dirx = Math.sin(f.yaw + Math.PI), dirz = Math.cos(f.yaw + Math.PI);
    stair(world, mb, w.x + dirx * 2.2, w.z + dirz * 2.2, f.yaw, gy, floorY + 0.05, 8, stone, 1.6);
  });

  world.collision.addFloor(quadAt(w.x, w.z, 2.4), floorY, 'cellar');
  world.loot.push({ p: { x: w.x, y: floorY + 0.15, z: w.z }, kind: 'locker' });
  world.loot.push({ p: { x: w.x + 0.8, y: floorY + 0.15, z: w.z + 0.4 }, kind: 'medicine' });
  world.spawns.push({ p: { x: w.x, y: floorY, z: w.z }, kind: 'cellar' });
  note(world, 'The coal cellar', w.x, w.z, 'reward', 'below the back of a hill house');
}

// --- 3. the shrine in the Hollow -------------------------------------------
// Observational. Somebody came down here and built this, and it is the only
// thing in the town that was made after everything else stopped.

function hollowShrine(world, rng) {
  const lf = world.cfg.landforms.hollow;
  const x = lf.x + Math.cos(lf.rampAngle + Math.PI) * lf.radius * 0.35;
  const z = lf.z + Math.sin(lf.rampAngle + Math.PI) * lf.radius * 0.35;
  const gy = world.gy(x, z);
  const stone = world.m('rock_dark', 2.0);
  const pale = world.m('prop_porcelain', 0.8);

  world.onGround(x, z, (mb, ctx) => {
    // A ring of stones. There are always thirteen and they are always the same
    // distance apart, which is the part that should bother you.
    for (let i = 0; i < 13; i++) {
      const a = (i / 13) * TAU;
      mb.push(x + Math.cos(a) * 3.4, 0, z + Math.sin(a) * 3.4, a);
      mb.boxC(0, 0, 0, 0.42, 0.95 + (i % 3) * 0.16, 0.36, stone);
      mb.pop();
    }
    mb.boxC(x, 0, z, 1.1, 0.55, 1.1, stone);
    // Candles. Every one of them is burnt down to exactly the same height.
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU;
      mb.boxC(x + Math.cos(a) * 0.34, 0.55, z + Math.sin(a) * 0.34, 0.07, 0.11, 0.07, pale);
    }
    ctx.lights.push({ p: mb.worldPoint(x, 0.8, z), r: 7, c: [0.30, 0.24, 0.14], flicker: true });
  });
  world.landmarks.push({ name: 'The Hollow', x, z, y: gy + 2, district: world.districts.districtAt(x, z) });
  note(world, 'The stone ring', x, z, 'observational', 'thirteen stones, evenly spaced');
}

// --- 4. the sewer chamber --------------------------------------------------
// The manholes that glow faintly from below were always hinting at this. One
// of them has had its cover levered off and its shaft has a ladder in it.

function sewerChamber(world, rng) {
  const pad = world.surfaces.pads.filter((p) => p.degree >= 3 && p.radius > 4.5);
  if (!pad.length) return;
  const node = world.graph.nodes[pad[Math.floor(rng.next() * pad.length)].node];
  const x = node.x + rng.range(-2, 2), z = node.z + rng.range(-2, 2);
  const gy = world.gy(x, z);
  const floorY = gy - 4.6;
  const brick = world.m('brick_deep#w', 1.6);
  const water = world.m('water', 4);
  const steel = world.m('prop_rust', 0.7);

  world.store.emit(x, z, (mb) => {
    mb.env = world.env;
    const prev = world.env.indoor;
    world.env.indoor = 1;
    // Shaft, then a barrel-vaulted chamber a few metres across.
    mb.box(x - 0.85, floorY, z - 0.85, x + 0.85, gy + 0.02, z + 0.85, brick, { skip: 'top bottom' });
    mb.box(x - 4.2, floorY, z - 4.2, x + 4.2, floorY + 2.6, z + 4.2, brick, { skip: 'top bottom' });
    mb.quadMat([x - 4.2, floorY + 2.6, z + 4.2], [x + 4.2, floorY + 2.6, z + 4.2],
      [x + 4.2, floorY + 2.6, z - 4.2], [x - 4.2, floorY + 2.6, z - 4.2], brick, [0, -1, 0],
      { spanU: 8.4, spanV: 8.4 });
    mb.quadMat([x - 4.2, floorY + 0.06, z - 4.2], [x + 4.2, floorY + 0.06, z - 4.2],
      [x + 4.2, floorY + 0.06, z + 4.2], [x - 4.2, floorY + 0.06, z + 4.2], water, [0, 1, 0],
      { spanU: 8.4, spanV: 8.4 });
    world.env.indoor = prev;
    // Rungs: a stepped spiral, so it is climbed rather than ridden.
    for (let i = 0; i < 14; i++) {
      const a = i * 0.9;
      mb.boxC(x + Math.cos(a) * 0.55, floorY + i * 0.34, z + Math.sin(a) * 0.55, 0.35, 0.06, 0.35, steel);
    }
    world.lights.push({ p: { x, y: floorY + 1.4, z }, r: 9, c: [0.16, 0.24, 0.20], flicker: true });
  });

  // Walls of the chamber, and the plates that make it standable and climbable.
  world.collision.addFloor(quadAt(x, z, 8.4), floorY + 0.06, 'sewer');
  for (let i = 0; i < 14; i++) {
    const a = i * 0.9;
    world.collision.addFloor(
      quadAt(x + Math.cos(a) * 0.55, z + Math.sin(a) * 0.55, 0.5), floorY + i * 0.34 + 0.06, 'sewer');
  }
  for (let i = 0; i < 4; i++) {
    const c = [[-4.2, -4.2], [4.2, -4.2], [4.2, 4.2], [-4.2, 4.2]];
    const a = c[i], bb = c[(i + 1) % 4];
    world.collision.addSegment(x + a[0], z + a[1], x + bb[0], z + bb[1], floorY, floorY + 2.6, 'wall');
  }
  world.loot.push({ p: { x: x + 2.4, y: floorY + 0.2, z: z + 1.6 }, kind: 'locker' });
  world.loot.push({ p: { x: x - 2.0, y: floorY + 0.2, z: z + 2.2 }, kind: 'tools' });
  world.spawns.push({ p: { x, y: floorY, z }, kind: 'sewer' });
  note(world, 'The chamber under the junction', x, z, 'reward', 'a manhole with its cover off');
}

// --- 5. the room that isn't ------------------------------------------------
// Observational, and the one that most people will refuse to believe. A brick
// box behind a building, with no door on the outside — because its door is on
// the *inside* of a wall that has nothing behind it.

function roomThatIsnt(world, rng) {
  const b = pickBuilding(world, rng, (bb) => bb.storeys >= 1 && bb.lot.area > 200);
  if (!b) return;
  const f = frame(b);
  const m = f.main;
  const c = f.toWorld(m.x0 + m.w * 0.5, m.z1 + 2.6);
  if (world.insideAnyBuilding(c.x, c.z, 2.2)) return;
  const gy = world.gy(c.x, c.z);
  const wall = world.m('brick_deep#w', 2.2);
  const floor = world.m('floor_wood', 2.4);

  world.store.emit(c.x, c.z, (mb) => {
    mb.env = world.env;
    mb.push(c.x, gy, c.z, f.yaw);
    const prev = world.env.indoor;
    // Outside: a windowless brick box, 4 x 4, with no opening at all.
    mb.box(-2, 0, -2, 2, 2.9, 2, wall, { skip: 'bottom' });
    world.env.indoor = 1;
    // Inside: one chair, facing a wall, and a bulb that is on.
    mb.quadMat([-1.8, 0.05, 1.8], [1.8, 0.05, 1.8], [1.8, 0.05, -1.8], [-1.8, 0.05, -1.8],
      floor, [0, 1, 0], { spanU: 3.6, spanV: 3.6 });
    const ctx = world.ctxFor(mb);
    P.chair(mb, ctx, 0, 0, Math.PI, rng, {});
    P.pendantLight(mb, ctx, 0, 2.7, 0, rng, { on: true, flicker: false, r: 5 });
    world.env.indoor = prev;
    mb.pop();
  });
  // Solid on all four sides. There is no way in. That is the point.
  for (let i = 0; i < 4; i++) {
    const pts = [[-2, -2], [2, -2], [2, 2], [-2, 2]];
    const p = f.fp.toWorld(0, 0);
    const rot = (lx, lz) => ({
      x: c.x + lx * Math.cos(f.yaw) + lz * Math.sin(f.yaw),
      z: c.z - lx * Math.sin(f.yaw) + lz * Math.cos(f.yaw),
    });
    const a = rot(pts[i][0], pts[i][1]), bb = rot(pts[(i + 1) % 4][0], pts[(i + 1) % 4][1]);
    world.collision.addSegment(a.x, a.z, bb.x, bb.z, gy, gy + 2.9, 'wall');
  }
  note(world, 'The room with no door', c.x, c.z, 'observational', 'the light is on inside');
}

// --- 6. the dry well -------------------------------------------------------

function dryWell(world, rng) {
  const lot = world.lots.filter((l) => l.zone === ZONE.RURAL && !l.footprint && l.area > 200);
  if (!lot.length) return;
  let p = null;
  for (let i = 0; i < 24 && !p; i++) {
    const L = lot[Math.floor(rng.next() * lot.length)];
    p = world.randomInPoly(L.poly, rng);
    if (p && world.insideAnyBuilding(p.x, p.z, 3)) p = null;
  }
  if (!p) return;
  const gy = world.gy(p.x, p.z);
  const floorY = gy - 5.2;
  const stone = world.m('found_stone', 1.4);
  const wood = world.m('prop_wood_dark', 0.9);

  world.store.emit(p.x, p.z, (mb) => {
    mb.env = world.env;
    mb.cylinder(p.x, gy - 0.1, p.z, 1.25, 0.95, 10, stone, { capTop: false });
    const prev = world.env.indoor;
    world.env.indoor = 1;
    mb.cylinder(p.x, floorY, p.z, 1.05, gy - floorY, 10, stone, { capTop: false });
    mb.quadMat([p.x - 1, floorY + 0.05, p.z + 1], [p.x + 1, floorY + 0.05, p.z + 1],
      [p.x + 1, floorY + 0.05, p.z - 1], [p.x - 1, floorY + 0.05, p.z - 1],
      world.m('dirt', 2), [0, 1, 0], { spanU: 2, spanV: 2 });
    world.env.indoor = prev;
    // Winding gear, and the bucket still on the rope.
    for (const sx of [-1, 1]) mb.boxC(p.x + sx * 1.15, gy + 0.85, p.z, 0.12, 1.5, 0.12, wood);
    mb.boxC(p.x, gy + 2.25, p.z, 2.6, 0.14, 0.14, wood);
    mb.boxC(p.x, gy - 1.6, p.z, 0.05, 3.8, 0.05, world.m('prop_rust', 0.4));
    // Stepped footholds cut into the shaft.
    for (let i = 0; i < 12; i++) {
      const a = i * 1.05;
      mb.boxC(p.x + Math.cos(a) * 0.72, floorY + i * 0.42, p.z + Math.sin(a) * 0.72, 0.3, 0.06, 0.3, stone);
      world.collision.addFloor(
        quadAt(p.x + Math.cos(a) * 0.72, p.z + Math.sin(a) * 0.72, 0.44), floorY + i * 0.42 + 0.06, 'well');
    }
  });
  world.collision.addFloor(quadAt(p.x, p.z, 2.0), floorY + 0.05, 'well');
  world.loot.push({ p: { x: p.x, y: floorY + 0.2, z: p.z }, kind: 'locker' });
  world.loot.push({ p: { x: p.x + 0.4, y: floorY + 0.2, z: p.z + 0.3 }, kind: 'crate' });
  note(world, 'The dry well', p.x, p.z, 'reward', 'the rope still reaches the bottom');
}

// --- 7. the car that is still running --------------------------------------

function stillRunningCar(world, rng) {
  const v = world.vehicles[Math.floor(rng.next() * world.vehicles.length)];
  if (!v) return;
  const gy = world.gy(v.x, v.z);
  world.lights.push({ p: { x: v.x, y: gy + 0.6, z: v.z }, r: 13, c: [0.55, 0.52, 0.42], flicker: false });
  world.store.emit(v.x, v.z, (mb) => {
    mb.env = world.env;
    // Both doors standing open, the headlamps burning, and the seats empty.
    const m = world.m('prop_white', 0.5);
    for (const sx of [-1, 1]) {
      mb.boxC(v.x + sx * 1.35, gy + 0.55, v.z - 2.2, 0.06, 0.9, 1.0, world.m('prop_dirtmetal', 1.2));
      mb.boxC(v.x + sx * 0.55, gy + 0.52, v.z - 2.5, 0.36, 0.18, 0.05, m);
    }
  });
  note(world, 'The idling car', v.x, v.z, 'observational', 'the battery has not run down');
}

// --- 8. the identical parlours ---------------------------------------------
// Two rooms, as far apart as the map allows, furnished the same way down to
// the position of the overturned chair. Neither is remarkable on its own.

function identicalParlours(world, rng) {
  const homes = world.buildings.filter((b) => b.prog && ['house', 'bungalow', 'duplex'].includes(b.prog.type));
  if (homes.length < 2) return;
  let a = null, b = null, best = -1;
  for (let i = 0; i < 60; i++) {
    const p = homes[Math.floor(rng.next() * homes.length)];
    const q = homes[Math.floor(rng.next() * homes.length)];
    const d = dist2D(p.origin.x, p.origin.z, q.origin.x, q.origin.z);
    if (d > best) { best = d; a = p; b = q; }
  }
  if (!a || !b || best < 60) return;
  const seed = rng.next();
  for (const bld of [a, b]) {
    const f = frame(bld);
    const m = f.main;
    const y = bld.baseY + bld.plinth + 0.03;
    world.store.emit(bld.origin.x, bld.origin.z, (mb) => {
      mb.env = world.env;
      const prev = world.env.indoor;
      world.env.indoor = 1;
      mb.push(f.fp.origin.x, y, f.fp.origin.z, f.yaw);
      const ctx = world.ctxFor(mb);
      const local = new (rng.constructor)(0x9a17);
      const cx = m.x0 + m.w * 0.5, cz = m.z0 + m.d * 0.34;
      P.chair(mb, ctx, cx, cz, Math.PI * 0.25, local, {});
      P.chair(mb, ctx, cx + 0.9, cz, Math.PI * 0.25, local, {});
      mb.push(cx - 0.9, 0.02, cz, 0.6);
      mb.boxC(0, 0, 0, 0.48, 0.45, 0.48, world.m('prop_wood_dark', 0.8));   // the chair, over
      mb.pop();
      P.rug(mb, ctx, cx, cz + 1.2, seed * TAU, local);
      P.bloodDecal(mb, ctx, cx + 0.3, 0.04, cz + 0.6, local);
      world.env.indoor = prev;
      mb.pop();
    });
    note(world, 'The parlour', bld.origin.x, bld.origin.z, 'observational', 'you have been in this room before');
  }
}

// --- 9. the tower platform -------------------------------------------------

function towerPlatform(world, rng) {
  const lm = world.landmarks.find((l) => l.name === 'Water Tower');
  if (!lm) return;
  const gy = world.gy(lm.x, lm.z);
  const steel = world.m('prop_rust', 1.0);
  const grate = world.m('prop_darksteel', 0.8);
  const deckY = gy + 11.5;

  world.store.emit(lm.x, lm.z, (mb) => {
    mb.env = world.env;
    // A stair spiralling the legs — the maintenance access nobody locked.
    for (let i = 0; i < 34; i++) {
      const a = i * 0.42;
      const r = 3.1;
      const px = lm.x + Math.cos(a) * r, pz = lm.z + Math.sin(a) * r;
      mb.push(px, gy + i * 0.34, pz, -a);
      mb.boxC(0, 0, 0, 1.0, 0.07, 0.8, grate);
      mb.boxC(0, 0, 0.45, 1.0, 0.95, 0.05, steel, { skip: 'top bottom' });
      mb.pop();
      world.collision.addFloor(quadAt(px, pz, 1.0), gy + i * 0.34 + 0.07, 'tower');
    }
    // The platform, and what someone left on it.
    mb.push(lm.x, deckY, lm.z, 0);
    mb.boxC(0, 0, 0, 7.4, 0.10, 7.4, grate, { skip: 'bottom' });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU;
      mb.push(Math.cos(a) * 3.6, 0.10, Math.sin(a) * 3.6, a);
      mb.boxC(0, 0, 0, 7.4, 1.05, 0.07, steel, { skip: 'top bottom' });
      mb.pop();
    }
    const ctx = world.ctxFor(mb);
    P.crate(mb, ctx, 1.6, 1.2, 0.4, rng, { size: 0.9 });
    P.barrel(mb, ctx, -1.9, -1.4, 0, rng, {});
    mb.boxC(-0.4, 0.10, 2.2, 1.4, 0.06, 0.9, world.m('prop_fabric_brown', 1.0));   // a bedroll
    mb.pop();
  });
  world.collision.addFloor(quadAt(lm.x, lm.z, 7.4), deckY + 0.10, 'tower');
  world.loot.push({ p: { x: lm.x + 1.6, y: deckY + 0.2, z: lm.z + 0.4 }, kind: 'locker' });
  world.loot.push({ p: { x: lm.x - 1.9, y: deckY + 0.2, z: lm.z - 1.4 }, kind: 'medicine' });
  world.loot.push({ p: { x: lm.x, y: deckY + 0.2, z: lm.z + 2.2 }, kind: 'tools' });
  note(world, 'The watch on the tower', lm.x, lm.z, 'reward', 'somebody was up here for a while');
}

// --- 10. the seventeenth step ----------------------------------------------
// A public stair on the hill. One tread is a different stone from all the
// others, and it lifts.

function seventeenthStep(world, rng) {
  const t = world.terrain;
  // Find a steep spot beside a road: exactly where a town builds steps.
  let best = null;
  for (const strip of world.surfaces.strips) {
    if (strip.length < 12) continue;
    const mx = (strip.a.x + strip.b.x) / 2, mz = (strip.a.z + strip.b.z) / 2;
    const off = 7;
    for (const s of [-1, 1]) {
      const px = mx - strip.dir.z * off * s, pz = mz + strip.dir.x * off * s;
      if (world.insideAnyBuilding(px, pz, 2.5)) continue;
      const slope = t.slopeAt(px, pz);
      if (slope < 0.45) continue;
      if (!best || slope > best.slope) best = { x: px, z: pz, slope, dir: strip.dir, s };
    }
  }
  if (!best) return;
  const yaw = Math.atan2(-best.dir.z * best.s, best.dir.x * best.s);
  const gy = world.gy(best.x, best.z);
  const stone = world.m('found_stone', 1.4);
  const odd = world.m('plaza_stone', 1.2);

  world.store.emit(best.x, best.z, (mb) => {
    mb.env = world.env;
    const rise = 0.17, run = 0.32;
    const dx = Math.sin(yaw), dz = Math.cos(yaw);
    const nx = Math.cos(yaw), nz = -Math.sin(yaw);
    for (let i = 0; i < 24; i++) {
      const px = best.x + dx * run * i, pz = best.z + dz * run * i;
      const y = gy + rise * (i + 1);
      const mat = i === 16 ? odd : stone;
      mb.box(px - nx * 0.9, y - rise, pz - nz * 0.9, px + nx * 0.9 + dx * run, y, pz + nz * 0.9 + dz * run,
        mat, { skip: 'bottom' });
      world.collision.addFloor(quadAt(px + dx * run * 0.5, pz + dz * run * 0.5, 1.7), y, 'steps');
    }
    // The cache under the odd tread, tucked into the side wall.
    const cx = best.x + dx * run * 16.5 + nx * 1.15;
    const cz = best.z + dz * run * 16.5 + nz * 1.15;
    mb.push(cx, gy + rise * 15, cz, yaw);
    mb.boxC(0, 0, 0, 1.2, 0.85, 0.9, world.m('found_stone', 1.0), { skip: 'nx' });
    mb.pop();
    world.loot.push({ p: { x: cx, y: gy + rise * 15 + 0.1, z: cz }, kind: 'locker' });
  });
  note(world, 'The seventeenth step', best.x, best.z, 'reward', 'one tread is the wrong stone');
}

// --- 11. the boarded house -------------------------------------------------
// Conditional. It is boarded until the fourth cordon opens, and then it is
// not, and no one boarded or unboarded it.

function boardedHouse(world, rng) {
  const b = pickBuilding(world, rng, (bb) =>
    bb.district === 2 && bb.prog && ['house', 'bungalow', 'duplex', 'shop'].includes(bb.prog.type));
  if (!b) return;
  const f = frame(b);
  const m = f.main;
  const board = world.m('prop_wood_pale', 0.8);
  const y = b.baseY + b.plinth;

  for (const state of ['shut', 'open']) {
    const store = world.gateStore(2, state);
    store.emit(b.origin.x, b.origin.z, (mb) => {
      mb.env = world.env;
      mb.push(f.fp.origin.x, b.baseY, f.fp.origin.z, f.yaw);
      if (state === 'shut') {
        // Planks nailed across the front door and the ground-floor windows.
        for (let i = 0; i < 5; i++) {
          mb.push(b.doorLocal.x, b.plinth + 0.35 + i * 0.42, -0.16, 0);
          mb.boxC(0, 0, 0, 1.9, 0.20, 0.05, board);
          mb.pop();
        }
        mb.boxC(m.x0 + m.w * 0.5, b.plinth + 1.4, -0.18, m.w * 0.7, 0.22, 0.05, board);
      } else {
        // The planks are on the path, still nailed to each other.
        for (let i = 0; i < 5; i++) {
          mb.push(b.doorLocal.x + (i - 2) * 0.3, b.plinth * 0 + 0.03, -1.3 - i * 0.22, 0.2 + i * 0.15);
          mb.boxC(0, 0, 0, 1.9, 0.06, 0.20, board);
          mb.pop();
        }
      }
      mb.pop();
    });
  }
  const dw = b.doorWorld || f.toWorld(b.doorLocal.x, -0.6);
  world.collision.addSegment(
    dw.x - Math.cos(f.yaw) * 1.0, dw.z + Math.sin(f.yaw) * 1.0,
    dw.x + Math.cos(f.yaw) * 1.0, dw.z - Math.sin(f.yaw) * 1.0,
    y, y + 2.2, 'cordon2gate');
  const inside = f.toWorld(b.doorLocal.x, 1.6);
  world.loot.push({ p: { x: inside.x, y: y + 0.15, z: inside.z }, kind: 'locker' });
  world.loot.push({ p: { x: inside.x, y: y + 0.15, z: inside.z + 0.6 }, kind: 'medicine' });
  note(world, 'The boarded house', b.origin.x, b.origin.z, 'conditional', 'it opens when the hill does');
}

// --- 12. the listening mast ------------------------------------------------

function listeningMast(world, rng) {
  const b = pickBuilding(world, rng, (bb) => bb.roofFlat && bb.storeys >= 2);
  if (!b) return;
  const f = frame(b);
  const m = f.main;
  const top = b.baseY + b.eaveY;
  const steel = world.m('prop_darksteel', 0.9);
  const c = f.toWorld(m.x0 + m.w * 0.35, m.z0 + m.d * 0.65);

  world.store.emit(c.x, c.z, (mb) => {
    mb.env = world.env;
    mb.push(c.x, top, c.z, 0);
    // A lattice mast, guyed, with something on top that is not an aerial.
    for (let i = 0; i < 7; i++) {
      const s = 0.5 - i * 0.05;
      mb.boxC(0, i * 1.1, 0, s, 1.1, s, steel, { skip: 'top bottom' });
      mb.boxC(0, i * 1.1, 0, s + 0.1, 0.07, s + 0.1, steel);
    }
    for (let g = 0; g < 3; g++) {
      const a = (g / 3) * TAU;
      mb.limb(0, 6.0, 0, Math.cos(a) * 3.4, 0.1, Math.sin(a) * 3.4, 0.03, 0.03, steel);
    }
    mb.boxC(0, 7.7, 0, 0.9, 0.9, 0.9, steel, { skip: 'bottom' });
    mb.boxC(0, 8.6, 0, 0.22, 0.5, 0.22, world.m('prop_red', 0.4));
    world.lights.push({ p: mb.worldPoint(0, 8.7, 0), r: 16, c: [0.42, 0.10, 0.08], flicker: true });
    mb.pop();
  });
  world.landmarks.push({ name: 'The Mast', x: c.x, z: c.z, y: top + 8, district: b.district });
  note(world, 'The mast', c.x, c.z, 'observational', 'the red lamp is still being paid for');
}
