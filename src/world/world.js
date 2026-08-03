// ---------------------------------------------------------------------------
// world.js — assembles the town.
//
// Order of operations matters and mirrors how a real place accumulates:
//   plan → ground → streets → kerbs and pavements → buildings → yards and
//   fences → street furniture → parks → landmarks → the cordon → secrets.
//
// The ground comes second and everything after it is DRAPED: there is one
// height function, `Terrain.heightAt`, and every surface, prop, collision
// segment and spawn point in the town is placed by asking it where the ground
// is. Nothing carries its own idea of "zero". That is the single rule that
// keeps a heightfield town from falling apart.
//
// Everything is emitted through per-chunk mesh builders so the renderer can
// frustum-cull at 44 m granularity, and everything solid is registered with the
// collision world as it is built.
// ---------------------------------------------------------------------------

import {
  RNG, TAU, clamp, clamp01, dist2D, lerp, polyArea, polyCentroid, polyInset,
  distPointSeg, valueNoise, smoothstep,
} from '../core/math.js';
import { MeshBuilder, installClip } from '../render/meshbuilder.js';
import { clipPolyHalfplane } from '../core/math.js';
import {
  generateRoadNetwork, cutAlleys, subdivideOversizedBlocks, buildRoadSurfaces,
  classWidth, classSidewalk, nearestRoad, ROAD_CLASS,
} from './roads.js';
import { makeZoning, makeLots, assignProgramme, chooseOpenSpaces, ZONE } from './plan.js';
import { computeFootprint, buildBuilding } from './building.js';
import { fitFootprints } from './fit.js';
import { buildKits } from '../art/materials.js';
import * as P from './props.js';
import { CollisionWorld } from '../game/collision.js';
import { Terrain } from './terrain.js';
import { makeDistricts, DISTRICTS } from './districts.js';
import { buildCordon } from './cordon.js';
import { placeSecrets } from './secrets.js';

installClip(clipPolyHalfplane);

const CHUNK = 44;
// Heights are now *offsets above the ground*, not absolute world Y.
const SIDEWALK_LIFT = 0.19;
const ROAD_LIFT = 0.035;
const LOT_LIFT = 0.11;
const GROUND_CELL = 2.0;      // terrain mesh triangle size
/**
 * How far the ground mesh sits below the height function it samples.
 *
 * A fixed clearance plus the field's own worst-case triangulation error plus a
 * term for how heavily this spot was paved. The paving term is not about
 * error — it is about giving the road, the footway and the lot ground room to
 * stack in the order they are laid, without a visible lip anywhere the paving
 * ends, because it fades out exactly where the paving does.
 */
const GROUND_SINK = (terrain, x, z) => 0.05 + terrain.sagAt(x, z) + 0.30 * terrain.fixAt(x, z);
const GROUND_PATCH = 8.0;     // one material choice per patch of ground

// ---------------------------------------------------------------------------

