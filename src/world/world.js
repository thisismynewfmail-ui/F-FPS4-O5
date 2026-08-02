// ---------------------------------------------------------------------------
// world.js — assembles the town.
//
// Order of operations matters and mirrors how a real place accumulates:
//   terrain → streets → kerbs and pavements → lots → buildings → yards and
//   fences → street furniture → landmarks.
//
// Everything is emitted through per-chunk mesh builders so the renderer can
// frustum-cull at 44 m granularity, and everything solid is registered with the
// collision world as it is built.
// ---------------------------------------------------------------------------

import {
  RNG, TAU, clamp, clamp01, dist2D, lerp, polyArea, polyCentroid, polyInset,
  distPointSeg, valueNoise,
} from '../core/math.js';
import { MeshBuilder, installClip } from '../render/meshbuilder.js';
import { clipPolyHalfplane } from '../core/math.js';
import {
  generateRoadNetwork, cutAlleys, subdivideOversizedBlocks, buildRoadSurfaces,
  classWidth, classSidewalk, nearestRoad, ROAD_CLASS,
} from './roads.js';
import { makeZoning, makeLots, assignProgramme, chooseOpenSpaces, ZONE } from './plan.js';
import { computeFootprint, buildBuilding } from './building.js';
import { buildKits } from '../art/materials.js';
import * as P from './props.js';
import { CollisionWorld } from '../game/collision.js';

installClip(clipPolyHalfplane);

const CHUNK = 44;
const SIDEWALK_Y = 0.155;
const ROAD_Y = 0.0;
const TERRAIN_Y = -0.06;

// ---------------------------------------------------------------------------

class ChunkStore {
  constructor(probe) {
    this.chunks = new Map();
    this.probe = probe;
  }
  key(x, z) { return `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`; }
  get(x, z) {
    const k = this.key(x, z);
    let c = this.chunks.get(k);
    if (!c) {
      const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
      c = {
        key: k, cx, cz,
        mb: new MeshBuilder({ probe: this.probe, maxEdge: 3.6 }),
        min: [cx * CHUNK, 1e9, cz * CHUNK],
        max: [(cx + 1) * CHUNK, -1e9, (cz + 1) * CHUNK],
      };
      this.chunks.set(k, c);
    }
    return c;
  }
  /** Route one unit of geometry into the chunk containing (x,z). */
  emit(x, z, fn) {
    const c = this.get(x, z);
    const before = c.mb.verts.length;
    fn(c.mb);
    // Track the vertical extent for frustum culling.
    for (let i = before; i < c.mb.verts.length; i += 12) {
      const wx = c.mb.verts[i], wy = c.mb.verts[i + 1], wz = c.mb.verts[i + 2];
      if (wy < c.min[1]) c.min[1] = wy;
      if (wy > c.max[1]) c.max[1] = wy;
      if (wx < c.min[0]) c.min[0] = wx;
      if (wx > c.max[0]) c.max[0] = wx;
      if (wz < c.min[2]) c.min[2] = wz;
      if (wz > c.max[2]) c.max[2] = wz;
    }
  }
}

// --- lighting --------------------------------------------------------------

function makeEnv(cfg) {
  const d = cfg.sunDir;
  const l = Math.hypot(d.x, d.y, d.z);
  return {
    sunDir: { x: d.x / l, y: d.y / l, z: d.z / l },
    // Heavy overcast: the sky is the key light and the sun barely shapes
    // anything, so the hemisphere term dominates and the lit/shaded ratio stays
    // near 1.6. Tuned so a mid-albedo brick wall in shade still reads at 320x240
    // instead of collapsing to black.
    sun: [0.46, 0.44, 0.37],
    sky: [0.98, 1.02, 1.09],
    grnd: [0.38, 0.35, 0.30],
    indoor: 0,
    lights: [],
    ao: 1,
  };
}

/**
 * The vertex-light probe. Sky/ground hemisphere plus a single unshadowed sun,
 * darkened when enclosed, plus whatever local lights the caller has pushed —
 * which is how daylight pools around windows without a lightmapper.
 */
function makeProbe(env) {
  return (x, y, z, nx, ny, nz) => {
    const skyF = 0.5 + 0.5 * ny;
    let r = env.sky[0] * skyF + env.grnd[0] * (1 - skyF);
    let g = env.sky[1] * skyF + env.grnd[1] * (1 - skyF);
    let b = env.sky[2] * skyF + env.grnd[2] * (1 - skyF);
    const ndl = nx * env.sunDir.x + ny * env.sunDir.y + nz * env.sunDir.z;
    if (ndl > 0) {
      r += env.sun[0] * ndl; g += env.sun[1] * ndl; b += env.sun[2] * ndl;
    }
    if (env.indoor > 0) {
      const f = lerp(1, 0.21, env.indoor);
      r *= f; g *= f; b *= f;
    }
    r *= env.ao; g *= env.ao; b *= env.ao;
    for (let i = 0; i < env.lights.length; i++) {
      const L = env.lights[i];
      const dx = L.x - x, dy = L.y - y, dz = L.z - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > L.r * L.r) continue;
      const dist = Math.sqrt(d2) || 1e-4;
      let atten = 1 - dist / L.r;
      atten *= atten;
      const dot = (dx * nx + dy * ny + dz * nz) / dist;
      const face = 0.25 + 0.75 * Math.max(dot, 0);
      r += L.c[0] * atten * face;
      g += L.c[1] * atten * face;
      b += L.c[2] * atten * face;
    }
    return [r, g, b];
  };
}

// ---------------------------------------------------------------------------

