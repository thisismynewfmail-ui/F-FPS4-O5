// ---------------------------------------------------------------------------
// cordon.js — the quarantine rings, their gates, and the bridges over the Ash.
//
// This is the progression system made physical. Five rings were thrown up
// around the town as it went, each in whatever was to hand that week:
//
//   ring 0  cars, nose to tail, welded together on the first night
//   ring 1  proper police barricades, and the first notices
//   ring 2  contractors' hoarding, because it was going to be a long job
//   ring 3  precast concrete, because the hoarding did not hold
//   ring 4  an earth berm, because by then they had stopped building walls
//
// The rings never come down. What opens is the GATES: one per through-road,
// with a shut state and an open state built as separate meshes so an unlock is
// two flag flips and one collision sweep rather than a rebuild. The player is
// never told a sector has opened. A shutter is up that was down.
//
// Where the cordon is already a building, no cordon is built — they used what
// was there, and so do we, which saves several thousand triangles a ring and
// looks more like something people did than something a generator did.
// ---------------------------------------------------------------------------

import {
  TAU, clamp, clamp01, lerp, dist2D, distPointSeg, smoothstep,
} from '../core/math.js';
import { classWidth, nearestRoad } from './roads.js';
import { DISTRICTS, CORDON_STYLE } from './districts.js';
import * as P from './props.js';

const RING_STEP = 2.0;
const GATE_ROADS = ['arterial', 'main', 'street'];

export function buildCordon(world) {
  buildRiverCrossings(world);
  for (let i = 0; i < DISTRICTS.length - 1; i++) buildRing(world, i);
}

// ---------------------------------------------------------------------------
// One ring
// ---------------------------------------------------------------------------

function buildRing(world, index) {
  const { rng, districts, graph } = world;
  const style = CORDON_STYLE[DISTRICTS[index].cordon];
  if (!style) return;

  const pts = districts.ringPoints(index, RING_STEP);

  // Classify every sample: buried in a building, on a road, or open ground.
  const kinds = pts.map((p) => {
    if (world.insideAnyBuilding(p.x, p.z, 0.6)) return { k: 'building' };
    const road = nearestRoad(graph, p.x, p.z, 30);
    if (road && road.dist < classWidth(road.cls) / 2 + 1.4) return { k: 'road', cls: road.cls };
    if (world.terrain.heightAt(p.x, p.z) < world.cfg.waterY + 0.6) return { k: 'water' };
    return { k: 'open' };
  });

  // Group the road samples into crossings.
  const crossings = [];
  let run = null;
  for (let i = 0; i <= pts.length; i++) {
    const k = kinds[i % pts.length];
    const isRoad = i < pts.length && k.k === 'road';
    if (isRoad) {
      if (!run) run = { from: i, to: i, cls: k.cls };
      else { run.to = i; if (rank(k.cls) > rank(run.cls)) run.cls = k.cls; }
    } else if (run) {
      crossings.push(run);
      run = null;
    }
  }
  if (run) crossings.push(run);

  // A ring is a circle and streets are not radial, so wherever the cordon runs
  // ALONGSIDE a street rather than across it, every sample for tens of metres
  // reads as "road". Left alone that becomes one enormous gate and the cordon
  // stops being a cordon. A crossing is only as wide as the carriageway plus a
  // footway either side; anything longer gets gated in the middle and walled
  // for the rest of its length.
  for (const cr of crossings) {
    const wide = classWidth(cr.cls) + 6;
    const arc = dist2D(pts[cr.from % pts.length].x, pts[cr.from % pts.length].z,
      pts[cr.to % pts.length].x, pts[cr.to % pts.length].z);
    if (arc <= wide) continue;
    const keep = Math.max(2, Math.round(wide / RING_STEP));
    const mid = Math.round((cr.from + cr.to) / 2);
    cr.from = mid - Math.floor(keep / 2);
    cr.to = cr.from + keep;
  }

  // Every through-road gets a gate; back lanes and alleys are simply sealed,
  // which is what concentrates traffic — yours and theirs — onto the streets
  // the town was laid out around. If that would leave fewer than two ways in,
  // the widest sealed crossings are promoted until there are.
  const gated = crossings.filter((c) => GATE_ROADS.includes(c.cls));
  if (gated.length < 2) {
    const rest = crossings.filter((c) => !gated.includes(c))
      .sort((a, b) => (b.to - b.from) - (a.to - a.from));
    while (gated.length < 2 && rest.length) gated.push(rest.shift());
  }
  const gateSet = new Set(gated);

  const inGate = new Uint8Array(pts.length);
  const wrap = (i) => ((i % pts.length) + pts.length) % pts.length;
  for (const c of gated) {
    for (let i = c.from; i <= c.to; i++) inGate[wrap(i)] = 1;
  }

  // --- the wall itself ----------------------------------------------------
  //
  // The collision is added for EVERY sample that is not a gate, including the
  // ones that fall inside a building. A cordon that stops at a wall is not a
  // cordon: the building has doors, and the horde and the player will both
  // walk straight through it and out the far side. Where it runs through an
  // interior it becomes a blocked-up corridor instead of a fence.
  for (let i = 0; i < pts.length; i++) {
    if (inGate[i]) continue;
    const k = kinds[i];
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    const yaw = alongYaw(a, b);
    // Panels are cut to the ACTUAL sample spacing, not to the nominal step:
    // the ring radius wobbles, so a fixed length leaves gaps you can walk
    // through on the stretches where the ring bulges outward.
    const len = Math.max(RING_STEP * 0.6, dist2D(a.x, a.z, b.x, b.z)) * 1.14;
    const sealed = k.k === 'road';   // a lane, bricked up for good
    emitPanel(world, index, style, mid, yaw, len, sealed, rng, k.k);
  }

  // --- the gates ----------------------------------------------------------
  for (const c of gated) {
    const a = pts[wrap(c.from)];
    const b = pts[wrap(c.to)];
    const cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
    const span = Math.max(4, dist2D(a.x, a.z, b.x, b.z) + RING_STEP);
    const yaw = alongYaw(a, b);
    const overWater = world.terrain.heightAt(cx, cz) < world.cfg.waterY + 1.5;
    const gate = {
      district: index, x: cx, z: cz, yaw, span,
      kind: overWater ? 'bascule' : style.gateKind,
      name: `${DISTRICTS[index].name} GATE`,
      cls: c.cls,
    };
    world.gates.push(gate);
    buildGate(world, gate, style, rng);
  }

  // A landmark so the compass can point at the way out of the sector you are
  // standing in — navigation by landmark, as the rest of the town works.
  if (gated.length) {
    const g = world.gates[world.gates.length - 1];
    world.landmarks.push({
      name: gateLabel(index), x: g.x, z: g.z,
      y: world.gy(g.x, g.z) + 5, district: index, gate: index,
    });
  }
}

