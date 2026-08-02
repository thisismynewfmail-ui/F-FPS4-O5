// Headless smoke test: boots the game in Chromium, waits for the world to
// build, drives a few frames of input, and screenshots.
//   node tools/smoke.mjs [outdir] [seed]
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, normalize } from 'node:path';

const ROOT = resolve(process.cwd());
const OUT = process.argv[2] || '/tmp/shots';
const SEED = process.argv[3] || '20250802';
const PRESET = process.argv[4] || 'authentic';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
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
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${(e.stack || '').split('\n').slice(0, 6).join('\n')}`));

const t0 = Date.now();
await page.goto(`http://localhost:${port}/?seed=${SEED}&preset=${PRESET}`, { waitUntil: 'load' });

let ok = true;
try {
  await page.waitForFunction(() => window.__game && window.__game.state !== 'loading', { timeout: 180000 });
} catch (e) {
  ok = false;
  logs.push(`[fatal] world never finished loading: ${e.message}`);
  const err = await page.$eval('#error', (el) => el.textContent).catch(() => '');
  if (err) logs.push(`[error-pane]\n${err}`);
}
console.log(`load took ${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (ok) {
  // Dismiss the start screen and simulate playing.
  await page.evaluate(() => {
    const s = document.getElementById('start');
    if (s) s.style.display = 'none';
    document.getElementById('loading').style.display = 'none';
    const g = window.__game;
    g.fadeIn = 0;
    // Inspection run: the player must survive to reach the later shots.
    g.player.maxHealth = 1e9; g.player.health = 1e9;
    // Pointer lock is unavailable headless, so drive the player directly.
    window.__drive = (fn) => fn(g);
  });
  await page.waitForTimeout(700);

  const shots = [
    ['01-street', (g) => {}],
    ['02-look-around', (g) => { g.player.yaw += 2.1; }],
    ['03-horde', (g) => {
      g.director.startWave();
      for (let i = 0; i < 26; i++) {
        const a = (i / 26) * Math.PI * 2;
        const d = 7 + (i % 5) * 2.5;
        const x = g.player.x + Math.cos(a) * d, z = g.player.z + Math.sin(a) * d;
        const y = g.world.collision.floorAt(x, z, g.player.y + 1, 2);
        g.horde.spawn(['shambler', 'runner', 'worker', 'crawler', 'hulk'][i % 5], x, y, z);
      }
      g.player.yaw -= 2.1;
    }],
    ['04-weapon-shotgun', (g) => { g.arsenal.owned.shotgun = true; g.arsenal.current = 'shotgun'; g.arsenal.fireFlash = 1; }],
    ['05-rooftop', (g) => {
      // Look down the main road from a height for the skyline.
      g.player.y += 14; g.player.pitch = -0.12;
    }],
    ['06-viewmodel-only', (g) => {
      // Hide the world and the horde so the weapon can be judged on its own.
      g.__chunks = g.chunks; g.chunks = [];
      g.horde.clear(); g.items.length = 0; g.particles.length = 0;
      g.player.y -= 14; g.player.pitch = 0;
      g.arsenal.current = 'pistol';
    }],
    ['07-viewmodel-rifle', (g) => { g.arsenal.owned.rifle = true; g.arsenal.current = 'rifle'; }],
    ['09-interior', (g) => {
      g.chunks = g.__chunks || g.chunks;
      // Step through the front door of the nearest house and look inside.
      let best = null;
      for (const b of g.world.buildings) {
        if (!b.doorWorld) continue;
        const d = Math.hypot(b.doorWorld.x - g.player.x, b.doorWorld.z - g.player.z);
        if (!best || d < best.d) best = { d, b };
      }
      if (!best) return;
      const b = best.b;
      const fwd = { x: Math.sin(b.yaw), z: Math.cos(b.yaw) };
      g.player.x = b.doorWorld.x + fwd.x * 3.4;
      g.player.z = b.doorWorld.z + fwd.z * 3.4;
      g.player.y = b.plinth;
      g.player.yaw = Math.atan2(fwd.x, fwd.z);
      g.player.pitch = 0;
      g.player.torchOn = true;
      g.__label = b.label;
    }],
    ['10-interior-lit', (g) => { g.player.yaw += 1.9; }],
    ['08-viewmodel-shotgun', (g) => { g.arsenal.current = 'shotgun'; g.chunks = g.__chunks; }],
  ];

  for (const [name, fn] of shots) {
    await page.evaluate(`window.__drive(${fn.toString()})`);
    await page.waitForTimeout(name === '03-horde' ? 1400 : 450);
    await page.screenshot({ path: `${OUT}/${name}.png` });
  }

  const info = await page.evaluate(() => {
    const g = window.__game;
    return {
      fps: g.fps, frameMs: g.frameMs,
      draws: g.renderer.stats.drawCalls, tris: g.renderer.stats.tris, chunks: g.renderer.stats.chunks,
      world: g.world.stats, alive: g.horde.liveCount, items: g.items.length,
      pos: [g.player.x.toFixed(1), g.player.y.toFixed(1), g.player.z.toFixed(1)],
    };
  });
  console.log(JSON.stringify(info, null, 2));
}

await browser.close();
server.close();
const errors = logs.filter((l) => l.includes('[error]') || l.includes('[pageerror]') || l.includes('[fatal]'));
if (logs.length) console.log('--- console ---\n' + logs.join('\n'));
process.exit(errors.length || !ok ? 1 : 0);
