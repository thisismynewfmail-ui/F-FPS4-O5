// ---------------------------------------------------------------------------
// districts.js — the progression system.
//
// The town opens outward from the square in six stages. You start in one
// block of it and you earn the rest.
//
// The boundaries are concentric because the town itself is concentric: it grew
// out from the crossroads, so the ring you are standing in tells you how old
// the buildings around you are, how maintained they are, and what they were
// for. Ring radii are wobbled by noise so no boundary ever reads as a circle
// on the ground.
//
// What actually stops you is a QUARANTINE CORDON — the thing that was thrown
// up around this place, in rings, as it failed. The cordon is permanent: it
// never disappears, and it is what gives the map its chokepoints. Only the
// GATES in it open, and they open by themselves as your kill count crosses
// each milestone, with no interface for it at all. A shutter winds up. A
// bascule bridge comes down over the Ash. A wrecked coach that was welded
// across Mill Street gets dragged aside.
//
// Because the cordon stays standing, sightlines stay structured all game: the
// horde has to come through the same handful of openings you do.
// ---------------------------------------------------------------------------

import { clamp, clamp01, valueNoise, smoothstep } from '../core/math.js';

/**
 * Six sectors, five thresholds. `radius` is the OUTER edge of the sector as a
 * fraction of the map half-size; the cordon that closes it stands on that
 * line. `kills` is the milestone that opens the cordon and lets you into the
 * NEXT sector out.
 *
 * The radii are set so each sector is meaningfully larger than the last while
 * the OUTERMOST one still reaches inside the map edges. Pushed any further out
 * it degenerates into four corner triangles behind the rail fence and the
 * river, and the largest investment in the game — seven thousand kills — opens
 * almost nothing, which is the worst possible shape for a progression curve.
 */
export const DISTRICTS = [
  {
    id: 0,
    name: 'THE SQUARE',
    subtitle: 'market cross, four streets, nothing else',
    radius: 0.245,
    kills: 500,
    cordon: 'wrecks',
    palette: 'core',
  },
  {
    id: 1,
    name: 'MARKET ROW',
    subtitle: 'the commercial core',
    radius: 0.415,
    kills: 1200,
    cordon: 'police',
    palette: 'core',
  },
  {
    id: 2,
    name: 'BEACON TERRACES',
    subtitle: 'civic quarter and the hill streets',
    radius: 0.585,
    kills: 2500,
    cordon: 'hoarding',
    palette: 'mixed',
  },
  {
    id: 3,
    name: 'THE WARRENS',
    subtitle: 'housing, allotments, the hollow',
    radius: 0.740,
    kills: 4500,
    cordon: 'concrete',
    palette: 'residential',
  },
  {
    id: 4,
    name: 'MILLGATE',
    subtitle: 'the works, the yard, the rail head',
    radius: 0.851,
    kills: 7000,
    cordon: 'berm',
    palette: 'industrial',
  },
  {
    id: 5,
    name: 'ASHGROVE OUT',
    subtitle: 'the ridge, the fields, across the water',
    radius: 99,
    kills: Infinity,
    cordon: null,
    palette: 'rural',
  },
];

/** How the cordon reads on the ground, per ring. */
export const CORDON_STYLE = {
  // Whatever was to hand on the first night: cars nose to tail, welded.
  wrecks: { height: 2.0, kind: 'wrecks', gateKind: 'coach', label: 'CIVIL DEFENCE LINE' },
  // Then the proper barricades came, and the notices.
  police: { height: 1.65, kind: 'barrier', gateKind: 'shutter', label: 'CORDON — NO ADMITTANCE' },
  // Then contractors' hoarding, because it was going to be a long job.
  hoarding: { height: 2.9, kind: 'hoarding', gateKind: 'chain', label: 'RESTRICTED — CHECKPOINT AHEAD' },
  // Then precast blocks, because the hoarding did not hold.
  concrete: { height: 3.4, kind: 'concrete', gateKind: 'liftgate', label: 'SECTOR 4 — CLOSED' },
  // Then they gave up on walls and moved earth instead.
  berm: { height: 3.6, kind: 'berm', gateKind: 'crossing', label: 'CONTAINMENT BERM' },
};

