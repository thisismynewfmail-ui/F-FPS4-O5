// ---------------------------------------------------------------------------
// terrain.js — the ground the town is built on.
//
// Flat ground kills a first-person shooter: it removes every reason to choose
// one route over another, and it makes a crowd of infected read as a single
// silhouette at one height. So the whole map is a heightfield, and the
// heightfield is authored for play rather than for realism alone:
//
//   * ASHGROVE RIDGE, a long spine on the eastern side. The water tower stands
//     on it, which makes it the map's primary wayfinder and its best firing
//     position — and the most exposed place to be caught standing.
//   * BEACON HILL in the north-west, a rounded dome the residential terraces
//     climb. Streets switch back across it, so a chase up the hill is slow and
//     a retreat down it is fast and dangerous.
//   * THE HOLLOW, a flooded clay pit near the mixed fringe. Steep on three
//     sides, one shallow ramp in: cover from rifle fire, a trap if you take it.
//   * THE ASH, the river cutting the south-west. It is the hard southern edge
//     of the map until the bridge comes down.
//   * Rolling low-frequency noise everywhere else, so no street is level for
//     more than a block.
//
// The field is built in stamped passes rather than as one closed-form
// function, because roads and building pads have to *conform*: a carriageway
// cannot follow raw noise or it becomes a rollercoaster, and a building cannot
// sit on a slope or its foundation floats. The passes are:
//
//   1. base landforms + fractal noise
//   2. road corridors, after the node heights have been grade-limited
//   3. building pads, keyed to the road they front onto
//   4. relaxation of everything that was not stamped, so cut and fill blend
//
// Everything downstream — mesh emission, collision, navigation, prop placement
// — samples the one function `heightAt`, so nothing can disagree about where
// the ground is.
// ---------------------------------------------------------------------------

import {
  clamp, clamp01, lerp, smoothstep, fbm, valueNoise, distPointSeg,
} from '../core/math.js';

const CELL = 4;                 // metres per heightfield sample
const ROAD_FEATHER = 11;        // how far cut/fill spreads either side of a road
const PAD_FEATHER = 3.2;        // how far a building pad blends into the ground

export class Terrain {
  constructor(cfg) {
    const B = cfg.bounds;
    this.cfg = cfg;
    this.cell = CELL;
    // The field origin is snapped to a multiple of the cell size, because the
    // mesh that draws the ground is grid-clipped on world-aligned lines. If
    // the two grids are out of phase, every ground vertex lands in the middle
    // of a field cell and samples the curved part of the bilinear patch, and
    // the ground surface no longer agrees with the height function that
    // everything else — roads, pavements, collision — is placed by. In phase,
    // every other vertex is an exact field sample.
    this.minX = Math.floor((B.minX - CELL * 2) / CELL) * CELL;
    this.minZ = Math.floor((B.minZ - CELL * 2) / CELL) * CELL;
    this.w = Math.ceil((B.maxX - this.minX) / CELL) + 3;
    this.h = Math.ceil((B.maxZ - this.minZ) / CELL) + 3;
    this.y = new Float32Array(this.w * this.h);
    this.fix = new Float32Array(this.w * this.h);   // 0 free .. 1 fully stamped
    this.lf = cfg.landforms;
    this.waterY = cfg.waterY;
  }

  idx(ix, iz) { return iz * this.w + ix; }
  wx(ix) { return this.minX + ix * CELL; }
  wz(iz) { return this.minZ + iz * CELL; }

  // --- pass 1: the landforms ------------------------------------------------

