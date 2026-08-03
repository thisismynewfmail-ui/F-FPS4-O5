// ---------------------------------------------------------------------------
// plan.js — zoning, lot subdivision and the building programme.
//
// This is where the brief's macro rules are enforced:
//
//  * Zones are concentric and organic, not rectangles: the commercial core sits
//    on the crossroads, residential fills the ring beyond it, industry is
//    banished to the eastern edge against the rail line, and the outermost band
//    is farmland. Zone boundaries are wobbled with noise so nothing reads as a
//    circle.
//  * Lots are cut from real city blocks by recursive splitting along the
//    block's own long axis, so every lot inherits the street's curvature and
//    every buildable lot has street frontage. That single property is what
//    later guarantees front doors face the street.
//  * Building types are drawn from a programme table with hard scarcity caps:
//    exactly one library, at most two places of worship, three to five filling
//    stations, and dozens of houses.
// ---------------------------------------------------------------------------

import {
  RNG, clamp, clamp01, dist2D, distPointSeg, lerp, minAreaRect, polyArea,
  polyCentroid, polyInsetVar, splitPoly, valueNoise, smoothstep,
} from '../core/math.js';
import { classSidewalk, classWidth, nearestRoad } from './roads.js';

// --- zoning ----------------------------------------------------------------

export const ZONE = {
  CORE: 'core',
  MIXED: 'mixed',
  RESIDENTIAL: 'residential',
  INDUSTRIAL: 'industrial',
  RURAL: 'rural',
};

export function makeZoning(cfg) {
  const o = cfg.origin;
  const half = cfg.mapSize / 2;

  /** Wobbled radius so the core is a lobe, never a disc. */
  const wobble = (ang, amp, seed) =>
    1 + (valueNoise(Math.cos(ang) * 2.4 + 8, Math.sin(ang) * 2.4 + 8, seed) - 0.5) * amp;

  return {
    zoneAt(x, z) {
      const dx = x - o.x, dz = z - o.z;
      const d = Math.hypot(dx, dz);
      const ang = Math.atan2(dz, dx);

      // Industry: eastern edge, hard against the rail and the river mouth.
      const indEdge = half * 0.50;
      if (x > indEdge && Math.abs(z - cfg.industrial.z) < half * 0.62) return ZONE.INDUSTRIAL;

      const core = cfg.coreRadius * wobble(ang, 0.46, 11);
      if (d < core) return ZONE.CORE;
      const mixed = cfg.coreRadius * 1.55 * wobble(ang, 0.42, 23);
      if (d < mixed) return ZONE.MIXED;
      const res = half * 0.80 * wobble(ang, 0.34, 37);
      if (d < res) return ZONE.RESIDENTIAL;
      return ZONE.RURAL;
    },

    /**
     * Environmental decay 0..1. The commercial core is maintained; the further
     * out you go the worse it gets. Industry is filthy regardless.
     */
    decayAt(x, z) {
      const d = dist2D(x, z, o.x, o.z);
      let v = smoothstep(clamp01((d - cfg.coreRadius * 0.55) / (half * 0.85)));
      v = 0.10 + v * 0.82;
      const zone = this.zoneAt(x, z);
      if (zone === ZONE.INDUSTRIAL) v = Math.max(v, 0.62);
      if (zone === ZONE.RURAL) v = Math.max(v, 0.70);
      // Local variation so neighbours differ.
      v += (valueNoise(x * 0.012, z * 0.012, 91) - 0.5) * 0.26;
      return clamp01(v);
    },
  };
}

// --- lot subdivision -------------------------------------------------------

/**
 * Cut a block into lots the way a surveyor would.
 *
 * A block deeper than about two lot-depths is first split *along* its長 axis
 * into two rows that back onto each other — that is why terraced streets have
 * back gardens meeting in the middle. Each row is then sliced *across* into
 * individual frontages. Doing it in that order means every lot keeps a street
 * edge, which is what later guarantees front doors face the street.
 *
 * Split positions and angles are jittered so frontage widths vary the way real
 * ones do, and so nothing reads as a grid.
 */