class ChunkStore {
  constructor(probe, tag) {
    this.chunks = new Map();
    this.probe = probe;
    this.tag = tag || null;
  }
  key(x, z) { return `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`; }
  get(x, z) {
    const k = this.key(x, z);
    let c = this.chunks.get(k);
    if (!c) {
      const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
      c = {
        key: k, cx, cz, tag: this.tag,
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
    const stride = 13;
    for (let i = before; i < c.mb.verts.length; i += stride) {
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
    // The cordon needs two mutually exclusive states per ring, so its geometry
    // lives in its own stores and the renderer just stops drawing one of them.
    this.gateStores = new Map();
    this.collision = new CollisionWorld(cfg.bounds);
    this.spawns = [];
    this.loot = [];
    this.doorways = [];
    this.vehicles = [];
    this.lights = [];
    this.buildings = [];
    this.landmarks = [];
    this.secrets = [];
    this.gates = [];
    this.streetProps = [];
    this.stats = {};
    this.kits = buildKits(lib, this.rng);
    this.districts = makeDistricts(cfg);
  }

  m(name, tile) { return this.lib.m(name, tile); }

  // --- ground helpers ------------------------------------------------------

  /** Ground height at a world position. The one authority. */
  gy(x, z) { return this.terrain.heightAt(x, z); }

  /**
   * Emit a prop standing on the ground at (x,z). The mesh builder is pushed to
   * the local ground level first, so props author themselves from y=0 exactly
   * as they always did and their collision, loot and light registrations
   * follow automatically — they all go through `mb.worldPoint`/`mb.ty`.
   */
  onGround(x, z, fn, lift = 0) {
    // Kerb lines are inset from the block boundary, and a setback can be
    // shallower than the inset, so furniture walked along a kerb occasionally
    // ends up standing in somebody's front room. It is cheap to check and
    // impossible to see if you do not.
    if (this.insideAnyBuilding(x, z, 0.35)) return;
    // Recorded so the validator can tell an outdoor prop from a sideboard: a
    // lamp post standing in someone's living room is a bug, and a bookcase
    // standing in someone's living room is a bookcase.
    this.streetProps.push({ x, z });
    this.store.emit(x, z, (mb) => {
      mb.env = this.env;
      mb.push(0, this.gy(x, z) + lift, 0, 0);
      fn(mb, this.ctxFor(mb));
      mb.pop();
    });
  }

  ctxFor(mb) {
    return {
      mb, lib: this.lib, collision: this.collision, spawns: this.spawns,
      loot: this.loot, lights: this.lights, world: this, env: this.env,
    };
  }

  /** The pluggable height sources every draped surface uses. */
  roadY(x, z) { return this.terrain.heightAt(x, z) + ROAD_LIFT; }
  walkY(x, z) { return this.terrain.heightAt(x, z) + SIDEWALK_LIFT; }
  lotY(x, z) { return this.terrain.heightAt(x, z) + LOT_LIFT; }

  /** The build pipeline, as discrete steps so loading can show progress. */
  steps() {
    return [
      ['Surveying the valley', () => this.stepPlan()],
      ['Cutting the ground', () => this.stepTerrain()],
      ['Paving the streets', () => this.stepRoads()],
      ['Pouring kerbs and pavements', () => this.stepBlocks()],
      ['Raising the buildings', () => this.stepBuildings()],
      ['Fencing the yards', () => this.stepYards()],
      ['Letting it back in', () => this.stepGreening()],
      ['Hanging the wires', () => this.stepStreetFurniture()],
      ['Opening the parks', () => this.stepOpenSpaces()],
      ['Bringing in the rail', () => this.stepLandmarks()],
      ['Closing the cordon', () => this.stepCordon()],
      ['Hiding what was left', () => this.stepSecrets()],
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
    // Nobody built in the clay pit. Keeping the floor of the Hollow clear is
    // what turns it from a dip in a housing estate into an arena: steep on
    // three sides, one ramp in, and nothing in it to break line of sight.
    const hl = cfg.landforms.hollow;
    for (const lot of assigned) {
      if (!lot.footprint) continue;
      if (dist2D(lot.centroid.x, lot.centroid.z, hl.x, hl.z) < hl.radius * 0.68) {
        lot.footprint = null;
        lot.kind = 'yard';
      }
    }
    this.surfaces = buildRoadSurfaces(this.graph);
    // Siting is only provisional until every neighbour exists: see fit.js.
    this.stats.fit = fitFootprints(this);
    for (const b of this.blocks) b.district = this.districts.districtAt(b.centroid.x, b.centroid.z);
    for (const l of this.lots) l.district = this.districts.districtAt(l.centroid.x, l.centroid.z);
  }

  // --- 2. the ground -------------------------------------------------------
  stepTerrain() {
    const { cfg } = this;
    const terrain = new Terrain(cfg);
    this.terrain = terrain;
    this.collision.terrain = terrain;

    // (a) the landforms, before anyone built here.
    terrain.buildBase();

    // (b) give every junction a legal elevation, then cut the carriageways in.
    terrain.levelRoadNetwork(this.graph, (cls) => cfg.maxGrade[cls] ?? 0.11);
    terrain.stampRoads(this.graph, (cls) => classWidth(cls) / 2 + classSidewalk(cls) * 0.6);

    // (c) building pads, keyed to the road each building fronts onto, so the
    //     front path is never a step and the back garden takes the slope.
    for (const lot of this.assigned) {
      const fp = lot.footprint;
      if (!fp) continue;
      const door = fp.toWorld(fp.doorLocal.x, -0.5);
      const padY = terrain.heightAt(door.x, door.z);
      // How far the natural ground falls away under the footprint decides how
      // tall the plinth has to be on the downhill side.
      let lo = padY, hi = padY;
      for (const m of fp.masses) {
        for (const c of m.corners) {
          const h = terrain.heightAt(c.x, c.z);
          if (h < lo) lo = h;
          if (h > hi) hi = h;
        }
      }
      lot.padY = padY;
      lot.foundDrop = clamp(padY - lo + 0.35, 0.4, 4.2);
      lot.cutInto = clamp(hi - padY, 0, 5);
      for (const m of fp.masses) terrain.stampPad(m.corners, padY);
    }

    // (d) blend everything that was not stamped, then measure how far a
    //     triangulated version of the result can float above it.
    terrain.relax(3);
    terrain.buildSagField();

    this.emitGround();
  }

  /**
   * The ground mesh. Triangles are 2 m because affine texture error scales
   * with the depth ratio across a polygon and that is worst underfoot; the
   * material is chosen per 8 m patch so the surface reads as fields and lots
   * rather than as noise.
   */
  emitGround() {
    const { cfg, rng, store, terrain } = this;
    const B = cfg.bounds;
    const grass = this.m('grass', 6);
    const meadow = this.m('grass', 9);
    const dead = this.m('grass_dead', 6);
    const dirt = this.m('dirt', 6);
    const gravel = this.m('gravel', 5);
    const asphalt = this.m('road_worn', 6);
    const rock = this.m('rock', 5);
    const rockDark = this.m('rock_dark', 4.5);
    // The ground mesh sits slightly BELOW the height function it samples.
    //
    // Every paved surface in the town drapes over the same field but with its
    // own tessellation, and two different triangulations of the same curved
    // bilinear patch disagree by up to a few tens of centimetres in the middle
    // of a cell. Left alone, the terrain punches up through the carriageway in
    // patches and the streets read as grass. The sink is proportional to how
    // hard the ground was stamped, so it is deepest exactly where paving is
    // about to be laid and fades to almost nothing out in open country, which
    // means there is never a visible lip where the two meet.
    const yFn = (x, z) => terrain.heightAt(x, z) - GROUND_SINK(terrain, x, z);
    const nFn = (x, z) => terrain.normalAt(x, z);

    const p0x = Math.floor((B.minX - GROUND_PATCH) / GROUND_PATCH) * GROUND_PATCH;
    const p0z = Math.floor((B.minZ - GROUND_PATCH) / GROUND_PATCH) * GROUND_PATCH;
    for (let pz = p0z; pz < B.maxZ + GROUND_PATCH; pz += GROUND_PATCH) {
      for (let px = p0x; px < B.maxX + GROUND_PATCH; px += GROUND_PATCH) {
        const cx = px + GROUND_PATCH / 2, cz = pz + GROUND_PATCH / 2;
        const zone = this.zoning.zoneAt(cx, cz);
        const road = nearestRoad(this.graph, cx, cz, 40);
        const nearRoad = road && road.dist < 16;
        const slope = terrain.slopeAt(cx, cz);
        const height = terrain.heightAt(cx, cz);
        const made = terrain.fixAt(cx, cz);
        // Coherent patches rather than per-cell coin flips: the same noise
        // field decides a whole hillside, so ground cover reads as fields and
        // yards instead of static.
        const grain = valueNoise(cx * 0.045, cz * 0.045, cfg.seed ^ 0x9e1);

        // Slope wins over zoning — nothing grows on a face this steep, and the
        // player has to be able to read "I cannot climb that" at a glance —
        // except where the slope is a road embankment or a building pad, which
        // is graded ground and should not be bare rock.
        let mat;
        if (slope > 0.92 && made < 0.25) mat = height < cfg.waterY + 4 ? rockDark : rock;
        else if (slope > 0.62 && made < 0.2) mat = grain > 0.42 ? rock : gravel;
        else if (height < cfg.waterY + 1.2) mat = grain > 0.5 ? dirt : gravel;
        else if (zone === ZONE.INDUSTRIAL) mat = grain > 0.5 ? gravel : asphalt;
        else if (zone === ZONE.CORE || zone === ZONE.MIXED) mat = nearRoad ? asphalt : dirt;
        else if (zone === ZONE.RURAL) mat = grain > 0.4 ? meadow : dead;
        else mat = grain > 0.5 ? grass : dirt;

        store.emit(cx, cz, (mb) => {
          const poly = [
            { x: px, z: pz }, { x: px + GROUND_PATCH, z: pz },
            { x: px + GROUND_PATCH, z: pz + GROUND_PATCH }, { x: px, z: pz + GROUND_PATCH },
          ];
          mb.polyFlatTess(poly, yFn, mat, GROUND_CELL, { normalFn: nFn });
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
    const yFn = (x, z) => this.roadY(x, z);

    for (const strip of surfaces.strips) {
      const c = polyCentroid(strip.poly);
      const decay = this.zoning.decayAt(c.x, c.z);
      const mat = strip.cls === 'alley' ? concrete : (decay > 0.55 ? worn : asphalt);
      store.emit(c.x, c.z, (mb) => {
        mb.polyFlatTess(strip.poly, yFn, mat, 1.5);
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
          // Markings drape too, or they float off the crown of a hill.
          mb.quadDrape(
            { x: a.x - nx * w, z: a.z - nz * w }, { x: a.x + nx * w, z: a.z + nz * w },
            { x: b.x + nx * w, z: b.z + nz * w }, { x: b.x - nx * w, z: b.z - nz * w },
            (x, z) => this.roadY(x, z) + 0.02, mk,
            { spanU: w * 2, spanV: strip.length, cell: 2.5, uv1: [1, strip.length / 3.2] });
        });
      }
    }

    for (const pad of surfaces.pads) {
      const c = polyCentroid(pad.poly);
      const decay = this.zoning.decayAt(c.x, c.z);
      const mat = decay > 0.55 ? worn : asphalt;
      store.emit(c.x, c.z, (mb) => mb.polyFlatTess(pad.poly, yFn, mat, 1.5));

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
            mb.quadDrape(
              { x: node.x + ux * d0 - uz * hw, z: node.z + uz * d0 + ux * hw },
              { x: node.x + ux * d0 + uz * hw, z: node.z + uz * d0 - ux * hw },
              { x: node.x + ux * d1 + uz * hw, z: node.z + uz * d1 - ux * hw },
              { x: node.x + ux * d1 - uz * hw, z: node.z + uz * d1 + ux * hw },
              (x, z) => this.roadY(x, z) + 0.02, mk,
              { spanU: hw * 2, spanV: 2.4, cell: 1.6, uv1: [(hw * 2) / 3.4, 1] });
          });
        }
      }
    }
  }

  // --- 4. kerbs, pavements, lot ground -------------------------------------
  stepBlocks() {
    const { store, rng } = this;
    const curbMat = this.m('curb', 1.6);
    const retain = this.m('concrete_precast', 2.6);

    for (const block of this.blocks) {
      if (!block.kerb || !block.buildable) continue;
      const c = block.centroid;
      const decay = this.zoning.decayAt(c.x, c.z);
      const walk = this.m(decay > 0.5 ? 'sidewalk_worn' : 'sidewalk', 4);
      const kerb = block.kerb, build = block.buildable;
      if (kerb.length !== build.length) continue;

      store.emit(c.x, c.z, (mb) => {
        mb.env = this.env;
        // Kerb face: bottom follows the carriageway, top follows the footway.
        const ring = kerb.concat([kerb[0]]);
        mb.ribbon(ring, (x, z) => this.roadY(x, z), (x, z) => this.walkY(x, z),
          curbMat, { maxEdge: 3.5, segment: 2.5 });
        // Pavement: a strip between the kerb line and the building line, with
        // its slabs running ALONG the footway the way slabs are actually laid.
        for (let i = 0; i < kerb.length; i++) {
          const a = kerb[i], b = kerb[(i + 1) % kerb.length];
          const a2 = build[i], b2 = build[(i + 1) % build.length];
          const len = Math.hypot(b.x - a.x, b.z - a.z);
          if (len < 0.05) continue;
          mb.quadDrape(a, b, b2, a2, (x, z) => this.walkY(x, z), walk,
            { spanU: len, spanV: Math.hypot(a2.x - a.x, a2.z - a.z), cell: 1.6 });
        }
      });

      // Ground inside the building line.
      const zone = block.zone;
      const groundMat = block.forceOpen
        ? this.m(block.openKind === 'square' ? 'plaza_stone' : 'grass', 5)
        : this.m(zone === ZONE.INDUSTRIAL ? 'gravel'
          : zone === ZONE.CORE ? 'sidewalk_worn'
            : (decay > 0.55 ? 'grass_dead' : 'grass'), 5);
      store.emit(c.x, c.z, (mb) => mb.polyFlatTess(build, (x, z) => this.lotY(x, z), groundMat, 1.6));

      // Where a block's interior stands well above the footway, the difference
      // is held by a retaining wall rather than by an impossible grass slope.
      // This is most of what makes the hill streets read as terraces — and it
      // is also the fastest way to seal every front door on the street, so
      // every wall piece that a path crosses becomes a flight of steps up to
      // the garden gate instead.
      const paths = this.frontPaths();
      store.emit(c.x, c.z, (mb) => {
        mb.env = this.env;
        for (let i = 0; i < kerb.length; i++) {
          const a = build[i], b = build[(i + 1) % build.length];
          const seg = Math.hypot(b.x - a.x, b.z - a.z);
          if (seg < 3) continue;
          const pieces = Math.ceil(seg / 4);
          for (let s = 0; s < pieces; s++) {
            const t0 = s / pieces, t1 = (s + 1) / pieces;
            const p = { x: lerp(a.x, b.x, t0), z: lerp(a.z, b.z, t0) };
            const q = { x: lerp(a.x, b.x, t1), z: lerp(a.z, b.z, t1) };
            const kp = kerb[i], kq = kerb[(i + 1) % kerb.length];
            const fp0 = { x: lerp(kp.x, kq.x, t0), z: lerp(kp.z, kq.z, t0) };
            const fq0 = { x: lerp(kp.x, kq.x, t1), z: lerp(kp.z, kq.z, t1) };
            const rise = Math.min(this.lotY(p.x, p.z) - this.walkY(fp0.x, fp0.z),
              this.lotY(q.x, q.z) - this.walkY(fq0.x, fq0.z));
            if (rise < 0.75) continue;
            const mx = (p.x + q.x) / 2, mz = (p.z + q.z) / 2;
            if (this.nearPath(paths, mx, mz, 2.6)) {
              this.frontSteps(mb, fp0, p, rise);
              continue;
            }
            mb.ribbon([p, q], (x, z) => this.walkY(x, z) - 0.1,
              (x, z) => this.lotY(x, z) + 0.06, retain, { segment: 2.2, doubleSided: false });
            this.collision.addSegment(p.x, p.z, q.x, q.z,
              this.walkY(p.x, p.z), this.lotY(p.x, p.z), 'wall');
          }
        }
      });
    }
  }

  /**
   * Every front path in the town, as a line from the pavement to the door.
   * Cached because the retaining-wall pass asks about all of them for every
   * four metres of every block boundary.
   */
  frontPaths() {
    if (this._paths) return this._paths;
    const out = [];
    for (const lot of this.assigned) {
      const fp = lot.footprint;
      if (!fp) continue;
      const door = fp.toWorld(fp.doorLocal.x, 0);
      const road = nearestRoad(this.graph, door.x, door.z, 60);
      if (!road) continue;
      out.push({ ax: door.x, az: door.z, bx: road.x, bz: road.z });
    }
    // Driveways count too — a garage behind a retaining wall is a garage
    // nobody has ever driven into.
    for (const lot of this.assigned) {
      const fp = lot.footprint;
      if (!fp) continue;
      const g = fp.masses.find((m) => m.kind === 'garage');
      if (!g) continue;
      const gc = polyCentroid(g.corners);
      const gr = nearestRoad(this.graph, gc.x, gc.z, 60);
      if (gr) out.push({ ax: gc.x, az: gc.z, bx: gr.x, bz: gr.z });
    }
    this._paths = out;
    return out;
  }

  nearPath(paths, x, z, r) {
    for (const p of paths) {
      if (distPointSeg(x, z, p.ax, p.az, p.bx, p.bz).dist < r) return true;
    }
    return false;
  }

  /** A short flight of steps up a retaining wall, with collision per tread. */
  frontSteps(mb, from, to, rise) {
    const dx = to.x - from.x, dz = to.z - from.z;
    const run = Math.hypot(dx, dz) || 1;
    const ux = dx / run, uz = dz / run;
    const nx = -uz, nz = ux;
    const n = Math.max(2, Math.round(rise / 0.18));
    const mat = this.m('found_stone', 1.4);
    const y0 = this.walkY(from.x, from.z);
    const y1 = this.lotY(to.x, to.z) + 0.02;
    const halfW = 1.05;
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      const px = from.x + ux * run * t0, pz = from.z + uz * run * t0;
      const qx = from.x + ux * run * t1, qz = from.z + uz * run * t1;
      const y = lerp(y0, y1, t1);
      mb.quadMat(
        [px - nx * halfW, y, pz - nz * halfW], [qx - nx * halfW, y, qz - nz * halfW],
        [qx + nx * halfW, y, qz + nz * halfW], [px + nx * halfW, y, pz + nz * halfW],
        mat, [0, 1, 0], { spanU: run / n, spanV: halfW * 2, maxEdge: 2 });
      // Riser.
      mb.quadMat(
        [px - nx * halfW, y - (y1 - y0) / n, pz - nz * halfW], [px + nx * halfW, y - (y1 - y0) / n, pz + nz * halfW],
        [px + nx * halfW, y, pz + nz * halfW], [px - nx * halfW, y, pz - nz * halfW],
        mat, [-ux, 0, -uz], { spanU: halfW * 2, spanV: (y1 - y0) / n });
      this.collision.addFloor([
        { x: px - nx * halfW, z: pz - nz * halfW }, { x: qx - nx * halfW, z: qz - nz * halfW },
        { x: qx + nx * halfW, z: qz + nz * halfW }, { x: px + nx * halfW, z: pz + nz * halfW },
      ], y, 'steps');
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
          lights: this.lights, env: this.env, world: this, doorways: this.doorways,
          baseY: lot.padY ?? 0,
        };
        const rec = this.buildOne(lot, ctx);
        if (rec) {
          rec.district = lot.district;
          this.buildings.push(rec);
        }
        tris += mb.triCount - before;
      });
    }
    this.stats.buildingTris = tris;
  }

  buildOne(lot, ctx) {
    const fp = lot.footprint;
    const winLights = [];
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
    const { rng } = this;

    for (const lot of this.lots) {
      const c = lot.centroid;
      const decay = lot.decay;
      const fp = lot.footprint;

      if (!fp) {
        // Yards, car parks and vacant plots. Overgrown lots are the signal
        // that nobody has been through here — so they get the tallest grass
        // and the most self-seeded trees in the town.
        if (lot.zone === ZONE.INDUSTRIAL) {
          for (let i = 0; i < rng.int(0, 4); i++) {
            const p = this.randomInPoly(lot.poly, rng);
            if (!p) break;
            if (this.terrain.slopeAt(p.x, p.z) > 0.45) continue;
            const yaw = rng.range(0, TAU);
            this.onGround(p.x, p.z, (mb, ctx) => {
              if (rng.chance(0.5)) P.shippingContainer(mb, ctx, p.x, p.z, yaw, rng);
              else P.palletStack(mb, ctx, p.x, p.z, yaw, rng);
            });
          }
        } else if (lot.area > 90) {
          for (let i = 0; i < rng.int(1, 4); i++) {
            const p = this.randomInPoly(lot.poly, rng);
            if (p) this.plantTree(p.x, p.z, rng, { dead: rng.chance(0.35), h: rng.range(4.5, 8) });
          }
          for (let i = 0; i < rng.int(4, 11); i++) {
            const p = this.randomInPoly(lot.poly, rng);
            if (p) this.plantWeeds(p.x, p.z, rng, 4, 1.6, { tall: true });
          }
          if (rng.chance(0.3)) {
            const p = this.randomInPoly(lot.poly, rng);
            if (p) this.onGround(p.x, p.z, (mb, ctx) => P.junkPile(mb, ctx, p.x, p.z, rng, 2.0));
          }
        }
        continue;
      }

      const padY = lot.padY ?? 0;

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
        this.store.emit(door.x, door.z, (mb) => {
          mb.env = this.env;
          // The path ramps from the pad down to whatever the ground is doing
          // at the gate, which is why the pad was keyed to the door in the
          // first place.
          const yFn = (x, z) => {
            const t = clamp01(((x - door.x) * ux + (z - door.z) * uz) / Math.max(pathLen, 0.001));
            return lerp(padY + 0.06, this.walkY(x, z), smoothstep(t));
          };
          mb.quadDrape(
            { x: door.x - uz * w, z: door.z + ux * w },
            { x: door.x + uz * w, z: door.z - ux * w },
            { x: door.x + ux * pathLen + uz * w, z: door.z + uz * pathLen - ux * w },
            { x: door.x + ux * pathLen - uz * w, z: door.z + uz * pathLen + ux * w },
            yFn, pm, { spanU: w * 2, spanV: pathLen, cell: 1.1 });
        });
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
          this.store.emit(gc.x, gc.z, (mb) => {
            mb.env = this.env;
            const yFn = (x, z) => {
              const t = clamp01(((x - gc.x) * ux + (z - gc.z) * uz) / l);
              return lerp(padY + 0.06, this.roadY(x, z), smoothstep(t));
            };
            mb.quadDrape(
              { x: gc.x - uz * w, z: gc.z + ux * w }, { x: gc.x + uz * w, z: gc.z - ux * w },
              { x: gr.x + uz * w, z: gr.z - ux * w }, { x: gr.x - uz * w, z: gr.z + ux * w },
              yFn, dm, { spanU: w * 2, spanV: l, cell: 1.5 });
          });
          const dvx = lerp(gc.x, gr.x, 0.45), dvz = lerp(gc.z, gr.z, 0.45);
          if (rng.chance(0.35) && this.vehicleFits(dvx, dvz, 2.9) && !this.insideAnyBuilding(dvx, dvz, 1.9)) {
            this.vehicles.push({ x: dvx, z: dvz, r: 2.9 });
            const yaw = Math.atan2(ux, uz);
            const wrecked = rng.chance(0.4);
            this.onGround(dvx, dvz, (mb, ctx) => P.car(mb, ctx, dvx, dvz, yaw, rng, { wrecked }), 0.05);
          }
        }
      }

      // Residential boundary treatment: picket fence or hedge along the front.
      if (lot.zone === ZONE.RESIDENTIAL || lot.zone === ZONE.RURAL) {
        if (lot.front && rng.chance(0.55)) {
          const a = lot.front.a, b = lot.front.b;
          const inset = 0.5;
          const nx = lot.front.nx * inset, nz = lot.front.nz * inset;
          const pts = [{ x: a.x - nx, z: a.z - nz }, { x: b.x - nx, z: b.z - nz }];
          this.fenceLine(pts, rng.chance(0.5) ? 'picket' : 'hedge', rng);
        }
        // Back garden dressing.
        for (let i = 0; i < rng.int(0, 3); i++) {
          const p = this.randomInPoly(lot.poly, rng, fp);
          if (p) this.plantTree(p.x, p.z, rng, { dead: rng.chance(0.3 + decay * 0.4) });
        }
        for (let i = 0; i < rng.int(2, 6); i++) {
          const p = this.randomInPoly(lot.poly, rng, fp);
          if (!p) continue;
          if (rng.chance(0.5)) this.plantBush(p.x, p.z, rng, {});
          else this.plantWeeds(p.x, p.z, rng);
        }
      }
      if (lot.zone === ZONE.INDUSTRIAL && rng.chance(0.45) && lot.front) {
        this.fenceLine([lot.front.a, lot.front.b], 'chain', rng, { h: 2.4, rusty: decay > 0.5 });
      }
    }
  }

  // --- 6b. greening --------------------------------------------------------
  /**
   * Nature comes back into the town rather than being kept in a park.
   *
   * The rules are the ones the weather actually imposes. Ivy climbs the walls
   * that face away from the sun, because that is where the damp sits — this
   * town's sun is south-westerly, so the north and east elevations get it, and
   * a player who notices will always be able to tell which way they are facing
   * from the walls alone. Weeds take the base of every wall, where rain runs
   * off the roof and nobody ever swept. Buddleia takes the gutters. And the
   * further from the maintained core, the more of all of it there is.
   */
  stepGreening() {
    const { rng } = this;
    const sun = this.env.sunDir;
    let vines = 0, tufts = 0;

    for (const b of this.buildings) {
      const fp = b.lot.footprint;
      if (!fp) continue;
      const main = fp.masses.find((m) => m.kind === 'main');
      if (!main) continue;
      const decay = b.lot.decay;
      const baseY = b.baseY;

      // The four elevations of the main mass, in world space.
      const faces = [
        { a: fp.toWorld(main.x0, main.z0), b: fp.toWorld(main.x1, main.z0), n: -1, along: 'x' },
        { a: fp.toWorld(main.x1, main.z0), b: fp.toWorld(main.x1, main.z1), n: 1, along: 'z' },
        { a: fp.toWorld(main.x1, main.z1), b: fp.toWorld(main.x0, main.z1), n: 1, along: 'x' },
        { a: fp.toWorld(main.x0, main.z1), b: fp.toWorld(main.x0, main.z0), n: -1, along: 'z' },
      ];

      for (const f of faces) {
        const dx = f.b.x - f.a.x, dz = f.b.z - f.a.z;
        const len = Math.hypot(dx, dz);
        if (len < 2.2) continue;
        // Outward normal of a clockwise-wound footprint.
        const nx = dz / len, nz = -dx / len;
        // How much sun this elevation gets: -1 is fully shaded.
        const facing = nx * sun.x + nz * sun.z;
        const shade = clamp01((-facing + 0.15) / 1.1);
        const cx = (f.a.x + f.b.x) / 2, cz = (f.a.z + f.b.z) / 2;

        if (shade > 0.35 && rng.chance(0.18 + shade * 0.42 + decay * 0.3)) {
          const h = Math.min(b.eaveY - b.plinth, rng.range(2.2, 7.5)) * (0.5 + shade * 0.6);
          const w = len * rng.range(0.35, 0.9);
          const ox = cx + rng.range(-0.25, 0.25) * len * (dx / len);
          const oz = cz + rng.range(-0.25, 0.25) * len * (dz / len);
          this.store.emit(ox, oz, (mb) => {
            mb.env = this.env;
            mb.push(0, baseY + b.plinth, 0, 0);
            P.vines(mb, this.ctxFor(mb), ox + nx * 0.04, oz + nz * 0.04, nx, nz, w, h, rng);
            mb.pop();
          });
          vines++;
        }

        // Weeds along the drip line, thicker on the shaded side.
        const n = Math.round(rng.range(0, 2.2 + decay * 3 + shade * 1.5));
        for (let i = 0; i < n; i++) {
          const t = rng.range(0.08, 0.92);
          const px = f.a.x + dx * t + nx * rng.range(0.25, 0.7);
          const pz = f.a.z + dz * t + nz * rng.range(0.25, 0.7);
          if (this.insideAnyBuilding(px, pz, 0)) continue;
          this.plantWeeds(px, pz, rng, 3, 0.45, { tall: decay > 0.55 && rng.chance(0.5) });
          tufts++;
        }
      }

      // Buddleia in the gutters of the more neglected blocks: the silhouette
      // detail that says nobody has been on that roof in years.
      if (b.roofFlat && decay > 0.45 && rng.chance(0.55)) {
        for (let i = 0; i < rng.int(1, 4); i++) {
          const p = fp.toWorld(rng.range(main.x0 + 0.4, main.x1 - 0.4), rng.range(main.z0 + 0.4, main.z1 - 0.4));
          this.store.emit(p.x, p.z, (mb) => {
            mb.env = this.env;
            mb.push(0, baseY + b.eaveY + 0.05, 0, 0);
            P.bush(mb, this.ctxFor(mb), p.x, p.z, rng, { s: rng.range(0.5, 1.1), dead: rng.chance(0.3) });
            mb.pop();
          });
        }
      }
    }

    // Bushes gather where a boundary stops the mower: fence lines, kerb backs,
    // and the corners of every block.
    for (const block of this.blocks) {
      if (!block.buildable || block.forceOpen) continue;
      const poly = block.buildable;
      for (let i = 0; i < poly.length; i++) {
        if (!rng.chance(0.45)) continue;
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const t = rng.range(0.15, 0.85);
        const x = lerp(a.x, b.x, t), z = lerp(a.z, b.z, t);
        if (this.insideAnyBuilding(x, z, 1.2)) continue;
        if (rng.chance(0.55)) this.plantBush(x, z, rng, { dead: rng.chance(0.25) });
        else this.plantWeeds(x, z, rng, 5, 1.1, { tall: true });
      }
    }
    this.stats.greening = { vines, tufts };
  }

  /** Fences and hedges follow the ground, in short pieces so they never float. */
  fenceLine(pts, kind, rng, o = {}) {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const steps = Math.max(1, Math.ceil(len / 3));
      for (let s = 0; s < steps; s++) {
        const p = { x: lerp(a.x, b.x, s / steps), z: lerp(a.z, b.z, s / steps) };
        const q = { x: lerp(a.x, b.x, (s + 1) / steps), z: lerp(a.z, b.z, (s + 1) / steps) };
        const mid = { x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 };
        const gy = this.gy(mid.x, mid.z);
        const lp = { x: p.x, z: p.z }, lq = { x: q.x, z: q.z };
        this.store.emit(mid.x, mid.z, (mb) => {
          mb.env = this.env;
          mb.push(0, gy, 0, 0);
          const ctx = this.ctxFor(mb);
          if (kind === 'picket') P.picketFence(mb, ctx, [lp, lq], rng, o.h ?? rng.range(0.9, 1.2));
          else if (kind === 'hedge') P.hedgeRow(mb, ctx, [lp, lq], rng, o.h ?? rng.range(0.9, 1.5));
          else P.chainLinkFence(mb, ctx, [lp, lq], o.h ?? 2.4, rng, { rusty: o.rusty });
          mb.pop();
        });
      }
    }
  }

  // --- vegetation ----------------------------------------------------------
  // Nature is woven through the town rather than fenced off in a wilderness
  // zone, and all of it sways: the wind allowance is set per card so a tree
  // crown moves more than a hedge and a hedge more than a tuft of grass.

  plantTree(x, z, rng, o = {}) {
    if (this.terrain.slopeAt(x, z) > 0.85) return;
    this.onGround(x, z, (mb, ctx) => P.tree(mb, ctx, x, z, rng, o));
  }

  plantBush(x, z, rng, o = {}) {
    this.onGround(x, z, (mb, ctx) => P.bush(mb, ctx, x, z, rng, o));
  }

  plantWeeds(x, z, rng, n = 3, spread = 1.2, o = {}) {
    this.onGround(x, z, (mb, ctx) => P.weeds(mb, ctx, x, z, rng, n, spread, o));
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

  /** True if (x,z) lies inside any building's footprint, plus a margin. */
  insideAnyBuilding(x, z, margin = 0) {
    for (const lot of this.assigned) {
      const fp = lot.footprint;
      if (!fp) continue;
      const a = lot.aabbCache || (lot.aabbCache = fpAabb(fp));
      if (x < a.minX - margin || x > a.maxX + margin || z < a.minZ - margin || z > a.maxZ + margin) continue;
      for (const m of fp.masses) {
        if (pointInPolySimple(m.corners, x, z)) return true;
        if (margin > 0) {
          for (let k = 0; k < 4; k++) {
            const p = m.corners[k], q = m.corners[(k + 1) % 4];
            if (distPointSeg(x, z, p.x, p.z, q.x, q.z).dist < margin) return true;
          }
        }
      }
    }
    return false;
  }

  // --- 7. street furniture -------------------------------------------------
  stepStreetFurniture() {
    const { rng, graph } = this;
    const poles = [];

    for (const block of this.blocks) {
      if (!block.kerb) continue;
      const kerb = block.kerb;
      const c = block.centroid;
      const decay = this.zoning.decayAt(c.x, c.z);
      const zone = block.zone;

      // Walk the kerb line placing furniture at intervals.
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
          t += next;
          if (t >= len) break;
          const px = a.x + ux * t + nx * 0.85;
          const pz = a.z + uz * t + nz * 0.85;
          const yaw = Math.atan2(-nx, -nz);   // face the road
          const r = rng.next();
          const lift = SIDEWALK_LIFT;
          this.onGround(px, pz, (mb, ctx) => {
            if (zone === ZONE.CORE || zone === ZONE.MIXED) {
              if (r < 0.18) P.streetLamp(mb, ctx, px, pz, yaw, rng, { lit: rng.chance(0.30), rusty: decay > 0.6 });
              else if (r < 0.27) P.trashCan(mb, ctx, px, pz, yaw, rng, { city: true, toppled: rng.chance(0.3) });
              else if (r < 0.36) P.parkingMeter(mb, ctx, px, pz, yaw, rng);
              else if (r < 0.44) P.bench(mb, ctx, px, pz, yaw + Math.PI, rng);
              else if (r < 0.51) P.newspaperBox(mb, ctx, px, pz, yaw, rng);
              else if (r < 0.58) P.fireHydrant(mb, ctx, px, pz, yaw, rng, { broken: decay > 0.6, knocked: rng.chance(0.22) });
              else if (r < 0.64) P.planter(mb, ctx, px, pz, yaw, rng);
              else if (r < 0.69) P.busShelter(mb, ctx, px + nx * 0.6, pz + nz * 0.6, yaw, rng);
              else if (r < 0.74) P.phoneBooth(mb, ctx, px, pz, yaw, rng);
              else if (r < 0.80) P.bollard(mb, ctx, px, pz, rng);
              else if (r < 0.86) P.streetSign(mb, ctx, px, pz, yaw, rng, { rusty: decay > 0.5, lean: rng.range(-0.12, 0.12) });
              else if (r < 0.93) {
                // A tree that came up through the paving. The kerb is broken
                // around it, which is the detail that sells it.
                P.tree(mb, ctx, px, pz, rng, { h: rng.range(4.5, 7.5), dead: rng.chance(0.35) });
                P.rubbleRing(mb, ctx, px, pz, rng, 1.5);
              } else P.weeds(mb, ctx, px, pz, rng, 5, 0.7, { crack: true });
            } else if (zone === ZONE.INDUSTRIAL) {
              if (r < 0.26) poles.push(P.utilityPole(mb, ctx, px, pz, yaw, rng));
              else if (r < 0.40) P.streetLamp(mb, ctx, px, pz, yaw, rng, { lit: rng.chance(0.2), rusty: true });
              else if (r < 0.52) P.barrel(mb, ctx, px, pz, rng.range(0, TAU), rng, { hazard: rng.chance(0.4), toppled: rng.chance(0.3) });
              else if (r < 0.64) P.jerseyBarrier(mb, ctx, px, pz, yaw, rng);
              else if (r < 0.74) P.fireHydrant(mb, ctx, px, pz, yaw, rng, { broken: true });
              else if (r < 0.86) P.junkPile(mb, ctx, px, pz, rng, 1.6);
              else P.weeds(mb, ctx, px, pz, rng, 6, 1.1, { tall: true });
            } else {
              if (r < 0.26) poles.push(P.utilityPole(mb, ctx, px, pz, yaw, rng));
              else if (r < 0.40) P.streetLamp(mb, ctx, px, pz, yaw, rng, { lit: rng.chance(0.22), rusty: decay > 0.5 });
              else if (r < 0.49) P.mailbox(mb, ctx, px, pz, yaw, rng);
              else if (r < 0.57) P.trashCan(mb, ctx, px, pz, yaw, rng, { toppled: rng.chance(0.4) });
              else if (r < 0.64) P.fireHydrant(mb, ctx, px, pz, yaw, rng, { knocked: rng.chance(0.25) });
              else if (r < 0.76) P.tree(mb, ctx, px, pz, rng, { dead: rng.chance(0.35) });
              else if (r < 0.83) P.bench(mb, ctx, px, pz, yaw + Math.PI, rng);
              else P.weeds(mb, ctx, px, pz, rng, 6, 0.9, { tall: rng.chance(0.5) });
            }
          }, lift);
          next = rng.range(zone === ZONE.CORE ? 7 : 11, zone === ZONE.CORE ? 15 : 26);
        }
      }
    }

    // Junction furniture: signals, stop signs, manholes.
    for (const pad of this.surfaces.pads) {
      const node = graph.nodes[pad.node];
      if (pad.degree < 3) {
        if (rng.chance(0.16)) {
          this.onGround(node.x, node.z, (mb, ctx) =>
            P.manhole(mb, ctx, node.x, node.z, rng, { displaced: rng.chance(0.3), glow: rng.chance(0.5) }), ROAD_LIFT + 0.01);
        }
        continue;
      }
      const big = node.edges.some((eid) => ['arterial', 'main'].includes(graph.edges[eid].cls));
      const decay = this.zoning.decayAt(node.x, node.z);
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
        const light = big && rng.chance(0.5);
        const kind = rng.chance(0.4) ? 'stop' : 'road';
        this.onGround(px, pz, (mb, ctx) => {
          if (light) P.trafficLight(mb, ctx, px, pz, yaw, rng);
          else P.streetSign(mb, ctx, px, pz, yaw, rng, { kind, rusty: decay > 0.5 });
        }, SIDEWALK_LIFT);
      }
      if (rng.chance(0.55)) {
        const mx = node.x + rng.range(-2, 2), mz = node.z + rng.range(-2, 2);
        this.onGround(mx, mz, (mb, ctx) =>
          P.manhole(mb, ctx, mx, mz, rng, { displaced: rng.chance(0.35), glow: rng.chance(0.6) }), ROAD_LIFT + 0.01);
      }
    }

    // String the wires between neighbouring poles. Poles now stand at
    // different heights, so the catenary has to be built in world space.
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
      this.store.emit((a.x + b.x) / 2, (a.z + b.z) / 2, (mb) => {
        mb.env = this.env;
        P.powerLine(mb, { lib: this.lib }, a, b, rng);
      });
    }
    this.poles = poles;

    // Abandoned traffic, thickest downtown. Vehicles are placed into discrete
    // slots along the strip and rejected if they would overlap one already
    // placed — random positions along a short strip put cars inside each other
    // — and rejected again if the slot has drifted into a building.
    for (const strip of this.surfaces.strips) {
      if (strip.cls === 'alley' || strip.length < 9) continue;
      const c = polyCentroid(strip.poly);
      const zone = this.zoning.zoneAt(c.x, c.z);
      const density = zone === ZONE.CORE ? 0.75 : zone === ZONE.MIXED ? 0.5 : 0.28;
      if (!rng.chance(density)) continue;
      const slots = Math.max(1, Math.floor(strip.length / 7.5));
      const want = Math.min(slots, rng.int(1, zone === ZONE.CORE ? 3 : 2));
      const order = rng.shuffle([...Array(slots).keys()]);
      for (let i = 0; i < want; i++) {
        const isTruck = rng.chance(0.16) && strip.width > 9.5 && strip.length > 18;
        const half = isTruck ? 5.0 : 2.9;
        const margin = half + 1.0;
        if (strip.length < margin * 2) break;
        const t = (margin + ((order[i] + 0.5) / slots) * (strip.length - margin * 2)) / strip.length;
        const laneMax = strip.width / 2 - 1.4;
        if (laneMax < 0.6) break;
        const lane = rng.sign() * rng.range(0.6, laneMax);
        const px = lerp(strip.a.x, strip.b.x, t) - strip.dir.z * lane;
        const pz = lerp(strip.a.z, strip.b.z, t) + strip.dir.x * lane;
        if (!this.vehicleFits(px, pz, half)) continue;
        if (this.insideAnyBuilding(px, pz, half * 0.5)) continue;
        this.vehicles.push({ x: px, z: pz, r: half });
        const yaw = Math.atan2(strip.dir.x, strip.dir.z) + (rng.chance(0.5) ? 0 : Math.PI) + rng.range(-0.22, 0.22);
        const wrecked = rng.chance(0.45);
        this.onGround(px, pz, (mb, ctx) => {
          if (isTruck) P.truck(mb, ctx, px, pz, yaw, rng);
          else P.car(mb, ctx, px, pz, yaw, rng, { wrecked });
        }, ROAD_LIFT + 0.02);
      }
    }
  }

  /** True if a vehicle of radius `r` at (x,z) clears everything already parked. */
  vehicleFits(x, z, r) {
    for (const v of this.vehicles) {
      if (dist2D(x, z, v.x, v.z) < (r + v.r) * 0.92) return false;
    }
    return true;
  }

  // --- 8. squares, parks, yards --------------------------------------------
  stepOpenSpaces() {
    const { rng } = this;
    for (const block of this.openSpaces) {
      const poly = block.buildable || block.kerb;
      if (!poly) continue;
      const c = block.centroid;
      const kind = block.openKind || 'island';

      if (kind === 'square') {
        // The town square: the landmark that orients the player downtown, and
        // the whole of the first sector's usable open ground.
        this.onGround(c.x, c.z, (mb, ctx) => P.statue(mb, ctx, c.x, c.z, rng.range(0, TAU), rng), LOT_LIFT);
        this.landmarks.push({ name: 'Town Square', x: c.x, z: c.z, y: this.gy(c.x, c.z) + 4, district: 0 });
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * TAU;
          const p = { x: c.x + Math.cos(a) * 7.5, z: c.z + Math.sin(a) * 7.5 };
          if (!pointInPolySimple(poly, p.x, p.z)) continue;
          const lit = rng.chance(0.5);
          this.onGround(p.x, p.z, (mb, ctx) => {
            if (i % 2 === 0) P.bench(mb, ctx, p.x, p.z, a + Math.PI / 2, rng);
            else P.streetLamp(mb, ctx, p.x, p.z, a, rng, { lit, h: 4.4 });
          }, LOT_LIFT);
        }
        // Market stalls: the reason the square exists, still standing.
        for (let i = 0; i < rng.int(3, 6); i++) {
          const p = this.randomInPoly(poly, rng);
          if (!p || dist2D(p.x, p.z, c.x, c.z) < 8) continue;
          const yaw = rng.range(0, TAU);
          this.onGround(p.x, p.z, (mb, ctx) => P.marketStall(mb, ctx, p.x, p.z, yaw, rng), LOT_LIFT);
        }
        for (let i = 0; i < 6; i++) {
          const p = this.randomInPoly(poly, rng);
          if (p && dist2D(p.x, p.z, c.x, c.z) > 9) this.plantTree(p.x, p.z, rng, { h: rng.range(6, 9) });
        }
      } else if (kind === 'park' || kind === 'ballfield') {
        for (let i = 0; i < rng.int(6, 14); i++) {
          const p = this.randomInPoly(poly, rng);
          if (p) this.plantTree(p.x, p.z, rng, { dead: rng.chance(0.25), h: rng.range(5, 10) });
        }
        for (let i = 0; i < rng.int(2, 5); i++) {
          const p = this.randomInPoly(poly, rng);
          if (p) this.onGround(p.x, p.z, (mb, ctx) => P.bench(mb, ctx, p.x, p.z, rng.range(0, TAU), rng), LOT_LIFT);
        }
        for (let i = 0; i < rng.int(6, 14); i++) {
          const p = this.randomInPoly(poly, rng);
          if (p) this.plantBush(p.x, p.z, rng, { dead: rng.chance(0.3) });
        }
        for (let i = 0; i < rng.int(8, 18); i++) {
          const p = this.randomInPoly(poly, rng);
          if (p) this.plantWeeds(p.x, p.z, rng, 5, 1.8, { tall: true });
        }
        if (kind === 'ballfield') {
          const pts = [];
          for (let i = 0; i <= 5; i++) {
            const a = -0.9 + (i / 5) * 1.8;
            pts.push({ x: c.x + Math.cos(a) * 9, z: c.z + Math.sin(a) * 9 });
          }
          this.fenceLine(pts, 'chain', rng, { h: 4.2, rusty: true });
        }
      } else if (kind === 'yard') {
        // Industrial storage yard: stacked containers make a maze arena.
        const per = polyInset(poly, 3);
        if (per) this.fenceLine(per.concat([per[0]]), 'chain', rng, { h: 2.6, rusty: true });
        for (let i = 0; i < rng.int(8, 18); i++) {
          const p = this.randomInPoly(poly, rng);
          if (!p) continue;
          const yaw = rng.chance(0.7) ? Math.round(rng.next() * 4) * (Math.PI / 2) : rng.range(0, TAU);
          const stack = rng.chance(0.35);
          this.onGround(p.x, p.z, (mb, ctx) => {
            P.shippingContainer(mb, ctx, p.x, p.z, yaw, rng);
            if (stack) P.shippingContainer(mb, ctx, p.x, p.z, yaw, rng, { y: 2.59 });
          });
        }
        for (let i = 0; i < rng.int(2, 6); i++) {
          const p = this.randomInPoly(poly, rng);
          if (p) this.onGround(p.x, p.z, (mb, ctx) => P.palletStack(mb, ctx, p.x, p.z, rng.range(0, TAU), rng));
        }
        this.spawns.push({ p: { x: c.x, y: this.gy(c.x, c.z), z: c.z }, kind: 'yard' });
      } else {
        // Traffic islands and leftovers.
        for (let i = 0; i < rng.int(1, 4); i++) {
          const p = this.randomInPoly(poly, rng);
          if (!p) continue;
          if (rng.chance(0.5)) this.plantWeeds(p.x, p.z, rng, 4, 1.0, { tall: true });
          else this.plantBush(p.x, p.z, rng, {});
        }
      }
    }
  }

  // --- 9. landmarks and boundaries ----------------------------------------
  stepLandmarks() {
    const { rng, store, cfg, terrain } = this;
    const B = cfg.bounds;

    // The water tower goes on the highest point of Ashgrove Ridge, because
    // that is where a water tower goes and because it makes the ridge legible
    // from the square. It is the map's primary wayfinder.
    const lf = cfg.landforms.ridge;
    let wtX = (lf.ax + lf.bx) / 2, wtZ = (lf.az + lf.bz) / 2, wtBest = -Infinity;
    for (let t = 0.15; t <= 0.85; t += 0.05) {
      for (let o = -20; o <= 20; o += 10) {
        const x = clamp(lerp(lf.ax, lf.bx, t) + o, B.minX + 30, B.maxX - 30);
        const z = clamp(lerp(lf.az, lf.bz, t), B.minZ + 30, B.maxZ - 30);
        const h = terrain.heightAt(x, z) - terrain.slopeAt(x, z) * 12;
        if (h > wtBest) { wtBest = h; wtX = x; wtZ = z; }
      }
    }
    this.onGround(wtX, wtZ, (mb, ctx) => P.waterTower(mb, ctx, wtX, wtZ, rng));
    this.landmarks.push({ name: 'Water Tower', x: wtX, z: wtZ, y: this.gy(wtX, wtZ) + 22, district: this.districts.districtAt(wtX, wtZ) });

    // Conifers along the ridge: the treeline is what makes the skyline read.
    for (let i = 0; i < 90; i++) {
      const t = rng.next();
      const x = lerp(lf.ax, lf.bx, t) + rng.gauss() * lf.width * 0.9;
      const z = lerp(lf.az, lf.bz, t) + rng.gauss() * 26;
      if (x < B.minX + 6 || x > B.maxX - 6 || z < B.minZ + 6 || z > B.maxZ - 6) continue;
      if (this.insideAnyBuilding(x, z, 3)) continue;
      if (nearestRoad(this.graph, x, z, 12)) continue;
      this.plantTree(x, z, rng, { pine: true, h: rng.range(7, 13) });
    }

    // The Hollow: a worked-out clay pit. Steep on three sides with one shallow
    // ramp, standing water at the bottom, and the plant that dug it still
    // sitting where it stopped. It plays completely differently from the
    // square — no cover, no exits, and everything above you.
    const hl = cfg.landforms.hollow;
    const puddle = this.m('water', 8);
    // The water finds its own level and its own shape. A pond is the set of
    // ground below a waterline, not a square: sample outward on every bearing
    // and stop where the floor climbs back through it. The result hugs the
    // contour of the pit, which is the only way a body of water reads as one.
    const pitFloor = terrain.heightAt(hl.x, hl.z);
    const pondY = pitFloor + 0.3;
    const rim = [];
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * TAU;
      let r = 1.5;
      while (r < hl.radius * 0.9
        && terrain.heightAt(hl.x + Math.cos(a) * r, hl.z + Math.sin(a) * r) < pondY) r += 1.5;
      rim.push({ x: hl.x + Math.cos(a) * r, z: hl.z + Math.sin(a) * r, r, a });
    }
    if (rim.some((p) => p.r > 4)) {
      store.emit(hl.x, hl.z, (mb) => {
        mb.env = this.env;
        mb.polyFlatTess(rim.map((p) => ({ x: p.x, z: p.z })), pondY, puddle, 6);
      });
    }
    // Standing water is a hazard, not a swimming pool: a rim of collision so
    // the pit's one flat piece of ground cannot be crossed straight through.
    for (let i = 0; i < rim.length; i++) {
      const a = rim[i], b = rim[(i + 1) % rim.length];
      if (a.r < 5 || b.r < 5) continue;
      this.collision.addSegment(a.x, a.z, b.x, b.z, pondY - 3, pondY + 1.5, 'water');
    }
    // The shrine goes at the water's edge on the far side from the ramp: dry,
    // but still down in the pit where you have to walk in to find it. Anchored
    // to the pond's own rim rather than to a search for high ground — a
    // shallow flood puts the first dry ground at the top of the bank, and a
    // shrine up among the houses is not a shrine in the Hollow.
    const shrineA = hl.rampAngle + Math.PI;
    let rimR = hl.radius * 0.3;
    for (const p of rim) {
      const d = Math.abs(((p.a - shrineA + Math.PI * 3) % TAU) - Math.PI);
      if (d < 0.35) rimR = p.r;
    }
    let shrineR = Math.min(rimR + 3.5, hl.radius * 0.62);
    // The pit floor is not monotonic — it can rise past the waterline and dip
    // back — so the position is confirmed against the one thing that actually
    // matters rather than inferred from the rim.
    for (let g = 0; g < 12; g++) {
      const px = hl.x + Math.cos(shrineA) * shrineR, pz = hl.z + Math.sin(shrineA) * shrineR;
      if (terrain.heightAt(px, pz) > pondY + 0.35) break;
      shrineR += 2;
    }
    this.hollowShrineAt = {
      x: hl.x + Math.cos(shrineA) * shrineR,
      z: hl.z + Math.sin(shrineA) * shrineR,
    };
    const floorY = pitFloor;
    for (let i = 0; i < 18; i++) {
      const a = rng.range(0, TAU), d = Math.sqrt(rng.next()) * hl.radius * 0.85;
      const x = hl.x + Math.cos(a) * d, z = hl.z + Math.sin(a) * d;
      if (terrain.slopeAt(x, z) > 0.7) continue;
      const r = rng.next();
      this.onGround(x, z, (mb, ctx) => {
        if (r < 0.28) P.junkPile(mb, ctx, x, z, rng, rng.range(1.6, 3.4));
        else if (r < 0.48) P.barrel(mb, ctx, x, z, rng.range(0, TAU), rng, { hazard: rng.chance(0.5), toppled: rng.chance(0.5) });
        else if (r < 0.62) P.palletStack(mb, ctx, x, z, rng.range(0, TAU), rng);
        else if (r < 0.70) P.shippingContainer(mb, ctx, x, z, rng.range(0, TAU), rng);
        else if (r < 0.78) P.jerseyBarrier(mb, ctx, x, z, rng.range(0, TAU), rng);
        else P.weeds(mb, ctx, x, z, rng, 6, 2.0, { tall: true });
      });
    }
    // The digger, at the foot of the ramp, pointing at the face it was cutting.
    const ra = hl.rampAngle;
    const dx = hl.x + Math.cos(ra) * hl.radius * 0.55, dz = hl.z + Math.sin(ra) * hl.radius * 0.55;
    if (!this.insideAnyBuilding(dx, dz, 3.2) && this.vehicleFits(dx, dz, 5)) {
      this.onGround(dx, dz, (mb, ctx) => P.truck(mb, ctx, dx, dz, ra + Math.PI, rng));
      this.vehicles.push({ x: dx, z: dz, r: 5 });
    }
    this.spawns.push({ p: { x: hl.x, y: floorY, z: hl.z }, kind: 'yard' });

    // The rail line along the eastern edge, with ballast, sleepers and rails.
    // The formation is level per span, so on the slope it runs on an
    // embankment, exactly like a real one.
    const railX = cfg.railX;
    const ballast = this.m('ballast', 4);
    const sleeper = this.m('prop_wood_dark', 1.0);
    const rail = this.m('prop_rust', 1.2);
    const embank = this.m('gravel', 4);
    for (let z = B.minZ; z < B.maxZ; z += 22) {
      const formY = Math.max(terrain.heightAt(railX, z), terrain.heightAt(railX, z + 22)) + 0.35;
      store.emit(railX, z + 11, (mb) => {
        mb.env = this.env;
        // Embankment shoulders down to whatever the ground is doing.
        mb.ribbon([{ x: railX - 5, z }, { x: railX - 5, z: z + 22 }],
          (x, zz) => terrain.heightAt(x, zz) - 0.2, () => formY, embank, { segment: 5.5 });
        mb.ribbon([{ x: railX + 5, z: z + 22 }, { x: railX + 5, z }],
          (x, zz) => terrain.heightAt(x, zz) - 0.2, () => formY, embank, { segment: 5.5 });
        mb.quadMat([railX - 5, formY, z + 22], [railX + 5, formY, z + 22],
          [railX + 5, formY, z], [railX - 5, formY, z], ballast, [0, 1, 0],
          { spanU: 10, spanV: 22, maxEdge: 8 });
        for (let s = 0; s < 22; s += 0.72) {
          mb.box(railX - 1.4, formY, z + s, railX + 1.4, formY + 0.14, z + s + 0.28, sleeper, { skip: 'bottom' });
        }
        for (const off of [-0.72, 0.72]) {
          mb.box(railX + off - 0.045, formY + 0.14, z, railX + off + 0.045, formY + 0.26, z + 22, rail, { skip: 'bottom' });
        }
      });
    }
    // Fence the rail off — it is out of bounds.
    const railFenceX = railX - 7.5;
    for (let z = B.minZ; z < B.maxZ; z += 30) {
      this.fenceLine([{ x: railFenceX, z }, { x: railFenceX, z: z + 30 }], 'chain', rng, { h: 2.6, rusty: true });
    }

    // The Ash. The water sits at a fixed level and the channel was carved down
    // to meet it, so the bank line is wherever the terrain crosses it.
    const water = this.m('water', 12);
    const wy = cfg.waterY;
    const rv = cfg.landforms.river;
    for (let x = B.minX - 20; x < Math.min(B.maxX, rv.x1) + 20; x += 24) {
      const cz = terrain.riverAt(x + 12, 0).centreZ;
      store.emit(x + 12, clamp(cz, B.minZ + 2, B.maxZ - 2), (mb) => {
        mb.env = this.env;
        mb.quadMat([x, wy, cz + rv.halfWidth], [x + 24, wy, cz + rv.halfWidth],
          [x + 24, wy, cz - rv.halfWidth], [x, wy, cz - rv.halfWidth], water, [0, 1, 0],
          { spanU: 24, spanV: rv.halfWidth * 2, maxEdge: 12 });
      });
    }
    this.landmarks.push({
      name: 'The Ash', x: (B.minX + rv.x1) / 2,
      z: terrain.riverAt((B.minX + rv.x1) / 2, 0).centreZ, y: wy,
      district: 5,
    });

    // You cannot swim, so the water has to stop you. The bank line is found by
    // walking out from the centre until the ground climbs back through the
    // wading depth, which puts the barrier exactly where the shallows end
    // rather than at some nominal offset — the channel wanders and its banks
    // are not parallel to it.
    const WADE = 1.1;
    for (let x = B.minX - 10; x < Math.min(B.maxX, rv.x1) + 16; x += 5) {
      const cz = terrain.riverAt(x + 2.5, 0).centreZ;
      for (const side of [-1, 1]) {
        const find = (px) => {
          let last = null;
          for (let d = rv.halfWidth * 1.5; d > 0; d -= 1.5) {
            const z = cz + side * d;
            if (terrain.heightAt(px, z) < wy - WADE) return last ?? z;
            last = z;
          }
          return null;
        };
        const a = find(x), b = find(x + 5);
        if (a === null || b === null) continue;
        this.collision.addSegment(x, a, x + 5, b,
          wy - 4, Math.max(this.gy(x, a), this.gy(x + 5, b)) + 3.2, 'water');
      }
    }

    // Perimeter: an impassable wall of collision just inside the map edge,
    // referenced to the ground so it works on the ridge as well as the flat.
    const m = 4;
    const corners = [
      { x: B.minX + m, z: B.minZ + m }, { x: B.maxX - m, z: B.minZ + m },
      { x: B.maxX - m, z: B.maxZ - m }, { x: B.minX + m, z: B.maxZ - m },
    ];
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4];
      const steps = Math.ceil(dist2D(a.x, a.z, b.x, b.z) / 20);
      for (let s = 0; s < steps; s++) {
        const p = { x: lerp(a.x, b.x, s / steps), z: lerp(a.z, b.z, s / steps) };
        const q = { x: lerp(a.x, b.x, (s + 1) / steps), z: lerp(a.z, b.z, (s + 1) / steps) };
        const base = Math.min(this.gy(p.x, p.z), this.gy(q.x, q.z));
        this.collision.addSegment(p.x, p.z, q.x, q.z, base - 6, base + 60, 'bounds');
      }
    }
  }

  // --- 10. the cordon ------------------------------------------------------
  stepCordon() { buildCordon(this); }

  /** A mesh store for one cordon ring in one state ('shut' or 'open'). */
  gateStore(district, state) {
    const key = `${district}:${state}`;
    let s = this.gateStores.get(key);
    if (!s) { s = new ChunkStore(this.probe, { district, state }); this.gateStores.set(key, s); }
    return s;
  }

  // --- 11. secrets ---------------------------------------------------------
  stepSecrets() { placeSecrets(this); }

  // --- 12. finalize --------------------------------------------------------
  stepFinalize() {
    // Start on the pavement by the town square, facing in — and INSIDE the
    // first cordon. The square is chosen as the block nearest the historic
    // crossroads, which on an awkward road layout can be most of the way to
    // the first ring; starting outside it hands the player four sectors on the
    // first frame and makes the whole progression invisible.
    const square = this.landmarks.find((l) => l.name === 'Town Square');
    const o = square && this.districts.districtAt(square.x, square.z) === 0
      ? square : this.cfg.origin;
    let start = null;
    for (let r = 6; r < 64 && !start; r += 3) {
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * TAU;
        const x = o.x + Math.cos(a) * r, z = o.z + Math.sin(a) * r;
        if (this.districts.districtAt(x, z) !== 0) continue;
        const g = this.gy(x, z);
        if (this.terrain.slopeAt(x, z) > 0.4) continue;
        if (!this.collision.isBlocked(x, z, 0.55, g + 0.2, g + 1.9)) { start = { x, z }; break; }
      }
    }
    this.playerStart = start || { x: this.cfg.origin.x, z: this.cfg.origin.z };
    this.playerStart.y = this.gy(this.playerStart.x, this.playerStart.z);
    this.playerYaw = Math.atan2(o.x - this.playerStart.x, o.z - this.playerStart.z);

    // Outdoor spawn points along the streets, for the director. Each one
    // records the sector it is in so the director can refuse to spawn the
    // horde behind a cordon the player has not opened yet.
    const rng = this.rng;
    for (const strip of this.surfaces.strips) {
      if (strip.length < 8) continue;
      if (!rng.chance(0.5)) continue;
      const t = rng.range(0.2, 0.8);
      const x = lerp(strip.a.x, strip.b.x, t), z = lerp(strip.a.z, strip.b.z, t);
      this.spawns.push({
        p: { x, y: this.gy(x, z), z },
        kind: strip.cls === 'alley' ? 'alley' : 'street',
      });
    }
    for (const s of this.spawns) {
      if (s.p) s.district = this.districts.districtAt(s.p.x, s.p.z);
    }
    for (const l of this.loot) {
      if (l.p) l.district = this.districts.districtAt(l.p.x, l.p.z);
    }

    this.stats.chunks = this.store.chunks.size;
    let tris = 0, verts = 0;
    for (const c of this.store.chunks.values()) { tris += c.mb.triCount; verts += c.mb.vertCount; }
    for (const s of this.gateStores.values()) {
      for (const c of s.chunks.values()) { tris += c.mb.triCount; verts += c.mb.vertCount; }
    }
    this.stats.tris = tris;
    this.stats.verts = verts;
    this.stats.buildings = this.buildings.length;
    this.stats.spawns = this.spawns.length;
    this.stats.loot = this.loot.length;
    this.stats.collision = this.collision.stats;
    this.stats.doorways = this.doorways.length;
    this.stats.vehicles = this.vehicles.length;
    this.stats.gates = this.gates.length;
    this.stats.secrets = this.secrets.length;
    this.stats.relief = this.terrain.rangeIn(
      this.cfg.bounds.minX, this.cfg.bounds.minZ, this.cfg.bounds.maxX, this.cfg.bounds.maxZ);
  }

  /** Hand finished chunks to the renderer. */
  uploadChunks(gl, program, createStaticMesh) {
    const out = [];
    const push = (c, tag) => {
      if (c.mb.isEmpty) return;
      const { vertices, indices } = c.mb.toArrays();
      const mesh = createStaticMesh(gl, program, vertices, indices);
      if (!mesh) return;
      if (c.min[1] > c.max[1]) { c.min[1] = 0; c.max[1] = 1; }
      out.push({
        mesh, tag,
        min: [c.min[0] - 1, c.min[1] - 1, c.min[2] - 1],
        max: [c.max[0] + 1, c.max[1] + 1, c.max[2] + 1],
        centre: [(c.min[0] + c.max[0]) / 2, (c.min[1] + c.max[1]) / 2, (c.min[2] + c.max[2]) / 2],
        // A gate's "open" geometry starts hidden; unlocking swaps the pair.
        hidden: !!(tag && tag.state === 'open'),
      });
      c.mb.verts.length = 0;
      c.mb.indices.length = 0;
    };
    for (const c of this.store.chunks.values()) push(c, null);
    for (const s of this.gateStores.values()) {
      for (const c of s.chunks.values()) push(c, s.tag);
    }
    this.chunkMeshes = out;
    return out;
  }

  /**
   * Open the cordon around sector `index`. Called by the progression system
   * when a kill milestone lands; safe to call twice.
   */
  openSector(index) {
    // The collision change comes FIRST and unconditionally. Tying it to the
    // presence of uploaded meshes means the whole progression system silently
    // does nothing anywhere there is no renderer — which is exactly where it
    // is tested.
    const removed = this.collision.disableTag(`cordon${index}gate`);
    let changed = false;
    for (const c of this.chunkMeshes || []) {
      if (!c.tag || c.tag.district !== index) continue;
      const wantHidden = c.tag.state === 'shut';
      if (c.hidden !== wantHidden) { c.hidden = wantHidden; changed = true; }
    }
    return changed || removed > 0;
  }

  /** Put a cordon back. Only used by a restart. */
  closeSector(index) {
    if (this.chunkMeshes) {
      for (const c of this.chunkMeshes) {
        if (!c.tag || c.tag.district !== index) continue;
        c.hidden = c.tag.state === 'open';
      }
    }
    this.collision.enableTag(`cordon${index}gate`);
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

function fpAabb(fp) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const m of fp.masses) {
    for (const c of m.corners) {
      if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x;
      if (c.z < minZ) minZ = c.z; if (c.z > maxZ) maxZ = c.z;
    }
  }
  return { minX, maxX, minZ, maxZ };
}

export { pointInPolySimple, CHUNK, SIDEWALK_LIFT, ROAD_LIFT, LOT_LIFT };
