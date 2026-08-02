// ---------------------------------------------------------------------------
// hud.js — the overlay, drawn at the internal resolution so the pixels line up
// with the world behind it.
//
// Layout follows the reference era: condition bottom-left, ammunition
// bottom-right, everything in chunky amber type. The compass strip along the
// top names the town's landmarks rather than drawing a map, so wayfinding stays
// a matter of looking at the skyline.
// ---------------------------------------------------------------------------

import { clamp, clamp01, angleDelta, dist2D } from '../core/math.js';

const AMBER = [1.0, 0.76, 0.30, 1];
const AMBER_DIM = [0.85, 0.62, 0.22, 0.75];
const RED = [0.95, 0.28, 0.22, 1];
const GREY = [0.72, 0.74, 0.72, 0.85];
const WHITE = [0.92, 0.94, 0.92, 1];

export function drawHUD(r, game, dt) {
  const W = r.rt.width, H = r.rt.height;
  r.setUISize(W, H);
  r.uiBegin();

  const player = game.player;
  const arsenal = game.arsenal;
  const director = game.director;
  const s = Math.max(1, Math.round(H / 240));   // integer HUD scale

  // --- crosshair ----------------------------------------------------------
  if (!player.dead && game.state === 'play') {
    const cx = Math.round(W / 2), cy = Math.round(H / 2);
    const spread = 3 + arsenal.recoil * 12 + (arsenal.def.spread * 190);
    const gap = Math.round(spread * s * 0.5);
    const len = Math.round(4 * s);
    const th = Math.max(1, Math.round(s));
    const col = game.crosshairHot > 0 ? RED : [0.88, 0.92, 0.86, 0.85];
    if (arsenal.zoomT < 0.6) {
      r.uiRect(cx - gap - len, cy - th / 2, len, th, col);
      r.uiRect(cx + gap, cy - th / 2, len, th, col);
      r.uiRect(cx - th / 2, cy - gap - len, th, len, col);
      r.uiRect(cx - th / 2, cy + gap, th, len, col);
    } else {
      // Scope reticle.
      r.uiRect(cx - 40 * s, cy - th / 2, 80 * s, th, [0, 0, 0, 0.9]);
      r.uiRect(cx - th / 2, cy - 40 * s, th, 80 * s, [0, 0, 0, 0.9]);
      r.uiRect(cx - th, cy - th, th * 2, th * 2, RED);
    }
    r.uiRect(cx - th / 2, cy - th / 2, th, th, [col[0], col[1], col[2], 0.5]);
  }

  // --- condition (bottom left) --------------------------------------------
  const pad = 6 * s;
  const baseY = H - pad - 22 * s;
  const hp = Math.max(0, Math.round(player.health));
  const hpCol = hp < 25 ? RED : AMBER;
  r.uiText('HEALTH', pad, baseY - 9 * s, s, AMBER_DIM);
  r.uiText(String(hp).padStart(3, ' '), pad, baseY, s * 2.4, hpCol);
  const barW = 46 * s;
  r.uiRect(pad, baseY + 21 * s, barW, 2 * s, [0.2, 0.16, 0.1, 0.8]);
  r.uiRect(pad, baseY + 21 * s, barW * clamp01(player.health / player.maxHealth), 2 * s, hpCol);

  if (player.armor > 0) {
    const ax = pad + 60 * s;
    r.uiText('ARMOR', ax, baseY - 9 * s, s, AMBER_DIM);
    r.uiText(String(Math.round(player.armor)).padStart(3, ' '), ax, baseY, s * 2.4, [0.55, 0.78, 0.95, 1]);
    r.uiRect(ax, baseY + 21 * s, barW, 2 * s, [0.14, 0.18, 0.24, 0.8]);
    r.uiRect(ax, baseY + 21 * s, barW * clamp01(player.armor / 100), 2 * s, [0.55, 0.78, 0.95, 1]);
  }

  // Stamina, only while it matters.
  if (player.sprintStamina < 0.995) {
    const sy = baseY + 26 * s;
    r.uiRect(pad, sy, barW, 2 * s, [0.16, 0.16, 0.16, 0.7]);
    r.uiRect(pad, sy, barW * player.sprintStamina, 2 * s, [0.55, 0.6, 0.55, 0.8]);
  }

  // --- ammunition (bottom right) ------------------------------------------
  const def = arsenal.def;
  const rightX = W - pad;
  r.uiText(def.name, rightX - r.textWidth(def.name, s), baseY - 9 * s, s, AMBER_DIM);
  if (!def.melee) {
    const clipTxt = String(arsenal.clipCount);
    const resTxt = def.infinite ? '---' : String(arsenal.reserveCount);
    const clipW = r.textWidth(clipTxt, s * 2.4);
    const resW = r.textWidth(resTxt, s * 1.3);
    const lowClip = arsenal.clipCount <= def.clip * 0.25;
    r.uiText(clipTxt, rightX - clipW - resW - 8 * s, baseY, s * 2.4, lowClip ? RED : AMBER);
    r.uiText('/', rightX - resW - 6 * s, baseY + 7 * s, s * 1.3, AMBER_DIM);
    r.uiText(resTxt, rightX - resW, baseY + 7 * s, s * 1.3, AMBER_DIM);
    if (arsenal.reloading > 0) {
      const t = 1 - clamp01(arsenal.reloading / Math.max(def.reload, 0.01));
      const rw = 40 * s;
      r.uiRect(rightX - rw, baseY + 22 * s, rw, 2 * s, [0.25, 0.2, 0.1, 0.9]);
      r.uiRect(rightX - rw, baseY + 22 * s, rw * t, 2 * s, AMBER);
    } else if (arsenal.clipCount === 0) {
      const txt = 'RELOAD [R]';
      r.uiText(txt, rightX - r.textWidth(txt, s), baseY + 20 * s, s, RED);
    }
  } else {
    r.uiText('MELEE', rightX - r.textWidth('MELEE', s * 2), baseY, s * 2, AMBER_DIM);
  }

  // --- weapon list --------------------------------------------------------
  let wy = baseY - 22 * s;
  const order = ['crowbar', 'pistol', 'smg', 'shotgun', 'rifle'];
  for (let i = order.length - 1; i >= 0; i--) {
    const k = order[i];
    if (!arsenal.owned[k]) continue;
    const isCur = k === arsenal.current;
    const label = `${i + 1} ${k.toUpperCase()}`;
    r.uiText(label, rightX - r.textWidth(label, s), wy, s, isCur ? AMBER : [0.6, 0.58, 0.5, 0.55]);
    wy -= 9 * s;
  }

  // --- torch --------------------------------------------------------------
  if (player.torchBattery < 0.999 || !player.torchOn) {
    const tx = pad;
    const ty = baseY - 20 * s;
    r.uiText('LAMP', tx, ty, s, player.torchOn ? AMBER_DIM : [0.5, 0.5, 0.5, 0.6]);
    r.uiRect(tx + 26 * s, ty + 2 * s, 24 * s, 3 * s, [0.18, 0.16, 0.12, 0.8]);
    r.uiRect(tx + 26 * s, ty + 2 * s, 24 * s * player.torchBattery, 3 * s,
      player.torchBattery < 0.2 ? RED : [0.85, 0.78, 0.5, 0.9]);
  }

  // --- wave state (top left) ----------------------------------------------
  r.uiText(director.message, pad, pad, s * 1.6, AMBER);
  r.uiText(director.submessage, pad, pad + 15 * s, s, AMBER_DIM);
  const kills = `KILLS ${game.stats.kills}`;
  r.uiText(kills, pad, pad + 25 * s, s, [0.6, 0.58, 0.5, 0.7]);

  // --- compass with landmark bearings (top centre) -------------------------
  drawCompass(r, game, W, s);

  // --- big notice ---------------------------------------------------------
  if (director.noticeT > 0 && director.notice) {
    const a = clamp01(director.noticeT / 0.7);
    const scale = s * 3;
    const w = r.textWidth(director.notice, scale);
    r.uiText(director.notice, Math.round((W - w) / 2), Math.round(H * 0.30), scale,
      [AMBER[0], AMBER[1], AMBER[2], a]);
  }

  // --- pickup / interaction prompt ----------------------------------------
  if (game.prompt) {
    const w = r.textWidth(game.prompt, s);
    r.uiText(game.prompt, Math.round((W - w) / 2), Math.round(H * 0.60), s, WHITE);
  }

  // --- damage direction indicators ----------------------------------------
  const cx = W / 2, cy = H / 2;
  for (const d of player.damageDirs) {
    const rel = angleDelta(player.yaw, d.ang);
    const a = clamp01(d.t / 1.4);
    const dist = 46 * s;
    const px = cx + Math.sin(rel) * dist;
    const py = cy - Math.cos(rel) * dist * 0.6;
    r.uiRect(px - 5 * s, py - 1.5 * s, 10 * s, 3 * s, [0.9, 0.15, 0.1, a * 0.85]);
  }

  // --- toast log ----------------------------------------------------------
  let ty = pad + 40 * s;
  for (const t of game.toasts) {
    const a = clamp01(t.t / 0.8);
    r.uiText(t.text, pad, ty, s, [t.col[0], t.col[1], t.col[2], a]);
    ty += 10 * s;
  }

  // --- death / pause ------------------------------------------------------
  if (player.dead) {
    const t1 = 'YOU DIED';
    const t2 = `HELD ${game.director.wave > 1 ? game.director.wave - 1 : 0} WAVES   ${game.stats.kills} KILLED`;
    const t3 = 'PRESS ENTER TO TRY AGAIN';
    r.uiRect(0, 0, W, H, [0.1, 0.0, 0.0, 0.35]);
    r.uiText(t1, Math.round((W - r.textWidth(t1, s * 4)) / 2), Math.round(H * 0.34), s * 4, RED);
    r.uiText(t2, Math.round((W - r.textWidth(t2, s)) / 2), Math.round(H * 0.48), s, GREY);
    r.uiText(t3, Math.round((W - r.textWidth(t3, s * 1.2)) / 2), Math.round(H * 0.56), s * 1.2, AMBER);
  } else if (game.state === 'paused') {
    const t1 = 'PAUSED';
    r.uiRect(0, 0, W, H, [0, 0, 0, 0.45]);
    r.uiText(t1, Math.round((W - r.textWidth(t1, s * 3)) / 2), Math.round(H * 0.40), s * 3, AMBER);
    const t2 = 'CLICK TO RESUME';
    r.uiText(t2, Math.round((W - r.textWidth(t2, s)) / 2), Math.round(H * 0.52), s, GREY);
  }

  if (game.showDebug) drawDebug(r, game, s);
  r.uiFlush();
}