export function subdivideBlock(poly, target, rng, depth = 0, out = []) {
  const rect = minAreaRect(poly);
  if (!rect || depth > 8) { out.push(poly); return out; }

  const longIsU = rect.w >= rect.h;
  const long = longIsU ? rect.w : rect.h;
  const short = longIsU ? rect.h : rect.w;
  // Unit vector along the long axis, and its perpendicular.
  const lx = longIsU ? rect.ux : -rect.uz;
  const lz = longIsU ? rect.uz : rect.ux;
  const sx = -lz, sz = lx;

  const cut = (dirX, dirZ, offX, offZ, span) => {
    const jitter = rng.range(-0.13, 0.13) * span;
    const px = rect.cx + offX * jitter, pz = rect.cz + offZ * jitter;
    const ang = Math.atan2(dirZ, dirX) + rng.range(-0.05, 0.05);
    const [a, b] = splitPoly(poly, px, pz, Math.cos(ang), Math.sin(ang));
    if (!a || !b || polyArea(a) < 24 || polyArea(b) < 24) { out.push(poly); return out; }
    subdivideBlock(a, target, rng, depth + 1, out);
    subdivideBlock(b, target, rng, depth + 1, out);
    return out;
  };

  // Too deep: split into two rows backing onto each other.
  if (short > target.depth * 1.85) return cut(lx, lz, sx, sz, short);
  // Too wide: slice off another frontage.
  if (long > target.width * 1.75) return cut(sx, sz, lx, lz, long);

  if (polyArea(poly) > 20) out.push(poly);
  return out;
}

/** Lot dimensions by zone: [frontage width, depth] in metres. */
const TARGET_LOT = {
  [ZONE.CORE]: { width: 9.5, depth: 19 },
  [ZONE.MIXED]: { width: 12.5, depth: 22 },
  [ZONE.RESIDENTIAL]: { width: 15.5, depth: 26 },
  [ZONE.INDUSTRIAL]: { width: 30, depth: 36 },
  [ZONE.RURAL]: { width: 42, depth: 46 },
};

/**
 * Turn city blocks into lots. Returns lots annotated with their frontage edge,
 * which fixes the orientation of every building placed on them.
 */
