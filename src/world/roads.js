// ---------------------------------------------------------------------------
// roads.js — the street network.
//
// The brief forbids grid symmetry and forbids random scatter. Real towns get
// their shape from history, so this generator reproduces the history:
//
//   1. A crossroads exists first (the church and the market square sit on it).
//   2. Two arterials run through it, curving with the terrain rather than
//      following a compass.
//   3. A mill road strikes out toward the river/rail where the works were
//      built, and the industry never left the edge of town.
//   4. Secondary streets branch off the arterials at irregular intervals and
//      angles, snapping to whatever they run into — which is what produces
//      irregular block shapes and T-junctions instead of a grid.
//   5. Residential lanes branch again, and a fraction of them dead-end in
//      cul-de-sacs; the rest loop back and reconnect.
//   6. Service alleys are cut through the deepest commercial blocks last.
//
// The result is planarised (every crossing becomes a real node) and then the
// faces of the planar graph are extracted as city blocks.
// ---------------------------------------------------------------------------

import {
  RNG, TAU, clamp, dist2D, polyArea, polyCentroid, segIntersect, distPointSeg,
} from '../core/math.js';

export const ROAD_CLASS = {
  arterial: { width: 13.0, sidewalk: 3.6, name: 'arterial' },
  main: { width: 11.0, sidewalk: 3.4, name: 'main' },
  street: { width: 8.4, sidewalk: 2.8, name: 'street' },
  lane: { width: 6.4, sidewalk: 2.0, name: 'lane' },
  alley: { width: 4.2, sidewalk: 0.0, name: 'alley' },
  service: { width: 7.0, sidewalk: 1.6, name: 'service' },
  boundary: { width: 0.0, sidewalk: 0.0, name: 'boundary' },
};

export class RoadGraph {
  constructor(cellSize = 24) {
    this.nodes = [];
    this.edges = [];
    this.cell = cellSize;
    this.grid = new Map();
  }

