// ---------------------------------------------------------------------------
// game.js — the loop that owns everything.
// ---------------------------------------------------------------------------

import { RNG, TAU, clamp, clamp01, damp, dist2D, lerp } from '../core/math.js';
import { MeshBuilder } from '../render/meshbuilder.js';
import { buildLibrary } from '../art/materials.js';
import { makeTownConfig } from '../world/config.js';
import { World } from '../world/world.js';
import { NavGrid } from './nav.js';
import { Player } from './player.js';
import { Arsenal, WEAPONS } from './weapons.js';
import { Horde, TYPES } from './actors.js';
import { Director } from './director.js';
import { drawHUD } from './hud.js';
import * as P from '../world/props.js';

const PRESETS = {
  authentic: { internalHeight: 240, snapDiv: 2.4, affine: 0.85, dither: 1.0, scanline: 0.10, grain: 0.030 },
  soft: { internalHeight: 360, snapDiv: 3.2, affine: 0.55, dither: 0.7, scanline: 0.05, grain: 0.02 },
  clean: { internalHeight: 540, snapDiv: 8.0, affine: 0.0, dither: 0.35, scanline: 0.0, grain: 0.012 },
};

export class Game {
  constructor(renderer, input, audio, opts = {}) {
    this.renderer = renderer;
    this.input = input;
    this.audio = audio;
    this.seed = opts.seed ?? 20250802;
    this.rng = new RNG(this.seed ^ 0x1234);
    this.state = 'loading';
    this.toasts = [];
    this.stats = { kills: 0, headshots: 0, shots: 0, hits: 0, damage: 0 };
    this.fps = 0;
    this.frameMs = 0;
    this.showDebug = false;
    this.crosshairHot = 0;
    this.prompt = null;
    this.difficulty = opts.difficulty || 1;
    this.presetName = opts.preset || 'authentic';
    this.fadeIn = 1;
    this.items = [];
    this.particles = [];
    this.dynamicLights = [];
    this.time = 0;
  }

  // --- loading -------------------------------------------------------------

  async load(onProgress) {
    const report = async (label, frac) => {
      if (onProgress) onProgress(label, frac);
      await new Promise((r) => setTimeout(r, 0));
    };

    await report('Mixing paint', 0.02);
    this.lib = buildLibrary(this.seed);
    const tasks = this.lib.tasks;
    for (let i = 0; i < tasks.length; i++) {
      tasks[i].run();
      if ((i & 15) === 0) await report(`Painting textures (${i}/${tasks.length})`, 0.02 + 0.34 * (i / tasks.length));
    }

    await report('Uploading materials', 0.38);
    this.renderer.uploadMaterials(this.lib);

    this.cfg = makeTownConfig(this.seed);
    this.world = new World({ lib: this.lib, cfg: this.cfg, seed: this.seed });
    const steps = this.world.steps();
    for (let i = 0; i < steps.length; i++) {
      await report(steps[i][0], 0.40 + 0.45 * (i / steps.length));
      steps[i][1]();
    }

    await report('Uploading geometry', 0.87);
    this.chunks = this.world.uploadChunks(this.renderer.gl, this.renderer.world,
      (gl, prog, v, idx) => this.renderer.createMesh(v, idx));

    await report('Mapping routes', 0.93);
    this.nav = new NavGrid(this.cfg.bounds);
    this.nav.build(this.world.collision);

    await report('Loading in', 0.97);
    this.setupSession();
    await report('Ready', 1);
    this.state = 'play';
    return this;
  }