export function makeLots(graph, blocks, zoning, cfg, rng) {
  const lots = [];
  const openSpaces = [];

  for (const block of blocks) {
    // Per-edge inset: half the road width plus that road's pavement.
    const dists = block.pts.map((_, i) => {
      const e = graph.edges[block.edgeRefs[i]];
      if (!e || e.cls === 'boundary') return 3.0;
      return classWidth(e.cls) / 2 + classSidewalk(e.cls);
    });
    const buildable = polyInsetVar(block.pts, dists);
    block.buildable = buildable;
    block.zone = zoning.zoneAt(block.centroid.x, block.centroid.z);

    // The kerb line, used for pavement geometry.
    block.kerb = polyInsetVar(block.pts, block.pts.map((_, i) => {
      const e = graph.edges[block.edgeRefs[i]];
      if (!e || e.cls === 'boundary') return 0.4;
      return classWidth(e.cls) / 2;
    }));

    if (!buildable || polyArea(buildable) < 60) {
      block.kind = 'island';
      openSpaces.push(block);
      continue;
    }

    const zone = block.zone;
    const bArea = polyArea(buildable);

    // Some blocks are never built on: the square, parks, the depot yard.
    if (block.forceOpen) {
      block.kind = 'open';
      openSpaces.push(block);
      continue;
    }

    const base = TARGET_LOT[zone];
    const target = {
      width: base.width * rng.range(0.85, 1.2),
      depth: base.depth * rng.range(0.85, 1.2),
    };
    const pieces = subdivideBlock(buildable, target, rng);

    for (const piece of pieces) {
      const area = polyArea(piece);
      if (area < 42) continue;
      const centroid = polyCentroid(piece);

      // Frontage: the lot edge that lies on the block's outer boundary and is
      // closest to an actual road. Interior pieces get no frontage and become
      // yards, car parks or garden plots instead of buildings.
      let front = null;
      for (let i = 0; i < piece.length; i++) {
        const a = piece[i], b = piece[(i + 1) % piece.length];
        const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len < 3.2) continue;
        let onBoundary = Infinity;
        for (let k = 0; k < buildable.length; k++) {
          const p = buildable[k], q = buildable[(k + 1) % buildable.length];
          onBoundary = Math.min(onBoundary, distPointSeg(mx, mz, p.x, p.z, q.x, q.z).dist);
        }
        if (onBoundary > 1.2) continue;
        const road = nearestRoad(graph, mx, mz, 70);
        if (!road) continue;
        const score = len * 1.0 - road.dist * 1.6;
        if (!front || score > front.score) {
          front = {
            score, i, len, a, b, mid: { x: mx, z: mz },
            roadDist: road.dist, roadClass: road.cls,
            // Outward normal (toward the street) for a CCW polygon.
            nx: (b.z - a.z) / len, nz: -(b.x - a.x) / len,
          };
        }
      }

      const lot = {
        poly: piece, area, centroid, zone,
        block, front,
        decay: zoning.decayAt(centroid.x, centroid.z),
        distToCentre: dist2D(centroid.x, centroid.z, cfg.origin.x, cfg.origin.z),
      };
      if (front) {
        // Point the normal at the street, not away from it.
        const road = nearestRoad(graph, front.mid.x, front.mid.z, 70);
        if (road) {
          const toRoad = { x: road.x - front.mid.x, z: road.z - front.mid.z };
          if (toRoad.x * front.nx + toRoad.z * front.nz < 0) { front.nx *= -1; front.nz *= -1; }
        }
        lot.facing = Math.atan2(front.nz, front.nx);
        lots.push(lot);
      } else {
        lot.kind = 'yard';
        lots.push(lot);
      }
    }
    block.kind = 'built';
  }
  return { lots, openSpaces };
}

// --- the building programme ------------------------------------------------
//
// `count` caps enforce the brief's scarcity rules. `weight` drives the filler
// draw once the capped buildings are placed.