/**
 * The yaw that puts the mesh builder's LOCAL +X along a->b.
 *
 * Every cordon panel and every gate leaf is authored as a box running along
 * local x, and the transform stack maps local +x to world (cos yaw, -sin yaw)
 * — not to (sin yaw, cos yaw), which is the *forward* convention the rest of
 * the game uses for headings. Using the heading here builds the entire cordon
 * at right angles to itself: a ring of two-metre walls each pointing outward,
 * with two-metre gaps between them, which looks almost right from a distance
 * and does not stop anybody.
 */
function alongYaw(a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  return Math.atan2(-dz / l, dx / l);
}

function rank(cls) {
  return { arterial: 4, main: 3, street: 2, lane: 1, alley: 0, service: 2 }[cls] ?? 0;
}

function gateLabel(index) {
  return ['CROSS GATE', 'MARKET GATE', 'HILL GATE', 'WARREN GATE', 'MILL GATE'][index] || 'GATE';
}

// ---------------------------------------------------------------------------
// Wall panels
// ---------------------------------------------------------------------------

function emitPanel(world, index, style, p, yaw, len, sealed, rng, terrainKind) {
  const tag = `cordon${index}`;
  const gy = world.gy(p.x, p.z);
  const h = style.height;

  // Water needs no geometry — the nav grid already refuses to cross it and a
  // barricade standing in the middle of the Ash looks like a mistake — but it
  // still needs the segment, because the player can wade a shallow bank.
  if (terrainKind !== 'water') {
    world.store.emit(p.x, p.z, (mb) => {
      mb.env = world.env;
      const prev = world.env.indoor;
      if (terrainKind === 'building') world.env.indoor = 1;
      mb.push(p.x, gy, p.z, yaw);
      const ctx = world.ctxFor(mb);
      // Collision for the cordon is the single segment added below; props must
      // not add their own or the ring becomes impossible to reason about.
      ctx.collision = null;
      if (terrainKind === 'building') cordonInfill(mb, ctx, len, rng);
      else {
        switch (style.kind) {
          case 'wrecks': cordonWreck(mb, ctx, len, h, rng, sealed); break;
          case 'barrier': cordonBarricade(mb, ctx, len, h, rng, sealed); break;
          case 'hoarding': cordonHoarding(mb, ctx, len, h, rng, sealed); break;
          case 'concrete': cordonConcrete(mb, ctx, len, h, rng, sealed); break;
          default: cordonBerm(mb, ctx, len, h, rng, sealed); break;
        }
      }
      mb.pop();
      world.env.indoor = prev;
    });
  }

  // Collision is one segment per panel, tagged with the ring so nothing can
  // ever accidentally remove it — only the gates carry the openable tag. It is
  // deliberately tall and deep: on a slope the ring must still seal, and a
  // building it passes through may have three floors.
  const hx = Math.cos(yaw) * len * 0.5, hz = -Math.sin(yaw) * len * 0.5;
  const top = terrainKind === 'building' ? gy + 22 : gy + h;
  world.collision.addSegment(p.x - hx, p.z - hz, p.x + hx, p.z + hz, gy - 3, top, tag);
}

/**
 * Where the ring runs through a building, they filled the room with whatever
 * was in it. This is what the player actually meets: a corridor packed floor
 * to ceiling with furniture, crates and brick.
 */
function cordonInfill(mb, ctx, len, rng) {
  const crate = ctx.lib.m('prop_crate', 0.9);
  const brick = ctx.lib.m('brick_deep#w', 1.4);
  const timber = ctx.lib.m('prop_wood_dark', 1.0);
  const sack = ctx.lib.m('prop_fabric_brown', 0.7);
  mb.boxC(0, 0, 0, len + 0.1, 2.9, 1.0, brick, { skip: 'bottom top' });
  for (let i = 0; i < 7; i++) {
    const s = rng.range(0.45, 0.95);
    mb.push(rng.range(-len / 2, len / 2), rng.range(0, 2.1), rng.range(-0.5, 0.5), rng.range(0, Math.PI));
    mb.boxC(0, 0, 0, s, s * rng.range(0.6, 1.1), s * rng.range(0.7, 1.2),
      rng.chance(0.5) ? crate : (rng.chance(0.5) ? timber : sack));
    mb.pop();
  }
}