  setupSession() {
    const start = this.world.playerStart;
    this.player = new Player(start.x, start.z, this.world.playerYaw);
    this.player.y = this.world.collision.floorAt(start.x, start.z, 2, 3);
    this.arsenal = new Arsenal(this.audio);
    this.horde = new Horde(this);
    this.director = new Director(this.world, this.horde, { seed: this.seed, difficulty: this.difficulty });
    this.dynamicMesh = this.renderer.createDynamic(90000);
    this.viewMesh = this.renderer.createDynamic(4000);
    // Actors are lit by the world's own probe so they sit in the scene instead
    // of glowing; the viewmodel keeps a fixed key light since it is in hand.
    this.dynBuilder = new MeshBuilder({ probe: this.world.probe, maxEdge: 999 });
    this.viewBuilder = new MeshBuilder({ probe: () => [1.25, 1.22, 1.14], maxEdge: 999 });
    this.applyPreset(this.presetName);
    this.spawnItems();
    this.toast('SIGNAL LOST. HOLD POSITION.', [1, 0.8, 0.4]);
    this.toast('WASD MOVE  LMB FIRE  R RELOAD  F LAMP  E USE', [0.8, 0.85, 0.8]);
  }

  applyPreset(name) {
    const p = PRESETS[name] || PRESETS.authentic;
    this.presetName = name;
    this.preset = p;
    this.renderer.setInternalHeight(p.internalHeight);
  }

  /** Turn the generator's loot points into things you can pick up. */
  spawnItems() {
    const rng = this.rng;
    const loot = this.world.loot.slice();
    rng.shuffle(loot);
    const budget = Math.min(loot.length, 260);
    const weaponPlan = ['smg', 'shotgun', 'rifle', 'smg', 'shotgun'];
    let wi = 0;
    for (let i = 0; i < budget; i++) {
      const l = loot[i];
      if (!l || !l.p) continue;
      let kind;
      const r = rng.next();
      if (wi < weaponPlan.length && (l.kind === 'locker' || l.kind === 'register' || l.kind === 'tools') && rng.chance(0.5)) {
        kind = weaponPlan[wi++];
      } else if (l.kind === 'medicine' || l.kind === 'fridge') kind = r < 0.6 ? 'health' : 'ammo';
      else if (l.kind === 'locker') kind = r < 0.5 ? 'armor' : 'ammo';
      else if (r < 0.46) kind = 'ammo';
      else if (r < 0.72) kind = 'health';
      else if (r < 0.85) kind = 'armor';
      else continue;
      this.items.push({
        kind, x: l.p.x, y: l.p.y + 0.05, z: l.p.z,
        bob: rng.range(0, TAU), taken: false,
      });
    }
  }

  toast(text, col = [1, 0.8, 0.4]) {
    this.toasts.unshift({ text, col, t: 4.5 });
    if (this.toasts.length > 5) this.toasts.pop();
  }

  restart() {
    this.horde.clear();
    this.items.length = 0;
    this.particles.length = 0;
    this.stats = { kills: 0, headshots: 0, shots: 0, hits: 0, damage: 0 };
    this.toasts.length = 0;
    const start = this.world.playerStart;
    this.player = new Player(start.x, start.z, this.world.playerYaw);
    this.player.y = this.world.collision.floorAt(start.x, start.z, 2, 3);
    this.arsenal = new Arsenal(this.audio);
    this.director = new Director(this.world, this.horde, { seed: this.seed + 1, difficulty: this.difficulty });
    this.spawnItems();
    this.fadeIn = 1;
    this.state = 'play';
  }

  // --- update --------------------------------------------------------------

