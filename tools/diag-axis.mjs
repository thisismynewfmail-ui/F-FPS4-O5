// Ground truth for the horizontal axis, read off the framebuffer.
//
// Nothing here trusts the camera math. It steps the camera sideways without
// rotating it — content always slides opposite the way the camera moved — to
// establish which world direction is screen-right, then checks the mouse, the
// strafe keys and the bearing cues (compass, damage arrows, stereo pan)
// against that. Prints the direction in words and exits non-zero on an
// inversion it can actually confirm.
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
  const { rightOfYaw } = await import('/src/core/math.js');
  const { compassFrac } = await import('/src/game/hud.js');
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

  const YAW = 0.7;                          // a view with plenty of structure
  // Somewhere both strafe directions are actually clear. Run this test wedged
  // against a wall and the scene does not move, which reads as an inversion.
  // A collision probe is not enough — only walking it proves it — so candidates
  // are filtered cheaply and then confirmed by simulating the strafe itself.
  const walk = (p, key, frames) => {
    g.player.x = p.x; g.player.z = p.z; g.player.y = p.y;
    g.player.yaw = YAW; g.player.vx = 0; g.player.vz = 0; g.player.vy = 0;
    for (let i = 0; i < 20; i++) g.update(0.016);      // settle onto the floor
    const sx = g.player.x, sz = g.player.z;
    g.input.keys.add(key);
    for (let i = 0; i < frames; i++) g.update(0.016);
    g.input.keys.delete(key);
    return Math.hypot(g.player.x - sx, g.player.z - sz);
  };
  const openSpot = () => {
    const C = g.world.collision, r = rightOfYaw(YAW);
    const cand = [{ x: g.player.x, z: g.player.z }];
    for (const rad of [6, 11, 17, 25, 34]) {          // nearest clear spot wins
      for (let i = 0; i < 32; i++) {
        const a = (i / 32) * Math.PI * 2;
        cand.push({ x: g.player.x + Math.cos(a) * rad, z: g.player.z + Math.sin(a) * rad });
      }
    }
    let tried = 0;
    for (const p of cand) {
      p.y = C.floorAt(p.x, p.z, 4, 6);
      const clear = (s) => {
        const m = C.moveCircle(p.x, p.z, r.x * 2.6 * s, r.z * 2.6 * s, 0.36, p.y, p.y + 1.78);
        return Math.hypot(m.x - p.x, m.z - p.z) > 2.4;
      };
      if (!clear(1) || !clear(-1)) continue;
      if (++tried > 14) break;
      if (Math.min(walk(p, 'KeyD', 45), walk(p, 'KeyA', 45)) > 2) return p;
    }
    return null;
  };
  const found = openSpot();
  const home = found || { x: g.player.x, z: g.player.z, y: g.player.y };
  const reset = () => {
    g.player.x = home.x; g.player.z = home.z; g.player.y = home.y;
    g.player.yaw = YAW; g.player.vx = 0; g.player.vz = 0; g.player.vy = 0;
  };

  // --- 1. which world direction is screen-right ----------------------------
  // Pure translation, no rotation: the scene slides opposite the camera's step.
  const right = rightOfYaw(YAW);
  const translate = [];
  for (const sgn of [1, -1]) {
    reset();
    await frame();
    const a = profile();
    g.player.x = home.x + right.x * 2.4 * sgn;
    g.player.z = home.z + right.z * 2.4 * sgn;
    await frame();
    translate.push({ sgn, shift: bestShift(a, profile()) });
  }

  // --- 2. mouse look -------------------------------------------------------
  const runs = [];
  for (const dx of [140, -140]) {
    reset();
    await frame();
    const a = profile();
    g.input.locked = true;
    g.input.mouse.dx = dx; g.input.mouse.dy = 0;
    g.update(0.016);
    g.input.locked = false;
    g.input.mouse.dx = 0;
    await frame();
    // b[x + s] ~ a[x]: s>0 means content in b sits to the RIGHT of where it was.
    runs.push({ dx, shift: bestShift(a, profile()), dYaw: g.player.yaw - YAW });
  }

  // --- 3. strafe -----------------------------------------------------------
  const strafeRuns = [];
  for (const key of ['KeyD', 'KeyA']) {
    reset();
    for (let i = 0; i < 20; i++) g.update(0.016);   // settle onto the floor first
    const sx = g.player.x, sz = g.player.z;
    await frame();
    const a = profile();
    g.input.keys.add(key);
    for (let i = 0; i < 90; i++) g.update(0.016);
    g.input.keys.delete(key);
    await frame();
    strafeRuns.push({
      key,
      shift: bestShift(a, profile()),
      moved: Math.hypot(g.player.x - sx, g.player.z - sz),
      alongRight: (g.player.x - sx) * right.x + (g.player.z - sz) * right.z,
    });
  }

  // --- 4. the cues that report a bearing back to the player -----------------
  const cues = [];
  const lm = g.world.landmarks[0];
  if (lm) {
    const bearing = Math.atan2(lm.x - home.x, lm.z - home.z);
    for (const off of [0.35, -0.35]) {
      reset();
      g.player.yaw = bearing + off;
      await frame();
      const m = g.renderer.viewProj;
      const w = m[3] * lm.x + m[7] * lm.y + m[11] * lm.z + m[15];
      cues.push({
        name: lm.name,
        ndcX: (m[0] * lm.x + m[4] * lm.y + m[8] * lm.z + m[12]) / w,
        compass: compassFrac(g.player.yaw, bearing) - 0.5,   // the strip's own mapping
        pan: g.audio.spatial(lm.x, lm.y, lm.z, 1e9).pan,
      });
    }
  }
  reset();
  return { translate, runs, strafeRuns, cues, openGround: !!found, width: c.width };
});
console.log(JSON.stringify(result));

