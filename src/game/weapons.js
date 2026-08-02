// ---------------------------------------------------------------------------
// weapons.js — the arsenal and the viewmodel.
//
// Five weapons, each with a distinct job in a wave defence: the crowbar for
// when you are dry, the pistol as an infinite fallback, the SMG for streams,
// the shotgun for doorways, and the rifle for the hulk walking up the avenue.
//
// Viewmodels are procedural boxes posed in view space. Remember the camera
// convention: with +Z forward and +Y up, screen-right is world −X, hence
// SCREEN_RIGHT below.
// ---------------------------------------------------------------------------

import { TAU, clamp, clamp01, damp, lerp } from '../core/math.js';

const SCREEN_RIGHT = -1;

export const WEAPONS = {
  crowbar: {
    name: 'CROWBAR', slot: 1, melee: true,
    damage: 42, rate: 0.62, range: 2.1, arc: 0.55,
    clip: 0, reserve: 0, spread: 0, recoil: 0.012,
    kick: 0.05, sound: null, ammoType: null,
  },
  pistol: {
    name: '9MM PISTOL', slot: 2,
    damage: 26, rate: 0.17, range: 120, pellets: 1,
    clip: 17, reserve: 68, maxReserve: 200, reload: 1.35,
    spread: 0.011, recoil: 0.028, kick: 0.09, sound: 'pistol', ammoType: '9mm',
    infinite: true,
  },
  smg: {
    name: 'SMG', slot: 3,
    damage: 20, rate: 0.082, range: 110, pellets: 1,
    clip: 35, reserve: 140, maxReserve: 420, reload: 1.85,
    spread: 0.026, recoil: 0.022, kick: 0.055, sound: 'smg', ammoType: '9mm', auto: true,
  },
  shotgun: {
    name: 'PUMP SHOTGUN', slot: 4,
    damage: 15, rate: 0.78, range: 34, pellets: 9,
    clip: 6, reserve: 32, maxReserve: 90, reload: 0.55, shellReload: true,
    spread: 0.088, recoil: 0.10, kick: 0.30, sound: 'shotgun', ammoType: 'shell',
  },
  rifle: {
    name: 'HUNTING RIFLE', slot: 5,
    damage: 110, rate: 1.05, range: 200, pellets: 1,
    clip: 5, reserve: 20, maxReserve: 60, reload: 2.4,
    spread: 0.0035, recoil: 0.085, kick: 0.26, sound: 'rifle', ammoType: 'rifle',
    penetrate: 3, zoom: 0.55,
  },
};

export class Arsenal {
  constructor(audio) {
    this.audio = audio;
    this.owned = { crowbar: true, pistol: true, smg: false, shotgun: false, rifle: false };
    this.ammo = {};
    this.clip = {};
    for (const k in WEAPONS) {
      this.clip[k] = WEAPONS[k].clip;
      this.ammo[k] = WEAPONS[k].reserve;
    }
    this.current = 'pistol';
    this.cooldown = 0;
    this.reloading = 0;
    this.reloadStage = 0;
    this.swap = 0;
    this.swapTo = null;
    this.recoil = 0;
    this.kick = 0;
    this.sway = { x: 0, y: 0 };
    this.bobPhase = 0;
    this.fireFlash = 0;
    this.shellsLoaded = 0;
    this.zoomT = 0;
    this.pumpT = 0;
  }

  get def() { return WEAPONS[this.current]; }
  get clipCount() { return this.clip[this.current]; }
  get reserveCount() { return this.ammo[this.current]; }

  give(name, ammo) {
    if (WEAPONS[name] && !this.owned[name]) {
      this.owned[name] = true;
      this.clip[name] = WEAPONS[name].clip;
      return true;
    }
    if (WEAPONS[name]) {
      const d = WEAPONS[name];
      this.ammo[name] = Math.min(d.maxReserve || 999, this.ammo[name] + (ammo || d.clip * 2));
      return true;
    }
    return false;
  }

  giveAmmoAll(mult = 1) {
    for (const k in WEAPONS) {
      const d = WEAPONS[k];
      if (!d.maxReserve || !this.owned[k]) continue;
      this.ammo[k] = Math.min(d.maxReserve, this.ammo[k] + Math.ceil(d.clip * 1.5 * mult));
    }
  }

  select(name) {
    if (!this.owned[name] || name === this.current || this.swapTo) return false;
    this.swapTo = name;
    this.swap = 0.22;
    this.reloading = 0;
    return true;
  }