/**
 * Ring 0: cars pushed nose to tail and welded, with rubble packed underneath.
 *
 * Built from the same car the traffic uses rather than from an approximation
 * of one, because this is the barricade the player spends the first five
 * hundred kills looking at from three metres away. Two cars per panel with a
 * long overlap, so the line reads as continuous however the ring curves.
 */
function cordonWreck(mb, ctx, len, h, rng, sealed) {
  const rubble = ctx.lib.m('road_concrete', 1.2);
  const plate = ctx.lib.m('prop_rust', 1.3);
  // Cars are authored along their own +Z, so each one is turned side-on to
  // the ring and laid end to end along it.
  const n = Math.max(1, Math.round(len / 2.4));
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : (i / (n - 1) - 0.5);
    P.car(mb, { lib: ctx.lib }, t * len * 0.9, rng.range(-0.35, 0.35),
      Math.PI / 2 + rng.range(-0.09, 0.09), rng,
      { wrecked: true, color: rng.pick(['prop_rust', 'prop_blue', 'prop_red', 'prop_dirtmetal', 'prop_white']) });
  }
  // Steel plate welded across the gaps between them, and rubble underneath so
  // nothing can be crawled beneath.
  mb.boxC(0, 0.55, 0, len + 0.4, 0.65, 0.28, plate, { skip: 'top bottom' });
  for (let i = 0; i < 3; i++) {
    mb.boxC(rng.range(-len * 0.5, len * 0.5), 0, rng.range(-0.9, 0.9),
      rng.range(0.3, 0.8), rng.range(0.12, 0.4), rng.range(0.3, 0.7), rubble);
  }
  if (sealed) {
    // Where it crosses a lane they packed the gap out with everything else.
    for (let i = 0; i < 5; i++) {
      mb.boxC(rng.range(-len / 2, len / 2), rng.range(0.3, 1.5), rng.range(-0.7, 0.7),
        rng.range(0.4, 0.9), rng.range(0.3, 0.7), rng.range(0.4, 0.8), rubble);
    }
  }
}

/** Ring 1: pressed-steel pedestrian barricades, wired together, plus notices. */
function cordonBarricade(mb, ctx, len, h, rng, sealed) {
  const steel = ctx.lib.m('prop_steel', 0.7);
  const rust = ctx.lib.m('prop_rust', 0.7);
  const m = rng.chance(0.5) ? steel : rust;
  const lean = sealed ? 0 : rng.range(-0.05, 0.05);
  mb.push(0, 0, 0, lean);
  for (const sx of [-1, 1]) mb.boxC(sx * (len / 2 - 0.08), 0, 0, 0.07, h, 0.07, m);
  for (const y of [h * 0.30, h * 0.62, h - 0.06]) {
    mb.boxC(0, y, 0, len, 0.06, 0.05, m);
  }
  for (let k = 1; k < 5; k++) {
    mb.boxC(-len / 2 + (len * k) / 5, h * 0.30, 0, 0.04, h * 0.68, 0.04, m);
  }
  if (rng.chance(0.35)) {
    mb.boxC(0, h * 0.34, -0.05, len * 0.55, 0.42, 0.03, ctx.lib.m('sign_cordon'));
  }
  // Sandbags along the foot: the detail that dates the line.
  if (rng.chance(0.5) || sealed) {
    for (let i = 0; i < (sealed ? 6 : 3); i++) {
      mb.boxC(rng.range(-len / 2, len / 2), rng.range(0, 0.5), rng.range(-0.3, 0.3),
        0.5, 0.24, 0.34, ctx.lib.m('prop_fabric_brown', 0.6));
    }
  }
  mb.pop();
}

/** Ring 2: ply hoarding on a stud frame, papered with the same notice. */
function cordonHoarding(mb, ctx, len, h, rng, sealed) {
  const face = ctx.lib.m('hoarding', 2.4);
  const post = ctx.lib.m('prop_wood_dark', 1.0);
  mb.boxC(0, 0, 0, len + 0.02, h, 0.10, face, { skip: 'bottom' });
  for (const sx of [-1, 1]) mb.boxC(sx * (len / 2), 0, 0.10, 0.12, h + 0.06, 0.12, post);
  // A raking brace on the inside, which is how these actually stand up.
  if (rng.chance(0.5)) {
    mb.limb(len * 0.3, h - 0.2, 0.12, len * 0.3, 0.05, 1.3, 0.05, 0.05, post);
  }
  if (rng.chance(0.3)) mb.boxC(rng.range(-len * 0.3, len * 0.3), h * 0.45, -0.07, 0.75, 0.5, 0.03, ctx.lib.m('sign_cordon'));
  if (sealed) mb.boxC(0, 0, 0.4, len, 1.1, 0.7, ctx.lib.m('road_concrete', 1.4));
  // Razor wire along the top, drawn as a thin dark band — legible at 240 lines,
  // which is all it needs to be.
  mb.boxC(0, h + 0.06, 0, len, 0.10, 0.10, ctx.lib.m('chainlink_rust', 0.5));
}