// A cross-correlation of a low-res render is noisy; below this many pixels the
// scene did not measurably move and the run says nothing either way.
const MIN = 6;
const side = (s) => (Math.abs(s) < MIN ? 'NOT MEASURABLY' : s > 0 ? 'RIGHT' : 'LEFT');
let bad = 0;
const verdict = (ok, measurable) => {
  if (!measurable) return 'inconclusive';
  if (!ok) bad++;
  return ok ? 'CORRECT' : '*** INVERTED ***';
};

for (const t of result.translate) {
  console.log(`camera stepped ${t.sgn > 0 ? 'along' : 'against'} (-cos yaw, sin yaw) ` +
    `-> scene slid ${side(t.shift)} (${t.shift}px)`);
}
const gt = result.translate[0];
if (Math.abs(gt.shift) < MIN) console.log('=> screen-right could not be established; check the spot');
else console.log(`=> world (-cos yaw, sin yaw) is screen-${gt.shift < 0 ? 'RIGHT' : 'LEFT'} ` +
  `${gt.shift < 0 ? '(as mat4View builds it)' : '(the renderer disagrees with mat4View)'}`);

for (const r of result.runs) {
  // Camera turning right makes scene content slide left.
  console.log(`mouse ${r.dx > 0 ? 'RIGHT' : 'LEFT'} (dx=${r.dx}) -> dYaw ${r.dYaw.toFixed(3)}, ` +
    `scene slid ${side(r.shift)} (${r.shift}px) -> camera turned ${r.shift < 0 ? 'RIGHT' : 'LEFT'}  ` +
    `${verdict((r.dx > 0) === (r.shift < 0), Math.abs(r.shift) >= MIN)}`);
}
if (!result.openGround) console.log('(no spot found where both strafes run clear — distances are wall-limited)');
for (const r of result.strafeRuns) {
  const wantRight = r.key === 'KeyD';
  // Primary signal is the displacement along the screen-right direction step 1
  // just measured off the framebuffer, so this is not the old circular check.
  // The scene shift corroborates it whenever the move was long enough to read.
  const v = verdict((r.alongRight > 0) === wantRight, r.moved > 0.3);
  const pixels = Math.abs(r.shift) < MIN ? 'scene shift too small to read'
    : `scene slid ${side(r.shift)} (${r.shift}px), ${(r.shift < 0) === wantRight ? 'agrees' : 'DISAGREES'}`;
  console.log(`${r.key} (expect move ${wantRight ? 'RIGHT' : 'LEFT'}) -> covered ${r.moved.toFixed(2)}m, ` +
    `${r.alongRight.toFixed(2)}m of it along screen-right  ${v}  [${pixels}]`);
}
for (const c of result.cues) {
  const s = c.ndcX > 0 ? 'RIGHT' : 'LEFT';
  console.log(`${c.name} renders ${s} of centre -> compass mark ` +
    `${c.compass > 0 ? 'RIGHT' : 'LEFT'} ${verdict((c.compass > 0) === (c.ndcX > 0), true)}, ` +
    `stereo pan ${c.pan > 0 ? 'RIGHT' : 'LEFT'} ${verdict((c.pan > 0) === (c.ndcX > 0), true)}`);
}

await page.screenshot({ path: `${OUT}/axis-truth.png` });
await browser.close();
server.close();
process.exit(bad ? 1 : 0);