export const PROGRAMME = [
  // --- civic & rare: hard caps
  { type: 'library', label: 'Public Library', zones: [ZONE.CORE, ZONE.MIXED], max: 1, min: 1, minArea: 320, minFront: 17, storeys: 2, landmark: true, priority: 10 },
  { type: 'church', label: 'Church', zones: [ZONE.CORE, ZONE.MIXED, ZONE.RESIDENTIAL], max: 2, min: 1, minArea: 300, minFront: 16, storeys: 1, landmark: true, priority: 10, spread: 150 },
  { type: 'townhall', label: 'Town Hall', zones: [ZONE.CORE], max: 1, min: 1, minArea: 300, minFront: 17, storeys: 2, landmark: true, priority: 9 },
  { type: 'school', label: 'Elementary School', zones: [ZONE.MIXED, ZONE.RESIDENTIAL], max: 1, min: 1, minArea: 420, minFront: 20, storeys: 2, priority: 9 },
  { type: 'clinic', label: 'Medical Clinic', zones: [ZONE.CORE, ZONE.MIXED], max: 1, min: 1, minArea: 220, minFront: 13, storeys: 2, priority: 8 },
  { type: 'police', label: 'Police Station', zones: [ZONE.CORE, ZONE.MIXED], max: 1, min: 1, minArea: 210, minFront: 13, storeys: 1, priority: 8 },
  { type: 'firehouse', label: 'Fire Station', zones: [ZONE.MIXED, ZONE.CORE], max: 1, min: 1, minArea: 230, minFront: 15, storeys: 1, priority: 8 },
  { type: 'supermarket', label: 'Supermarket', zones: [ZONE.MIXED, ZONE.CORE], max: 1, min: 1, minArea: 460, minFront: 20, storeys: 1, priority: 8 },
  { type: 'gasstation', label: 'Filling Station', zones: [ZONE.MIXED, ZONE.RESIDENTIAL, ZONE.INDUSTRIAL], max: 4, min: 3, minArea: 240, minFront: 17, storeys: 1, priority: 9, spread: 110, roadClasses: ['arterial', 'main', 'street'] },
  { type: 'motel', label: 'Motel', zones: [ZONE.MIXED, ZONE.RESIDENTIAL], max: 1, min: 0, minArea: 340, minFront: 18, storeys: 2, priority: 6 },
  { type: 'cinema', label: 'Cinema', zones: [ZONE.CORE], max: 1, min: 0, minArea: 300, minFront: 15, storeys: 2, priority: 6 },
  { type: 'bank', label: 'Savings Bank', zones: [ZONE.CORE], max: 1, min: 1, minArea: 180, minFront: 11, storeys: 2, priority: 7 },

  // --- commercial filler
  { type: 'shop', label: 'Storefront', zones: [ZONE.CORE, ZONE.MIXED], weight: 30, minArea: 85, minFront: 6.5, storeys: [2, 3] },
  { type: 'diner', label: 'Diner', zones: [ZONE.CORE, ZONE.MIXED], weight: 7, max: 3, minArea: 120, minFront: 9, storeys: 1 },
  { type: 'bar', label: 'Tavern', zones: [ZONE.CORE, ZONE.MIXED], weight: 6, max: 3, minArea: 110, minFront: 8, storeys: 2 },
  { type: 'office', label: 'Offices', zones: [ZONE.CORE], weight: 16, minArea: 115, minFront: 8.5, storeys: [3, 5] },
  { type: 'apartment', label: 'Apartments', zones: [ZONE.CORE, ZONE.MIXED], weight: 18, minArea: 135, minFront: 9, storeys: [3, 4] },
  { type: 'hardware', label: 'Hardware Store', zones: [ZONE.MIXED], weight: 5, max: 2, minArea: 150, minFront: 10, storeys: 1 },
  { type: 'pharmacy', label: 'Pharmacy', zones: [ZONE.CORE, ZONE.MIXED], weight: 4, max: 2, minArea: 120, minFront: 9, storeys: 1 },
  { type: 'laundromat', label: 'Laundromat', zones: [ZONE.MIXED], weight: 4, max: 2, minArea: 100, minFront: 8, storeys: 1 },

  // --- residential filler: the bulk of the map
  { type: 'house', label: 'House', zones: [ZONE.RESIDENTIAL, ZONE.MIXED], weight: 100, minArea: 95, minFront: 8, storeys: [1, 2] },
  { type: 'bungalow', label: 'Bungalow', zones: [ZONE.RESIDENTIAL], weight: 34, minArea: 85, minFront: 8, storeys: 1 },
  { type: 'duplex', label: 'Duplex', zones: [ZONE.RESIDENTIAL, ZONE.MIXED], weight: 20, minArea: 130, minFront: 11, storeys: 2 },
  { type: 'rowhouse', label: 'Row House', zones: [ZONE.MIXED], weight: 16, minArea: 80, minFront: 6, storeys: [2, 3] },

  // --- industrial
  { type: 'warehouse', label: 'Warehouse', zones: [ZONE.INDUSTRIAL], weight: 24, minArea: 380, minFront: 16, storeys: 1 },
  { type: 'factory', label: 'Works', zones: [ZONE.INDUSTRIAL], weight: 14, minArea: 520, minFront: 20, storeys: 1 },
  { type: 'workshop', label: 'Workshop', zones: [ZONE.INDUSTRIAL], weight: 16, minArea: 180, minFront: 11, storeys: 1 },
  { type: 'depot', label: 'Depot Office', zones: [ZONE.INDUSTRIAL], weight: 8, minArea: 140, minFront: 10, storeys: 2 },

  // --- rural
  { type: 'farmhouse', label: 'Farmhouse', zones: [ZONE.RURAL], weight: 10, minArea: 130, minFront: 9, storeys: 2 },
  { type: 'barn', label: 'Barn', zones: [ZONE.RURAL], weight: 10, minArea: 200, minFront: 12, storeys: 1 },
  { type: 'shed', label: 'Outbuilding', zones: [ZONE.RURAL, ZONE.RESIDENTIAL], weight: 8, minArea: 60, minFront: 6, storeys: 1 },
];

