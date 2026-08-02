// Builds the whole town in Node (no GL needed) — the fastest way to catch
// generator errors and to measure geometry budgets.
//   node tools/build-world.mjs [seed]
import { buildLibrary } from '../src/art/materials.js';
import { makeTownConfig } from '../src/world/config.js';
import { World } from '../src/world/world.js';

const seed = Number(process.argv[2] || 20250802);
const t0 = Date.now();
const lib = buildLibrary(seed);
for (const t of lib.tasks) t.run();
const tex = Date.now() - t0;

const cfg = makeTownConfig(seed);
const world = new World({ lib, cfg, seed });
const timings = [];
for (const [label, run] of world.steps()) {
  const a = Date.now();
  run();
  timings.push([label, Date.now() - a]);
}
const total = Date.now() - t0;
console.log(`seed ${seed}: textures ${tex}ms, world ${total - tex}ms, total ${(total / 1000).toFixed(1)}s`);
console.log(timings.map(([l, ms]) => `  ${String(ms).padStart(5)}ms  ${l}`).join('\n'));
const s = world.stats;
console.log(`buildings ${s.buildings}  tris ${(s.tris / 1000).toFixed(0)}k  verts ${(s.verts / 1000).toFixed(0)}k  chunks ${s.chunks}`);
console.log(`collision: ${s.collision.segments} segments, ${s.collision.floors} floors`);
console.log(`spawns ${s.spawns}  loot ${s.loot}  lights ${world.lights.length}  landmarks ${world.landmarks.length}`);
const perChunk = [...world.store.chunks.values()].map((c) => c.mb.triCount).sort((a, b) => b - a);
console.log(`chunk tris: max ${perChunk[0]}  median ${perChunk[perChunk.length >> 1]}`);
console.log(`player start ${world.playerStart.x.toFixed(1)}, ${world.playerStart.z.toFixed(1)}`);