  /**
   * The shape of the valley before anyone built in it. Kept as its own method
   * so the road pass can ask "what was here originally?" while stamping.
   */
  baseAt(x, z) {
    const lf = this.lf;
    const s = this.cfg.seed;

    // Rolling ground: two octaves of low-frequency noise plus a finer ripple.
    let y = (fbm(x * 0.0035 + 11, z * 0.0035 + 7, 3, s ^ 0x51ce) - 0.5) * 11.5;
    y += (valueNoise(x * 0.0125 + 31, z * 0.0125 + 19, s ^ 0x2b7f) - 0.5) * 2.6;

    // Ashgrove Ridge — a spine, not a cone: distance to a line segment.
    const r = lf.ridge;
    const rd = distPointSeg(x, z, r.ax, r.az, r.bx, r.bz).dist;
    y += r.height * Math.exp(-(rd * rd) / (2 * r.width * r.width));
    // A scarp on the town side so the ridge reads as an edge, not a bump.
    const scarp = clamp01((r.width * 1.35 - rd) / (r.width * 0.5));
    y += r.height * 0.16 * smoothstep(scarp) * (x < (r.ax + r.bx) / 2 ? 1 : 0.2);

    // Beacon Hill — a dome with a noise-broken skirt.
    const hdx = x - lf.hill.x, hdz = z - lf.hill.z;
    const hd = Math.hypot(hdx, hdz) / lf.hill.radius;
    if (hd < 1.6) {
      const wob = 1 + (valueNoise(x * 0.006 + 3, z * 0.006 + 3, s ^ 0x77aa) - 0.5) * 0.5;
      y += lf.hill.height * Math.pow(clamp01(1 - hd / wob), 1.7);
    }

    // The Hollow — a clay pit. Steep walls, one shallow ramp on its west side.
    const qdx = x - lf.hollow.x, qdz = z - lf.hollow.z;
    const qd = Math.hypot(qdx, qdz) / lf.hollow.radius;
    if (qd < 1.25) {
      const ramp = clamp01((Math.atan2(qdz, qdx) - lf.hollow.rampAngle + Math.PI * 3) % (Math.PI * 2) - Math.PI);
      const rampEase = smoothstep(clamp01(1 - Math.abs(ramp) / 0.62));
      y -= lf.hollow.depth * smoothstep(clamp01(1 - qd)) * (1 - rampEase * 0.86);
    }

    // The Ash — a river valley carved toward the south-west corner.
    const rv = this.riverAt(x, z);
    if (rv.t < 1) {
      // Channel floor, then banks that rise out of it.
      const cut = lf.river.depth * (1 - smoothstep(rv.t));
      y -= cut;
      y += lf.river.berm * smoothstep(clamp01((rv.t - 0.55) / 0.45)) * smoothstep(clamp01((1.35 - rv.t) / 0.35));
    }

    // The historic crossroads sits in the flattest ground in the valley —
    // that is *why* the town is there. The core is pulled toward its own datum
    // but not flattened onto it: the opening sector is small, and if it were
    // level there would be nowhere in it to stand above anything, which is the
    // one thing the first five hundred kills most need.
    const o = this.cfg.origin;
    const dc = Math.hypot(x - o.x, z - o.z);
    const settle = smoothstep(clamp01(1 - dc / (this.cfg.coreRadius * 1.55)));
    y = lerp(y, y * 0.42 + lf.coreDatum * 0.58, settle * 0.74);

    // Field-scale roll, coming in as the graded town gives way to country.
    // Long, low ridges and hollows at a wavelength of a few hundred metres.
    //
    // It ramps in from just outside the core rather than only at the map edge
    // because the sectors are concentric BANDS: the outer ones are only twenty
    // or thirty metres deep, so whatever variation they have has to come from
    // something that changes over their circumference rather than across their
    // width. Without this, a band can quite easily land entirely on one flank
    // of one hill and be the one flat sector in the game.
    const half = this.cfg.mapSize / 2;
    const outer = smoothstep(clamp01((dc - half * 0.30) / (half * 0.55)));
    y += (fbm(x * 0.0026 + 41, z * 0.0026 + 17, 3, s ^ 0x3311) - 0.5) * 19 * outer;

    return y;
  }

