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
    g.player.torchOn = true;   // the game now starts with it off
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
    ['11-traffic', (g) => {
      // Stand beside the tightest cluster of parked vehicles and look at it.
      const V = g.world.vehicles;
      let best = null;
      for (const v of V) {
        let n = 0;
        for (const o of V) if (o !== v && Math.hypot(o.x - v.x, o.z - v.z) < 22) n++;
        if (!best || n > best.n) best = { n, v };
      }
      if (!best) return;
      g.player.x = best.v.x + 9; g.player.z = best.v.z + 9;
      g.player.y = g.world.collision.floorAt(g.player.x, g.player.z, 4, 6);
      g.player.yaw = Math.atan2(best.v.x - g.player.x, best.v.z - g.player.z);
      g.player.pitch = -0.12;
      g.horde.clear();
    }],
    ['08-viewmodel-shotgun', (g) => { g.arsenal.current = 'shotgun'; g.chunks = g.__chunks; }],
  ];

  for (const [name, fn] of shots) {
    await page.evaluate(`window.__drive(${fn.toString()})`);
    await page.waitForTimeout(name === '03-horde' ? 1400 : 450);
    // Clear the damage vignette so screenshots show the world's real colour.
    await page.evaluate(() => { window.__game.player.hurtFlash = 0; });
    await page.waitForTimeout(120);
    await page.screenshot({ path: `${OUT}/${name}.png` });
  }

  // --- axis regression check, grounded in rendered pixels -----------------
  // An earlier version of this test compared yaw against the same right-vector
  // formula the movement code uses, which is circular: if the assumption is
  // wrong the test confirms the bug. This one cross-correlates the actual
  // framebuffer before and after an input, so it measures what the player sees.
  const axes = await page.evaluate(async () => {
    const g = window.__game;
    g.horde.clear(); g.items.length = 0; g.particles.length = 0;
    g.player.dead = false; g.player.pitch = 0; g.player.hurtFlash = 0;
    const c = document.getElementById('view');
    const tmp = document.createElement('canvas');
    tmp.width = c.width; tmp.height = c.height;
    const tctx = tmp.getContext('2d');
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const profile = () => {
      tctx.drawImage(c, 0, 0);
      const d = tctx.getImageData(0, 0, c.width, c.height).data;
      // A band low enough to be looking at the town rather than at the sky.
      // Once the world had a horizon, a band straddling it was mostly cloud —
      // which is smooth, so the correlation below had nothing to lock onto and
      // wandered to whatever shift happened to align two flat regions.
      const y0 = Math.floor(c.height * 0.42), y1 = Math.floor(c.height * 0.78);
      const lum = new Float64Array(c.width);
      for (let x = 0; x < c.width; x++) {
        let sum = 0;
        for (let y = y0; y < y1; y++) {
          const i = (y * c.width + x) * 4;
          sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        }
        lum[x] = sum / (y1 - y0);
      }
      // Correlate the DERIVATIVE, not the brightness: what physically moves
      // when the camera turns is the edges. A brightness profile also carries
      // a big smooth left-to-right gradient from the lighting, and that
      // gradient dominates the sum of squares and biases it toward zero.
      const p = new Float64Array(c.width);
      for (let x = 1; x < c.width - 1; x++) p[x] = lum[x + 1] - lum[x - 1];
      return p;
    };
    /**
     * Normalised cross-correlation peak. Returns the shift and how good the
     * match was, so the caller can refuse to draw a conclusion from noise —
     * the previous version returned its best guess unconditionally, and its
     * best guess on a low-contrast frame was arbitrary.
     */
    const bestShift = (a, b) => {
      const W = a.length, max = Math.floor(W * 0.3);
      let bestS = 0, bestR = -Infinity;
      for (let sh = -max; sh <= max; sh++) {
        const lo = Math.max(1, -sh), hi = Math.min(W - 1, W - 1 - sh);
        if (hi - lo < W * 0.35) continue;
        let sa = 0, sb = 0, n = 0;
        for (let x = lo; x < hi; x++) { sa += a[x]; sb += b[x + sh]; n++; }
        const ma = sa / n, mb = sb / n;
        let num = 0, da = 0, db = 0;
        for (let x = lo; x < hi; x++) {
          const u = a[x] - ma, v = b[x + sh] - mb;
          num += u * v; da += u * u; db += v * v;
        }
        const r = num / (Math.sqrt(da * db) || 1e-9);
        if (r > bestR) { bestR = r; bestS = sh; }
      }
      return { shift: bestS, r: bestR };
    };

    /**
     * Where a fixed point of the world lands on screen, taken from the matrix
     * the frame was ACTUALLY drawn with. This is the primary measurement: it
     * follows the whole chain the player experiences — mouse delta, input,
     * yaw, view matrix, projection — and it has no correlation noise in it at
     * all, so it gives the same answer on an empty street and in a fog bank.
     *
     * It is not the circular test this file used to contain. That one compared
     * yaw against the same right-vector formula the movement code uses, so a
     * wrong assumption confirmed itself. This compares yaw against the matrix
     * the GPU consumed, which is the thing that was historically wrong.
     */
    const ndcOf = (p) => {
      const m = g.renderer.viewProj;
      const w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
      return { x: (m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12]) / w, w };
    };

    const measure = async (mirror) => {
      g.input.mirrorX = mirror;
      g.player.yaw = 0.7;
      g.player.pitch = 0;
      // A mark straight ahead and far enough away to be unaffected by the
      // camera's own bob.
      const mark = {
        x: g.player.x + Math.sin(0.7) * 400,
        y: g.player.eyeY,
        z: g.player.z + Math.cos(0.7) * 400,
      };
      await frame();
      const a = profile();
      const n0 = ndcOf(mark);
      g.input.locked = true;
      // A small turn: the pixel corroboration below models the frame as a
      // rigid translation, and over a large turn it simply is not one.
      g.input.mouse.dx = 40; g.input.mouse.dy = 0;
      const before = g.player.yaw;
      g.update(0.016);
      g.input.locked = false;
      await frame();
      const n1 = ndcOf(mark);
      const res = bestShift(a, profile());
      res.dyaw = g.player.yaw - before;
      // Negative = the world moved left on screen = the camera turned right.
      res.ndc = (n1.x - n0.x) * (n0.w > 0 && n1.w > 0 ? 1 : 0);
      return res;
    };
    const shipped = g.input.mirrorX;
    const normal = await measure(false);
    const mirrored = await measure(true);
    g.input.mirrorX = shipped;
    // What the pixel shift SHOULD be, from the geometry alone: a yaw change of
    // `dyaw` moves the scene by that fraction of the horizontal field of view.
    const fov = 1.48;
    const hfov = 2 * Math.atan(Math.tan(fov / 2) * (c.width / c.height));
    const predicted = -(normal.dyaw / hfov) * c.width;
    return { normal, mirrored, shipped, predicted };
  });
  // Unmirrored: mouse right => camera turns right => content slides LEFT.
  // mirrorX flips look and strafe together; it ships ON because unmirrored was
  // reported as reversed in play, so this asserts the two senses are opposites
  // and reports which one the build actually ships with.
  // Mouse right must move the world LEFT across the screen, and the mirror
  // toggle must reverse that. Judged on where a fixed point of the world
  // projected under the frame's own matrix, which is exact.
  const lookOk = axes.normal.ndc < -1e-6;
  const mirrorOk = axes.mirrored.ndc > 1e-6;
  console.log(`look: unmirrored moves the world ${axes.normal.ndc.toFixed(4)} in NDC ` +
    `— camera turns ${lookOk ? 'RIGHT' : 'LEFT'}; mirrored ` +
    `${axes.mirrored.ndc.toFixed(4)} ` +
    `${mirrorOk ? 'ok' : 'BROKEN — both senses agree, the toggle is dead'}; ` +
    `shipping ${axes.shipped ? 'MIRRORED' : 'UNMIRRORED'}`);
  if (!lookOk || !mirrorOk) logs.push('[fatal] horizontal look axis check failed');

  // Corroboration from the framebuffer itself, so the check is not resting
  // entirely on a matrix the renderer handed us. Only conclusive when the
  // correlation is actually strong: a low-contrast frame — fog, a blank wall,
  // sky — gives an arbitrary answer, and reporting one anyway is how the
  // previous version of this check came to "pass" on r=0.21.
  const pixOk = axes.normal.shift < 0;
  const strong = axes.normal.r > 0.55;
  console.log(`look: framebuffer agrees? ${strong ? (pixOk ? 'yes' : 'NO') : 'inconclusive'} ` +
    `(shift ${axes.normal.shift}px, predicted ${axes.predicted.toFixed(0)}px, ` +
    `r=${axes.normal.r.toFixed(2)})`);
  if (strong && pixOk !== lookOk) {
    logs.push('[fatal] the rendered frame disagrees with the view matrix about which way the camera turned');
  }

  // --- the cues that read a world bearing back to the player ---------------
  // Fixing the controls is only half of it: the compass, the damage arrows and
  // the stereo pan all answer "which side is that on", and each of them had the
  // sense backwards at some point. Reference is the projected position in the
  // framebuffer's own clip space, so nothing here can agree with itself.
  const cues = await page.evaluate(async () => {
    const g = window.__game;
    const { compassFrac } = await import('/src/game/hud.js');
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const out = [];
    const lm = g.world.landmarks[0];
    if (!lm) return out;
    const bearing = Math.atan2(lm.x - g.player.x, lm.z - g.player.z);
    for (const off of [0.35, -0.35]) {
      // Put the landmark a fixed angle off the centre of the view, either side.
      g.player.yaw = bearing + off;
      await frame();
      const m = g.renderer.viewProj;
      const w = m[3] * lm.x + m[7] * lm.y + m[11] * lm.z + m[15];
      const ndcX = (m[0] * lm.x + m[4] * lm.y + m[8] * lm.z + m[12]) / w;
      const pan = g.audio.spatial(lm.x, lm.y, lm.z, 1e9).pan;
      out.push({
        off, w,
        screen: Math.sign(ndcX),                                       // truth
        compass: Math.sign(compassFrac(g.player.yaw, bearing) - 0.5),  // the HUD's own mapping
        pan: Math.sign(pan),
      });
    }
    return out;
  });
  let cuesOk = cues.length > 0;
  for (const c of cues) {
    const side = c.screen > 0 ? 'RIGHT' : 'LEFT';
    const ok = c.w > 0 && c.compass === c.screen && c.pan === c.screen;
    if (!ok) cuesOk = false;
    console.log(`cues: landmark renders ${side} of centre -> compass ` +
      `${c.compass === c.screen ? 'agrees' : 'DISAGREES'}, stereo pan ` +
      `${c.pan === c.screen ? 'agrees' : 'DISAGREES'}`);
  }
  if (!cuesOk) logs.push('[fatal] compass / damage / audio disagree with the rendered image');

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