/** Ring 3: precast blocks, double-stacked where the ground allows. */
function cordonConcrete(mb, ctx, len, h, rng, sealed) {
  const block = ctx.lib.m('concrete_precast', 2.4);
  const worn = ctx.lib.m('concrete_brutal', 2.4);
  const m = rng.chance(0.6) ? block : worn;
  const lower = Math.min(h * 0.62, 2.1);
  mb.boxC(0, 0, 0, len + 0.04, lower, 0.62, m, { skip: 'bottom' });
  if (!sealed && rng.chance(0.75)) {
    mb.boxC(rng.range(-0.25, 0.25), lower, 0, len + 0.04, h - lower, 0.58, m, { skip: 'bottom' });
  } else {
    mb.boxC(0, lower, 0, len + 0.04, h - lower, 0.58, m, { skip: 'bottom' });
  }
  if (rng.chance(0.22)) mb.boxC(0, h * 0.4, -0.32, len * 0.6, 0.45, 0.03, ctx.lib.m('sign_cordon'));
  if (rng.chance(0.3)) mb.boxC(rng.range(-len / 2, len / 2), 0, -0.7, 0.7, 0.9, 0.6, ctx.lib.m('prop_rust', 1.0));
}

/** Ring 4: they stopped building walls and started moving earth. */
function cordonBerm(mb, ctx, len, h, rng, sealed) {
  const soil = ctx.lib.m('dirt', 3.5);
  const rock = ctx.lib.m('rock_dark', 3.0);
  const half = len / 2 + 0.05;
  const base = 4.2, crest = 1.1;
  // Trapezoid section, emitted as two rakes and a crest.
  mb.slope([-half, 0, -base / 2], [half, 0, -base / 2], [half, h, -crest / 2], [-half, h, -crest / 2], soil);
  mb.slope([half, 0, base / 2], [-half, 0, base / 2], [-half, h, crest / 2], [half, h, crest / 2], soil);
  mb.quadMat([-half, h, crest / 2], [half, h, crest / 2], [half, h, -crest / 2], [-half, h, -crest / 2],
    soil, [0, 1, 0], { spanU: len, spanV: crest });
  if (rng.chance(0.4)) {
    mb.boxC(rng.range(-half, half), h * 0.25, rng.range(-1.4, 1.4), rng.range(0.5, 1.2),
      rng.range(0.3, 0.7), rng.range(0.5, 1.0), rock);
  }
  // Wire pickets along the crest.
  for (let k = 0; k < 2; k++) {
    const x = -half + (len * (k + 0.5)) / 2;
    mb.boxC(x, h, 0, 0.07, 0.85, 0.07, ctx.lib.m('prop_rust', 0.6));
  }
  mb.boxC(0, h + 0.75, 0, len, 0.09, 0.09, ctx.lib.m('chainlink_rust', 0.5));
  if (sealed) mb.boxC(0, 0, 0, len, h * 0.7, base * 0.5, soil, { skip: 'bottom' });
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/**
 * A gate is built twice — shut and open — into two separate chunk stores. The
 * renderer draws one of them. Only the shut state registers collision, under
 * the tag `cordonNgate`, and opening the sector retires exactly that tag.
 */
function buildGate(world, gate, style, rng) {
  const { x, z, yaw, span, district } = gate;
  const gy = world.gy(x, z);
  const tag = `cordon${district}gate`;
  const w = Math.min(Math.max(span, 6), 16);

  for (const state of ['shut', 'open']) {
    const store = world.gateStore(district, state);
    store.emit(x, z, (mb) => {
      mb.env = world.env;
      mb.push(x, gy, z, yaw);
      const ctx = world.ctxFor(mb);
      // Nothing inside a gate mesh may register collision through props — the
      // open mesh would add solids that can never be removed. Collision for
      // the shut state is added explicitly below.
      ctx.collision = null;
      ctx.spawns = null;
      const shut = state === 'shut';
      switch (gate.kind) {
        case 'coach': gateCoach(mb, ctx, w, shut, rng, world); break;
        case 'shutter': gateShutter(mb, ctx, w, shut, rng, world); break;
        case 'chain': gateChain(mb, ctx, w, shut, rng, world); break;
        case 'liftgate': gateLift(mb, ctx, w, shut, rng, world); break;
        case 'bascule': gateBascule(mb, ctx, w, shut, rng, world); break;
        default: gateCrossing(mb, ctx, w, shut, rng, world); break;
      }
      mb.pop();
    });
  }

  // The barrier across the road. It spans the FULL crossing, not the clamped
  // width the geometry was drawn at — a gate narrower than the gap it stands
  // in is a gate you can walk around, which is the same as no gate at all —
  // and it is built in short pieces, each referenced to the ground under IT.
  // One long segment on a cambered road has its top below the verge at either
  // end, and the navigation grid, which quite correctly asks whether a wall is
  // tall enough to matter *here*, walks straight round it.
  const full = span + RING_STEP * 1.6;
  const h = gate.kind === 'bascule' ? 3.4 : style.height + 0.6;
  const pieces = Math.max(2, Math.ceil(full / 2));
  for (let i = 0; i < pieces; i++) {
    const t0 = (i / pieces - 0.5) * full, t1 = ((i + 1) / pieces - 0.5) * full;
    const ax = x + Math.cos(yaw) * t0, az = z - Math.sin(yaw) * t0;
    const bx = x + Math.cos(yaw) * t1, bz = z - Math.sin(yaw) * t1;
    const base = Math.min(world.gy(ax, az), world.gy(bx, bz));
    world.collision.addSegment(ax, az, bx, bz, base - 3, base + h, tag);
  }

  // A bascule gate is a hole in the ground when shut, so it needs a deck to
  // walk on when it is open. Floors cannot be retired, so the deck is only
  // ever added for the crossing itself, which is impassable while the leaf is
  // up because the leaf is what the collision segment above represents.
  if (gate.kind === 'bascule') {
    const nx = -Math.sin(yaw), nz = -Math.cos(yaw);
    const d = 9;
    world.collision.addFloor([
      { x: x - hx - nx * d, z: z - hz - nz * d }, { x: x + hx - nx * d, z: z + hz - nz * d },
      { x: x + hx + nx * d, z: z + hz + nz * d }, { x: x - hx + nx * d, z: z - hz + nz * d },
    ], gy, 'bascule');
  }
}

/** Ring 0: a coach, welded across the street. Open: shunted onto the pavement. */
function gateCoach(mb, ctx, w, shut, rng, world) {
  const body = ctx.lib.m('prop_white', 1.8);
  const dark = ctx.lib.m('prop_darksteel', 0.9);
  const glass = ctx.lib.m('glass_broken', 1.2);
  const rubble = ctx.lib.m('road_concrete', 1.2);
  const L = Math.min(w + 1.5, 11.5);
  // Shut: across the road on its axle stops. Open: dragged a quarter turn out
  // of the way, nose into the kerb, with the drag scars still on the tarmac.
  mb.push(shut ? 0 : w * 0.42, 0, shut ? 0 : 2.6, shut ? 0 : 1.15);
  mb.boxC(0, 0.62, 0, L, 2.05, 2.45, body, { skip: 'bottom' });
  mb.boxC(0, 0.42, 0, L - 0.4, 0.24, 2.55, dark);
  for (let k = -3; k <= 3; k++) {
    mb.boxC(k * (L / 8), 1.35, -1.24, L / 10, 0.85, 0.04, glass);
    mb.boxC(k * (L / 8), 1.35, 1.24, L / 10, 0.85, 0.04, glass);
  }
  mb.boxC(0, 2.67, 0, L - 0.5, 0.10, 2.3, dark, { skip: 'bottom' });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      mb.cylinder(sx * L * 0.34, 0, sz * 1.05, 0.45, 0.3, 8, ctx.lib.m('prop_black', 0.5));
    }
  }
  mb.pop();
  if (shut) {
    for (let i = 0; i < 6; i++) {
      mb.boxC(rng.range(-w / 2, w / 2), 0, rng.range(-2.4, 2.4) + (rng.chance(0.5) ? 3 : -3),
        rng.range(0.4, 1.0), rng.range(0.2, 0.6), rng.range(0.4, 0.9), rubble);
    }
  } else {
    // Scrape marks and the bar they levered it with.
    mb.boxC(-1.2, 0.02, 0, 0.2, 0.04, 5.5, ctx.lib.m('prop_rust', 1.2));
    mb.boxC(1.6, 0.02, -0.5, 0.14, 0.05, 2.2, ctx.lib.m('prop_darksteel', 0.8));
  }
}