  /**
   * Normalised distance to the river centreline: 0 mid-channel, 1 at the top
   * of the bank. Also returns the centreline point, which the bridge builder
   * needs.
   */
  riverAt(x, z) {
    const rv = this.lf.river;
    // Centreline is a shallow arc across the south-west.
    const t = clamp01((x - rv.x0) / (rv.x1 - rv.x0));
    const cz = lerp(rv.z0, rv.z1, t) + Math.sin(t * 2.4 + rv.phase) * rv.wobble;
    const d = Math.abs(z - cz);
    return { t: d / rv.halfWidth, d, centreZ: cz };
  }

  // --- pass 1 driver --------------------------------------------------------

  buildBase() {
    for (let iz = 0; iz < this.h; iz++) {
      const z = this.wz(iz);
      for (let ix = 0; ix < this.w; ix++) {
        this.y[this.idx(ix, iz)] = this.baseAt(this.wx(ix), z);
      }
    }
  }

  // --- pass 2: roads --------------------------------------------------------

  /**
   * Give every junction an elevation, then relax it until no carriageway
   * exceeds its class's maximum grade. Without this a street laid straight
   * over Beacon Hill would hit 30% and be unwalkable; with it the streets
   * switch back and cut into the slope the way real hill towns do.
   */
  levelRoadNetwork(graph, maxGradeFor) {
    const nodeY = new Float64Array(graph.nodes.length);
    const live = [];
    for (const n of graph.nodes) {
      if (n.merged !== undefined) continue;
      nodeY[n.id] = this.baseAt(n.x, n.z);
      if (n.edges.length) live.push(n.id);
    }

    const edges = graph.liveEdges().filter((e) => e.cls !== 'boundary');
    const lens = edges.map((e) => {
      const a = graph.nodes[e.a], b = graph.nodes[e.b];
      return Math.max(1, Math.hypot(b.x - a.x, b.z - a.z));
    });

    for (let iter = 0; iter < 90; iter++) {
      let worst = 0;
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const len = lens[i];
        const max = maxGradeFor(e.cls) * len;
        let d = nodeY[e.b] - nodeY[e.a];
        const over = Math.abs(d) - max;
        if (over <= 0) continue;
        worst = Math.max(worst, over);
        // Move both ends halfway toward legality; convergence is fast because
        // every correction is local and the graph is sparse.
        const fix = Math.sign(d) * over * 0.5 * 0.62;
        nodeY[e.b] -= fix;
        nodeY[e.a] += fix;
      }
      if (worst < 0.02) break;
    }
    this.nodeY = nodeY;
    return nodeY;
  }

  /**
   * Stamp one road corridor: flat across the carriageway, feathered outward.
   *
   * The stamp is suppressed inside the river channel. Without that, any road
   * that happens to cross the Ash quietly fills it in with a causeway and the
   * river stops being a barrier — and stops being the thing the last bridge is
   * for. Suppressed, the channel stays open and the crossing has to be a
   * bridge, which is what `buildRiverCrossings` then builds over the gap.
   */
  stampCorridor(ax, az, ay, bx, bz, by, halfWidth) {
    const pad = halfWidth + ROAD_FEATHER;
    const minIX = this.clampIX(Math.min(ax, bx) - pad);
    const maxIX = this.clampIX(Math.max(ax, bx) + pad);
    const minIZ = this.clampIZ(Math.min(az, bz) - pad);
    const maxIZ = this.clampIZ(Math.max(az, bz) + pad);
    for (let iz = minIZ; iz <= maxIZ; iz++) {
      const z = this.wz(iz);
      for (let ix = minIX; ix <= maxIX; ix++) {
        const x = this.wx(ix);
        const r = distPointSeg(x, z, ax, az, bx, bz);
        if (r.dist > pad) continue;
        const t = r.t !== undefined ? r.t : 0;
        const roadY = lerp(ay, by, clamp01(t));
        let w = r.dist <= halfWidth ? 1 : smoothstep(clamp01(1 - (r.dist - halfWidth) / ROAD_FEATHER));
        w *= smoothstep(clamp01((this.riverAt(x, z).t - 0.30) / 0.45));
        if (w <= 0.001) continue;
        // Where two corridors overlap the shared junction height wins, because
        // both corridors interpolate to the same node elevation there.
        const i = this.idx(ix, iz);
        this.y[i] = lerp(this.y[i], roadY, w);
        if (w > this.fix[i]) this.fix[i] = w;
      }
    }
  }

  stampRoads(graph, halfWidthFor) {
    const nodeY = this.nodeY;
    for (const e of graph.liveEdges()) {
      if (e.cls === 'boundary') continue;
      const a = graph.nodes[e.a], b = graph.nodes[e.b];
      this.stampCorridor(a.x, a.z, nodeY[a.id], b.x, b.z, nodeY[b.id], halfWidthFor(e.cls) + 1.2);
    }
  }

  // --- pass 3: building pads ------------------------------------------------

  /**
   * Flatten the ground under a footprint to a single level. Buildings sit on a
   * pad because a house on a 6% slope has either a floating corner or a
   * basement, and the collision world only knows about horizontal floors.
   */
  stampPad(poly, padY, feather = PAD_FEATHER) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of poly) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
    const minIX = this.clampIX(minX - feather), maxIX = this.clampIX(maxX + feather);
    const minIZ = this.clampIZ(minZ - feather), maxIZ = this.clampIZ(maxZ + feather);
    for (let iz = minIZ; iz <= maxIZ; iz++) {
      const z = this.wz(iz);
      for (let ix = minIX; ix <= maxIX; ix++) {
        const x = this.wx(ix);
        const d = polyDistance(poly, x, z);
        if (d > feather) continue;
        const w = d <= 0 ? 1 : smoothstep(clamp01(1 - d / feather)) * 0.92;
        const i = this.idx(ix, iz);
        this.y[i] = lerp(this.y[i], padY, w);
        if (w > this.fix[i]) this.fix[i] = w;
      }
    }
  }

  // --- pass 4: relaxation ---------------------------------------------------

  /**
   * Smooth the unstamped ground so cut and fill blend into the landform
   * instead of terracing. Stamped cells hold their value in proportion to how
   * hard they were stamped, which is what produces embankments beside a road
   * on a slope.
   */
  relax(iterations = 3) {
    const tmp = new Float32Array(this.y.length);
    for (let k = 0; k < iterations; k++) {
      tmp.set(this.y);
      for (let iz = 1; iz < this.h - 1; iz++) {
        for (let ix = 1; ix < this.w - 1; ix++) {
          const i = this.idx(ix, iz);
          const f = this.fix[i];
          if (f > 0.985) continue;
          const avg = (tmp[i - 1] + tmp[i + 1] + tmp[i - this.w] + tmp[i + this.w]) * 0.25;
          this.y[i] = lerp(lerp(tmp[i], avg, 0.62), tmp[i], f);
        }
      }
    }
  }

  clampIX(x) { return clamp(Math.round((x - this.minX) / CELL), 0, this.w - 1); }
  clampIZ(z) { return clamp(Math.round((z - this.minZ) / CELL), 0, this.h - 1); }

  // --- sampling -------------------------------------------------------------

  /**
   * How far a flat-triangle approximation of this field can sit ABOVE the
   * field itself, per cell.
   *
   * The field is bilinear inside each cell, so the surface over a cell is a
   * hyperbolic paraboloid with cross-term a = y00 + y11 - y01 - y10. Splitting
   * the cell into 2 m quarters and triangulating each quarter leaves a
   * worst-case error of |a|/16 — the two halvings each scale the cross-term by
   * a half, and triangulating a bilinear patch by its corners costs a quarter
   * of what is left.
   *
   * Computing it rather than guessing a constant is the difference between a
   * number that happens to work on the seeds that were looked at and one that
   * is correct on all of them: a saddle in the field is exactly where the
   * ground punches through the road, and a saddle is exactly what `a` measures.
   */
  buildSagField() {
    this.sag = new Float32Array(this.w * this.h);
    for (let iz = 0; iz < this.h - 1; iz++) {
      for (let ix = 0; ix < this.w - 1; ix++) {
        const i = this.idx(ix, iz);
        const a = this.y[i] + this.y[i + this.w + 1] - this.y[i + 1] - this.y[i + this.w];
        this.sag[i] = Math.abs(a) / 12;
      }
    }
    // Spread each cell's figure to its neighbours: a vertex on a cell boundary
    // belongs to four cells and has to clear the worst of them.
    const tmp = Float32Array.from(this.sag);
    for (let iz = 1; iz < this.h - 1; iz++) {
      for (let ix = 1; ix < this.w - 1; ix++) {
        const i = this.idx(ix, iz);
        this.sag[i] = Math.max(tmp[i], tmp[i - 1], tmp[i + 1], tmp[i - this.w], tmp[i + this.w]);
      }
    }
  }

  sagAt(x, z) {
    if (!this.sag) return 0;
    const fx = (x - this.minX) / CELL;
    const fz = (z - this.minZ) / CELL;
    const ix = clamp(Math.floor(fx), 0, this.w - 2);
    const iz = clamp(Math.floor(fz), 0, this.h - 2);
    const i = this.idx(ix, iz);
    // The maximum of the four, not their average: a smoothed bound is not one.
    return Math.max(this.sag[i], this.sag[i + 1], this.sag[i + this.w], this.sag[i + this.w + 1]);
  }

  /** Bilinear height. This is the single source of truth for "where is up". */
  heightAt(x, z) {
    const fx = (x - this.minX) / CELL;
    const fz = (z - this.minZ) / CELL;
    const ix = clamp(Math.floor(fx), 0, this.w - 2);
    const iz = clamp(Math.floor(fz), 0, this.h - 2);
    const tx = clamp01(fx - ix), tz = clamp01(fz - iz);
    const i = this.idx(ix, iz);
    const a = this.y[i], b = this.y[i + 1];
    const c = this.y[i + this.w], d = this.y[i + this.w + 1];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  }

  /** Surface normal, for lighting the ground and for slope tests. */
  normalAt(x, z) {
    const e = CELL * 0.5;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    const nx = -hx / (2 * e), nz = -hz / (2 * e);
    const l = Math.hypot(nx, 1, nz) || 1;
    return { x: nx / l, y: 1 / l, z: nz / l };
  }

  /**
   * How hard this spot was stamped by a road corridor or a building pad:
   * 0 is untouched country, 1 is carriageway or slab. Two things read it —
   * the ground mesh, to know that a slope it is looking at is an embankment
   * rather than a hillside and should not be textured as bare rock; and the
   * ground mesh again, to know how far to sink itself out of the way of the
   * paving that is about to be laid on top of it.
   */
  fixAt(x, z) {
    const fx = (x - this.minX) / CELL;
    const fz = (z - this.minZ) / CELL;
    const ix = clamp(Math.floor(fx), 0, this.w - 2);
    const iz = clamp(Math.floor(fz), 0, this.h - 2);
    const tx = clamp01(fx - ix), tz = clamp01(fz - iz);
    const i = this.idx(ix, iz);
    const a = this.fix[i], b = this.fix[i + 1];
    const c = this.fix[i + this.w], d = this.fix[i + this.w + 1];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  }

  /** Gradient magnitude (rise over run). 0.36 is about 20 degrees. */
  slopeAt(x, z) {
    const e = CELL * 0.5;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return Math.hypot(hx, hz) / (2 * e);
  }

  /** Highest and lowest ground inside an axis-aligned box, for AABB fitting. */
  rangeIn(minX, minZ, maxX, maxZ) {
    let lo = Infinity, hi = -Infinity;
    for (let iz = this.clampIZ(minZ); iz <= this.clampIZ(maxZ); iz++) {
      for (let ix = this.clampIX(minX); ix <= this.clampIX(maxX); ix++) {
        const v = this.y[this.idx(ix, iz)];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (lo > hi) { const c = this.heightAt((minX + maxX) / 2, (minZ + maxZ) / 2); return { lo: c, hi: c }; }
    return { lo, hi };
  }

  /** Mean height over a polygon, sampled on the field grid. */
  averageOver(poly) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of poly) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
    let sum = 0, n = 0;
    for (let iz = this.clampIZ(minZ); iz <= this.clampIZ(maxZ); iz++) {
      for (let ix = this.clampIX(minX); ix <= this.clampIX(maxX); ix++) {
        const x = this.wx(ix), z = this.wz(iz);
        if (!pointInPoly2(poly, x, z)) continue;
        sum += this.y[this.idx(ix, iz)]; n++;
      }
    }
    if (!n) {
      let cx = 0, cz = 0;
      for (const p of poly) { cx += p.x; cz += p.z; }
      return this.heightAt(cx / poly.length, cz / poly.length);
    }
    return sum / n;
  }

  /**
   * March a ray against the heightfield. Bullets, line of sight and the
   * director's visibility tests all need to know that a hill blocks a shot.
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    const step = 0.9;
    let prevT = 0;
    let prevGap = oy - this.heightAt(ox, oz);
    if (prevGap < 0) return { dist: 0, x: ox, y: oy, z: oz };
    for (let t = step; t <= maxDist; t += step) {
      const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
      const gap = y - this.heightAt(x, z);
      if (gap <= 0) {
        // Linear refine between the last two samples.
        const f = prevGap / (prevGap - gap);
        const ht = lerp(prevT, t, clamp01(f));
        return { dist: ht, x: ox + dx * ht, y: oy + dy * ht, z: oz + dz * ht };
      }
      prevT = t; prevGap = gap;
    }
    return null;
  }
}

// --- helpers ---------------------------------------------------------------

function pointInPoly2(poly, x, z) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Signed-ish distance: <=0 inside the polygon, otherwise distance to its edge. */
function polyDistance(poly, x, z) {
  if (pointInPoly2(poly, x, z)) return 0;
  let best = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const d = distPointSeg(x, z, a.x, a.z, b.x, b.z).dist;
    if (d < best) best = d;
  }
  return best;
}