export class World {
  constructor({ lib, cfg, seed }) {
    this.lib = lib;
    this.cfg = cfg;
    this.seed = seed;
    this.rng = new RNG(seed);
    this.env = makeEnv(cfg);
    this.probe = makeProbe(this.env);
    this.store = new ChunkStore(this.probe);
    this.collision = new CollisionWorld(cfg.bounds);
    this.spawns = [];
    this.loot = [];
    this.lights = [];
    this.buildings = [];
    this.landmarks = [];
    this.stats = {};
    this.kits = buildKits(lib, this.rng);
  }

  m(name, tile) { return this.lib.m(name, tile); }

  /** The build pipeline, as discrete steps so loading can show progress. */
  steps() {
    return [
      ['Surveying the valley', () => this.stepPlan()],
      ['Laying the roads', () => this.stepTerrain()],
      ['Paving the streets', () => this.stepRoads()],
      ['Pouring kerbs and pavements', () => this.stepBlocks()],
      ['Raising the buildings', () => this.stepBuildings()],
      ['Fencing the yards', () => this.stepYards()],
      ['Hanging the wires', () => this.stepStreetFurniture()],
      ['Opening the parks', () => this.stepOpenSpaces()],
      ['Bringing in the rail', () => this.stepLandmarks()],
      ['Settling the dust', () => this.stepFinalize()],
    ];
  }

  // --- 1. plan -------------------------------------------------------------
  stepPlan() {
    const { cfg, rng } = this;
    this.graph = generateRoadNetwork(cfg, rng);
    subdivideOversizedBlocks(this.graph, cfg, rng, { maxArea: cfg.maxBlockArea, passes: 6 });
    let blocks = this.graph.faces(140);
    cutAlleys(this.graph, blocks, cfg, rng);
    blocks = this.graph.faces(140);
    this.blocks = blocks;
    this.zoning = makeZoning(cfg);
    chooseOpenSpaces(blocks, cfg, rng, this.zoning);
    const { lots, openSpaces } = makeLots(this.graph, blocks, this.zoning, cfg, rng);
    this.lots = lots;
    this.openSpaces = openSpaces;
    const { assigned, counts } = assignProgramme(lots, cfg, rng);
    this.assigned = assigned;
    this.programmeCounts = counts;
    for (const lot of assigned) lot.footprint = computeFootprint(lot, rng);
    this.surfaces = buildRoadSurfaces(this.graph);
  }

  // --- 2. terrain ----------------------------------------------------------
  stepTerrain() {
    const { cfg, rng, store } = this;
    const B = cfg.bounds;
    const cell = 22;
    const grass = this.m('grass', 6);
    const dead = this.m('grass_dead', 6);
    const dirt = this.m('dirt', 6);
    const gravel = this.m('gravel', 5);
    const asphalt = this.m('road_worn', 6);

    for (let z = B.minZ; z < B.maxZ; z += cell) {
      for (let x = B.minX; x < B.maxX; x += cell) {
        const cx = x + cell / 2, cz = z + cell / 2;
        const zone = this.zoning.zoneAt(cx, cz);
        const road = nearestRoad(this.graph, cx, cz, 40);
        const nearRoad = road && road.dist < 16;
        let mat;
        if (zone === ZONE.INDUSTRIAL) mat = rng.chance(0.5) ? gravel : asphalt;
        else if (zone === ZONE.CORE || zone === ZONE.MIXED) mat = nearRoad ? asphalt : dirt;
        else if (zone === ZONE.RURAL) mat = rng.chance(0.6) ? grass : dead;
        else mat = rng.chance(0.5) ? grass : dirt;
        store.emit(cx, cz, (mb) => {
          mb.quadMat([x, TERRAIN_Y, z + cell], [x + cell, TERRAIN_Y, z + cell],
            [x + cell, TERRAIN_Y, z], [x, TERRAIN_Y, z], mat, [0, 1, 0],
            { spanU: cell, spanV: cell, uvShift: [x / mat.tile, z / mat.tile], maxEdge: 6 });
        });
      }
    }
  }

