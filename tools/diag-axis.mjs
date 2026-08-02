// Ground truth for "which world direction is screen-right".
// Places a marker at world +X and another at world -X, both in front of a
// camera at yaw 0, then reads the framebuffer to see which side each lands on.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, normalize } from 'node:path';

const ROOT = resolve(process.cwd());
const OUT = process.argv[2] || '/tmp/shots';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://l');
    let p = normalize(resolve(ROOT, '.' + u.pathname));
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    if (u.pathname === '/') p = resolve(ROOT, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(await readFile(p));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, r));
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
page.on('pageerror', (e) => console.log('ERR', e.message));
await page.goto(`http://localhost:${server.address().port}/?seed=20250802`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.state !== 'loading', { timeout: 180000 });

const result = await page.evaluate(async () => {
  const g = window.__game;
  document.getElementById('start').style.display = 'none';
  document.getElementById('loading').style.display = 'none';
  g.fadeIn = 0;
  g.horde.clear(); g.items.length = 0; g.particles.length = 0;
  g.player.pitch = 0; g.player.hurtFlash = 0;

  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const c = document.getElementById('view');
  const tmp = document.createElement('canvas');
  tmp.width = c.width; tmp.height = c.height;
  const tctx = tmp.getContext('2d');

  // Column-luminance profile of a horizontal band of the scene, avoiding HUD.
  const profile = () => {
    tctx.drawImage(c, 0, 0);
    const d = tctx.getImageData(0, 0, c.width, c.height).data;
    const y0 = Math.floor(c.height * 0.30), y1 = Math.floor(c.height * 0.62);
    const p = new Float64Array(c.width);
    for (let x = 0; x < c.width; x++) {
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        const i = (y * c.width + x) * 4;
        sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      }
      p[x] = sum / (y1 - y0);
    }
    return Array.from(p);
  };

  // Best horizontal shift aligning `b` onto `a` (negative = content moved left).
  const bestShift = (a, b) => {
    const W = a.length, max = Math.floor(W * 0.30);
    let bestS = 0, bestErr = Infinity;
    for (let s = -max; s <= max; s++) {
      let err = 0, n = 0;
      for (let x = Math.max(0, -s); x < Math.min(W, W - s); x += 2) {
        const d0 = a[x] - b[x + s];
        err += d0 * d0; n++;
      }
      if (n < W * 0.3) continue;
      err /= n;
      if (err < bestErr) { bestErr = err; bestS = s; }
    }
    return bestS;
  };

  // --- strafe: hold D / A and cross-correlate the same way -----------------
  const strafeRuns = [];
  for (const key of ['KeyD', 'KeyA']) {
    g.player.yaw = 0.7; g.player.vx = 0; g.player.vz = 0;
    await frame();
    const a = profile();
    const x0 = g.player.x, z0 = g.player.z;
    g.input.keys.add(key);
    for (let i = 0; i < 10; i++) g.update(0.016);
    g.input.keys.delete(key);
    await frame();
    const b = profile();
    // Screen-right in world terms, measured independently further down.
    const rx = -Math.cos(0.7), rz = Math.sin(0.7);
    strafeRuns.push({
      key,
      shift: bestShift(a, b),
      alongRight: (g.player.x - x0) * rx + (g.player.z - z0) * rz,
    });
  }

  const runs = [];
  for (const dx of [140, -140]) {
    g.player.yaw = 0.7;                    // a view with plenty of structure
    await frame();
    const a = profile();
    const yaw0 = g.player.yaw;
    g.input.locked = true;
    g.input.mouse.dx = dx; g.input.mouse.dy = 0;
    g.update(0.016);
    g.input.locked = false;
    await frame();
    const b = profile();
    // b[x + s] ~ a[x]: s>0 means content in b sits to the RIGHT of where it was.
    runs.push({ dx, shift: bestShift(a, b), dYaw: g.player.yaw - yaw0 });
  }
  return { runs, strafeRuns, width: c.width };
});
console.log(JSON.stringify(result));
for (const r of result.strafeRuns) {
  const want = r.key === 'KeyD' ? 'RIGHT' : 'LEFT';
  // Moving right makes the world slide left, same as turning right.
  const slid = r.shift > 0 ? 'RIGHT' : 'LEFT';
  const ok = (r.key === 'KeyD') === (r.shift < 0);
  console.log(`${r.key} (expect move ${want}) -> along screen-right ${r.alongRight.toFixed(2)}m, ` +
    `scene slid ${slid} (${r.shift}px)  ${ok ? 'CORRECT' : '*** INVERTED ***'}`);
}
for (const r of result.runs) {
  const dir = r.dx > 0 ? 'RIGHT' : 'LEFT';
  const slid = r.shift === 0 ? 'NOT AT ALL' : (r.shift > 0 ? 'RIGHT' : 'LEFT');
  // Camera turning right makes scene content slide left.
  const turned = r.shift < 0 ? 'RIGHT' : 'LEFT';
  const ok = (r.dx > 0) === (r.shift < 0);
  console.log(`mouse ${dir} (dx=${r.dx}) -> dYaw ${r.dYaw.toFixed(3)}, scene slid ${slid} ` +
    `(${r.shift}px) -> camera turned ${turned}  ${ok ? 'CORRECT' : '*** INVERTED ***'}`);
}
await page.screenshot({ path: `${OUT}/axis-truth.png` });
await browser.close();
server.close();