function lotFrontLength(lot) { return lot.front ? lot.front.len : 0; }

function fits(prog, lot) {
  if (!lot.front) return false;
  if (!prog.zones.includes(lot.zone)) return false;
  if (lot.area < prog.minArea) return false;
  if (lotFrontLength(lot) < prog.minFront) return false;
  if (prog.roadClasses && !prog.roadClasses.includes(lot.front.roadClass)) return false;
  return true;
}

/**
 * Assign a building type to every lot with frontage.
 *
 * Capped civic buildings are placed first on the lots that suit them best
 * (biggest frontage, right zone, far enough from an existing one of the same
 * type). Everything else is drawn by weight. Scarcity is therefore guaranteed
 * rather than hoped for.
 */
export function assignProgramme(lots, cfg, rng) {
  const buildable = lots.filter((l) => l.front && l.area >= 55);
  const placed = new Map();
  const results = [];
  const taken = new Set();

  const capped = PROGRAMME.filter((p) => p.max !== undefined)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  /**
   * Find the best free lot for a programme. `relax` (0..2) progressively drops
   * the siting constraints so hard minimums — three filling stations, exactly
   * one library — are met even on an awkward road layout.
   */
  const bestLotFor = (prog, positions, relax) => {
    const minArea = prog.minArea * (relax >= 2 ? 0.55 : relax >= 1 ? 0.78 : 1);
    const minFront = prog.minFront * (relax >= 2 ? 0.6 : relax >= 1 ? 0.8 : 1);
    let best = null;
    for (const lot of buildable) {
      if (taken.has(lot)) continue;
      if (!prog.zones.includes(lot.zone) && relax < 2) continue;
      if (lot.area < minArea) continue;
      if (lotFrontLength(lot) < minFront) continue;
      if (relax < 1 && prog.roadClasses && !prog.roadClasses.includes(lot.front.roadClass)) continue;
      if (prog.spread) {
        const spread = prog.spread * (relax >= 2 ? 0.35 : relax >= 1 ? 0.6 : 1);
        let tooClose = false;
        for (const p of positions) {
          if (dist2D(p.x, p.z, lot.centroid.x, lot.centroid.z) < spread) { tooClose = true; break; }
        }
        if (tooClose) continue;
      }
      // Prefer prominent lots: wide frontage on a big road, near the centre for
      // civic buildings.
      const roadBonus = lot.front.roadClass === 'arterial' ? 22
        : lot.front.roadClass === 'main' ? 14 : lot.front.roadClass === 'street' ? 6 : 0;
      const centreBias = prog.landmark ? -lot.distToCentre * 0.09 : 0;
      const score = lot.front.len * 1.4 + lot.area * 0.03 + roadBonus + centreBias + rng.range(0, 9);
      if (!best || score > best.score) best = { score, lot };
    }
    return best;
  };

  for (const prog of capped) {
    const want = prog.min !== undefined && prog.max !== undefined
      ? rng.int(prog.min, prog.max)
      : prog.max;
    const need = prog.min ?? 0;
    const positions = [];
    let count = 0;
    for (let k = 0; k < want; k++) {
      let best = bestLotFor(prog, positions, 0);
      // Only relax while we are still short of the required minimum.
      for (let relax = 1; !best && count < need && relax <= 2; relax++) {
        best = bestLotFor(prog, positions, relax);
      }
      if (!best) break;
      taken.add(best.lot);
      best.lot.programme = prog;
      positions.push(best.lot.centroid);
      results.push(best.lot);
      count++;
      placed.set(prog.type, count);
    }
  }

  // Weighted filler for everything else.
  const fillers = PROGRAMME.filter((p) => p.weight);
  for (const lot of buildable) {
    if (taken.has(lot)) continue;
    const options = [];
    for (const p of fillers) {
      if (!fits(p, lot)) continue;
      if (p.max !== undefined && (placed.get(p.type) || 0) >= p.max) continue;
      let w = p.weight;
      // Storefronts want the busiest streets; houses want the quiet ones.
      if (p.type === 'shop' || p.type === 'office' || p.type === 'apartment') {
        w *= lot.front.roadClass === 'arterial' ? 2.2 : lot.front.roadClass === 'main' ? 1.7 : 0.7;
      }
      if (p.type === 'house' || p.type === 'bungalow') {
        w *= lot.front.roadClass === 'lane' ? 1.9 : lot.front.roadClass === 'street' ? 1.3 : 0.55;
      }
      options.push([p, w]);
    }
    if (!options.length) { lot.kind = 'yard'; continue; }
    const prog = rng.weighted(options);
    lot.programme = prog;
    placed.set(prog.type, (placed.get(prog.type) || 0) + 1);
    results.push(lot);
    taken.add(lot);
  }

  return { assigned: results, counts: placed };
}