/**
 * Which sector a point is in. The wobble is deliberately low-frequency: the
 * boundary should bulge around a whole block, not scallop between lamp posts.
 */
export function makeDistricts(cfg) {
  const o = cfg.origin;
  const half = cfg.mapSize / 2;
  const seed = cfg.seed ^ 0x0d15;

  const wobbleAt = (ang, band) =>
    1 + (valueNoise(Math.cos(ang) * 1.9 + band * 3.3 + 5, Math.sin(ang) * 1.9 + band * 3.3 + 5, seed) - 0.5) * 0.30;

  /** Radius of the cordon that closes sector `i`, at bearing `ang`. */
  const radiusOf = (i, ang) => DISTRICTS[i].radius * half * wobbleAt(ang, i);

  const districtAt = (x, z) => {
    const dx = x - o.x, dz = z - o.z;
    const d = Math.hypot(dx, dz);
    const ang = Math.atan2(dz, dx);
    for (let i = 0; i < DISTRICTS.length - 1; i++) {
      if (d < radiusOf(i, ang)) return i;
    }
    return DISTRICTS.length - 1;
  };

  return {
    list: DISTRICTS,
    radiusOf,
    districtAt,
    /** Signed distance to the cordon that closes sector `i`: <0 is inside. */
    edgeDistance(i, x, z) {
      const dx = x - o.x, dz = z - o.z;
      const d = Math.hypot(dx, dz);
      return d - radiusOf(i, Math.atan2(dz, dx));
    },
    /** Sample the cordon ring for sector `i` at roughly `step` metres. */
    ringPoints(i, step = 2.0) {
      const pts = [];
      const rMean = DISTRICTS[i].radius * half;
      const n = Math.max(64, Math.ceil((Math.PI * 2 * rMean * 1.2) / step));
      for (let k = 0; k < n; k++) {
        const ang = (k / n) * Math.PI * 2;
        const r = radiusOf(i, ang);
        pts.push({ x: o.x + Math.cos(ang) * r, z: o.z + Math.sin(ang) * r, ang, r });
      }
      return pts;
    },
    name(i) { return DISTRICTS[clamp(i, 0, DISTRICTS.length - 1)].name; },
  };
}

/**
 * Runtime state: how many sectors are open right now. Kept deliberately
 * separate from the generator so a save, a restart or a debug unlock all go
 * through one place.
 */
export class Progression {
  constructor(world, opts = {}) {
    this.world = world;
    this.list = DISTRICTS;
    this.open = 0;                 // highest sector index the player may enter
    this.kills = 0;
    this.pending = [];             // unlock events the game loop still has to play
    this.onUnlock = opts.onUnlock || null;
  }

  get current() { return this.list[Math.min(this.open, this.list.length - 1)]; }
  get nextThreshold() { return this.open < this.list.length - 1 ? this.list[this.open].kills : null; }

  /** Progress toward the next opening, 0..1. */
  get fraction() {
    const t = this.nextThreshold;
    if (t === null || !isFinite(t)) return 1;
    const prev = this.open > 0 ? this.list[this.open - 1].kills : 0;
    return clamp01((this.kills - prev) / Math.max(1, t - prev));
  }

  /** Feed the running total; returns the sectors opened by this call. */
  setKills(n) {
    this.kills = n;
    const opened = [];
    while (this.open < this.list.length - 1 && n >= this.list[this.open].kills) {
      const sector = this.list[this.open];
      this.open++;
      opened.push(sector);
      this.pending.push(sector);
      if (this.onUnlock) this.onUnlock(sector, this.open);
    }
    return opened;
  }

  /** True if the player is allowed to be at (x,z) right now. */
  allows(districtIndex) { return districtIndex <= this.open; }

  reset() {
    this.open = 0;
    this.kills = 0;
    this.pending.length = 0;
  }
}

/**
 * Decay is stronger the further out you are, but the cordon rings interrupt
 * it: the strip just inside a cordon was fought over and looks it.
 */
export function cordonScar(districts, x, z, index) {
  if (index <= 0) return 0;
  const d = Math.abs(districts.edgeDistance(index - 1, x, z));
  return smoothstep(clamp01(1 - d / 26));
}