/** Ring 1: a roller shutter on a scaffold gantry. Open: wound into its drum. */
function gateShutter(mb, ctx, w, shut, rng, world) {
  const steel = ctx.lib.m('prop_darksteel', 1.0);
  const shutter = ctx.lib.m('metal_ribbed', 1.4);
  const H = 3.3;
  for (const sx of [-1, 1]) {
    mb.boxC(sx * (w / 2), 0, 0, 0.30, H + 0.5, 0.30, steel);
    mb.boxC(sx * (w / 2), 0, 0, 0.9, 0.25, 0.9, ctx.lib.m('concrete_precast', 1.6));
  }
  mb.boxC(0, H, 0, w + 0.6, 0.32, 0.5, steel, { skip: 'bottom' });
  // The drum the shutter rolls onto.
  mb.push(0, H - 0.18, 0.36, Math.PI / 2);
  mb.cylinder(0, -w / 2, 0, shut ? 0.20 : 0.46, w, 8, steel);
  mb.pop();
  if (shut) {
    mb.boxC(0, 0.02, 0, w - 0.1, H - 0.34, 0.09, shutter, { skip: 'bottom top' });
    mb.boxC(0, 0.0, 0, w - 0.1, 0.14, 0.14, steel);
    mb.boxC(0, 1.6, -0.08, 1.1, 0.7, 0.03, ctx.lib.m('sign_cordon'));
  } else {
    // A metre of shutter still hanging, and the notice on the deck below it.
    mb.boxC(0, H - 0.9, 0, w - 0.1, 0.55, 0.08, shutter, { skip: 'bottom top' });
    mb.boxC(rng.range(-1.5, 1.5), 0.02, rng.range(-1, 1), 1.0, 0.05, 0.7, ctx.lib.m('sign_cordon'));
  }
}

