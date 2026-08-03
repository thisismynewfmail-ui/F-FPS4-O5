// ---------------------------------------------------------------------------
// config.js — one place for every tunable that shapes the town.
// ---------------------------------------------------------------------------

import { RNG } from '../core/math.js';
import { makeLandforms } from './terrain.js';
import { DISTRICTS } from './districts.js';

export function makeTownConfig(seed = 20250802) {
  const rng = new RNG(seed ^ 0x5eed);
  const mapSize = 470;
  const half = mapSize / 2;
  const cfg = {
    seed,
    mapSize,
    bounds: { minX: -half, maxX: half, minZ: -half, maxZ: half },

    // The historic crossroads. Everything grew outward from here.
    origin: { x: rng.range(-24, 10), z: rng.range(-18, 14) },
    coreRadius: 96,

    // The works were built beside the rail head on the eastern edge.
    industrial: { z: rng.range(-40, 70) },
    railX: half - 26,
    riverBand: 46,

    // Network density.
    secondaryStreets: 42,
    lanes: 54,
    culDeSacs: 10,
    alleys: 14,
    maxBlockArea: 4200,
    parks: 3,

    // Vertical language. A cold, wet, northern town: steep roofs, deep eaves.
    storeyHeight: 3.05,
    commercialStoreyHeight: 3.9,
    roofPitchMin: 32,
    roofPitchMax: 46,

    // --- topography --------------------------------------------------------
    // Maximum grade a carriageway is allowed to reach, by road class. These
    // are what force the streets to switch back across Beacon Hill instead of
    // running straight up it. Real hill-town figures: 8% on a bus route, 20%
    // on a back lane that only ever carried carts.
    maxGrade: { arterial: 0.055, main: 0.070, street: 0.105, lane: 0.155, alley: 0.185, service: 0.10 },
    waterY: -5.4,

    // Above this gradient the player is fighting the hill rather than walking
    // up it; above the second figure nothing can climb at all.
    slopeSlowStart: 0.30,
    slopeSlowFull: 0.78,
    slopeImpassable: 1.05,

    // --- progression -------------------------------------------------------
    // Kill milestones that open each successive part of town. 500 is the
    // reference point the design was pinned to; the rest scale by roughly
    // 2.4x, 2.1x, 1.8x, 1.55x, so each sector takes longer in absolute terms
    // but less than proportionally longer given how much faster you kill once
    // you have the shotgun and the high ground.
    districts: DISTRICTS,

    // Atmosphere.
    fogStart: 26,
    fogEnd: 118,
    sunDir: { x: -0.34, y: 0.42, z: 0.60 },
  };
  cfg.landforms = makeLandforms(cfg, rng);
  return cfg;
}