  update(dt) {
    this.time += dt;
    const input = this.input;

    if (input.justPressed('F3')) this.showDebug = !this.showDebug;
    if (input.justPressed('F2')) {
      const order = ['authentic', 'soft', 'clean'];
      const next = order[(order.indexOf(this.presetName) + 1) % order.length];
      this.applyPreset(next);
      this.toast(`RENDER: ${next.toUpperCase()}`, [0.7, 0.9, 1]);
    }
    if (input.justPressed('Escape')) {
      if (this.state === 'play') { this.state = 'paused'; input.exitLock(); }
    }
    if (this.state === 'paused' && input.locked) this.state = 'play';

    if (this.player.dead) {
      if (input.justPressed('Enter') || input.justPressed('NumpadEnter')) { this.restart(); return; }
    }
    if (this.state !== 'play') { this.updateEffects(dt); return; }

    this.fadeIn = Math.max(0, this.fadeIn - dt * 0.7);

    // --- player -----------------------------------------------------------
    this.player.speedScale = 1;
    this.player.update(dt, input, this.world.collision, this.audio);
    if (this.player.madeNoise) {
      this.director.makeNoise(this.player.madeNoise);
      this.player.madeNoise = 0;
    }

    if (this.audio) {
      this.audio.listener.x = this.player.x;
      this.audio.listener.y = this.player.eyeY;
      this.audio.listener.z = this.player.z;
      this.audio.listener.yaw = this.player.yaw;
    }

    if (!this.player.dead) {
      if (input.justPressed('KeyF')) {
        this.player.torchOn = !this.player.torchOn && this.player.torchBattery > 0.02;
      }
      // --- weapons --------------------------------------------------------
      const a = this.arsenal;
      a.update(dt, this.player, input);
      const order = ['crowbar', 'pistol', 'smg', 'shotgun', 'rifle'];
      for (let i = 0; i < order.length; i++) {
        if (input.justPressed(`Digit${i + 1}`)) a.select(order[i]);
      }
      if (input.mouse.wheel) a.nextWeapon(input.mouse.wheel > 0 ? 1 : -1);
      if (input.justPressed('KeyR')) a.startReload();
      if (input.justPressed('KeyQ')) a.nextWeapon(1);

      const wantFire = a.def.auto ? input.mouseDown(0) : input.mouseJustPressed(0);
      if (wantFire || (a.def.melee && input.mouseDown(0))) {
        const shot = a.fire(this.player, this.rng);
        if (shot) this.resolveShot(shot);
      }
      this.tryInteract(input);
    }

    // --- AI ---------------------------------------------------------------
    this.navTimer = (this.navTimer || 0) - dt;
    if (this.navTimer <= 0) {
      this.navTimer = 0.28;
      this.nav.update(this.player.x, this.player.z);
    }
    this.horde.update(dt, this.player, this.world.collision, this.nav, this.audio);
    this.director.update(dt, this.player, this.player, this.world.collision, this.audio);

    // Ambient dread.
    this.moanTimer = (this.moanTimer || 6) - dt;
    if (this.moanTimer <= 0) {
      this.moanTimer = this.rng.range(9, 26);
      if (this.audio) this.audio.distantMoan();
    }

    this.updateEffects(dt);
    this.updateCrosshairHeat(dt);
  }