/** Ring 2: a chain-link vehicle gate. Open: both leaves swung back and hooked. */
function gateChain(mb, ctx, w, shut, rng, world) {
  const post = ctx.lib.m('prop_rust', 0.9);
  const mesh = ctx.lib.m('chainlink_rust', 2.0);
  const H = 2.9;
  for (const sx of [-1, 1]) mb.boxC(sx * (w / 2), 0, 0, 0.20, H + 0.35, 0.20, post);
  const leafW = w / 2 - 0.15;
  for (const sx of [-1, 1]) {
    // Shut: the leaf lies in the plane of the fence. Open: swung 100 degrees.
    const swing = shut ? 0 : sx * 1.75;
    mb.push(sx * (w / 2), 0, 0, swing);
    mb.boxC(-sx * leafW / 2, 0.12, 0, leafW, H - 0.2, 0.05, mesh, { skip: 'bottom top' });
    mb.boxC(-sx * leafW / 2, 0.12, 0, leafW, 0.08, 0.09, post);
    mb.boxC(-sx * leafW / 2, H - 0.16, 0, leafW, 0.08, 0.09, post);
    mb.boxC(-sx * leafW, 0.12, 0, 0.09, H - 0.1, 0.09, post);
    mb.pop();
  }
  if (shut) {
    mb.boxC(0, 1.25, -0.10, 0.34, 0.30, 0.10, ctx.lib.m('prop_steel', 0.4));   // the chain and lock
    mb.boxC(0, 1.7, -0.10, 1.2, 0.6, 0.03, ctx.lib.m('sign_cordon'));
  } else {
    mb.boxC(0, 0.02, 0.9, 0.4, 0.06, 0.3, ctx.lib.m('prop_steel', 0.4));       // the lock, cut, on the ground
  }
}

/** Ring 3: a counterweighted boom between block piers. Open: boom vertical. */
function gateLift(mb, ctx, w, shut, rng, world) {
  const block = ctx.lib.m('concrete_precast', 2.2);
  const boom = ctx.lib.m('prop_orange', 0.8);
  const steel = ctx.lib.m('prop_darksteel', 0.9);
  for (const sx of [-1, 1]) {
    mb.boxC(sx * (w / 2 + 0.6), 0, 0, 1.5, 2.4, 1.0, block, { skip: 'bottom' });
  }
  mb.boxC(-w / 2 + 0.2, 0, 0, 0.5, 1.5, 0.5, steel);
  // The boom pivots at the left pier; shut it lies across the road, open it
  // stands up against the pier.
  mb.push(-w / 2 + 0.2, 1.25, 0, 0);
  if (shut) {
    mb.boxC(w / 2, 0, 0, w - 0.5, 0.16, 0.16, boom);
    mb.boxC(-0.55, 0, 0, 0.9, 0.35, 0.35, steel);       // counterweight
  } else {
    mb.boxC(0, 0, 0, 0.18, w - 0.5, 0.18, boom);
    mb.boxC(0, -0.45, 0.55, 0.35, 0.35, 0.9, steel);
  }
  mb.pop();
  // The blocks that were dragged out of the roadway are still beside it.
  for (let i = 0; i < 3; i++) {
    const px = shut ? rng.range(-w / 2 + 1, w / 2 - 1) : rng.range(-w / 2 - 2, -w / 2 - 0.5);
    mb.boxC(px, 0, shut ? rng.range(-0.5, 0.5) : rng.range(1.5, 3.5),
      1.6, 1.05, 0.7, block, { skip: 'bottom' });
  }
  if (shut) mb.boxC(0, 1.55, -0.2, 1.3, 0.6, 0.03, ctx.lib.m('sign_cordon'));
}

/** Ring 4: a level-crossing barrier and a spill of berm across the road. */
function gateCrossing(mb, ctx, w, shut, rng, world) {
  const soil = ctx.lib.m('dirt', 3.0);
  const post = ctx.lib.m('prop_rust', 0.8);
  const boom = ctx.lib.m('prop_white', 0.7);
  for (const sx of [-1, 1]) mb.boxC(sx * (w / 2 + 0.3), 0, 0, 0.26, 3.0, 0.26, post);
  mb.push(-w / 2 - 0.3, 1.5, 0, 0);
  if (shut) mb.boxC(w / 2 + 0.3, 0, 0, w, 0.15, 0.15, boom);
  else mb.boxC(0, 0, 0, 0.16, w * 0.9, 0.16, boom);
  mb.pop();
  if (shut) {
    // The berm carried straight across, bulldozed into the carriageway.
    mb.slope([-w / 2, 0, -2.1], [w / 2, 0, -2.1], [w / 2, 3.2, -0.55], [-w / 2, 3.2, -0.55], soil);
    mb.slope([w / 2, 0, 2.1], [-w / 2, 0, 2.1], [-w / 2, 3.2, 0.55], [w / 2, 3.2, 0.55], soil);
    mb.quadMat([-w / 2, 3.2, 0.55], [w / 2, 3.2, 0.55], [w / 2, 3.2, -0.55], [-w / 2, 3.2, -0.55],
      soil, [0, 1, 0], { spanU: w, spanV: 1.1 });
    mb.boxC(0, 1.8, -0.6, 1.4, 0.65, 0.04, ctx.lib.m('sign_cordon'));
  } else {
    // A cut through it, with the spoil heaped either side.
    for (const sx of [-1, 1]) {
      mb.slope([sx * w / 2, 0, -2.1], [sx * 2.2, 0, -2.1], [sx * 2.2, 3.0, -0.6], [sx * w / 2, 3.0, -0.6], soil);
      mb.slope([sx * 2.2, 0, 2.1], [sx * w / 2, 0, 2.1], [sx * w / 2, 3.0, 0.6], [sx * 2.2, 3.0, 0.6], soil);
      mb.quadMat([sx * w / 2, 3.0, 0.6], [sx * 2.2, 3.0, 0.6], [sx * 2.2, 3.0, -0.6], [sx * w / 2, 3.0, -0.6],
        soil, [0, 1, 0], { spanU: Math.abs(w / 2 - 2.2), spanV: 1.2 });
      mb.slope([sx * 2.2, 0, -2.1], [sx * 2.2, 0, 2.1], [sx * 2.2, 3.0, 0.6], [sx * 2.2, 3.0, -0.6],
        soil, { flip: sx < 0 });
    }
    // Track marks where whatever cut it drove out again.
    mb.boxC(0, 0.02, 0, 2.6, 0.04, 6.0, ctx.lib.m('mud', 2.4));
  }
}

