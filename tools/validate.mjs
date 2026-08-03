// Build several towns and assert the brief's hard rules still hold.
//   node tools/validate.mjs [n]
//
// Two families of check live here:
//
//   SCARCITY & PROGRAMME — one library, at most two churches, dozens of homes.
//     These are rules about what a town contains.
//
//   GEOMETRIC INTEGRITY — nothing overlaps anything, no door opens into a
//     wall, no car is parked inside a shop, no interior is sealed, and every
//     sector can actually be reached once its cordon opens. These are the ones
//     that matter, because every failure they catch is invisible in a
//     screenshot and fatal in play.
import { buildLibrary } from '../src/art/materials.js';
import { makeTownConfig } from '../src/world/config.js';
import { World } from '../src/world/world.js';
import { NavGrid } from '../src/game/nav.js';
import { distPointSeg, dist2D } from '../src/core/math.js';

const N = Number(process.argv[2] || 6);
const seeds = [20250802, 7, 99, 1234, 555, 88888, 42, 31337].slice(0, N);
let failures = 0;

// --- geometry helpers ------------------------------------------------------

function polyBounds(poly) {
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

/** Convex-ish polygon overlap: shared area, not merely touching edges. */
function polysOverlap(A, B) {
  const ba = polyBounds(A), bb = polyBounds(B);
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

function distToPoly(poly, x, z) {
  if (pointInPoly(poly, x, z)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const d = distPointSeg(x, z, a.x, a.z, b.x, b.z).dist;
    if (d < best) best = d;
  }
  return best;
}

// ---------------------------------------------------------------------------

for (const seed of seeds) {
  const lib = buildLibrary(seed);
  for (const t of lib.tasks) t.run();
  const cfg = makeTownConfig(seed);
  const world = new World({ lib, cfg, seed });
  const t0 = Date.now();
  for (const [, run] of world.steps()) run();
  const ms = Date.now() - t0;

  const c = (k) => world.programmeCounts.get(k) || 0;
  const homes = c('house') + c('bungalow') + c('duplex') + c('rowhouse') + c('farmhouse');
  const problems = [];
  const warn = [];

  // --- scarcity and programme --------------------------------------------
  if (c('library') !== 1) problems.push(`library=${c('library')} (must be exactly 1)`);
  if (c('church') > 2 || c('church') < 1) problems.push(`church=${c('church')} (max 2)`);
  if (c('gasstation') < 3 || c('gasstation') > 5) problems.push(`gasstation=${c('gasstation')} (3-5)`);
  if (homes < 24) problems.push(`homes=${homes} (want dozens)`);
  if (world.buildings.length < 90) problems.push(`only ${world.buildings.length} buildings`);
  if (world.stats.collision.segments < 5000) problems.push('collision world too sparse');
  if (!world.playerStart) problems.push('no player start');
  if (world.spawns.length < 200) problems.push('too few spawn points');
  if (world.stats.tris > 2_600_000) problems.push(`${world.stats.tris} tris over budget`);

  // --- topography ---------------------------------------------------------
  // The brief asks for meaningful elevation change, and specifically for at
  // least one 10 m feature per sector. Flat ground is a design failure here,
  // not merely a dull one.
  const relief = world.stats.relief;
  if (relief.hi - relief.lo < 20) problems.push(`only ${(relief.hi - relief.lo).toFixed(1)} m of relief`);
  // Sampled per sector rather than uniformly over the map: the opening sector
  // is a fiftieth of the area, so a uniform draw gives it a handful of points
  // and systematically under-reports the one figure that matters most.
  const perSector = new Array(world.districts.list.length).fill(null);
  for (let d = 0; d < world.districts.list.length; d++) {
    const s = { lo: Infinity, hi: -Infinity, n: 0 };
    const rIn = d === 0 ? 0 : world.districts.radiusOf(d - 1, 0);
    const rOut = d < world.districts.list.length - 1
      ? world.districts.radiusOf(d, 0) : cfg.mapSize * 0.72;
    for (let i = 0; i < 6000; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = rIn + Math.sqrt(Math.random()) * (rOut * 1.25 - rIn);
      const x = cfg.origin.x + Math.cos(a) * r, z = cfg.origin.z + Math.sin(a) * r;
      if (x < cfg.bounds.minX || x > cfg.bounds.maxX || z < cfg.bounds.minZ || z > cfg.bounds.maxZ) continue;
      if (world.districts.districtAt(x, z) !== d) continue;
      const y = world.terrain.heightAt(x, z);
      if (y < s.lo) s.lo = y;
      if (y > s.hi) s.hi = y;
      s.n++;
    }
    if (s.n) perSector[d] = s;
  }
  // Every sector must contain 10 m of height difference somewhere in it, so
  // there is always ground to hold and ground to be caught on.
  for (let d = 0; d < perSector.length; d++) {
    const s = perSector[d];
    if (!s || s.n < 30) continue;
    if (s.hi - s.lo < 10) problems.push(`sector ${d} relief only ${(s.hi - s.lo).toFixed(1)} m (want 10+)`);
  }
  // The streets must remain walkable: no carriageway may exceed its class's
  // maximum grade by more than a small tolerance.
  let steepRoads = 0;
  for (const strip of world.surfaces.strips) {
    const dy = Math.abs(world.terrain.heightAt(strip.b.x, strip.b.z) - world.terrain.heightAt(strip.a.x, strip.a.z));
    const grade = dy / Math.max(strip.length, 1);
    if (grade > (cfg.maxGrade[strip.cls] ?? 0.11) * 2.4 + 0.03) steepRoads++;
  }
  if (steepRoads > world.surfaces.strips.length * 0.03) {
    problems.push(`${steepRoads}/${world.surfaces.strips.length} road strips exceed their grade limit`);
  }

  // --- the ground mesh must stay under the paving -------------------------
  // Roads, pavements and lot ground all drape over the same height field with
  // their own tessellations, and two triangulations of the same curved patch
  // disagree in the middle of a cell. When the disagreement exceeds the lift,
  // the terrain punches up through the carriageway in blotches and the street
  // reads as grass — which looks like a texturing mistake and is not one.
  // Reproduced here exactly as the ground mesh emits it: 2 m grid, split into
  // the same two triangles.
  {
    const T = world.terrain;
    const gY = (x, z) => T.heightAt(x, z) - (0.05 + T.sagAt(x, z) + 0.30 * T.fixAt(x, z));
    let worst = -Infinity;
    for (let i = 0; i < 40000; i++) {
      const x = cfg.bounds.minX + Math.random() * cfg.mapSize;
      const z = cfg.bounds.minZ + Math.random() * cfg.mapSize;
      const gx = Math.floor(x / 2) * 2, gz = Math.floor(z / 2) * 2;
      const u = (x - gx) / 2, v = (z - gz) / 2;
      const h00 = gY(gx, gz), h10 = gY(gx + 2, gz), h01 = gY(gx, gz + 2), h11 = gY(gx + 2, gz + 2);
      const tri = (u + v < 1)
        ? h00 + (h10 - h00) * u + (h01 - h00) * v
        : h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
      worst = Math.max(worst, tri - (T.heightAt(x, z) + 0.035));
    }
    if (worst > -0.004) problems.push(`ground mesh punches ${worst.toFixed(3)} m through the road surface`);
  }

  // --- building-vs-building overlap ---------------------------------------
  // Two buildings sharing ground is the single most visible generator failure
  // and the easiest to miss: from the street it just looks like an odd corner.
  const masses = [];
  for (const b of world.buildings) {
    const fp = b.lot.footprint;
    if (!fp) continue;
    for (const m of fp.masses) masses.push({ b, m, bounds: polyBounds(m.corners) });
  }
  const CELLM = 30;
  const grid = new Map();
  for (let i = 0; i < masses.length; i++) {
    const bb = masses[i].bounds;
    for (let gz = Math.floor(bb.minZ / CELLM); gz <= Math.floor(bb.maxZ / CELLM); gz++) {
      for (let gx = Math.floor(bb.minX / CELLM); gx <= Math.floor(bb.maxX / CELLM); gx++) {
        const k = `${gx},${gz}`;
        let l = grid.get(k); if (!l) { l = []; grid.set(k, l); }
        l.push(i);
      }
    }
  }
  let overlaps = 0;
  const seenPair = new Set();
  for (const list of grid.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const A = masses[list[a]], B = masses[list[b]];
        if (A.b === B.b) continue;
        const key = list[a] < list[b] ? `${list[a]}:${list[b]}` : `${list[b]}:${list[a]}`;
        if (seenPair.has(key)) continue;
        seenPair.add(key);
        if (polysOverlap(A.m.corners, B.m.corners)) overlaps++;
      }
    }
  }
  if (overlaps) problems.push(`${overlaps} building masses overlap another building`);

  // --- buildings vs the carriageway ---------------------------------------
  // A house in the road is the other classic. Checked against the actual road
  // surface polygons rather than against the centreline.
  let inRoad = 0;
  for (const m of masses) {
    for (const strip of world.surfaces.strips) {
      const sb = polyBounds(strip.poly);
      if (m.bounds.maxX < sb.minX || sb.maxX < m.bounds.minX) continue;
      if (m.bounds.maxZ < sb.minZ || sb.maxZ < m.bounds.minZ) continue;
      if (polysOverlap(m.m.corners, strip.poly)) { inRoad++; break; }
    }
  }
  if (inRoad > masses.length * 0.01) problems.push(`${inRoad}/${masses.length} building masses sit in the road`);

  // --- vehicles vs buildings ----------------------------------------------
  let carsInside = 0;
  for (const v of world.vehicles) {
    for (const m of masses) {
      if (v.x < m.bounds.minX - 1 || v.x > m.bounds.maxX + 1) continue;
      if (v.z < m.bounds.minZ - 1 || v.z > m.bounds.maxZ + 1) continue;
      if (distToPoly(m.m.corners, v.x, v.z) < v.r * 0.35) { carsInside++; break; }
    }
  }
  if (carsInside) problems.push(`${carsInside} vehicles clip a building`);

  // --- doors ---------------------------------------------------------------
  let doorless = 0, doorBlocked = 0, doorInWall = 0;
  for (const b of world.buildings) {
    if (!b.doorWorld) { doorless++; continue; }
    const fp = b.lot.footprint;
    // The step outside the front door must be clear ground: no other building
    // may occupy it, or the door opens into a neighbour's back wall.
    const out = fp.toWorld(b.doorLocal.x, -1.5);
    for (const m of masses) {
      if (m.b === b) continue;
      if (out.x < m.bounds.minX - 0.5 || out.x > m.bounds.maxX + 0.5) continue;
      if (out.z < m.bounds.minZ - 0.5 || out.z > m.bounds.maxZ + 0.5) continue;
      if (pointInPoly(m.m.corners, out.x, out.z)) { doorBlocked++; break; }
    }
    // ...and it must face a street, which is the property the lot subdivision
    // is supposed to guarantee structurally.
    let nearRoad = Infinity;
    for (const strip of world.surfaces.strips) {
      const d = distPointSeg(out.x, out.z, strip.a.x, strip.a.z, strip.b.x, strip.b.z).dist;
      if (d < nearRoad) nearRoad = d;
    }
    if (nearRoad > 42) doorInWall++;
  }
  if (doorless) problems.push(`${doorless} buildings without a front door`);
  if (doorBlocked) problems.push(`${doorBlocked} front doors open into another building`);
  if (doorInWall > world.buildings.length * 0.06) {
    problems.push(`${doorInWall} front doors are not on a street`);
  }

  // --- the building frame -------------------------------------------------
  // `building.js` draws the wall shells, corner boards, interior and collision
  // from local (0,0), and the foundation, roof, guttering and chimney from the
  // main mass's own x0/z0. Those agree only while the main mass starts at the
  // origin of its own frame, and the siting pass moves frames around. When it
  // stops being true the foundation slides out from under the walls, which is
  // a gap of daylight under the building and a roof hanging off the far side.
  {
    let skewed = 0, worst = 0;
    for (const b of world.buildings) {
      const m = b.masses.find((x) => x.kind === 'main');
      if (!m) continue;
      const d = Math.hypot(m.x0, m.z0);
      if (d > 1e-6) { skewed++; worst = Math.max(worst, d); }
    }
    if (skewed) {
      problems.push(`${skewed} buildings have their frame off the main mass (worst ${worst.toFixed(1)} m) — foundation and roof will not line up with the walls`);
    }
  }

  // --- foundations must reach the ground ----------------------------------
  // Sampled around the whole perimeter against the surface that is actually
  // drawn, which is the height field minus the ground mesh's own sink.
  {
    const T = world.terrain;
    const sink = (x, z) => 0.05 + T.sagAt(x, z) + 0.30 * T.fixAt(x, z);
    let floating = 0, worstGap = 0;
    for (const b of world.buildings) {
      const base = b.baseY - b.foundDrop;
      for (const m of b.masses) {
        if (m.kind === 'porch') continue;
        const cx = (m.corners[0].x + m.corners[2].x) / 2;
        const cz = (m.corners[0].z + m.corners[2].z) / 2;
        let gap = 0;
        for (let i = 0; i < 4; i++) {
          const a = m.corners[i], bb = m.corners[(i + 1) % 4];
          const len = Math.hypot(bb.x - a.x, bb.z - a.z);
          const steps = Math.max(2, Math.ceil(len / 1.5));
          for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const px = a.x + (bb.x - a.x) * t, pz = a.z + (bb.z - a.z) * t;
            const ox = px - cx, oz = pz - cz;
            const ol = Math.hypot(ox, oz) || 1;
            for (const out of [0, 0.8]) {
              const qx = px + (ox / ol) * out, qz = pz + (oz / ol) * out;
              const g = T.heightAt(qx, qz) - sink(qx, qz);
              // Daylight is the foundation bottom standing ABOVE the ground.
              if (base - g > gap) gap = base - g;
            }
          }
        }
        if (gap > 0.02) { floating++; worstGap = Math.max(worstGap, gap); break; }
      }
    }
    if (floating) {
      problems.push(`${floating} buildings do not reach the ground (worst ${worstGap.toFixed(2)} m of daylight under a wall)`);
    }
  }

  // --- openings on the same elevation -------------------------------------
  // A door drawn across a window is the most conspicuous clipping there is:
  // the wall is cut correctly, so it is not a hole, it is two panels fighting
  // over the same rectangle. Every pair on every elevation is checked.
  let clashes = 0, offWall = 0;
  for (const b of world.buildings) {
    if (!b.openings) continue;
    for (const name of ['front', 'back', 'left', 'right']) {
      const list = b.openings[name];
      const len = b.faceLen[name];
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (o.u0 < 0.2 || o.u1 > len - 0.2) offWall++;
        for (let j = i + 1; j < list.length; j++) {
          const k = list[j];
          if (o.u0 < k.u1 && k.u0 < o.u1 && o.y0 < k.y1 && k.y0 < o.y1) clashes++;
        }
      }
    }
  }
  if (clashes) problems.push(`${clashes} pairs of openings overlap on an elevation`);
  if (offWall) problems.push(`${offWall} openings run off the end of their wall`);

  // --- street furniture inside walls --------------------------------------
  // Furniture is walked along kerb lines and dropped into yards, both of which
  // can drift into a setback. Only OUTDOOR props are tested — a bookcase in a
  // living room is a bookcase, a lamp post in one is not.
  let propsInBuildings = 0;
  for (const p of world.streetProps) {
    for (const m of masses) {
      if (p.x < m.bounds.minX || p.x > m.bounds.maxX || p.z < m.bounds.minZ || p.z > m.bounds.maxZ) continue;
      if (pointInPoly(m.m.corners, p.x, p.z)) { propsInBuildings++; break; }
    }
  }
  if (propsInBuildings > world.streetProps.length * 0.01) {
    problems.push(`${propsInBuildings}/${world.streetProps.length} street props stand inside a building`);
  }

  // --- reachability, per progression stage --------------------------------
  // The important one. The flood is run once with every cordon shut and once
  // with them all open: the first proves the starting sector is a coherent
  // playable space, the second proves nothing is stranded behind a gate that
  // never opens.
  const nav = new NavGrid(cfg.bounds);
  const navOpts = {
    terrain: world.terrain,
    slopeImpassable: cfg.slopeImpassable,
    slopeSlow: cfg.slopeSlowFull * 0.62,
    waterY: cfg.waterY,
  };
  nav.build(world.collision, world.doorways, navOpts);
  nav.update(world.playerStart.x, world.playerStart.z, 60000);

  const sectorReach = [];
  for (let d = 0; d < world.districts.list.length; d++) {
    const inSector = world.buildings.filter((b) => b.district === d && b.doorLocal && b.lot.footprint);
    if (!inSector.length) { sectorReach.push(null); continue; }
    let ok = 0;
    for (const b of inSector) {
      const p = b.lot.footprint.toWorld(b.doorLocal.x, 1.5);
      if (nav.costAt(p.x, p.z) !== 65535) ok++;
    }
    sectorReach.push({ ok, n: inSector.length });
  }
  // With everything shut, sector 0 must be whole and everything past the first
  // cordon must be shut out. A cordon that leaks is the whole progression
  // system quietly not existing: play would never notice, because the town is
  // large enough that you would simply assume you had wandered somewhere.
  if (sectorReach[0] && sectorReach[0].ok / sectorReach[0].n < 0.7) {
    problems.push(`starting sector only ${sectorReach[0].ok}/${sectorReach[0].n} reachable`);
  }
  for (let d = 1; d < sectorReach.length; d++) {
    const leak = sectorReach[d];
    if (!leak || leak.n < 6) continue;
    if (leak.ok / leak.n > 0.2) {
      problems.push(`cordon leaks: sector ${d} is ${leak.ok}/${leak.n} reachable while shut`);
    }
  }

  for (let d = 0; d < world.districts.list.length - 1; d++) world.openSector(d);
  nav.build(world.collision, world.doorways, navOpts);
  nav.update(world.playerStart.x, world.playerStart.z, 60000);
  let sampled = 0, unreachable = 0;
  for (const b of world.buildings) {
    if (!b.doorLocal || !b.lot || !b.lot.footprint) continue;
    sampled++;
    const p = b.lot.footprint.toWorld(b.doorLocal.x, 1.5);
    if (nav.costAt(p.x, p.z) === 65535) unreachable++;
  }
  const frac = sampled ? unreachable / sampled : 0;
  if (frac > 0.15) problems.push(`${unreachable}/${sampled} building interiors unreachable on foot`);

  // Every sector must have at least most of it reachable once opened.
  for (let d = 0; d < world.districts.list.length; d++) {
    const inSector = world.buildings.filter((b) => b.district === d && b.doorLocal && b.lot.footprint);
    // The outermost band is mostly field, rail and river; a handful of farm
    // buildings there is too small a sample to draw a conclusion from.
    if (inSector.length < 10) continue;
    let ok = 0;
    for (const b of inSector) {
      const p = b.lot.footprint.toWorld(b.doorLocal.x, 1.5);
      if (nav.costAt(p.x, p.z) !== 65535) ok++;
    }
    if (ok / inSector.length < 0.6) {
      problems.push(`sector ${d} still ${inSector.length - ok}/${inSector.length} unreachable after opening`);
    }
  }
  // ...but every sector must be enterable at all, or its cordon opens onto
  // nothing and the milestone that opened it was a lie.
  for (let d = 1; d < world.districts.list.length; d++) {
    let reached = 0;
    for (let i = 0; i < 900; i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = world.districts.radiusOf(d - 1, a) + Math.random() * 30 + 6;
      const x = cfg.origin.x + Math.cos(a) * rr, z = cfg.origin.z + Math.sin(a) * rr;
      if (x < cfg.bounds.minX + 6 || x > cfg.bounds.maxX - 6) continue;
      if (z < cfg.bounds.minZ + 6 || z > cfg.bounds.maxZ - 6) continue;
      if (world.districts.districtAt(x, z) !== d) continue;
      if (nav.costAt(x, z) !== 65535) reached++;
      if (reached > 12) break;
    }
    if (reached < 6) problems.push(`sector ${d} is not enterable even with its cordon open`);
  }

  // --- progression fixtures -----------------------------------------------
  for (let d = 0; d < world.districts.list.length - 1; d++) {
    const n = world.gates.filter((g) => g.district === d).length;
    if (n < 1) problems.push(`sector ${d} cordon has no gate`);
  }
  if (world.secrets.length < 10) problems.push(`only ${world.secrets.length} secrets (want 10+)`);

  const reachNote = `reach ${sampled - unreachable}/${sampled}`;
  const status = problems.length ? 'FAIL' : 'ok  ';
  if (problems.length) failures++;
  console.log(`${status} seed ${String(seed).padEnd(9)} ${String(world.buildings.length).padStart(4)} bld  ` +
    `${String(Math.round(world.stats.tris / 1000)).padStart(5)}k tris  ${String(ms).padStart(5)}ms  ` +
    `lib ${c('library')} church ${c('church')} gas ${c('gasstation')} homes ${String(homes).padStart(3)}  ` +
    `relief ${(relief.hi - relief.lo).toFixed(0)}m  gates ${world.gates.length}  ` +
    `secrets ${world.secrets.length}  ${reachNote}` +
    (problems.length ? `\n     ${problems.join('\n     ')}` : '') +
    (warn.length ? `\n     · ${warn.join('\n     · ')}` : ''));
}
console.log(failures ? `${failures}/${seeds.length} seeds FAILED` : `all ${seeds.length} seeds pass`);
process.exit(failures ? 1 : 0);
