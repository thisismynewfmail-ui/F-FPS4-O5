// Drive the camera to specific, named places in the generated world and
// screenshot each one. Unlike smoke.mjs (which plays the game), this exists to
// LOOK at particular level-design features — the cordon gates, the hill
// streets, the ridge, the river bridge, the secrets — because those are the
// things a random walk almost never happens to stand in front of.
//
//   node tools/tour.mjs [outdir] [seed] [preset]
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve, normalize } from 'node:path';

const ROOT = resolve(process.cwd());
const OUT = process.argv[2] || '/tmp/tour';
const SEED = process.argv[3] || '42';
const PRESET = process.argv[4] || 'clean';
await mkdir(OUT, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let p = normalize(resolve(ROOT, '.' + url.pathname));
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    if (url.pathname === '/') p = resolve(ROOT, 'index.html');
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(`http://localhost:${port}/?seed=${SEED}&preset=${PRESET}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.state !== 'loading', { timeout: 240000 });

await page.evaluate(() => {
  for (const id of ['start', 'loading']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  const g = window.__game;
  g.fadeIn = 0;
  g.player.maxHealth = 1e9; g.player.health = 1e9;
  g.horde.clear();
  g.director.phaseT = 1e9;             // no waves during a tour
  g.director.betweenWaves = true;
  window.__look = (x, y, z, tx, tz, pitch) => {
    const p = g.player;
    p.x = x; p.z = z; p.y = y;
    p.yaw = Math.atan2(tx - x, tz - z);
    p.pitch = pitch || 0;
    p.vx = p.vy = p.vz = 0;
    p.hurtFlash = 0;
  };
  // The elevations most likely to show a clipping mistake: the widest
  // frontages with the most openings on them, which is where a door and a
  // shopfront window are most likely to have wanted the same rectangle.
  window.__facades = (n) => {
    const w = g.world;
    return w.buildings
      .filter((b) => b.openings && b.doorWorld)
      .map((b) => ({ b, n: b.openings.front.length }))
      .sort((p, q) => q.n - p.n)
      .slice(0, n)
      .map(({ b }) => ({
        x: b.doorWorld.x, z: b.doorWorld.z,
        nx: Math.sin(b.yaw), nz: Math.cos(b.yaw),
        label: b.label, w: b.lot.footprint.w,
      }));
  };
  // The buildings standing on the steepest sites, which is where the ground
  // meeting the bottom of the wall is hardest and where a gap shows first.
  window.__bases = (n) => {
    const w = g.world;
    return w.buildings
      .filter((b) => b.doorWorld && b.lot.footprint)
      .sort((p, q) => q.foundDrop - p.foundDrop)
      .slice(0, n)
      .map((b) => ({
        x: b.doorWorld.x, z: b.doorWorld.z,
        nx: Math.sin(b.yaw), nz: Math.cos(b.yaw),
        drop: b.foundDrop, label: b.label,
      }));
  };
  window.__plan = () => {
    const w = g.world;
    return {
      gates: w.gates.map((q) => ({ d: q.district, k: q.kind, x: q.x, z: q.z })),
      secrets: w.secrets.map((s) => ({ n: s.name, x: s.x, z: s.z })),
      bridges: (w.bridges || []).map((b) => ({ x: (b.ax + b.bx) / 2, z: (b.az + b.bz) / 2, span: b.span })),
      landmarks: w.landmarks.map((l) => ({ n: l.name, x: l.x, z: l.z })),
      start: w.playerStart,
      relief: w.stats.relief,
    };
  };
});

const plan = await page.evaluate(() => window.__plan());
console.log(`relief ${plan.relief.lo.toFixed(1)} .. ${plan.relief.hi.toFixed(1)} m`);

/**
 * Stand `back` metres from a target, at eye height above the ground there.
 *
 * The bearing is a starting suggestion, not an instruction: a fixed one puts a
 * building, a cordon or a hillside between the camera and the thing being
 * photographed often enough that half the shots were of something else. Eight
 * bearings are tried and the first with a clear line to the target wins, with
 * the stand-off pulled in if none of them is clear.
 */
async function shot(name, tx, tz, back = 16, bearing = 0, pitch = 0) {
  const p = await page.evaluate(([tx, tz, back, bearing, pitch]) => {
    const g = window.__game;
    const place = (b, d) => {
      const x = tx + Math.sin(b) * d, z = tz + Math.cos(b) * d;
      return { x, z, gy: g.world.gy(x, z) };
    };
    let best = place(bearing, back);
    let found = false;
    outer:
    for (const d of [back, back * 0.65, back * 0.4]) {
      for (let i = 0; i < 8; i++) {
        const b = bearing + (i / 8) * Math.PI * 2;
        const c = place(b, d);
        const ty = g.world.gy(tx, tz) + 1.4;
        // Standing in a stockroom that happens to have a clear line out
        // through a doorway is not a photograph of the thing outside it.
        if (g.world.insideAnyBuilding(c.x, c.z, 1.2)) continue;
        if (g.world.collision.lineOfSight(c.x, c.gy + 1.6, c.z, tx, ty, tz)) {
          best = c; found = true; break outer;
        }
      }
    }
    best.clear = found;
    window.__look(best.x, best.gy + 1.6, best.z, tx, tz, pitch);
    return best;
  }, [tx, tz, back, bearing, pitch]);
  await page.waitForTimeout(420);
  await page.evaluate(() => { window.__game.player.hurtFlash = 0; });
  await page.waitForTimeout(140);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${name.padEnd(26)} at ${p.x.toFixed(0)},${p.z.toFixed(0)} ` +
    `ground ${p.gy.toFixed(1)}${p.clear ? '' : '  (no clear view — shot is of whatever is in the way)'}`);
}