/** A bascule bridge over the Ash. Shut: the leaf stands vertical. */
function gateBascule(mb, ctx, w, shut, rng, world) {
  const deck = ctx.lib.m('road_concrete', 3.0);
  const steel = ctx.lib.m('prop_rust', 1.2);
  const dark = ctx.lib.m('prop_darksteel', 1.0);
  const leaf = 9.0;
  // Towers on both banks.
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) {
      mb.boxC(sx * (w / 2 + 0.6), 0, sz * leaf * 0.52, 1.0, 7.5, 1.0, steel, { skip: 'bottom' });
    }
    mb.boxC(0, 7.5, sz * leaf * 0.52, w + 2.6, 0.5, 1.0, dark, { skip: 'bottom' });
  }
  // Fixed approach spans.
  for (const sz of [-1, 1]) {
    mb.boxC(0, -0.35, sz * (leaf * 0.52 + 4.5), w + 1.0, 0.35, 9.0, deck, { skip: 'bottom' });
    for (const sx of [-1, 1]) mb.boxC(sx * (w / 2 + 0.4), 0, sz * (leaf * 0.52 + 4.5), 0.22, 1.0, 9.0, steel);
  }
  if (shut) {
    // Both leaves raised. The gap between them is the barrier.
    for (const sz of [-1, 1]) {
      mb.push(0, 0, sz * leaf * 0.42, 0);
      mb.boxC(0, 0, 0, w + 0.8, leaf * 0.82, 0.35, deck, { skip: 'bottom' });
      for (const sx of [-1, 1]) mb.boxC(sx * (w / 2 + 0.4), 0, -0.3, 0.22, leaf * 0.8, 0.22, steel);
      mb.pop();
    }
  } else {
    mb.boxC(0, -0.35, 0, w + 0.8, 0.35, leaf * 0.9, deck, { skip: 'bottom' });
    for (const sx of [-1, 1]) mb.boxC(sx * (w / 2 + 0.4), 0, 0, 0.22, 1.0, leaf * 0.9, steel);
    mb.boxC(0, 0.02, 0, 0.5, 0.03, leaf * 0.9, ctx.lib.m('mark_dash'));
  }
}

// ---------------------------------------------------------------------------
// River crossings
// ---------------------------------------------------------------------------

/**
 * Every road that meets the Ash gets a bridge, because the terrain pass
 * deliberately refused to fill the channel in under it. Piers to the water,
 * a deck at the road's own elevation, parapets that double as cover.
 */
function buildRiverCrossings(world) {
  const { graph, terrain, cfg, rng } = world;
  const nodeY = terrain.nodeY;
  world.bridges = [];

  for (const e of graph.liveEdges()) {
    if (e.cls === 'boundary') continue;
    const a = graph.nodes[e.a], b = graph.nodes[e.b];
    const len = dist2D(a.x, a.z, b.x, b.z);
    if (len < 4) continue;

    // Find the stretch of this edge that is over open channel.
    let t0 = -1, t1 = -1;
    const steps = Math.ceil(len / 3);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = lerp(a.x, b.x, t), z = lerp(a.z, b.z, t);
      if (terrain.riverAt(x, z).t < 0.82) {
        if (t0 < 0) t0 = t;
        t1 = t;
      }
    }
    if (t0 < 0 || (t1 - t0) * len < 8) continue;

    const pad = 3 / len;
    t0 = clamp(t0 - pad, 0, 1); t1 = clamp(t1 + pad, 0, 1);
    const ax = lerp(a.x, b.x, t0), az = lerp(a.z, b.z, t0);
    const bx = lerp(a.x, b.x, t1), bz = lerp(a.z, b.z, t1);
    const ay = lerp(nodeY[a.id], nodeY[b.id], t0);
    const by = lerp(nodeY[a.id], nodeY[b.id], t1);
    const width = classWidth(e.cls);
    world.bridges.push({ ax, az, ay, bx, bz, by, width, cls: e.cls, span: (t1 - t0) * len });
    emitBridge(world, world.bridges[world.bridges.length - 1], rng);
  }
}