  // --- 3. roads ------------------------------------------------------------
  stepRoads() {
    const { rng, store, surfaces, graph } = this;
    const asphalt = this.m('road_asphalt', 7);
    const worn = this.m('road_worn', 7);
    const concrete = this.m('road_concrete', 8);

    for (const strip of surfaces.strips) {
      const c = polyCentroid(strip.poly);
      const decay = this.zoning.decayAt(c.x, c.z);
      const mat = strip.cls === 'alley' ? concrete : (decay > 0.55 ? worn : asphalt);
      store.emit(c.x, c.z, (mb) => {
        mb.polyFlatTess(strip.poly, ROAD_Y, mat, 3);
      });
      // Lane markings on the bigger roads.
      if ((strip.cls === 'arterial' || strip.cls === 'main') && strip.length > 8) {
        const style = strip.cls === 'arterial' ? 'mark_dash' : 'mark_solid';
        const mk = this.m(style);
        const d = strip.dir;
        const nx = -d.z, nz = d.x;
        const w = 0.32;
        store.emit(c.x, c.z, (mb) => {
          const a = strip.a, b = strip.b;
          mb.quad([a.x - nx * w, ROAD_Y + 0.02, a.z - nz * w], [b.x - nx * w, ROAD_Y + 0.02, b.z - nz * w],
            [b.x + nx * w, ROAD_Y + 0.02, b.z + nz * w], [a.x + nx * w, ROAD_Y + 0.02, a.z + nz * w],
            [0, 0, strip.length / 3.2, 1], mk.layer, [0, 1, 0], { maxEdge: 6 });
        });
      }
    }

    for (const pad of surfaces.pads) {
      const c = polyCentroid(pad.poly);
      const decay = this.zoning.decayAt(c.x, c.z);
      const mat = decay > 0.55 ? worn : asphalt;
      store.emit(c.x, c.z, (mb) => mb.polyFlatTess(pad.poly, ROAD_Y, mat, 3));

      // Crosswalks at proper junctions.
      if (pad.degree >= 3 && pad.radius > 4.5) {
        const node = graph.nodes[pad.node];
        const mk = this.m('mark_crosswalk');
        for (const eid of node.edges) {
          const e = graph.edges[eid];
          if (e.cls === 'boundary' || e.cls === 'alley' || e.cls === 'lane') continue;
          if (!rng.chance(0.65)) continue;
          const o = graph.nodes[e.a === node.id ? e.b : e.a];
          const dx = o.x - node.x, dz = o.z - node.z;
          const l = Math.hypot(dx, dz) || 1;
          const ux = dx / l, uz = dz / l;
          const hw = classWidth(e.cls) / 2 - 0.3;
          const d0 = pad.radius * 0.55, d1 = pad.radius * 0.55 + 2.4;
          store.emit(node.x, node.z, (mb) => {
            mb.quad(
              [node.x + ux * d0 - uz * hw, ROAD_Y + 0.02, node.z + uz * d0 + ux * hw],
              [node.x + ux * d0 + uz * hw, ROAD_Y + 0.02, node.z + uz * d0 - ux * hw],
              [node.x + ux * d1 + uz * hw, ROAD_Y + 0.02, node.z + uz * d1 - ux * hw],
              [node.x + ux * d1 - uz * hw, ROAD_Y + 0.02, node.z + uz * d1 + ux * hw],
              [0, 0, (hw * 2) / 3.4, 1], mk.layer, [0, 1, 0], { maxEdge: 5 });
          });
        }
      }
    }
  }

  // --- 4. kerbs, pavements, lot ground -------------------------------------
  stepBlocks() {
    const { store, rng } = this;
    const curbMat = this.m('curb', 1.6);

    for (const block of this.blocks) {
      if (!block.kerb || !block.buildable) continue;
      const c = block.centroid;
      const decay = this.zoning.decayAt(c.x, c.z);
      const walk = this.m(decay > 0.5 ? 'sidewalk_worn' : 'sidewalk', 4);
      const kerb = block.kerb, build = block.buildable;
      if (kerb.length !== build.length) continue;

      store.emit(c.x, c.z, (mb) => {
        // Kerb face.
        const ring = kerb.concat([kerb[0]]);
        mb.ribbon(ring, ROAD_Y, SIDEWALK_Y, curbMat, { maxEdge: 3.5 });
        // Pavement: a quad strip between the kerb line and the building line.
        for (let i = 0; i < kerb.length; i++) {
          const a = kerb[i], b = kerb[(i + 1) % kerb.length];
          const a2 = build[i], b2 = build[(i + 1) % build.length];
          const len = Math.hypot(b.x - a.x, b.z - a.z);
          if (len < 0.05) continue;
          mb.quadMat([a.x, SIDEWALK_Y, a.z], [b.x, SIDEWALK_Y, b.z],
            [b2.x, SIDEWALK_Y, b2.z], [a2.x, SIDEWALK_Y, a2.z], walk, [0, 1, 0],
            { spanU: len, spanV: Math.hypot(a2.x - a.x, a2.z - a.z), maxEdge: 3.0 });
        }
      });

      // Ground inside the building line.
      const zone = block.zone;
      const groundMat = block.forceOpen
        ? this.m(block.openKind === 'square' ? 'plaza_stone' : 'grass', 5)
        : this.m(zone === ZONE.INDUSTRIAL ? 'gravel'
          : zone === ZONE.CORE ? 'sidewalk_worn'
            : (decay > 0.55 ? 'grass_dead' : 'grass'), 5);
      store.emit(c.x, c.z, (mb) => mb.polyFlatTess(build, SIDEWALK_Y, groundMat, 3));
    }
  }

  // --- 5. buildings --------------------------------------------------------
  stepBuildings() {
    const { rng, store } = this;
    let tris = 0;
    for (const lot of this.assigned) {
      if (!lot.footprint) continue;
      const c = lot.centroid;
      const kit = this.pickKit(lot);
      store.emit(c.x, c.z, (mb) => {
        mb.env = this.env;
        const before = mb.triCount;
        const ctx = {
          mb, lib: this.lib, rng, kit, cfg: this.cfg,
          collision: this.collision, spawns: this.spawns, loot: this.loot,
          lights: this.lights, env: this.env, world: this,
        };
        const rec = this.buildOne(lot, ctx);
        if (rec) this.buildings.push(rec);
        tris += mb.triCount - before;
      });
    }
    this.stats.buildingTris = tris;
  }

  buildOne(lot, ctx) {
    const fp = lot.footprint;
    const env = this.env;
    // Window lights: daylight pooling just inside every opening. Computed from
    // the plan before the interior is furnished so rooms light correctly.
    const winLights = [];
    const main = fp.masses.find((m) => m.kind === 'main');
    const record = buildBuilding(lot, Object.assign({}, ctx, { winLights }));
    return record;
  }