// The base of a wall on the steepest sites, from across the street and low —
// the angle a player actually sees a gap from.
const bases = await page.evaluate(() => window.__bases(4));
for (let i = 0; i < bases.length; i++) {
  const b = bases[i];
  const p = await page.evaluate(([b]) => {
    const g = window.__game;
    // Back off until we are out of any neighbour, then aim at the wall foot.
    let x = b.x, z = b.z, d = 5;
    for (; d < 22; d += 1.5) {
      const px = b.x - b.nx * d, pz = b.z - b.nz * d;
      if (g.world.insideAnyBuilding(px, pz, 0.8)) break;
      x = px; z = pz;
    }
    const gy = g.world.gy(x, z);
    window.__look(x, gy + 1.5, z, b.x, b.z, -0.13);
    return { x, z, d };
  }, [b]);
  await page.waitForTimeout(420);
  await page.screenshot({ path: `${OUT}/base-${i}-drop${b.drop.toFixed(1)}.png` });
  console.log(`base-${i}`.padEnd(26) + ` ${b.label}  foundation ${b.drop.toFixed(2)} m deep, from ${p.d.toFixed(0)} m`);
}

// Facades, straight on, from far enough back to see the whole elevation.
const facades = await page.evaluate(() => window.__facades(6));
for (let i = 0; i < facades.length; i++) {
  const f = facades[i];
  const back = Math.max(11, f.w * 0.95);
  await page.evaluate(([f, back]) => {
    const g = window.__game;
    // Stand out in the street, square to the front wall.
    const x = f.x - f.nx * back, z = f.z - f.nz * back;
    window.__look(x, g.world.gy(x, z) + 2.4, z, f.x, f.z, -0.06);
  }, [f, back]);
  await page.waitForTimeout(420);
  await page.screenshot({ path: `${OUT}/facade-${i}-${f.label.toLowerCase().replace(/\W+/g, '-')}.png` });
  console.log(`facade-${i}`.padEnd(26) + ` ${f.label}`);
}

// One gate per cordon ring, whichever is first.
for (let d = 0; d < 5; d++) {
  const g = plan.gates.find((q) => q.d === d);
  if (g) await shot(`gate-${d}-${g.k}`, g.x, g.z, 17, Math.PI * 0.25);
}
// The same first gate, opened, so the two states can be compared.
await page.evaluate(() => {
  const g = window.__game;
  for (let i = 0; i < 5; i++) g.progression.setKills(g.world.districts.list[i].kills);
  g.toasts.length = 0;
});
for (let d = 0; d < 5; d++) {
  const g = plan.gates.find((q) => q.d === d);
  if (g) await shot(`gate-${d}-${g.k}-open`, g.x, g.z, 17, Math.PI * 0.25);
}

for (const l of plan.landmarks) {
  const slug = l.n.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  await shot(`lm-${slug}`, l.x, l.z, l.n === 'Water Tower' ? 34 : 20, 1.1, 0.05);
}
for (const b of plan.bridges.slice(0, 2)) {
  await shot('bridge', b.x, b.z, Math.max(22, b.span * 0.8), 1.6, 0.0);
}
for (const s of plan.secrets) {
  const slug = s.n.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  await shot(`secret-${slug}`, s.x, s.z, 12, 0.7, -0.08);
}

if (logs.length) console.log('--- errors ---\n' + logs.slice(0, 20).join('\n'));
await browser.close();
server.close();