function drawCompass(r, game, W, s) {
  const player = game.player;
  const cw = 140 * s;
  const x0 = Math.round((W - cw) / 2);
  const y = 4 * s;
  r.uiRect(x0, y, cw, 11 * s, [0.05, 0.05, 0.05, 0.35]);

  const fov = 1.6;   // radians of bearing shown across the strip
  const mark = (ang, label, col) => {
    const rel = angleDelta(player.yaw, ang);
    if (Math.abs(rel) > fov / 2) return;
    const px = Math.round(x0 + cw / 2 + (rel / fov) * cw);
    r.uiRect(px, y, Math.max(1, s), 4 * s, col);
    if (label) {
      const w = r.textWidth(label, s * 0.85);
      r.uiText(label, Math.round(px - w / 2), y + 4 * s, s * 0.85, col);
    }
  };

  for (const [ang, label] of [[0, 'N'], [Math.PI / 2, 'E'], [Math.PI, 'S'], [-Math.PI / 2, 'W']]) {
    mark(ang, label, [0.7, 0.72, 0.68, 0.75]);
  }
  for (const lm of game.world.landmarks) {
    const ang = Math.atan2(lm.x - player.x, lm.z - player.z);
    const d = Math.round(dist2D(lm.x, lm.z, player.x, player.z));
    mark(ang, `${lm.name.toUpperCase()} ${d}`, [1.0, 0.76, 0.3, 0.8]);
  }
  // Centre tick.
  r.uiRect(Math.round(x0 + cw / 2), y - 2 * s, Math.max(1, s), 3 * s, [1, 1, 1, 0.9]);
}

function drawDebug(r, game, s) {
  const lines = [
    `fps ${game.fps.toFixed(0)}  frame ${game.frameMs.toFixed(1)}ms`,
    `draws ${game.renderer.stats.drawCalls}  tris ${(game.renderer.stats.tris / 1000).toFixed(1)}k  chunks ${game.renderer.stats.chunks}`,
    `pos ${game.player.x.toFixed(1)} ${game.player.y.toFixed(1)} ${game.player.z.toFixed(1)}`,
    `alive ${game.horde.liveCount}  stress ${game.director.stress.toFixed(2)}  phase ${game.director.phase}`,
    `world ${(game.world.stats.tris / 1000).toFixed(0)}k tris  ${game.world.stats.chunks} chunks  ${game.world.stats.buildings} buildings`,
  ];
  let y = 4 * s;
  const x = 4 * s;
  for (const l of lines) {
    r.uiText(l, x, y, s * 0.9, [0.5, 1.0, 0.6, 0.9]);
    y += 9 * s;
  }
}