  nextWeapon(dir) {
    const list = Object.keys(WEAPONS).filter((k) => this.owned[k]);
    const i = list.indexOf(this.current);
    const n = list[(i + dir + list.length * 2) % list.length];
    this.select(n);
  }

  canFire() {
    return this.cooldown <= 0 && this.reloading <= 0 && !this.swapTo
      && (this.def.melee || this.clip[this.current] > 0);
  }

  startReload() {
    const d = this.def;
    if (d.melee || this.reloading > 0) return false;
    if (this.clip[this.current] >= d.clip) return false;
    if (this.ammo[this.current] <= 0) return false;
    this.reloading = d.shellReload ? d.reload : d.reload;
    this.reloadStage = 0;
    if (this.audio) this.audio.reload('out');
    return true;
  }

  update(dt, player, input) {
    this.cooldown -= dt;
    this.fireFlash = Math.max(0, this.fireFlash - dt * 7);
    this.pumpT = Math.max(0, this.pumpT - dt);
    this.recoil = damp(this.recoil, 0, 8, dt);
    this.kick = damp(this.kick, 0, 11, dt);

    if (this.swapTo) {
      this.swap -= dt;
      if (this.swap <= 0) {
        this.current = this.swapTo;
        this.swapTo = null;
        this.swap = 0.22;
      }
    } else if (this.swap > 0) this.swap -= dt;

    if (this.reloading > 0) {
      this.reloading -= dt;
      const d = this.def;
      if (d.shellReload) {
        if (this.reloading <= 0) {
          // One shell at a time; keep going until full or empty.
          const need = d.clip - this.clip[this.current];
          if (need > 0 && this.ammo[this.current] > 0) {
            this.clip[this.current]++;
            this.ammo[this.current]--;
            if (this.audio) this.audio.reload('in');
            if (this.clip[this.current] < d.clip && this.ammo[this.current] > 0) {
              this.reloading = d.reload;
            }
          }
        }
      } else if (this.reloading <= 0) {
        const need = d.clip - this.clip[this.current];
        const take = Math.min(need, this.ammo[this.current]);
        this.clip[this.current] += take;
        this.ammo[this.current] -= take;
        if (this.audio) this.audio.reload('in');
      }
    }

    // Sway lags the look direction — the classic weighty viewmodel.
    const targetX = clamp(-input.mouse.dx * 0.0016, -0.06, 0.06);
    const targetY = clamp(input.mouse.dy * 0.0016, -0.05, 0.05);
    this.sway.x = damp(this.sway.x, targetX, 9, dt);
    this.sway.y = damp(this.sway.y, targetY, 9, dt);
    this.bobPhase += Math.hypot(player.vx, player.vz) * dt * 1.9;

    const wantZoom = this.def.zoom && input.mouseDown(2) && !this.reloading;
    this.zoomT = damp(this.zoomT, wantZoom ? 1 : 0, 11, dt);
  }

  /** Fire. Returns a list of shots (ray directions) for the game to trace. */
  fire(player, rng) {
    const d = this.def;
    if (!this.canFire()) {
      if (!d.melee && this.clip[this.current] <= 0 && this.cooldown <= 0) {
        this.cooldown = 0.28;
        if (this.audio) this.audio.dryFire();
        if (this.reserveCount > 0) this.startReload();
      }
      return null;
    }
    this.cooldown = d.rate;
    this.recoil = Math.min(1, this.recoil + d.recoil * 14);
    this.kick = d.kick;
    if (!d.melee) {
      this.clip[this.current]--;
      this.fireFlash = 1;
      if (d.shellReload) this.pumpT = d.rate * 0.75;
      if (this.audio) {
        this.audio.gunshot(d.sound, player.x, player.eyeY, player.z);
        if (d.sound === 'shotgun' || d.sound === 'rifle') this.audio.shellDrop(player.x, player.eyeY, player.z);
      }
      player.viewKickPitch += d.recoil * (0.85 + rng.next() * 0.4);
      player.viewKickYaw += (rng.next() - 0.5) * d.recoil * 0.8;
      player.madeNoise = 55;
    } else {
      if (this.audio) this.audio.melee(player.x, player.eyeY, player.z);
      player.madeNoise = 6;
    }

    const dir = player.lookDir();
    const shots = [];
    const spread = d.spread * (1 + this.recoil * 0.9) * (this.zoomT > 0.5 ? 0.35 : 1);
    const n = d.pellets || 1;
    for (let i = 0; i < n; i++) {
      // Random cone around the view ray.
      const a = rng.range(0, TAU);
      const r = Math.sqrt(rng.next()) * spread;
      const ox = Math.cos(a) * r, oy = Math.sin(a) * r;
      // Build the cone in the camera basis.
      const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
      const rightX = -cy, rightZ = sy;
      const upX = -sy * Math.sin(player.pitch);
      const upY = Math.cos(player.pitch);
      const upZ = -cy * Math.sin(player.pitch);
      let vx = dir.x + rightX * ox + upX * oy;
      let vy = dir.y + upY * oy;
      let vz = dir.z + rightZ * ox + upZ * oy;
      const l = Math.hypot(vx, vy, vz) || 1;
      shots.push({ x: vx / l, y: vy / l, z: vz / l });
    }
    return { shots, def: d, melee: !!d.melee };
  }