  pickKit(lot) {
    const { rng } = this;
    const t = lot.programme.type;
    let pool;
    if (['warehouse', 'factory', 'workshop', 'depot', 'barn'].includes(t)) pool = this.kits.industrial;
    else if (['library', 'church', 'townhall', 'school', 'clinic', 'police', 'firehouse'].includes(t)) pool = this.kits.civic;
    else if (['house', 'bungalow', 'duplex', 'farmhouse', 'shed', 'motel'].includes(t)) pool = this.kits.residential;
    else if (['shop', 'diner', 'bar', 'office', 'apartment', 'hardware', 'pharmacy',
      'laundromat', 'supermarket', 'bank', 'cinema', 'rowhouse', 'gasstation'].includes(t)) pool = this.kits.commercial;
    else pool = this.kits.residential;
    // A deterministic-but-scattered index so neighbours differ.
    const idx = Math.floor(Math.abs(valueNoise(lot.centroid.x * 0.07, lot.centroid.z * 0.07, 5) * 997)) % pool.length;
    const kit = pool[(idx + rng.int(0, 2)) % pool.length];
    // Vary trim and roof within the kit so no two are identical.
    return Object.assign({}, kit, {
      trim: rng.chance(0.45) ? this.lib.trimIds[rng.int(0, this.lib.trimIds.length - 1)] : kit.trim,
      trimAlt: rng.chance(0.5) ? this.lib.trimIds[rng.int(0, this.lib.trimIds.length - 1)] : kit.trimAlt,
      roof: rng.chance(0.35) ? this.lib.roofIds[rng.int(0, this.lib.roofIds.length - 1)] : kit.roof,
      door: rng.chance(0.35) ? this.lib.doorIds[rng.int(0, this.lib.doorIds.length - 1)] : kit.door,
    });
  }

  // --- 6. yards, drives, fences -------------------------------------------
  stepYards() {
    const { rng, store } = this;
    const ctxBase = { lib: this.lib, collision: this.collision, spawns: this.spawns, loot: this.loot, lights: this.lights };

    for (const lot of this.lots) {
      const c = lot.centroid;
      const decay = lot.decay;
      const fp = lot.footprint;
      store.emit(c.x, c.z, (mb) => {
        mb.env = this.env;
        const ctx = Object.assign({ mb }, ctxBase);

        if (!fp) {
          // Yards, car parks and vacant plots.
          if (lot.zone === ZONE.INDUSTRIAL) {
            for (let i = 0; i < rng.int(0, 4); i++) {
              const p = this.randomInPoly(lot.poly, rng);
              if (!p) break;
              if (rng.chance(0.5)) P.shippingContainer(mb, ctx, p.x, p.z, rng.range(0, TAU), rng);
              else P.palletStack(mb, ctx, p.x, p.z, rng.range(0, TAU), rng);
            }
          } else if (lot.area > 90) {
            for (let i = 0; i < rng.int(1, 4); i++) {
              const p = this.randomInPoly(lot.poly, rng);
              if (p) P.tree(mb, ctx, p.x, p.z, rng, { dead: rng.chance(0.35), h: rng.range(4.5, 8) });
            }
            for (let i = 0; i < rng.int(2, 7); i++) {
              const p = this.randomInPoly(lot.poly, rng);
              if (p) P.weeds(mb, ctx, p.x, p.z, rng, 3, 1.4);
            }
            if (rng.chance(0.3)) {
              const p = this.randomInPoly(lot.poly, rng);
              if (p) P.junkPile(mb, ctx, p.x, p.z, rng, 2.0);
            }
          }
          return;
        }

        // Front path from the door to the pavement.
        const door = fp.toWorld(fp.doorLocal.x, 0);
        const road = nearestRoad(this.graph, door.x, door.z, 60);
        if (road && fp.setback > 1.6) {
          const dx = road.x - door.x, dz = road.z - door.z;
          const l = Math.hypot(dx, dz) || 1;
          const ux = dx / l, uz = dz / l;
          const pathLen = Math.max(0, fp.setback - 0.2);
          const w = 0.62;
          const pm = this.m(decay > 0.55 ? 'sidewalk_worn' : 'sidewalk', 2.4);
          mb.quad([door.x - uz * w, SIDEWALK_Y + 0.02, door.z + ux * w],
            [door.x + uz * w, SIDEWALK_Y + 0.02, door.z - ux * w],
            [door.x + ux * pathLen + uz * w, SIDEWALK_Y + 0.02, door.z + uz * pathLen - ux * w],
            [door.x + ux * pathLen - uz * w, SIDEWALK_Y + 0.02, door.z + uz * pathLen + ux * w],
            [0, 0, 1, pathLen / 2.4], pm.layer, [0, 1, 0], { maxEdge: 3 });
        }

        // Driveway if the lot has a garage.
        const garage = fp.masses.find((m) => m.kind === 'garage');
        if (garage) {
          const gc = polyCentroid(garage.corners);
          const gr = nearestRoad(this.graph, gc.x, gc.z, 60);
          if (gr) {
            const dm = this.m('road_concrete', 4);
            const dx = gr.x - gc.x, dz = gr.z - gc.z;
            const l = Math.hypot(dx, dz) || 1;
            const ux = dx / l, uz = dz / l, w = 1.6;
            mb.quad([gc.x - uz * w, SIDEWALK_Y + 0.02, gc.z + ux * w],
              [gc.x + uz * w, SIDEWALK_Y + 0.02, gc.z - ux * w],
              [gr.x + uz * w, SIDEWALK_Y + 0.02, gr.z - ux * w],
              [gr.x - uz * w, SIDEWALK_Y + 0.02, gr.z + ux * w],
              [0, 0, 1, l / 4], dm.layer, [0, 1, 0], { maxEdge: 4 });
            if (rng.chance(0.35)) P.car(mb, ctx, lerp(gc.x, gr.x, 0.45), lerp(gc.z, gr.z, 0.45),
              Math.atan2(ux, uz), rng, { wrecked: rng.chance(0.4) });
          }
        }

        // Residential boundary treatment: picket fence or hedge along the front.
        if (lot.zone === ZONE.RESIDENTIAL || lot.zone === ZONE.RURAL) {
          if (lot.front && rng.chance(0.55)) {
            const a = lot.front.a, b = lot.front.b;
            const inset = 0.5;
            const nx = lot.front.nx * inset, nz = lot.front.nz * inset;
            const pts = [{ x: a.x - nx, z: a.z - nz }, { x: b.x - nx, z: b.z - nz }];
            if (rng.chance(0.5)) P.picketFence(mb, ctx, pts, rng, rng.range(0.9, 1.2));
            else P.hedgeRow(mb, ctx, pts, rng, rng.range(0.9, 1.5));
          }
          // Back garden dressing.
          for (let i = 0; i < rng.int(0, 3); i++) {
            const p = this.randomInPoly(lot.poly, rng, fp);
            if (p) P.tree(mb, ctx, p.x, p.z, rng, { dead: rng.chance(0.3 + decay * 0.4) });
          }
          for (let i = 0; i < rng.int(1, 5); i++) {
            const p = this.randomInPoly(lot.poly, rng, fp);
            if (p) (rng.chance(0.5) ? P.bush : P.weeds)(mb, ctx, p.x, p.z, rng);
          }
        }
        if (lot.zone === ZONE.INDUSTRIAL && rng.chance(0.45) && lot.front) {
          const a = lot.front.a, b = lot.front.b;
          P.chainLinkFence(mb, ctx, [a, b], 2.4, rng, { rusty: decay > 0.5 });
        }
      });
    }
  }