function emitBridge(world, br, rng) {
  const { ax, az, ay, bx, bz, by, width } = br;
  const span = Math.hypot(bx - ax, bz - az);
  const ux = (bx - ax) / span, uz = (bz - az) / span;
  const nx = -uz, nz = ux;
  const hw = width / 2;
  const deckMat = world.m('road_concrete', 4.0);
  const asph = world.m('road_worn', 5);
  const parapet = world.m('concrete_precast', 2.2);
  const steel = world.m('prop_rust', 1.4);
  const yAt = (t) => lerp(ay, by, t) + 0.06;

  const cx = (ax + bx) / 2, cz = (az + bz) / 2;
  world.store.emit(cx, cz, (mb) => {
    mb.env = world.env;
    // Deck, in bays so it follows the road's own gradient.
    const bays = Math.max(2, Math.ceil(span / 4));
    for (let i = 0; i < bays; i++) {
      const t0 = i / bays, t1 = (i + 1) / bays;
      const p0 = { x: ax + ux * span * t0, z: az + uz * span * t0, y: yAt(t0) };
      const p1 = { x: ax + ux * span * t1, z: az + uz * span * t1, y: yAt(t1) };
      mb.quadMat(
        [p0.x + nx * hw, p0.y, p0.z + nz * hw], [p1.x + nx * hw, p1.y, p1.z + nz * hw],
        [p1.x - nx * hw, p1.y, p1.z - nz * hw], [p0.x - nx * hw, p0.y, p0.z - nz * hw],
        asph, [0, 1, 0], { spanU: span / bays, spanV: width, maxEdge: 3 });
      // Soffit and edge beams, so it reads as a structure from the bank.
      mb.quadMat(
        [p0.x - nx * hw, p0.y - 0.6, p0.z - nz * hw], [p1.x - nx * hw, p1.y - 0.6, p1.z - nz * hw],
        [p1.x + nx * hw, p1.y - 0.6, p1.z + nz * hw], [p0.x + nx * hw, p0.y - 0.6, p0.z + nz * hw],
        deckMat, [0, -1, 0], { spanU: span / bays, spanV: width, maxEdge: 4 });
      for (const s of [-1, 1]) {
        mb.quadMat(
          [p0.x + nx * hw * s, p0.y - 0.6, p0.z + nz * hw * s], [p1.x + nx * hw * s, p1.y - 0.6, p1.z + nz * hw * s],
          [p1.x + nx * hw * s, p1.y, p1.z + nz * hw * s], [p0.x + nx * hw * s, p0.y, p0.z + nz * hw * s],
          deckMat, [nx * s, 0, nz * s], { spanU: span / bays, spanV: 0.6 });
      }
    }
    // Parapets. Chest height, so they are cover you can shoot over.
    for (const s of [-1, 1]) {
      const pts = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        pts.push({ x: ax + ux * span * t + nx * hw * s, z: az + uz * span * t + nz * hw * s });
      }
      mb.ribbon(pts, (x, z) => yAt(param(x, z)) , (x, z) => yAt(param(x, z)) + 1.05,
        parapet, { segment: 3, doubleSided: true });
    }
    // Piers down to the water.
    const piers = Math.max(1, Math.round(span / 11));
    for (let i = 1; i <= piers; i++) {
      const t = i / (piers + 1);
      const px = ax + ux * span * t, pz = az + uz * span * t;
      const base = Math.min(world.cfg.waterY - 1.2, world.terrain.heightAt(px, pz));
      const top = yAt(t) - 0.6;
      mb.box(px - hw * 0.7, base, pz - 1.0, px + hw * 0.7, top, pz + 1.0, deckMat, { skip: 'bottom top' });
      if (rng.chance(0.6)) mb.box(px - 0.1, base, pz - 1.3, px + 0.1, top, pz + 1.3, steel, { skip: 'bottom top' });
    }
  });

  function param(x, z) {
    return clamp01(((x - ax) * ux + (z - az) * uz) / span);
  }

  // Collision: a deck to stand on, and a parapet either side.
  const poly = [
    { x: ax + nx * hw, z: az + nz * hw }, { x: bx + nx * hw, z: bz + nz * hw },
    { x: bx - nx * hw, z: bz - nz * hw }, { x: ax - nx * hw, z: az - nz * hw },
  ];
  // Split the deck into bays so a sloping bridge is still a sequence of flat
  // plates the collision world can actually represent.
  const bays = Math.max(2, Math.ceil(span / 4));
  for (let i = 0; i < bays; i++) {
    const t0 = i / bays, t1 = (i + 1) / bays;
    const y = yAt((t0 + t1) / 2);
    const q0 = { x: ax + ux * span * t0, z: az + uz * span * t0 };
    const q1 = { x: ax + ux * span * t1, z: az + uz * span * t1 };
    world.collision.addFloor([
      { x: q0.x + nx * hw, z: q0.z + nz * hw }, { x: q1.x + nx * hw, z: q1.z + nz * hw },
      { x: q1.x - nx * hw, z: q1.z - nz * hw }, { x: q0.x - nx * hw, z: q0.z - nz * hw },
    ], y, 'bridge');
  }
  for (const s of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const t0 = i / 6, t1 = (i + 1) / 6;
      const p = { x: ax + ux * span * t0 + nx * hw * s, z: az + uz * span * t0 + nz * hw * s };
      const q = { x: ax + ux * span * t1 + nx * hw * s, z: az + uz * span * t1 + nz * hw * s };
      world.collision.addSegment(p.x, p.z, q.x, q.z, yAt(t0) - 1, yAt(t0) + 1.05, 'wall');
    }
  }
  world.landmarks.push({
    name: 'Ash Bridge', x: cx, z: cz, y: (ay + by) / 2 + 2,
    district: world.districts.districtAt(cx, cz),
  });
}
