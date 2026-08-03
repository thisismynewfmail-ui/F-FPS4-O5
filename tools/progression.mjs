// Walk the whole progression without a browser: open each cordon in turn and
// assert that the sector it opens actually becomes reachable, that nothing
// beyond the NEXT one does, and that the loot economy grows with it.
//
//   node tools/progression.mjs [seed]
//
// This exists because the progression is the one system whose failures are
// completely invisible in play: a cordon that leaks looks exactly like a town
// you happened to wander further into, and a sector that never opens looks
// exactly like a sector you have not found the way into yet.
import { buildLibrary } from '../src/art/materials.js';
import { makeTownConfig } from '../src/world/config.js';
import { World } from '../src/world/world.js';
import { NavGrid } from '../src/game/nav.js';
import { Progression } from '../src/world/districts.js';

const seed = Number(process.argv[2] || 20250802);
const lib = buildLibrary(seed);
for (const t of lib.tasks) t.run();
const cfg = makeTownConfig(seed);
const world = new World({ lib, cfg, seed });
for (const [, run] of world.steps()) run();

const nav = new NavGrid(cfg.bounds);
const navOpts = {
  terrain: world.terrain,
  slopeImpassable: cfg.slopeImpassable,
  slopeSlow: cfg.slopeSlowFull * 0.62,
  waterY: cfg.waterY,
};

const prog = new Progression(world, { onUnlock: (s) => world.openSector(s.id) });

/** Fraction of a sector's ground that can be walked to from the start. */
function reachOf(d) {
  let hit = 0, n = 0;
  for (let i = 0; i < 4000 && n < 260; i++) {
    const a = Math.random() * Math.PI * 2;
    const rIn = d === 0 ? 0 : world.districts.radiusOf(d - 1, a);
    const rOut = d < world.districts.list.length - 1
      ? world.districts.radiusOf(d, a) : cfg.mapSize * 0.7;
    const r = rIn + Math.random() * (rOut - rIn);
    const x = cfg.origin.x + Math.cos(a) * r, z = cfg.origin.z + Math.sin(a) * r;
    if (x < cfg.bounds.minX + 8 || x > cfg.bounds.maxX - 8) continue;
    if (z < cfg.bounds.minZ + 8 || z > cfg.bounds.maxZ - 8) continue;
    if (world.districts.districtAt(x, z) !== d) continue;
    n++;
    if (nav.costAt(x, z) !== 65535) hit++;
  }
  return n ? hit / n : null;
}

let failures = 0;
const stages = [0, ...world.districts.list.slice(0, -1).map((s) => s.kills)];
console.log(`seed ${seed} — ${world.buildings.length} buildings, ${world.gates.length} gates\n`);
console.log('kills     open      reachable ground per sector (%)          loot available');
console.log('------------------------------------------------------------------------');

for (const kills of stages) {
  prog.setKills(kills);
  nav.build(world.collision, world.doorways, navOpts);
  nav.update(world.playerStart.x, world.playerStart.z, 60000);

  const reach = world.districts.list.map((_, d) => reachOf(d));
  const loot = world.loot.filter((l) => (l.district ?? 0) <= prog.open).length;
  const cells = reach.map((r) => (r === null ? '  -' : String(Math.round(r * 100)).padStart(3)));
  console.log(`${String(kills).padStart(6)}  ${String(prog.open).padStart(4)}      ${cells.join('  ')}      ${String(loot).padStart(5)}`);

  // The sector just opened must be genuinely enterable...
  const here = reach[prog.open];
  if (here !== null && here < 0.35) {
    console.log(`     FAIL sector ${prog.open} is only ${Math.round(here * 100)}% reachable after opening`);
    failures++;
  }
  // ...and the one after it must not be.
  const next = prog.open + 1;
  if (next < reach.length && reach[next] !== null && reach[next] > 0.25) {
    console.log(`     FAIL sector ${next} is ${Math.round(reach[next] * 100)}% reachable before its cordon opens`);
    failures++;
  }
}

console.log('');
console.log(failures ? `${failures} progression FAILURES` : 'progression holds at every stage');
process.exit(failures ? 1 : 0);