  /** A random point inside a polygon that is not under a building. */
  randomInPoly(poly, rng, fp, tries = 12) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of poly) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
    for (let i = 0; i < tries; i++) {
      const x = rng.range(minX, maxX), z = rng.range(minZ, maxZ);
      if (!pointInPolySimple(poly, x, z)) continue;
      if (fp) {
        let inside = false;
        for (const m of fp.masses) {
          if (pointInPolySimple(m.corners, x, z)) { inside = true; break; }
        }
        if (inside) continue;
        // Keep clear of the walls.
        let tooClose = false;
        for (const m of fp.masses) {
          for (let k = 0; k < 4; k++) {
            const a = m.corners[k], b = m.corners[(k + 1) % 4];
            if (distPointSeg(x, z, a.x, a.z, b.x, b.z).dist < 1.1) { tooClose = true; break; }
          }
          if (tooClose) break;
        }
        if (tooClose) continue;
      }
      return { x, z };
    }
    return null;
  }

  // --- 7. street furniture -------------------------------------------------
  stepStreetFurniture() {
    const { rng, store, graph } = this;
    const ctxBase = { lib: this.lib, collision: this.collision, spawns: this.spawns, loot: this.loot, lights: this.lights };
    const poles = [];

    for (const block of this.blocks) {
      if (!block.kerb) continue;
      const kerb = block.kerb;
      const c = block.centroid;
      const decay = this.zoning.decayAt(c.x, c.z);
      const zone = block.zone;

      // Walk the kerb line placing furniture at intervals.
      let travelled = 0;
      let next = rng.range(6, 16);
      for (let i = 0; i < kerb.length; i++) {
        const a = kerb[i], b = kerb[(i + 1) % kerb.length];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len < 0.2) continue;
        const ux = (b.x - a.x) / len, uz = (b.z - a.z) / len;
        // Inward normal (into the block, away from the road).
        const inx = -uz, inz = ux;
        const cIn = { x: (a.x + b.x) / 2 + inx, z: (a.z + b.z) / 2 + inz };
        const sign = pointInPolySimple(block.buildable || kerb, cIn.x, cIn.z) ? 1 : -1;
        const nx = inx * sign, nz = inz * sign;

        let t = 0;
        while (t < len) {
          const step = next;
          t += step;
          if (t >= len) { travelled += len; break; }
          const px = a.x + ux * t + nx * 0.85;
          const pz = a.z + uz * t + nz * 0.85;
          const yaw = Math.atan2(-nx, -nz);   // face the road
          const r = rng.next();
          store.emit(px, pz, (mb) => {
            mb.env = this.env;
            const ctx = Object.assign({ mb }, ctxBase);
            if (zone === ZONE.CORE || zone === ZONE.MIXED) {
              if (r < 0.20) P.streetLamp(mb, ctx, px, pz, yaw, rng, { lit: rng.chance(0.30), rusty: decay > 0.6 });
              else if (r < 0.30) P.trashCan(mb, ctx, px, pz, yaw, rng, { city: true, toppled: rng.chance(0.3) });
              else if (r < 0.40) P.parkingMeter(mb, ctx, px, pz, yaw, rng);
              else if (r < 0.48) P.bench(mb, ctx, px, pz, yaw + Math.PI, rng);
              else if (r < 0.55) P.newspaperBox(mb, ctx, px, pz, yaw, rng);
              else if (r < 0.62) P.fireHydrant(mb, ctx, px, pz, yaw, rng, { broken: decay > 0.6, knocked: rng.chance(0.22) });
              else if (r < 0.68) P.planter(mb, ctx, px, pz, yaw, rng);
              else if (r < 0.73) P.busShelter(mb, ctx, px + nx * 0.6, pz + nz * 0.6, yaw, rng);
              else if (r < 0.78) P.phoneBooth(mb, ctx, px, pz, yaw, rng);
              else if (r < 0.84) P.bollard(mb, ctx, px, pz, rng);
              else if (r < 0.90) P.streetSign(mb, ctx, px, pz, yaw, rng, { rusty: decay > 0.5, lean: rng.range(-0.12, 0.12) });
              else P.weeds(mb, ctx, px, pz, rng, 4, 0.7);
            } else if (zone === ZONE.INDUSTRIAL) {
              if (r < 0.28) poles.push(P.utilityPole(mb, ctx, px, pz, yaw, rng));
              else if (r < 0.42) P.streetLamp(mb, ctx, px, pz, yaw, rng, { lit: rng.chance(0.2), rusty: true });
              else if (r < 0.55) P.barrel(mb, ctx, px, pz, rng.range(0, TAU), rng, { hazard: rng.chance(0.4), toppled: rng.chance(0.3) });
              else if (r < 0.68) P.jerseyBarrier(mb, ctx, px, pz, yaw, rng);
              else if (r < 0.78) P.fireHydrant(mb, ctx, px, pz, yaw, rng, { broken: true });
              else P.junkPile(mb, ctx, px, pz, rng, 1.6);
            } else {
              if (r < 0.30) poles.push(P.utilityPole(mb, ctx, px, pz, yaw, rng));
              else if (r < 0.44) P.streetLamp(mb, ctx, px, pz, yaw, rng, { lit: rng.chance(0.22), rusty: decay > 0.5 });
              else if (r < 0.54) P.mailbox(mb, ctx, px, pz, yaw, rng);
              else if (r < 0.62) P.trashCan(mb, ctx, px, pz, yaw, rng, { toppled: rng.chance(0.4) });
              else if (r < 0.70) P.fireHydrant(mb, ctx, px, pz, yaw, rng, { knocked: rng.chance(0.25) });
              else if (r < 0.78) P.tree(mb, ctx, px, pz, rng, { dead: rng.chance(0.35) });
              else if (r < 0.85) P.bench(mb, ctx, px, pz, yaw + Math.PI, rng);
              else P.weeds(mb, ctx, px, pz, rng, 5, 0.9);
            }
          });
          next = rng.range(zone === ZONE.CORE ? 7 : 11, zone === ZONE.CORE ? 15 : 26);
        }
        travelled += len;
      }
    }

    // Junction furniture: signals, stop signs, manholes.
    for (const pad of this.surfaces.pads) {
      const node = graph.nodes[pad.node];
      if (pad.degree < 3) {
        if (rng.chance(0.16)) {
          store.emit(node.x, node.z, (mb) => {
            mb.env = this.env;
            P.manhole(mb, Object.assign({ mb }, ctxBase), node.x, node.z, rng,
              { displaced: rng.chance(0.3), glow: rng.chance(0.5) });
          });
        }
        continue;
      }
      const big = node.edges.some((eid) => ['arterial', 'main'].includes(graph.edges[eid].cls));
      const c = { x: node.x, z: node.z };
      const decay = this.zoning.decayAt(c.x, c.z);
      store.emit(c.x, c.z, (mb) => {
        mb.env = this.env;
        const ctx = Object.assign({ mb }, ctxBase);
        // Corner furniture just outside the pad.
        for (const eid of node.edges) {
          const e = graph.edges[eid];
          if (e.cls === 'boundary') continue;
          if (!rng.chance(big ? 0.5 : 0.3)) continue;
          const o = graph.nodes[e.a === node.id ? e.b : e.a];
          const dx = o.x - node.x, dz = o.z - node.z;
          const l = Math.hypot(dx, dz) || 1;
          const ux = dx / l, uz = dz / l;
          const off = pad.radius + 1.6;
          const side = rng.sign();
          const px = node.x + ux * off - uz * side * (classWidth(e.cls) / 2 + 1.1);
          const pz = node.z + uz * off + ux * side * (classWidth(e.cls) / 2 + 1.1);
          const yaw = Math.atan2(-ux, -uz);
          if (big && rng.chance(0.5)) P.trafficLight(mb, ctx, px, pz, yaw, rng);
          else P.streetSign(mb, ctx, px, pz, yaw, rng, { kind: rng.chance(0.4) ? 'stop' : 'road', rusty: decay > 0.5 });
        }
        if (rng.chance(0.55)) {
          P.manhole(mb, ctx, node.x + rng.range(-2, 2), node.z + rng.range(-2, 2), rng,
            { displaced: rng.chance(0.35), glow: rng.chance(0.6) });
        }
      });
    }

    // String the wires between neighbouring poles.
    for (let i = 0; i < poles.length; i++) {
      let best = null;
      for (let j = 0; j < poles.length; j++) {
        if (i === j) continue;
        const d = dist2D(poles[i].x, poles[i].z, poles[j].x, poles[j].z);
        if (d < 8 || d > 46) continue;
        if (!best || d < best.d) best = { d, j };
      }
      if (!best || best.j < i) continue;
      const a = poles[i], b = poles[best.j];
      store.emit((a.x + b.x) / 2, (a.z + b.z) / 2, (mb) => {
        mb.env = this.env;
        P.powerLine(mb, { lib: this.lib }, a, b, rng);
      });
    }
    this.poles = poles;

    // Abandoned traffic, thickest downtown.
    for (const strip of this.surfaces.strips) {
      if (strip.cls === 'alley' || strip.length < 9) continue;
      const c = polyCentroid(strip.poly);
      const zone = this.zoning.zoneAt(c.x, c.z);
      const density = zone === ZONE.CORE ? 0.75 : zone === ZONE.MIXED ? 0.5 : 0.28;
      const n = rng.chance(density) ? rng.int(1, zone === ZONE.CORE ? 3 : 2) : 0;
      for (let i = 0; i < n; i++) {
        const t = rng.range(0.15, 0.85);
        const lane = rng.sign() * rng.range(0.9, strip.width / 2 - 1.3);
        const px = lerp(strip.a.x, strip.b.x, t) - strip.dir.z * lane;
        const pz = lerp(strip.a.z, strip.b.z, t) + strip.dir.x * lane;
        const yaw = Math.atan2(strip.dir.x, strip.dir.z) + (rng.chance(0.5) ? 0 : Math.PI) + rng.range(-0.35, 0.35);
        store.emit(px, pz, (mb) => {
          mb.env = this.env;
          const ctx = Object.assign({ mb }, ctxBase);
          if (rng.chance(0.16) && strip.width > 9) P.truck(mb, ctx, px, pz, yaw, rng);
          else P.car(mb, ctx, px, pz, yaw, rng, { wrecked: rng.chance(0.45) });
        });
      }
    }
  }

  // --- 8. squares, parks, yards --------------------------------------------
  stepOpenSpaces() {
    const { rng, store } = this;
    const ctxBase = { lib: this.lib, collision: this.collision, spawns: this.spawns, loot: this.loot, lights: this.lights };
    for (const block of this.openSpaces) {
      const poly = block.buildable || block.kerb;
      if (!poly) continue;
      const c = block.centroid;
      store.emit(c.x, c.z, (mb) => {
        mb.env = this.env;
        const ctx = Object.assign({ mb }, ctxBase);
        const kind = block.openKind || 'island';

        if (kind === 'square') {
          // The town square: the landmark that orients the player downtown.
          P.statue(mb, ctx, c.x, c.z, rng.range(0, TAU), rng);
          this.landmarks.push({ name: 'Town Square', x: c.x, z: c.z, y: 4 });
          for (let i = 0; i < 8; i++) {
            const a = (i / 8) * TAU;
            const p = { x: c.x + Math.cos(a) * 7.5, z: c.z + Math.sin(a) * 7.5 };
            if (!pointInPolySimple(poly, p.x, p.z)) continue;
            if (i % 2 === 0) P.bench(mb, ctx, p.x, p.z, a + Math.PI / 2, rng);
            else P.streetLamp(mb, ctx, p.x, p.z, a, rng, { lit: rng.chance(0.5), h: 4.4 });
          }
          for (let i = 0; i < 6; i++) {
            const p = this.randomInPoly(poly, rng);
            if (p && dist2D(p.x, p.z, c.x, c.z) > 9) P.tree(mb, ctx, p.x, p.z, rng, { h: rng.range(6, 9) });
          }
        } else if (kind === 'park' || kind === 'ballfield') {
          for (let i = 0; i < rng.int(6, 14); i++) {
            const p = this.randomInPoly(poly, rng);
            if (p) P.tree(mb, ctx, p.x, p.z, rng, { dead: rng.chance(0.25), h: rng.range(5, 10) });
          }
          for (let i = 0; i < rng.int(2, 5); i++) {
            const p = this.randomInPoly(poly, rng);
            if (p) P.bench(mb, ctx, p.x, p.z, rng.range(0, TAU), rng);
          }
          for (let i = 0; i < rng.int(4, 10); i++) {
            const p = this.randomInPoly(poly, rng);
            if (p) P.bush(mb, ctx, p.x, p.z, rng, { dead: rng.chance(0.3) });
          }
          if (kind === 'ballfield') {
            // Backstop: chain link, and good cover.
            const pts = [];
            for (let i = 0; i <= 5; i++) {
              const a = -0.9 + (i / 5) * 1.8;
              pts.push({ x: c.x + Math.cos(a) * 9, z: c.z + Math.sin(a) * 9 });
            }
            P.chainLinkFence(mb, ctx, pts, 4.2, rng, { rusty: true });
          }
        } else if (kind === 'yard') {
          // Industrial storage yard: stacked containers make a maze arena.
          const per = polyInset(poly, 3);
          if (per) P.chainLinkFence(mb, ctx, per.concat([per[0]]), 2.6, rng, { rusty: true });
          for (let i = 0; i < rng.int(8, 18); i++) {
            const p = this.randomInPoly(poly, rng);
            if (!p) continue;
            const yaw = rng.chance(0.7) ? Math.round(rng.next() * 4) * (Math.PI / 2) : rng.range(0, TAU);
            P.shippingContainer(mb, ctx, p.x, p.z, yaw, rng);
            if (rng.chance(0.35)) P.shippingContainer(mb, ctx, p.x, p.z, yaw, rng, { y: 2.59 });
          }
          for (let i = 0; i < rng.int(2, 6); i++) {
            const p = this.randomInPoly(poly, rng);
            if (p) P.palletStack(mb, ctx, p.x, p.z, rng.range(0, TAU), rng);
          }
          this.spawns.push({ p: { x: c.x, y: 0, z: c.z }, kind: 'yard' });
        } else {
          // Traffic islands and leftovers.
          for (let i = 0; i < rng.int(1, 4); i++) {
            const p = this.randomInPoly(poly, rng);
            if (p) (rng.chance(0.5) ? P.weeds : P.bush)(mb, ctx, p.x, p.z, rng);
          }
        }
      });
    }
  }

  // --- 9. landmarks and boundaries ----------------------------------------
  stepLandmarks() {
    const { rng, store, cfg } = this;
    const B = cfg.bounds;
    const ctxBase = { lib: this.lib, collision: this.collision, spawns: this.spawns, loot: this.loot, lights: this.lights };

    // Water tower on the highest ground east of town: the primary wayfinder.
    const wtX = clamp(cfg.origin.x + cfg.mapSize * 0.24, B.minX + 30, B.maxX - 30);
    const wtZ = clamp(cfg.origin.z - cfg.mapSize * 0.20, B.minZ + 30, B.maxZ - 30);
    store.emit(wtX, wtZ, (mb) => {
      mb.env = this.env;
      P.waterTower(mb, Object.assign({ mb }, ctxBase), wtX, wtZ, rng);
    });
    this.landmarks.push({ name: 'Water Tower', x: wtX, z: wtZ, y: 22 });

    // The rail line along the eastern edge, with ballast, sleepers and rails.
    const railX = cfg.railX;
    const ballast = this.m('ballast', 4);
    const sleeper = this.m('prop_wood_dark', 1.0);
    const rail = this.m('prop_rust', 1.2);
    for (let z = B.minZ; z < B.maxZ; z += 22) {
      store.emit(railX, z + 11, (mb) => {
        mb.env = this.env;
        mb.quadMat([railX - 5, TERRAIN_Y + 0.10, z + 22], [railX + 5, TERRAIN_Y + 0.10, z + 22],
          [railX + 5, TERRAIN_Y + 0.10, z], [railX - 5, TERRAIN_Y + 0.10, z], ballast, [0, 1, 0],
          { spanU: 10, spanV: 22, maxEdge: 8 });
        for (let s = 0; s < 22; s += 0.72) {
          mb.box(railX - 1.4, TERRAIN_Y + 0.10, z + s, railX + 1.4, TERRAIN_Y + 0.24, z + s + 0.28, sleeper, { skip: 'bottom' });
        }
        for (const off of [-0.72, 0.72]) {
          mb.box(railX + off - 0.045, TERRAIN_Y + 0.24, z, railX + off + 0.045, TERRAIN_Y + 0.36, z + 22, rail, { skip: 'bottom' });
        }
      });
    }
    // Fence the rail off — it is out of bounds.
    const railFenceX = railX - 7.5;
    for (let z = B.minZ; z < B.maxZ; z += 30) {
      store.emit(railFenceX, z + 15, (mb) => {
        mb.env = this.env;
        P.chainLinkFence(mb, Object.assign({ mb }, ctxBase),
          [{ x: railFenceX, z }, { x: railFenceX, z: z + 30 }], 2.6, rng, { rusty: true });
      });
    }

    // The river along the south-west, and the road bridge over it.
    const water = this.m('water', 12);
    store.emit(B.minX + 40, B.maxZ - 30, (mb) => {
      mb.env = this.env;
      const poly = [
        { x: B.minX - 10, z: B.maxZ - 6 }, { x: B.maxX * 0.25, z: B.maxZ + 10 },
        { x: B.maxX * 0.25, z: B.maxZ - 40 }, { x: B.minX - 10, z: B.maxZ - 62 },
      ];
      mb.polyFlatTess(poly, -1.4, water, 20);
    });

    // Perimeter: an impassable wall of collision just inside the map edge.
    const m = 4;
    const corners = [
      { x: B.minX + m, z: B.minZ + m }, { x: B.maxX - m, z: B.minZ + m },
      { x: B.maxX - m, z: B.maxZ - m }, { x: B.minX + m, z: B.maxZ - m },
    ];
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4];
      this.collision.addSegment(a.x, a.z, b.x, b.z, -2, 60, 'bounds');
    }
  }

  // --- 10. finalize --------------------------------------------------------
  stepFinalize() {
    // Choose a start point: on the pavement near the town square, facing in.
    const square = this.landmarks.find((l) => l.name === 'Town Square');
    const o = square || this.cfg.origin;
    let start = null;
    for (let r = 8; r < 60 && !start; r += 4) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU;
        const x = o.x + Math.cos(a) * r, z = o.z + Math.sin(a) * r;
        if (!this.collision.isBlocked(x, z, 0.55, 0.2, 1.9)) { start = { x, z }; break; }
      }
    }
    this.playerStart = start || { x: this.cfg.origin.x, z: this.cfg.origin.z };
    this.playerYaw = Math.atan2(o.x - this.playerStart.x, o.z - this.playerStart.z);

    // Outdoor spawn points along the streets, for the director.
    const rng = this.rng;
    for (const strip of this.surfaces.strips) {
      if (strip.length < 8) continue;
      if (!rng.chance(0.5)) continue;
      const t = rng.range(0.2, 0.8);
      this.spawns.push({
        p: { x: lerp(strip.a.x, strip.b.x, t), y: 0, z: lerp(strip.a.z, strip.b.z, t) },
        kind: strip.cls === 'alley' ? 'alley' : 'street',
      });
    }

    this.stats.chunks = this.store.chunks.size;
    let tris = 0, verts = 0;
    for (const c of this.store.chunks.values()) { tris += c.mb.triCount; verts += c.mb.vertCount; }
    this.stats.tris = tris;
    this.stats.verts = verts;
    this.stats.buildings = this.buildings.length;
    this.stats.spawns = this.spawns.length;
    this.stats.loot = this.loot.length;
    this.stats.collision = this.collision.stats;
  }

  /** Hand finished chunks to the renderer. */
  uploadChunks(gl, program, createStaticMesh) {
    const out = [];
    for (const c of this.store.chunks.values()) {
      if (c.mb.isEmpty) continue;
      const { vertices, indices } = c.mb.toArrays();
      const mesh = createStaticMesh(gl, program, vertices, indices);
      if (!mesh) continue;
      if (c.min[1] > c.max[1]) { c.min[1] = 0; c.max[1] = 1; }
      out.push({
        mesh,
        min: [c.min[0] - 1, c.min[1] - 1, c.min[2] - 1],
        max: [c.max[0] + 1, c.max[1] + 1, c.max[2] + 1],
        centre: [(c.min[0] + c.max[0]) / 2, (c.min[1] + c.max[1]) / 2, (c.min[2] + c.max[2]) / 2],
      });
      c.mb.verts.length = 0;
      c.mb.indices.length = 0;
    }
    this.chunkMeshes = out;
    return out;
  }
}

function pointInPolySimple(poly, x, z) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