/**
 * Choose the block that becomes the town square, plus a few parks. Called
 * before lot subdivision so those blocks are never built on.
 */
export function chooseOpenSpaces(blocks, cfg, rng, zoning) {
  const o = cfg.origin;
  const scored = blocks.map((b) => ({
    b,
    d: dist2D(b.centroid.x, b.centroid.z, o.x, o.z),
    zone: zoning.zoneAt(b.centroid.x, b.centroid.z),
  }));

  // The square: a modest block right on the crossroads. It has to sit well
  // inside the first cordon, because the first cordon is the whole of the
  // opening sector and the square is what the player is given to stand on.
  const inner = (cfg.districts ? cfg.districts[0].radius : 0.245) * (cfg.mapSize / 2) * 0.62;
  const squareCandidates = scored
    .filter((s) => s.b.area > 900 && s.b.area < 7000)
    .sort((a, b) => a.d - b.d);
  const square = squareCandidates.find((s) => s.d < inner) || squareCandidates[0];
  if (square) {
    square.b.forceOpen = true;
    square.b.openKind = 'square';
  }

  // Two or three parks, spread out, in the residential ring.
  const parkCandidates = scored
    .filter((s) => s.b.area > 2200 && s.d > cfg.coreRadius && s.zone !== ZONE.INDUSTRIAL && !s.b.forceOpen)
    .sort((a, b) => b.b.area - a.b.area);
  const parks = [];
  for (const c of parkCandidates) {
    if (parks.length >= (cfg.parks ?? 3)) break;
    if (parks.some((p) => dist2D(p.centroid.x, p.centroid.z, c.b.centroid.x, c.b.centroid.z) < 130)) continue;
    c.b.forceOpen = true;
    c.b.openKind = rng.chance(0.35) ? 'ballfield' : 'park';
    parks.push(c.b);
  }

  // One yard in the industrial belt for stacked containers and trucks.
  const yard = scored
    .filter((s) => s.zone === ZONE.INDUSTRIAL && s.b.area > 3000 && !s.b.forceOpen)
    .sort((a, b) => b.b.area - a.b.area)[0];
  if (yard) { yard.b.forceOpen = true; yard.b.openKind = 'yard'; }

  return blocks.filter((b) => b.forceOpen);
}