  key(x, z) { return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`; }

  addNode(x, z, meta) {
    const id = this.nodes.length;
    this.nodes.push({ id, x, z, edges: [], ...meta });
    return id;
  }

  addEdge(a, b, cls = 'street') {
    if (a === b) return -1;
    const na = this.nodes[a], nb = this.nodes[b];
    for (const e of na.edges) {
      const ed = this.edges[e];
      if (ed.a === b || ed.b === b) return e;   // already connected
    }
    const id = this.edges.length;
    const e = { id, a, b, cls, dead: false };
    this.edges.push(e);
    na.edges.push(id);
    nb.edges.push(id);
    this._index(e);
    return id;
  }

  _index(e) {
    const na = this.nodes[e.a], nb = this.nodes[e.b];
    const steps = Math.max(1, Math.ceil(dist2D(na.x, na.z, nb.x, nb.z) / this.cell));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const k = this.key(na.x + (nb.x - na.x) * t, na.z + (nb.z - na.z) * t);
      let list = this.grid.get(k);
      if (!list) { list = []; this.grid.set(k, list); }
      if (!list.includes(e.id)) list.push(e.id);
    }
  }

  reindex() {
    this.grid.clear();
    for (const e of this.edges) if (!e.dead) this._index(e);
  }

  nearbyEdges(x, z, radius) {
    const out = new Set();
    const r = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const list = this.grid.get(`${cx + dx},${cz + dz}`);
        if (list) for (const id of list) if (!this.edges[id].dead) out.add(id);
      }
    }
    return out;
  }

  nearestNode(x, z, radius, exclude = -1) {
    let best = -1, bestD = radius;
    for (const id of this.nearbyEdges(x, z, radius + this.cell)) {
      const e = this.edges[id];
      for (const nid of [e.a, e.b]) {
        if (nid === exclude) continue;
        const n = this.nodes[nid];
        const d = dist2D(x, z, n.x, n.z);
        if (d < bestD) { bestD = d; best = nid; }
      }
    }
    return best;
  }

  /** Split an edge at parameter t, returning the new node id. */
  splitEdge(edgeId, t) {
    const e = this.edges[edgeId];
    const na = this.nodes[e.a], nb = this.nodes[e.b];
    const x = na.x + (nb.x - na.x) * t, z = na.z + (nb.z - na.z) * t;
    const mid = this.addNode(x, z);
    const a = e.a, b = e.b, cls = e.cls;
    this.removeEdge(edgeId);
    this.addEdge(a, mid, cls);
    this.addEdge(mid, b, cls);
    return mid;
  }

  removeEdge(edgeId) {
    const e = this.edges[edgeId];
    if (!e || e.dead) return;
    e.dead = true;
    for (const nid of [e.a, e.b]) {
      const n = this.nodes[nid];
      const i = n.edges.indexOf(edgeId);
      if (i >= 0) n.edges.splice(i, 1);
    }
  }

  /**
   * First crossing of segment (p→q) with an existing edge, ignoring edges
   * incident to `fromNode` (they legitimately share an endpoint).
   */
  firstCrossing(px, pz, qx, qz, fromNode) {
    let best = null;
    const mx = (px + qx) / 2, mz = (pz + qz) / 2;
    const r = dist2D(px, pz, qx, qz) / 2 + this.cell;
    for (const id of this.nearbyEdges(mx, mz, r)) {
      const e = this.edges[id];
      if (e.a === fromNode || e.b === fromNode) continue;
      const na = this.nodes[e.a], nb = this.nodes[e.b];
      const hit = segIntersect(px, pz, qx, qz, na.x, na.z, nb.x, nb.z);
      if (hit && hit.t > 0.02 && (!best || hit.t < best.t)) best = { t: hit.t, u: hit.u, edge: id, x: hit.x, z: hit.z };
    }
    return best;
  }

  /** Turn every crossing into a shared node so face extraction is valid. */
  planarize() {
    let guard = 0;
    let found = true;
    while (found && guard++ < 40) {
      found = false;
      this.reindex();
      const live = this.edges.filter((e) => !e.dead).map((e) => e.id);
      for (const id of live) {
        const e = this.edges[id];
        if (e.dead) continue;
        const na = this.nodes[e.a], nb = this.nodes[e.b];
        for (const oid of this.nearbyEdges((na.x + nb.x) / 2, (na.z + nb.z) / 2,
          dist2D(na.x, na.z, nb.x, nb.z) / 2 + this.cell)) {
          if (oid === id) continue;
          const o = this.edges[oid];
          if (o.dead || e.dead) continue;
          if (o.a === e.a || o.a === e.b || o.b === e.a || o.b === e.b) continue;
          const oa = this.nodes[o.a], ob = this.nodes[o.b];
          const hit = segIntersect(na.x, na.z, nb.x, nb.z, oa.x, oa.z, ob.x, ob.z, 1e-7);
          if (!hit) continue;
          if (hit.t < 0.001 || hit.t > 0.999 || hit.u < 0.001 || hit.u > 0.999) continue;
          const mid = this.splitEdge(id, hit.t);
          // The other edge's parameter is unchanged by the first split.
          const o2 = this.edges[oid];
          if (!o2.dead) {
            const mid2 = this.splitEdge(oid, hit.u);
            // Weld the two coincident nodes by connecting them (zero length).
            const n1 = this.nodes[mid], n2 = this.nodes[mid2];
            n2.x = n1.x; n2.z = n1.z;
            this._weld(mid, mid2);
          }
          found = true;
          break;
        }
      }
    }
    this.reindex();
    this.dedupeNodes();
  }

  /** Move all of b's edges onto a and retire b. */
  _weld(a, b) {
    if (a === b) return;
    const nb = this.nodes[b];
    for (const eid of nb.edges.slice()) {
      const e = this.edges[eid];
      const other = e.a === b ? e.b : e.a;
      this.removeEdge(eid);
      this.addEdge(a, other, e.cls);
    }
    nb.merged = a;
  }

  /** Weld nodes that ended up essentially on top of each other. */
  dedupeNodes(eps = 0.35) {
    const buckets = new Map();
    for (const n of this.nodes) {
      if (n.merged !== undefined || n.edges.length === 0) continue;
      const k = `${Math.round(n.x / eps)},${Math.round(n.z / eps)}`;
      const prev = buckets.get(k);
      if (prev === undefined) buckets.set(k, n.id);
      else this._weld(prev, n.id);
    }
    this.reindex();
  }

  liveEdges() { return this.edges.filter((e) => !e.dead); }

  /**
   * Extract the faces of the planar subdivision. Walking "the next edge
   * clockwise around the far node" keeps the interior on the left, so inner
   * faces come out counter-clockwise (positive area) and the single outer face
   * comes out negative and is dropped.
   */
  faces(minArea = 60) {
    const around = new Map();   // node id -> neighbour ids sorted by angle
    for (const n of this.nodes) {
      if (n.merged !== undefined || n.edges.length === 0) continue;
      const nbrs = n.edges.map((eid) => {
        const e = this.edges[eid];
        const o = this.nodes[e.a === n.id ? e.b : e.a];
        return { id: o.id, edge: eid, ang: Math.atan2(o.z - n.z, o.x - n.x) };
      }).sort((p, q) => p.ang - q.ang);
      around.set(n.id, nbrs);
    }

    const visited = new Set();
    const faces = [];
    for (const e of this.edges) {
      if (e.dead) continue;
      for (const [u, v] of [[e.a, e.b], [e.b, e.a]]) {
        const startKey = `${u}>${v}`;
        if (visited.has(startKey)) continue;
        const pts = [];
        const edgeRefs = [];
        let cu = u, cv = v, guard = 0;
        let ok = true;
        while (guard++ < 4000) {
          const key = `${cu}>${cv}`;
          if (visited.has(key) && !(cu === u && cv === v && guard > 1)) {
            if (guard > 1) { ok = false; break; }
          }
          visited.add(key);
          pts.push({ x: this.nodes[cu].x, z: this.nodes[cu].z });
          const nbrs = around.get(cv);
          if (!nbrs || nbrs.length === 0) { ok = false; break; }
          const i = nbrs.findIndex((nb) => nb.id === cu);
          if (i < 0) { ok = false; break; }
          edgeRefs.push(nbrs[i].edge);
          const nxt = nbrs[(i - 1 + nbrs.length) % nbrs.length];
          cu = cv; cv = nxt.id;
          if (cu === u && cv === v) break;
        }
        if (!ok || pts.length < 3) continue;
        const area = polyArea(pts);
        if (area > minArea) faces.push({ pts, edgeRefs, area, centroid: polyCentroid(pts) });
      }
    }
    return faces;
  }
}

// ---------------------------------------------------------------------------
// Growth
// ---------------------------------------------------------------------------

/**
 * Grow a street from `startNode` heading at `ang`. Streets curve as they go,
 * snap to nearby junctions, and split any edge they cross — the three rules
 * that produce organic, irregular blocks.
 */
export function growStreet(graph, startNode, ang, opts) {
  const rng = opts.rng;
  const step = opts.step ?? 24;
  const curve = opts.curve ?? 0.14;
  const snap = opts.snap ?? 17;
  const cls = opts.cls || 'street';
  const bounds = opts.bounds;
  let cur = startNode;
  let travelled = 0;
  const created = [cur];

  while (travelled < opts.length) {
    ang += rng.gauss() * curve;
    if (opts.bias !== undefined) {
      // Gently pull back toward the intended heading so streets wander
      // without turning into spirals.
      let d = opts.bias - ang;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      ang += d * (opts.biasStrength ?? 0.16);
    }
    const n = graph.nodes[cur];
    const stepLen = step * rng.range(0.82, 1.18);
    const nx = n.x + Math.cos(ang) * stepLen;
    const nz = n.z + Math.sin(ang) * stepLen;

    if (bounds && (nx < bounds.minX || nx > bounds.maxX || nz < bounds.minZ || nz > bounds.maxZ)) {
      return { end: 'bounds', last: cur, created };
    }

    const cross = graph.firstCrossing(n.x, n.z, nx, nz, cur);
    if (cross) {
      const mid = graph.splitEdge(cross.edge, cross.u);
      graph.addEdge(cur, mid, cls);
      return { end: 'cross', last: mid, created: created.concat([mid]) };
    }

    const near = graph.nearestNode(nx, nz, snap, cur);
    if (near >= 0 && near !== cur) {
      graph.addEdge(cur, near, cls);
      return { end: 'snap', last: near, created: created.concat([near]) };
    }

    const nn = graph.addNode(nx, nz);
    graph.addEdge(cur, nn, cls);
    created.push(nn);
    cur = nn;
    travelled += stepLen;
  }
  return { end: 'length', last: cur, created };
}

/** Grow a polyline of control points into the graph (used for arterials). */
function layPolyline(graph, pts, cls) {
  let prev = -1;
  const ids = [];
  for (const p of pts) {
    let id = graph.nearestNode(p.x, p.z, 6, prev);
    if (id < 0) id = graph.addNode(p.x, p.z);
    if (prev >= 0 && prev !== id) graph.addEdge(prev, id, cls);
    ids.push(id);
    prev = id;
  }
  return ids;
}

/** A gently meandering path between two points. */
function meander(rng, from, to, wobble, segments) {
  const pts = [];
  const dx = to.x - from.x, dz = to.z - from.z;
  const len = Math.hypot(dx, dz);
  const px = -dz / len, pz = dx / len;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const envelope = Math.sin(t * Math.PI);       // pinned at both ends
    const off = (Math.sin(t * 4.1 + rng.next() * 6) * 0.6 + rng.gauss() * 0.7) * wobble * envelope;
    pts.push({ x: from.x + dx * t + px * off, z: from.z + dz * t + pz * off });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Town assembly
// ---------------------------------------------------------------------------

export function generateRoadNetwork(cfg, rng) {
  const g = new RoadGraph(26);
  const B = cfg.bounds;
  const inner = {
    minX: B.minX + 6, maxX: B.maxX - 6, minZ: B.minZ + 6, maxZ: B.maxZ - 6,
  };

  // --- the map boundary, so peripheral blocks are closed --------------------
  const ringStep = 40;
  const ring = [];
  for (let x = B.minX; x < B.maxX; x += ringStep) ring.push({ x, z: B.minZ });
  for (let z = B.minZ; z < B.maxZ; z += ringStep) ring.push({ x: B.maxX, z });
  for (let x = B.maxX; x > B.minX; x -= ringStep) ring.push({ x, z: B.maxZ });
  for (let z = B.maxZ; z > B.minZ; z -= ringStep) ring.push({ x: B.minX, z });
  const ringIds = ring.map((p) => g.addNode(p.x, p.z, { boundary: true }));
  for (let i = 0; i < ringIds.length; i++) {
    g.addEdge(ringIds[i], ringIds[(i + 1) % ringIds.length], 'boundary');
  }

  // --- 1. the historic crossroads ------------------------------------------
  const origin = cfg.origin;

  // Main Street: the east-west arterial. Curves around where the hill was.
  const mainPts = meander(rng, { x: B.minX, z: origin.z + rng.range(-26, 26) },
    { x: B.maxX, z: origin.z + rng.range(-30, 30) }, 34, 16);
  // Force it through the crossroads.
  const midIdx = Math.round(mainPts.length / 2);
  mainPts[midIdx] = { x: origin.x, z: origin.z };
  mainPts[midIdx - 1] = { x: (mainPts[midIdx - 1].x + origin.x) / 2 - 20, z: (mainPts[midIdx - 1].z + origin.z) / 2 };
  const mainIds = layPolyline(g, mainPts, 'arterial');

  // Church Street: north-south, meeting Main at the square.
  const churchPts = meander(rng, { x: origin.x + rng.range(-24, 24), z: B.minZ },
    { x: origin.x + rng.range(-20, 20), z: B.maxZ }, 30, 15);
  const cMid = Math.round(churchPts.length / 2);
  churchPts[cMid] = { x: origin.x, z: origin.z };
  layPolyline(g, churchPts, 'arterial');

  // Mill Road: strikes east toward the works and the rail head.
  const millPts = meander(rng, { x: origin.x, z: origin.z },
    { x: B.maxX, z: cfg.industrial.z }, 26, 9);
  layPolyline(g, millPts, 'main');

  // River Road: hugs the water on the south-west.
  const riverPts = meander(rng, { x: B.minX, z: origin.z + 96 },
    { x: origin.x + 60, z: B.maxZ - 30 }, 24, 11);
  layPolyline(g, riverPts, 'main');

  // Station Road: north out of the square toward the highway.
  const stationPts = meander(rng, { x: origin.x - 8, z: origin.z },
    { x: origin.x - cfg.mapSize * 0.18, z: B.minZ }, 22, 8);
  layPolyline(g, stationPts, 'main');

  g.planarize();

  // --- 2. secondary streets branching off the spine ------------------------
  const spine = g.liveEdges().filter((e) => e.cls === 'arterial' || e.cls === 'main');
  const branchPoints = [];
  for (const e of spine) {
    const na = g.nodes[e.a], nb = g.nodes[e.b];
    const len = dist2D(na.x, na.z, nb.x, nb.z);
    if (len < 12) continue;
    branchPoints.push({ edge: e.id, t: rng.range(0.2, 0.8), len });
  }
  rng.shuffle(branchPoints);

  const targetSecondary = cfg.secondaryStreets ?? 26;
  let made = 0;
  for (const bp of branchPoints) {
    if (made >= targetSecondary) break;
    const e = g.edges[bp.edge];
    if (e.dead) continue;
    const na = g.nodes[e.a], nb = g.nodes[e.b];
    const ang = Math.atan2(nb.z - na.z, nb.x - na.x);
    const node = g.splitEdge(bp.edge, bp.t);
    const n = g.nodes[node];
    // Distance from the centre decides how long the street runs and how
    // tightly it curves: downtown streets are short and straight, outskirts
    // streets are long and wandering.
    const dCentre = dist2D(n.x, n.z, origin.x, origin.z);
    const outer = clamp(dCentre / (cfg.mapSize * 0.45), 0, 1);
    for (const side of rng.chance(0.45) ? [1, -1] : [rng.sign()]) {
      if (made >= targetSecondary) break;
      const perp = ang + side * (Math.PI / 2) + rng.range(-0.42, 0.42);
      const res = growStreet(g, node, perp, {
        rng,
        cls: outer > 0.55 ? 'lane' : 'street',
        length: rng.range(70, 190) * (0.7 + outer * 0.6),
        step: rng.range(20, 30),
        curve: 0.07 + outer * 0.16,
        bias: perp,
        biasStrength: 0.12,
        snap: 18,
        bounds: inner,
      });
      made++;
      if (res.end === 'length' && rng.chance(0.5)) {
        // Continue with a turn — how streets bend around old field boundaries.
        growStreet(g, res.last, perp + rng.sign() * rng.range(0.7, 1.5), {
          rng, cls: 'lane', length: rng.range(50, 130), step: 22,
          curve: 0.16, snap: 18, bounds: inner,
        });
      }
    }
  }
  g.planarize();

  // --- 3. residential lanes and cul-de-sacs --------------------------------
  const lanes = g.liveEdges().filter((e) => e.cls === 'street' || e.cls === 'lane');
  rng.shuffle(lanes);
  let culs = 0;
  const targetLanes = cfg.lanes ?? 30;
  for (let i = 0; i < lanes.length && i < targetLanes; i++) {
    const e = lanes[i];
    if (e.dead) continue;
    const na = g.nodes[e.a], nb = g.nodes[e.b];
    if (dist2D(na.x, na.z, nb.x, nb.z) < 16) continue;
    const mid = g.splitEdge(e.id, rng.range(0.3, 0.7));
    const n = g.nodes[mid];
    const dCentre = dist2D(n.x, n.z, origin.x, origin.z);
    if (dCentre < cfg.coreRadius * 0.8) continue;   // downtown has alleys, not lanes
    const ang = Math.atan2(nb.z - na.z, nb.x - na.x) + rng.sign() * Math.PI / 2 + rng.range(-0.5, 0.5);
    const res = growStreet(g, mid, ang, {
      rng, cls: 'lane',
      length: rng.range(40, 110),
      step: rng.range(18, 26),
      curve: 0.2,
      snap: 15,
      bounds: inner,
    });
    if (res.end === 'length') {
      if (culs < (cfg.culDeSacs ?? 9) && rng.chance(0.62)) {
        // Cul-de-sac: a turning bulb, and nothing beyond it.
        g.nodes[res.last].culDeSac = true;
        culs++;
      } else {
        // Loop back into the network.
        growStreet(g, res.last, ang + rng.sign() * rng.range(1.1, 1.9), {
          rng, cls: 'lane', length: 160, step: 22, curve: 0.18, snap: 20, bounds: inner,
        });
      }
    }
  }
  g.planarize();

  return g;
}

/**
 * Any block too deep to reach from the street would have had a road cut
 * through it long ago. This pass does exactly that, repeatedly, which is what
 * gives the town its fine-grained irregular blocks instead of a few huge ones.
 */
export function subdivideOversizedBlocks(graph, cfg, rng, opts = {}) {
  const maxArea = opts.maxArea ?? 5200;
  const passes = opts.passes ?? 5;
  const radius = opts.radius ?? cfg.mapSize * 0.40;
  let cuts = 0;
  for (let pass = 0; pass < passes; pass++) {
    const blocks = graph.faces(200);
    let cutThisPass = 0;
    for (const b of blocks) {
      const d = dist2D(b.centroid.x, b.centroid.z, cfg.origin.x, cfg.origin.z);
      if (d > radius) continue;
      const limit = maxArea * (1 + (d / radius) * 1.4);   // blocks loosen outward
      if (b.area < limit) continue;

      // Cut between the two most distant vertices, bowed a little.
      let best = null;
      for (let i = 0; i < b.pts.length; i++) {
        for (let j = i + 2; j < b.pts.length; j++) {
          if (i === 0 && j === b.pts.length - 1) continue;
          const dd = dist2D(b.pts[i].x, b.pts[i].z, b.pts[j].x, b.pts[j].z);
          if (!best || dd > best.d) best = { d: dd, i, j };
        }
      }
      if (!best || best.d < 42) continue;
      const p = b.pts[best.i], q = b.pts[best.j];
      const a = graph.nearestNode(p.x, p.z, 5);
      const c = graph.nearestNode(q.x, q.z, 5);
      if (a < 0 || c < 0 || a === c) continue;
      const cls = b.area > 16000 ? 'street' : 'lane';
      const steps = 2 + (rng.next() < 0.5 ? 1 : 0);
      let prev = a;
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const mx = p.x + (q.x - p.x) * t + rng.gauss() * 8;
        const mz = p.z + (q.z - p.z) * t + rng.gauss() * 8;
        const nn = graph.addNode(mx, mz);
        graph.addEdge(prev, nn, cls);
        prev = nn;
      }
      graph.addEdge(prev, c, cls);
      cuts++; cutThisPass++;
    }
    graph.planarize();
    if (!cutThisPass) break;
  }
  return cuts;
}

/**
 * Cut service alleys through the deepest downtown blocks, then re-extract the
 * faces so the alleys really do subdivide them.
 */
export function cutAlleys(graph, blocks, cfg, rng) {
  let cut = 0;
  for (const b of blocks) {
    if (cut >= (cfg.alleys ?? 12)) break;
    if (b.area < 2600) continue;
    const d = dist2D(b.centroid.x, b.centroid.z, cfg.origin.x, cfg.origin.z);
    if (d > cfg.coreRadius * 1.5) continue;

    // Run the alley along the block's long axis, entering and leaving through
    // the two most distant boundary points.
    let best = null;
    for (let i = 0; i < b.pts.length; i++) {
      for (let j = i + 2; j < b.pts.length; j++) {
        const dd = dist2D(b.pts[i].x, b.pts[i].z, b.pts[j].x, b.pts[j].z);
        if (!best || dd > best.d) best = { d: dd, i, j };
      }
    }
    if (!best || best.d < 46) continue;
    const p = b.pts[best.i], q = b.pts[best.j];
    const a = graph.nearestNode(p.x, p.z, 8);
    const bnode = graph.nearestNode(q.x, q.z, 8);
    if (a < 0 || bnode < 0) continue;

    // Bend it slightly so alleys aren't dead straight.
    const midx = (p.x + q.x) / 2 + rng.gauss() * 7;
    const midz = (p.z + q.z) / 2 + rng.gauss() * 7;
    const m = graph.addNode(midx, midz, { alley: true });
    graph.addEdge(a, m, 'alley');
    graph.addEdge(m, bnode, 'alley');
    cut++;
  }
  graph.planarize();
  return cut;
}

// ---------------------------------------------------------------------------
// Road surface geometry
// ---------------------------------------------------------------------------

export function classWidth(cls) { return (ROAD_CLASS[cls] || ROAD_CLASS.street).width; }
export function classSidewalk(cls) { return (ROAD_CLASS[cls] || ROAD_CLASS.street).sidewalk; }

/**
 * Build non-overlapping road surfaces: a convex pad at every junction, and a
 * quad for the stretch of each edge between its two pads. Overlapping coplanar
 * quads would z-fight, so nothing overlaps by construction and the terrain
 * plane underneath covers any hairline seam.
 */
export function buildRoadSurfaces(graph) {
  const padRadius = new Map();
  for (const n of graph.nodes) {
    if (n.merged !== undefined || n.edges.length === 0) continue;
    let maxHalf = 0, minLen = Infinity;
    let real = 0;
    for (const eid of n.edges) {
      const e = graph.edges[eid];
      if (e.cls === 'boundary') continue;
      real++;
      maxHalf = Math.max(maxHalf, classWidth(e.cls) / 2);
      const o = graph.nodes[e.a === n.id ? e.b : e.a];
      minLen = Math.min(minLen, dist2D(n.x, n.z, o.x, o.z));
    }
    if (!real) continue;
    padRadius.set(n.id, Math.min(maxHalf * 1.30, minLen * 0.45));
  }

  const pads = [];
  for (const n of graph.nodes) {
    const r = padRadius.get(n.id);
    if (r === undefined) continue;
    const corners = [];
    for (const eid of n.edges) {
      const e = graph.edges[eid];
      if (e.cls === 'boundary') continue;
      const o = graph.nodes[e.a === n.id ? e.b : e.a];
      const dx = o.x - n.x, dz = o.z - n.z;
      const len = Math.hypot(dx, dz) || 1;
      const ux = dx / len, uz = dz / len;
      const hw = classWidth(e.cls) / 2;
      const px = -uz * hw, pz = ux * hw;
      corners.push({ x: n.x + ux * r + px, z: n.z + uz * r + pz });
      corners.push({ x: n.x + ux * r - px, z: n.z + uz * r - pz });
    }
    if (corners.length < 3) continue;
    pads.push({ poly: convexHull(corners), node: n.id, radius: r, degree: corners.length / 2 });
  }

  const strips = [];
  for (const e of graph.liveEdges()) {
    if (e.cls === 'boundary') continue;
    const na = graph.nodes[e.a], nb = graph.nodes[e.b];
    const dx = nb.x - na.x, dz = nb.z - na.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.5) continue;
    const ux = dx / len, uz = dz / len;
    const hw = classWidth(e.cls) / 2;
    const ra = padRadius.get(na.id) ?? 0;
    const rb = padRadius.get(nb.id) ?? 0;
    if (ra + rb >= len - 0.2) continue;      // pads already cover this stretch
    const ax = na.x + ux * ra, az = na.z + uz * ra;
    const bx = nb.x - ux * rb, bz = nb.z - uz * rb;
    const px = -uz * hw, pz = ux * hw;
    strips.push({
      edge: e.id, cls: e.cls, length: len - ra - rb, width: hw * 2,
      dir: { x: ux, z: uz },
      poly: [
        { x: ax + px, z: az + pz }, { x: bx + px, z: bz + pz },
        { x: bx - px, z: bz - pz }, { x: ax - px, z: az - pz },
      ],
      a: { x: ax, z: az }, b: { x: bx, z: bz },
    });
  }
  return { pads, strips, padRadius };
}

/** Andrew's monotone chain. */
export function convexHull(points) {
  const pts = points.slice().sort((a, b) => (a.x - b.x) || (a.z - b.z));
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/** Nearest point on the road network — used to face buildings at the street. */
export function nearestRoad(graph, x, z, maxDist = 80) {
  let best = null;
  for (const id of graph.nearbyEdges(x, z, maxDist)) {
    const e = graph.edges[id];
    if (e.cls === 'boundary') continue;
    const na = graph.nodes[e.a], nb = graph.nodes[e.b];
    const r = distPointSeg(x, z, na.x, na.z, nb.x, nb.z);
    if (!best || r.dist < best.dist) best = { dist: r.dist, x: r.x, z: r.z, edge: id, cls: e.cls };
  }
  return best;
}