/**
 * Terrain-relevant tunables, derived from the seed so every town gets its own
 * topography while keeping the same play-tested proportions.
 */
export function makeLandforms(cfg, rng) {
  const half = cfg.mapSize / 2;
  const o = cfg.origin;
  return {
    coreDatum: 0,
    ridge: {
      // Runs roughly north-south down the eastern third, behind the works.
      ax: o.x + half * 0.30 + rng.range(-14, 14), az: -half * 0.86,
      bx: o.x + half * 0.40 + rng.range(-14, 14), bz: half * 0.62,
      width: rng.range(46, 58),
      height: rng.range(15, 19),
    },
    hill: {
      x: o.x - half * 0.44 + rng.range(-18, 18),
      z: o.z - half * 0.40 + rng.range(-18, 18),
      radius: rng.range(118, 148),
      height: rng.range(17, 22),
    },
    hollow: {
      x: o.x - half * 0.10 + rng.range(-26, 26),
      z: o.z + half * 0.44 + rng.range(-20, 20),
      radius: rng.range(40, 54),
      depth: rng.range(7.5, 10.5),
      rampAngle: rng.range(-Math.PI, Math.PI),
    },
    river: {
      x0: -half - 20, x1: half * 0.34,
      z0: half - rng.range(24, 40), z1: half + 26,
      halfWidth: rng.range(30, 40),
      depth: rng.range(7.5, 9.5),
      berm: rng.range(1.4, 2.6),
      wobble: rng.range(8, 18),
      phase: rng.range(0, Math.PI * 2),
    },
  };
}