  updateEffects(dt) {
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      this.toasts[i].t -= dt;
      if (this.toasts[i].t <= 0) this.toasts.splice(i, 1);
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      p.vy -= 16 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.vx *= 0.96; p.vz *= 0.96;
    }
    for (const it of this.items) if (!it.taken) it.bob += dt * 2.2;
  }

  updateCrosshairHeat(dt) {
    this.crosshairHot = Math.max(0, this.crosshairHot - dt * 4);
    const d = this.player.lookDir();
    const hit = this.horde.raycast(this.player.x, this.player.eyeY, this.player.z, d.x, d.y, d.z, 60);
    if (hit) {
      const wall = this.world.collision.raycast(this.player.x, this.player.eyeY, this.player.z, d.x, d.y, d.z, hit.dist);
      if (!wall) this.crosshairHot = 1;
    }
  }

  // --- combat --------------------------------------------------------------

  resolveShot(shot) {
    const p = this.player;
    const ox = p.x, oy = p.eyeY, oz = p.z;
    this.stats.shots++;

    if (shot.melee) {
      // A short arc rather than a ray: swinging a crowbar should not need
      // pixel-perfect aim.
      const d = shot.def;
      let best = null;
      for (const z of this.horde.list) {
        if (!z.alive) continue;
        const dx = z.x - ox, dz = z.z - oz;
        const dist = Math.hypot(dx, dz);
        if (dist > d.range + z.radius) continue;
        const ang = Math.atan2(dx, dz);
        if (Math.abs(((ang - p.yaw + Math.PI * 3) % TAU) - Math.PI) > d.arc) continue;
        if (!best || dist < best.dist) best = { dist, z };
      }
      if (best) {
        const dmg = best.z.hurtBy(d.damage, best.z.x - ox, best.z.z - oz, false);
        this.onHit(best.z, dmg, best.z.x, best.z.y + best.z.def.height * 0.6, best.z.z, false);
      }
      return;
    }

    for (const dir of shot.shots) {
      let remaining = shot.def.penetrate || 1;
      let originX = ox, originY = oy, originZ = oz;
      let maxDist = shot.def.range;
      const hitAlready = new Set();
      while (remaining > 0) {
        const zh = this.horde.raycast(originX, originY, originZ, dir.x, dir.y, dir.z, maxDist);
        const wh = this.world.collision.raycast(originX, originY, originZ, dir.x, dir.y, dir.z, maxDist);
        if (zh && (!wh || zh.dist < wh.dist) && !hitAlready.has(zh.zombie.id)) {
          hitAlready.add(zh.zombie.id);
          const dmg = zh.zombie.hurtBy(shot.def.damage, dir.x, dir.z, zh.head);
          this.onHit(zh.zombie, dmg, zh.x, zh.y, zh.z, zh.head);
          remaining--;
          originX = zh.x + dir.x * 0.15;
          originY = zh.y + dir.y * 0.15;
          originZ = zh.z + dir.z * 0.15;
          maxDist -= zh.dist + 0.15;
          if (maxDist <= 0) break;
        } else if (wh) {
          this.spawnImpact(wh.x, wh.y, wh.z, wh.nx, wh.ny, wh.nz, 'wall');
          if (this.audio) this.audio.impact('wall', wh.x, wh.y, wh.z);
          break;
        } else break;
      }
    }
  }

  onHit(z, dmg, x, y, zz, head) {
    this.stats.hits++;
    this.stats.damage += dmg;
    if (head) this.stats.headshots++;
    this.spawnImpact(x, y, zz, 0, 1, 0, 'flesh');
    if (this.audio) this.audio.impact('flesh', x, y, zz);
    if (!z.alive) {
      this.stats.kills++;
      this.director.onKill(z);
      const gibs = z.overkill ? 12 : 4;
      this.horde.spawnGibs(z, gibs, this.lib, this.rng);
      if (this.audio && z.overkill) this.audio.gib(z.x, z.y + 1, z.z);
      if (z.type === 'hulk') this.toast('HULK DOWN', [1, 0.5, 0.3]);
    }
  }

  spawnImpact(x, y, z, nx, ny, nz, kind) {
    const n = kind === 'flesh' ? 7 : 5;
    for (let i = 0; i < n; i++) {
      const a = this.rng.range(0, TAU);
      const s = this.rng.range(1.2, 4.5);
      this.particles.push({
        x, y, z,
        vx: nx * 1.6 + Math.cos(a) * s * 0.5,
        vy: ny * 1.6 + this.rng.range(0.8, 3.2),
        vz: nz * 1.6 + Math.sin(a) * s * 0.5,
        size: this.rng.range(0.03, 0.09),
        life: this.rng.range(0.3, 0.85),
        mat: kind === 'flesh' ? 'blood_splat' : 'prop_dirtmetal',
      });
    }
  }

  // --- interaction ---------------------------------------------------------

  tryInteract(input) {
    this.prompt = null;
    const p = this.player;
    let best = null;
    for (const it of this.items) {
      if (it.taken) continue;
      const d = dist2D(it.x, it.z, p.x, p.z);
      if (d > 2.2 || Math.abs(it.y - p.y) > 2.4) continue;
      if (!best || d < best.d) best = { d, it };
    }
    if (!best) return;
    const it = best.it;
    const label = {
      health: 'MEDKIT', ammo: 'AMMUNITION', armor: 'BODY ARMOUR',
      smg: 'SMG', shotgun: 'PUMP SHOTGUN', rifle: 'HUNTING RIFLE',
    }[it.kind] || it.kind.toUpperCase();
    this.prompt = `[E]  ${label}`;
    if (!input.justPressed('KeyE')) return;

    it.taken = true;
    if (it.kind === 'health') {
      this.player.heal(28);
      this.toast('+28 HEALTH', [0.5, 1, 0.5]);
      if (this.audio) this.audio.pickup('health');
    } else if (it.kind === 'armor') {
      this.player.addArmor(30);
      this.toast('+30 ARMOUR', [0.5, 0.8, 1]);
      if (this.audio) this.audio.pickup('armor');
    } else if (it.kind === 'ammo') {
      this.arsenal.giveAmmoAll(1);
      this.toast('AMMUNITION RESUPPLIED', [1, 0.85, 0.4]);
      if (this.audio) this.audio.pickup('ammo');
    } else if (WEAPONS[it.kind]) {
      const isNew = !this.arsenal.owned[it.kind];
      this.arsenal.give(it.kind, WEAPONS[it.kind].clip * 3);
      this.toast(isNew ? `PICKED UP ${WEAPONS[it.kind].name}` : `${WEAPONS[it.kind].name} AMMO`, [1, 0.9, 0.5]);
      if (isNew) this.arsenal.select(it.kind);
      if (this.audio) this.audio.pickup('weapon');
    }
  }

  // --- rendering -----------------------------------------------------------

  render(dt) {
    const r = this.renderer;
    const preset = this.preset;
    const camera = this.player.camera(lerp(1.48, 0.85, this.arsenal ? this.arsenal.zoomT : 0));

    const env = {
      fogStart: this.cfg.fogStart,
      fogEnd: this.cfg.fogEnd,
      fogColor: [0.406, 0.424, 0.435],
      skyTop: [0.235, 0.271, 0.325],
      skyHorizon: [0.478, 0.478, 0.463],
      cloudDark: [0.263, 0.267, 0.290],
      cloudLight: [0.545, 0.537, 0.514],
      sunGlow: [0.451, 0.400, 0.302],
      sunDir: this.world.env.sunDir,
      overcast: 0.88,
      snap: r.rt.width / preset.snapDiv,
      affine: preset.affine,
      ambientBoost: 1.0,
      grain: preset.grain,
      vignette: 0.55,
      scanline: preset.scanline,
      dither: preset.dither,
      grade: [1.02, 1.0, 0.96],
      viewDistance: 300,
      viewmodelFov: 1.15,
    };

    r.beginFrame(camera, env, dt);
    r.drawSky(env);

    // Nearest dynamic lights: lit lamps, plus the muzzle flash.
    const lights = this.gatherLights(camera);
    const torch = {
      on: this.player.torchOn && !this.player.dead,
      pos: camera.pos,
      dir: this.player.lookDir(),
      color: [0.95, 0.88, 0.72],
      range: 26,
      cosInner: Math.cos(0.28),
      cosOuter: Math.cos(0.52),
    };
    r.beginWorld(env, lights, torch);
    r.drawChunks(this.chunks, env.fogEnd + 34);

    // Dynamic geometry.
    const mb = this.dynBuilder;
    mb.reset();
    this.horde.render(mb, this.lib, camera, env.fogEnd);
    this.renderItems(mb);
    this.renderParticles(mb);
    if (!mb.isEmpty) {
      const arrays = mb.toArrays();
      r.updateDynamic(this.dynamicMesh, arrays.vertices, arrays.vertCount,
        new Uint32Array(arrays.indices), arrays.indices.length);
      r.drawDynamicMesh(this.dynamicMesh);
    }

    // Viewmodel.
    if (!this.player.dead) {
      const vb = this.viewBuilder;
      vb.reset();
      this.arsenal.renderViewmodel(vb, this.lib, this.player, dt);
      if (!vb.isEmpty) {
        const arrays = vb.toArrays();
        r.updateDynamic(this.viewMesh, arrays.vertices, arrays.vertCount,
          new Uint32Array(arrays.indices), arrays.indices.length);
        r.drawViewmodel(this.viewMesh, env, torch,
          this.arsenal.sway.x * 0.5, -this.arsenal.sway.y * 0.5 + this.arsenal.kick * 0.22);
      }
    }

    r.endFrame(env, {
      hurt: clamp01(this.player.hurtFlash * 0.9 + (this.player.health < 30 ? 0.14 + Math.sin(this.time * 4) * 0.05 : 0)),
      fade: this.fadeIn,
    });
    drawHUD(r, this, dt);
  }

  gatherLights(camera) {
    const out = [];
    const px = camera.pos.x, pz = camera.pos.z;
    // Muzzle flash first: it should never be culled.
    if (this.arsenal && this.arsenal.fireFlash > 0.3) {
      const m = this.arsenal.muzzleWorld(this.player);
      const i = this.arsenal.fireFlash;
      out.push({ x: m.x, y: m.y, z: m.z, r: 16, c: [1.5 * i, 1.25 * i, 0.75 * i] });
    }
    const cands = [];
    for (const L of this.world.lights) {
      const d = dist2D(L.p.x, L.p.z, px, pz);
      if (d > L.r + 6) continue;
      cands.push({ d, L });
    }
    cands.sort((a, b) => a.d - b.d);
    for (let i = 0; i < cands.length && out.length < 8; i++) {
      const L = cands[i].L;
      let k = 1;
      if (L.flicker) {
        const n = Math.sin(this.time * 11.3 + L.p.x) * Math.sin(this.time * 7.7 + L.p.z);
        k = n > -0.55 ? 1 : 0.15;
      }
      out.push({ x: L.p.x, y: L.p.y, z: L.p.z, r: L.r, c: [L.c[0] * k, L.c[1] * k, L.c[2] * k] });
    }
    return out;
  }

  renderItems(mb) {
    const px = this.player.x, pz = this.player.z;
    for (const it of this.items) {
      if (it.taken) continue;
      if (dist2D(it.x, it.z, px, pz) > 34) continue;
      const y = it.y + 0.14 + Math.sin(it.bob) * 0.05;
      const yaw = it.bob * 0.6;
      mb.push(it.x, y, it.z, yaw);
      if (it.kind === 'health') {
        mb.boxC(0, 0, 0, 0.30, 0.16, 0.22, this.lib.m('prop_white', 0.5), { noTess: true });
        mb.boxC(0, 0.16, 0, 0.20, 0.01, 0.14, this.lib.m('sign_medical'), { noTess: true });
      } else if (it.kind === 'armor') {
        mb.boxC(0, 0, 0, 0.30, 0.36, 0.16, this.lib.m('prop_blue', 0.6), { noTess: true });
        mb.boxC(0, 0.06, -0.09, 0.16, 0.16, 0.02, this.lib.m('prop_chrome', 0.4), { noTess: true });
      } else if (it.kind === 'ammo') {
        mb.boxC(0, 0, 0, 0.34, 0.18, 0.24, this.lib.m('prop_olive' in this.lib.mats ? 'prop_olive' : 'prop_green', 0.5), { noTess: true });
        mb.boxC(0, 0.18, 0, 0.30, 0.03, 0.20, this.lib.m('prop_darksteel', 0.4), { noTess: true });
      } else {
        // A weapon lying on the ground.
        mb.boxC(0, 0.02, 0, 0.10, 0.09, 0.70, this.lib.m('gun_dark', 0.5), { noTess: true });
        mb.boxC(0, 0.0, -0.18, 0.09, 0.16, 0.12, this.lib.m('gun_wood', 0.5), { noTess: true });
      }
      mb.pop();
    }
  }

  renderParticles(mb) {
    for (const p of this.particles) {
      const m = this.lib.m(p.mat, 0.4);
      mb.push(p.x, p.y, p.z, p.life * 6);
      mb.boxC(0, 0, 0, p.size, p.size, p.size, m, { noTess: true });
      mb.pop();
    }
  }
}
