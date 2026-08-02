// Isolate a ground-rendering artefact: same camera, four sampling/warp modes.
//   node tools/diag-ground.mjs <outdir> [seed]
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, normalize } from 'node:path';

const ROOT = resolve(process.cwd());
const OUT = process.argv[2] || '/tmp/shots';
const SEED = process.argv[3] || '20250802';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
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
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
page.on('pageerror', (e) => console.log('ERR', e.message));
await page.goto(`http://localhost:${server.address().port}/?seed=${SEED}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.state !== 'loading', { timeout: 180000 });

// Stand on the largest patch of grass and look down it at a grazing angle.
await page.evaluate(() => {
  document.getElementById('start').style.display = 'none';
  document.getElementById('loading').style.display = 'none';
  const g = window.__game;
  g.fadeIn = 0;
  g.player.maxHealth = 1e9; g.player.health = 1e9;
  g.horde.clear();
  let best = null;
  for (const b of g.world.blocks) {
    if (!b.buildable || b.zone === 'core' || b.zone === 'industrial') continue;
    const a = Math.abs(b.area || 0);
    if (!best || a > best.a) best = { a, b };
  }
  if (best) {
    const c = best.b.centroid;
    g.player.x = c.x; g.player.z = c.z;
    g.player.y = g.world.collision.floorAt(c.x, c.z, 4, 6);
  }
  g.player.pitch = -0.32;
  g.player.hurtFlash = 0;
  window.__set = (fn) => fn(window.__game);
});
await page.waitForTimeout(600);

const modes = [
  ['A-as-shipped', () => {}],
  ['B-affine-off', (g) => { g.preset.affine = 0; }],
  ['C-trilinear', (g) => {
    const gl = g.renderer.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, g.renderer.atlas.tex);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  }],
  ['D-trilinear-aniso', (g) => {
    const gl = g.renderer.gl;
    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, g.renderer.atlas.tex);
    if (ext) gl.texParameterf(gl.TEXTURE_2D_ARRAY, ext.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    console.log('aniso ext:', !!ext);
  }],
  ['E-affine-on-aniso', (g) => { g.preset.affine = 0.85; }],
];
for (const [name, fn] of modes) {
  await page.evaluate(`window.__set(${fn.toString()})`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/ground-${name}.png` });
}
await browser.close();
server.close();