  // --- viewmodel -----------------------------------------------------------

  /**
   * Emit the weapon in view space. The mesh builder is in the camera's frame:
   * +Z is forward, +Y up, and screen-right is −X.
   */
  renderViewmodel(mb, lib, player, dt) {
    const d = this.def;
    const bob = clamp01(Math.hypot(player.vx, player.vz) / 6);
    const bx = Math.cos(this.bobPhase) * 0.022 * bob;
    const by = Math.abs(Math.sin(this.bobPhase)) * -0.018 * bob;

    // Swap dip, reload tilt, recoil push.
    const swapDip = this.swapTo ? (1 - clamp01(this.swap / 0.22)) * -0.26
      : (this.swap > 0 ? clamp01(this.swap / 0.22) * -0.26 : 0);
    const reloadT = this.reloading > 0 ? clamp01(this.reloading / Math.max(d.reload, 0.01)) : 0;
    const reloadDip = Math.sin(reloadT * Math.PI) * (d.shellReload ? -0.06 : -0.16);
    const reloadRoll = Math.sin(reloadT * Math.PI) * (d.shellReload ? 0.18 : 0.55);
    const pump = this.pumpT > 0 ? Math.sin((1 - this.pumpT / (d.rate * 0.75)) * Math.PI) : 0;

    const zoom = this.zoomT;
    const baseX = lerp(0.165, 0.0, zoom) * SCREEN_RIGHT;
    const baseY = lerp(-0.170, -0.078, zoom);
    const baseZ = lerp(0.60, 0.70, zoom);

    const px = baseX + bx + this.sway.x * SCREEN_RIGHT;
    const py = baseY + by + swapDip + reloadDip + this.sway.y - this.kick * 0.10;
    const pz = baseZ - this.kick * 0.16 - pump * 0.05;

    // A few degrees of yaw so you see the weapon's side profile rather than
    // an edge-on slab.
    mb.push(px, py, pz, 0.22);
    // Tilt: recoil pitches the muzzle up, reloading rolls the weapon inward.
    const tilt = this.kick * 0.5;
    const M = (n, t) => lib.m(n, t);
    const metal = M('gun_metal', 0.35);
    const dark = M('gun_metal', 0.5);   // pure black reads as a hole at 320x240
    const wood = M('gun_wood', 0.6);
    const grip = M('gun_grip', 0.4);

    // Everything below is authored in metres at arm's length; X is negated so
    // positive numbers read as "toward screen right".
    const R = SCREEN_RIGHT;
    // Viewmodels are modelled at true scale and then shrunk, the way shooters
    // have always done it: a real rifle held at arm's length fills half the
    // screen and you cannot see past it.
    const S = 0.72;
    const box = (cx, cy, cz, sx, sy2, sz, m) =>
      mb.boxC(cx * R * S, cy * S, cz * S, sx * S, sy2 * S, sz * S, m, { noTess: true });

    switch (this.current) {
      case 'crowbar': {
        const sw = this.cooldown > 0 ? Math.sin(clamp01(1 - this.cooldown / d.rate) * Math.PI) : 0;
        mb.push(0, -sw * 0.10, sw * 0.22, 0);
        box(0.02, -0.02 - reloadRoll * 0.1, 0.02, 0.035, 0.30, 0.035, metal);
        box(0.02, 0.26, 0.02, 0.035, 0.035, 0.30, metal);
        box(0.02, 0.28, 0.20, 0.035, 0.10, 0.035, metal);
        box(0.02, -0.06, 0.0, 0.05, 0.14, 0.05, grip);
        mb.pop();
        break;
      }
      case 'pistol': {
        box(0, 0.02, 0.12, 0.055, 0.080, 0.34, dark);        // slide
        box(0, -0.015, 0.10, 0.065, 0.055, 0.26, metal);     // frame
        box(0, -0.145, -0.04, 0.058, 0.19, 0.090, grip);     // grip
        box(0, -0.045, 0.02, 0.036, 0.05, 0.05, metal);      // trigger guard
        box(0, 0.065, 0.275, 0.014, 0.020, 0.024, metal);    // front sight
        box(0, 0.065, -0.02, 0.036, 0.020, 0.024, metal);    // rear sight
        box(0, -0.02, 0.30, 0.030, 0.030, 0.05, dark);       // muzzle
        break;
      }
      case 'smg': {
        box(0, 0.0, 0.14, 0.05, 0.085, 0.42, dark);
        box(0, 0.075, 0.10, 0.035, 0.03, 0.30, metal);       // rail
        box(0, -0.14, 0.06, 0.042, 0.20, 0.075, dark);       // magazine
        box(0, -0.10, -0.10, 0.045, 0.13, 0.075, grip);      // pistol grip
        box(0, -0.02, 0.40, 0.028, 0.028, 0.12, metal);      // barrel
        box(0, 0.02, -0.16, 0.035, 0.05, 0.14, dark);        // stock
        box(0, 0.10, 0.30, 0.012, 0.02, 0.02, metal);
        break;
      }
      case 'shotgun': {
        mb.push(0, 0, -pump * 0.07, 0);
        box(0, 0.02, 0.20, 0.05, 0.06, 0.62, metal);         // barrel
        box(0, -0.05, 0.16, 0.048, 0.05, 0.52, dark);        // tube
        mb.pop();
        mb.push(0, 0, pump * 0.11, 0);
        box(0, -0.05, 0.16, 0.062, 0.062, 0.20, wood);       // pump grip
        mb.pop();
        box(0, -0.03, -0.10, 0.055, 0.09, 0.24, wood);       // receiver
        box(0, -0.12, -0.26, 0.05, 0.14, 0.22, wood);        // stock
        box(0, 0.06, 0.48, 0.012, 0.02, 0.02, metal);
        break;
      }
      case 'rifle': {
        box(0, 0.0, 0.30, 0.038, 0.05, 0.86, metal);         // barrel
        box(0, -0.02, -0.02, 0.055, 0.09, 0.34, wood);       // receiver
        box(0, -0.10, -0.28, 0.05, 0.15, 0.28, wood);        // stock
        box(0, -0.04, 0.24, 0.05, 0.055, 0.26, wood);        // forestock
        box(0, 0.10, 0.10, 0.032, 0.032, 0.30, dark);        // scope tube
        box(0, 0.10, 0.26, 0.042, 0.042, 0.05, dark);
        box(0, 0.10, -0.06, 0.042, 0.042, 0.05, dark);
        box(0, 0.05, 0.05, 0.02, 0.06, 0.03, metal);         // bolt
        break;
      }
      default: break;
    }

    // Muzzle flash sprite, on for a couple of frames.
    if (this.fireFlash > 0.25 && !d.melee) {
      const mz = ({ pistol: 0.34, smg: 0.50, shotgun: 0.56, rifle: 0.80 }[this.current] || 0.4) * 0.72;
      const s = (0.13 + this.fireFlash * 0.12) * 0.72;
      const fm = lib.m('muzzle_flash');
      mb.quad([-s * R, -s, mz], [s * R, -s, mz], [s * R, s, mz], [-s * R, s, mz],
        [0, 0, 1, 1], fm.layer, [0, 0, -1], { noTess: true });
      mb.quad([-s * 0.6 * R, -s * 0.6, mz + 0.12], [s * 0.6 * R, -s * 0.6, mz + 0.12],
        [s * 0.6 * R, s * 0.6, mz + 0.12], [-s * 0.6 * R, s * 0.6, mz + 0.12],
        [0, 0, 1, 1], fm.layer, [0, 0, -1], { noTess: true });
    }
    mb.pop();
    return { tilt, reloadRoll };
  }

  muzzleWorld(player) {
    const d = player.lookDir();
    return {
      x: player.x + d.x * 0.6,
      y: player.eyeY + d.y * 0.6 - 0.12,
      z: player.z + d.z * 0.6,
    };
  }
}
