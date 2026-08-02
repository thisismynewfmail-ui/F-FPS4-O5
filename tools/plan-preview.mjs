// Renders the town plan to an SVG so the urban layout can be judged without
// booting the renderer.  node tools/plan-preview.mjs [seed] > plan.svg
import { writeFileSync } from 'node:fs';
import { RNG, polyCentroid } from '../src/core/math.js';
import {
  generateRoadNetwork, cutAlleys, subdivideOversizedBlocks, buildRoadSurfaces, classWidth,
} from '../src/world/roads.js';
import { makeZoning, makeLots, assignProgramme, chooseOpenSpaces, ZONE } from '../src/world/plan.js';
import { makeTownConfig } from '../src/world/config.js';
import { computeFootprint } from '../src/world/building.js';

const seed = Number(process.argv[2] || 20250802);
const rng = new RNG(seed);
const cfg = makeTownConfig(seed);

const t0 = Date.now();
const graph = generateRoadNetwork(cfg, rng);
subdivideOversizedBlocks(graph, cfg, rng, { maxArea: cfg.maxBlockArea, passes: 6 });
let blocks = graph.faces(140);
cutAlleys(graph, blocks, cfg, rng);
blocks = graph.faces(140);

const zoning = makeZoning(cfg);
chooseOpenSpaces(blocks, cfg, rng, zoning);
const { lots, openSpaces } = makeLots(graph, blocks, zoning, cfg, rng);
const { assigned, counts } = assignProgramme(lots, cfg, rng);
for (const lot of assigned) lot.footprint = computeFootprint(lot, rng);
const surfaces = buildRoadSurfaces(graph);
const ms = Date.now() - t0;

const S = cfg.mapSize / 2;
const PAD = 20;
const SIZE = 1400;
const sc = (SIZE - PAD * 2) / (S * 2);
const X = (x) => (PAD + (x + S) * sc).toFixed(1);
const Z = (z) => (PAD + (z + S) * sc).toFixed(1);
const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x)},${Z(p.z)}`).join('') + 'Z';

const zoneColor = {
  [ZONE.CORE]: '#4a3f2e', [ZONE.MIXED]: '#3f4030', [ZONE.RESIDENTIAL]: '#2f3a2c',
  [ZONE.INDUSTRIAL]: '#3a3238', [ZONE.RURAL]: '#2a3226',
};

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
<rect width="${SIZE}" height="${SIZE}" fill="#14171a"/>`;

// blocks tinted by zone
for (const b of blocks) {
  const zone = zoning.zoneAt(b.centroid.x, b.centroid.z);
  const fill = b.forceOpen ? '#22331f' : (zoneColor[zone] || '#333');
  svg += `<path d="${path(b.pts)}" fill="${fill}" stroke="#0a0c0e" stroke-width="0.6"/>`;
}
// roads
for (const s of surfaces.strips) svg += `<path d="${path(s.poly)}" fill="#5a5a5e"/>`;
for (const p of surfaces.pads) svg += `<path d="${path(p.poly)}" fill="#5a5a5e"/>`;
// lots
for (const l of lots) {
  const c = l.programme ? '#8fa06f' : '#4b5240';
  svg += `<path d="${path(l.poly)}" fill="none" stroke="${c}" stroke-width="0.7" opacity="0.8"/>`;
}
// building footprints
for (const l of assigned) {
  if (!l.footprint) continue;
  for (const mass of l.footprint.masses) {
    svg += `<path d="${path(mass.corners)}" fill="#c8bda0" stroke="#20242a" stroke-width="0.5" opacity="0.95"/>`;
  }
  // door marker
  const d = l.footprint.door;
  if (d) svg += `<circle cx="${X(d.x)}" cy="${Z(d.z)}" r="1.8" fill="#e04a3a"/>`;
}
// landmark labels
for (const l of assigned) {
  const p = l.programme;
  if (!p || (p.max === undefined) || p.max > 4) continue;
  svg += `<text x="${X(l.centroid.x)}" y="${Z(l.centroid.z)}" fill="#ffd479" font-size="9" font-family="monospace" text-anchor="middle">${p.label}</text>`;
}
svg += `<text x="14" y="${SIZE - 12}" fill="#8899aa" font-size="13" font-family="monospace">seed ${seed} · ${blocks.length} blocks · ${lots.length} lots · ${assigned.length} buildings · ${ms}ms</text>`;
svg += '</svg>';

writeFileSync(process.argv[3] || 'plan.svg', svg);

const tally = [...counts.entries()].sort((a, b) => b[1] - a[1]);
console.log(`seed ${seed}  ${ms}ms`);
console.log(`blocks ${blocks.length}  open ${openSpaces.length}  lots ${lots.length}  buildings ${assigned.length}`);
console.log(tally.map(([k, v]) => `${k}:${v}`).join('  '));
