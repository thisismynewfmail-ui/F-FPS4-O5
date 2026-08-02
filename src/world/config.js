// ---------------------------------------------------------------------------
// config.js — one place for every tunable that shapes the town.
// ---------------------------------------------------------------------------

import { RNG } from '../core/math.js';

export function makeTownConfig(seed = 20250802) {
  const rng = new RNG(seed ^ 0x5eed);
  const mapSize = 470;
  const half = mapSize / 2;
  return {
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

    // Atmosphere.
    fogStart: 26,
    fogEnd: 118,
    sunDir: { x: -0.34, y: 0.42, z: 0.60 },
  };
}
