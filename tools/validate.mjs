// Build several towns and assert the brief's hard rules still hold.
//   node tools/validate.mjs [n]
import { buildLibrary } from '../src/art/materials.js';
import { makeTownConfig } from '../src/world/config.js';
import { World } from '../src/world/world.js';

const N = Number(process.argv[2] || 6);
const seeds = [20250802, 7, 99, 1234, 555, 88888, 42, 31337].slice(0, N);
let failures = 0;

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
  if (c('library') !== 1) problems.push(`library=${c('library')} (must be exactly 1)`);
  if (c('church') > 2 || c('church') < 1) problems.push(`church=${c('church')} (max 2)`);
  if (c('gasstation') < 3 || c('gasstation') > 5) problems.push(`gasstation=${c('gasstation')} (3-5)`);
  if (homes < 24) problems.push(`homes=${homes} (want dozens)`);
  if (world.buildings.length < 90) problems.push(`only ${world.buildings.length} buildings`);
  if (world.stats.collision.segments < 5000) problems.push('collision world too sparse');
  if (!world.playerStart) problems.push('no player start');
  if (world.spawns.length < 200) problems.push('too few spawn points');
  if (world.stats.tris > 2_000_000) problems.push(`${world.stats.tris} tris over budget`);

  // Every building must have a front door reachable from the street side.
  let doorless = 0;
  for (const b of world.buildings) if (!b.doorWorld) doorless++;
  if (doorless) problems.push(`${doorless} buildings without a front door`);

  const status = problems.length ? 'FAIL' : 'ok  ';
  if (problems.length) failures++;
  console.log(`${status} seed ${String(seed).padEnd(9)} ${String(world.buildings.length).padStart(4)} bld  ` +
    `${String(Math.round(world.stats.tris / 1000)).padStart(5)}k tris  ${String(ms).padStart(5)}ms  ` +
    `lib ${c('library')} church ${c('church')} gas ${c('gasstation')} homes ${String(homes).padStart(3)}` +
    (problems.length ? `\n     ${problems.join('\n     ')}` : ''));
}
console.log(failures ? `${failures}/${seeds.length} seeds FAILED` : `all ${seeds.length} seeds pass`);
process.exit(failures ? 1 : 0);
