// ---------------------------------------------------------------------------
// main.js — boot, loading screen and the frame loop.
// ---------------------------------------------------------------------------

import { Renderer } from './render/renderer.js';
import { Input } from './core/input.js';
import { Audio } from './core/audio.js';
import { Game } from './game/game.js';

// Bumped whenever input handling changes, so a stale cached copy is obvious.
export const BUILD = 'ashgrove-2026-08-02-e';

const canvas = document.getElementById('view');
const loadingEl = document.getElementById('loading');
const barEl = document.getElementById('bar');
const labelEl = document.getElementById('label');
const startEl = document.getElementById('start');
const errorEl = document.getElementById('error');

function fail(err) {
  console.error(err);
  errorEl.style.display = 'block';
  errorEl.textContent = `${err.message || err}\n\n${err.stack || ''}`;
  loadingEl.style.display = 'none';
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const seed = Number(params.get('seed')) || 20250802;
  const preset = params.get('preset') || 'authentic';

  console.log(`[build] ${BUILD}  (if this is not the newest build you are running a cached copy — hard-reload with Ctrl+Shift+R)`);
  const stamp = document.getElementById('build');
  if (stamp) stamp.textContent = BUILD;

  let renderer, input, audio, game;
  try {
    renderer = new Renderer(canvas, { internalHeight: 240 });
  } catch (e) { fail(e); return; }

  input = new Input(canvas);
  // Horizontal mirror is a URL-only escape hatch, like inverty. It used to be a
  // key you could hit by accident and a saved preference, which meant a single
  // stray F4 left both horizontal axes inverted in every later session with
  // nothing on screen to say why. Drop any such leftover on the way past.
  if (params.has('mirrorx')) input.mirrorX = params.get('mirrorx') !== '0';
  try { localStorage.removeItem('ashgrove.mirrorX'); } catch { /* private mode */ }
  if (params.has('inverty')) input.invertY = params.get('inverty') !== '0';
  if (params.has('sens')) input.sensitivity = Number(params.get('sens')) || input.sensitivity;
  audio = new Audio();
  game = new Game(renderer, input, audio, { seed, preset, difficulty: Number(params.get('difficulty')) || 1 });
  window.__game = game;
  window.__build = BUILD;

  try {
    await game.load((label, frac) => {
      labelEl.textContent = label;
      barEl.style.width = `${Math.round(frac * 100)}%`;
    });
  } catch (e) { fail(e); return; }

  // Report what was actually built, so the generator's output is inspectable.
  const s = game.world.stats;
  const counts = [...game.world.programmeCounts.entries()]
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
  console.log(`[world] seed ${seed} · ${s.buildings} buildings · ${(s.tris / 1000).toFixed(0)}k tris · ` +
    `${s.chunks} chunks · ${s.collision.segments} wall segments · ${s.collision.floors} floors · ` +
    `${s.spawns} spawn points · ${s.loot} loot points`);
  console.log(`[programme] ${counts}`);
  window.__worldStats = s;

  loadingEl.classList.add('done');
  startEl.style.display = 'flex';

  const begin = () => {
    audio.init();
    audio.resume();
    input.requestLock();
    startEl.style.display = 'none';
    loadingEl.style.display = 'none';
  };
  startEl.addEventListener('click', begin);
  canvas.addEventListener('click', () => {
    audio.resume();
    if (game.state !== 'loading') input.requestLock();
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' && startEl.style.display !== 'none') begin();
  });

  window.addEventListener('resize', () => renderer.resize());

  let last = performance.now();
  let acc = 0, frames = 0;
  function frame(now) {
    const t0 = performance.now();
    let dt = (now - last) / 1000;
    last = now;
    if (!isFinite(dt) || dt < 0) dt = 0;
    dt = Math.min(dt, 0.1);          // never let one hitch teleport the horde

    try {
      game.update(dt);
      game.render(dt);
    } catch (e) { fail(e); return; }
    input.endFrame();

    game.frameMs = performance.now() - t0;
    acc += dt; frames++;
    if (acc >= 0.5) { game.fps = frames / acc; acc = 0; frames = 0; }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot();
