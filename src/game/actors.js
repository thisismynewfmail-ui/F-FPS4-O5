// ---------------------------------------------------------------------------
// actors.js — the infected, their animation and their bodies.
//
// Each one is a dozen boxes posed on the CPU and written into a single
// rebuilt-every-frame vertex buffer, so a hundred of them still cost one draw
// call. The silhouettes are deliberately readable at 320x240: a shambler
// slumps, a runner leans, a hulk is twice as wide as anything else in the game.
// ---------------------------------------------------------------------------

import { RNG, TAU, clamp, clamp01, damp, lerp, angleDelta } from '../core/math.js';

export const TYPES = {
  shambler: {
    hp: 95, speed: 1.35, accel: 6, damage: 11, reach: 1.55, attackTime: 1.05,
    height: 1.78, width: 0.42, mass: 1, score: 10,
    skin: 'flesh_pale', cloth: ['cloth_civ', 'cloth_worker', 'cloth_dark'], pitch: 1,
  },
  worker: {
    hp: 130, speed: 1.25, accel: 5, damage: 14, reach: 1.6, attackTime: 1.15,
    height: 1.82, width: 0.46, mass: 1.2, score: 15,
    skin: 'flesh_grey', cloth: ['cloth_worker', 'cloth_hazmat'], pitch: 0.92,
  },
  runner: {
    hp: 58, speed: 4.35, accel: 14, damage: 9, reach: 1.4, attackTime: 0.62,
    height: 1.7, width: 0.36, mass: 0.75, score: 25,
    skin: 'flesh_pale', cloth: ['cloth_medic', 'cloth_civ'], pitch: 1.25,
  },
  crawler: {
    hp: 46, speed: 2.5, accel: 10, damage: 8, reach: 1.25, attackTime: 0.75,
    height: 0.95, width: 0.42, mass: 0.6, score: 20, crawl: true,
    skin: 'flesh_grey', cloth: ['cloth_dark', 'cloth_civ'], pitch: 1.4,
  },
  hulk: {
    hp: 430, speed: 1.9, accel: 5, damage: 34, reach: 2.0, attackTime: 1.5,
    height: 2.28, width: 0.72, mass: 3.4, score: 100, knockback: 9,
    skin: 'flesh_bloat', cloth: ['cloth_worker', 'cloth_dark'], pitch: 0.62,
  },
  officer: {
    hp: 210, speed: 2.6, accel: 9, damage: 18, reach: 1.6, attackTime: 0.85,
    height: 1.84, width: 0.5, mass: 1.6, score: 45, armor: 0.45,
    skin: 'flesh_grey', cloth: ['cloth_cop'], pitch: 0.85,
  },
};

const STATE = { IDLE: 0, ALERT: 1, CHASE: 2, ATTACK: 3, STAGGER: 4, DEAD: 5 };

let nextId = 1;

export class Zombie {
  constructor(type, x, y, z, rng) {
    const t = TYPES[type] || TYPES.shambler;
    this.id = nextId++;
    this.type = type;
    this.def = t;
    this.x = x; this.y = y; this.z = z;
    this.vx = 0; this.vz = 0; this.vy = 0;
    this.yaw = rng.range(0, TAU);
    this.hp = t.hp * rng.range(0.85, 1.15);
    this.maxHp = this.hp;
    this.state = STATE.IDLE;
    this.phase = rng.range(0, TAU);
    this.lean = rng.range(-0.14, 0.14);
    this.limpSide = rng.chance(0.5) ? 1 : -1;
    this.limp = rng.range(0, 0.35);
    this.attackCd = 0;
    this.growlCd = rng.range(1, 7);
    this.stagger = 0;
    this.deathT = 0;
    this.grounded = true;
    this.scale = rng.range(0.94, 1.07);
    this.skin = t.skin;
    this.cloth = rng.pick(t.cloth);
    this.pitchVar = t.pitch * rng.range(0.9, 1.12);
    this.target = null;
    this.repathT = rng.range(0, 0.4);
    this.wanderDir = rng.range(0, TAU);
    this.wanderT = 0;
    this.headHit = false;
    this.lastDamageDir = 0;
    this.floorY = y;
  }

  get alive() { return this.state !== STATE.DEAD; }
  get eyeY() { return this.y + this.def.height * this.scale * 0.86; }
  get radius() { return this.def.width * this.scale; }

  hurtBy(amount, dirX, dirZ, isHead) {
    if (this.state === STATE.DEAD) return 0;
    let dmg = amount;
    if (isHead) dmg *= 2.6;
    if (this.def.armor) dmg *= 1 - this.def.armor * (isHead ? 0.3 : 1);
    this.hp -= dmg;
    this.lastDamageDir = Math.atan2(dirX, dirZ);
    this.headHit = !!isHead;
    // Light types flinch; a hulk shrugs it off.
    const flinch = dmg / (this.maxHp * 0.55);
    if (flinch > 0.16 && this.def.mass < 3) this.stagger = Math.min(0.55, flinch * 0.5);
    if (this.state === STATE.IDLE) this.state = STATE.CHASE;
    if (this.hp <= 0) {
      this.state = STATE.DEAD;
      this.deathT = 0;
      this.deathSpin = (Math.random() - 0.5) * 3;
      this.overkill = this.hp < -this.maxHp * 0.55;
      return dmg;
    }
    return dmg;
  }
}

// ---------------------------------------------------------------------------

export class Horde {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.rng = new RNG(0xa11e5);
    this.gibs = [];
  }

  get liveCount() { let n = 0; for (const z of this.list) if (z.alive) n++; return n; }

  spawn(type, x, y, z) {
    const zb = new Zombie(type, x, y, z, this.rng);
    zb.floorY = y;
    this.list.push(zb);
    return zb;
  }

  clear() { this.list.length = 0; this.gibs.length = 0; }

  update(dt, player, collision, nav, audio) {
    const g = this.game;
    const px = player.x, pz = player.z, py = player.y;
    let nearest = Infinity;
    let alerted = 0;

    for (let i = this.list.length - 1; i >= 0; i--) {
      const z = this.list[i];

      if (z.state === STATE.DEAD) {
        z.deathT += dt;
        // Fall, then lie there for a while before being cleaned up.
        if (z.deathT > 22) { this.list.splice(i, 1); continue; }
        continue;
      }

      const dx = px - z.x, dz = pz - z.z;
      const dist = Math.hypot(dx, dz);
      const dy = py - z.y;
      if (dist < nearest) nearest = dist;

      // --- perception ------------------------------------------------------
      if (z.state === STATE.IDLE) {
        const facing = Math.abs(angleDelta(z.yaw, Math.atan2(dx, dz))) < 1.25;
        const canSee = dist < (facing ? 34 : 11) && Math.abs(dy) < 6
          && collision.lineOfSight(z.x, z.eyeY, z.z, px, py + 1.4, pz);
        if (canSee || dist < 4.5) {
          z.state = STATE.CHASE;
          if (audio && this.rng.chance(0.6)) audio.growl(z.x, z.eyeY, z.z, z.pitchVar, true);
        }
      }
      if (z.state !== STATE.IDLE) alerted++;

      // --- staggering ------------------------------------------------------
      if (z.stagger > 0) {
        z.stagger -= dt;
        z.vx = damp(z.vx, 0, 8, dt);
        z.vz = damp(z.vz, 0, 8, dt);
        this.integrate(z, dt, collision);
        continue;
      }

      let desiredX = 0, desiredZ = 0, speed = 0;

      if (z.state === STATE.IDLE) {
        // Milling about: slow, aimless, and it makes the town feel inhabited.
        z.wanderT -= dt;
        if (z.wanderT <= 0) {
          z.wanderT = this.rng.range(2.5, 7);
          z.wanderDir += this.rng.range(-1.6, 1.6);
        }
        desiredX = Math.sin(z.wanderDir);
        desiredZ = Math.cos(z.wanderDir);
        speed = z.def.speed * 0.28;
      } else {
        // --- routing -------------------------------------------------------
        z.repathT -= dt;
        const closeEnough = dist < 7 && collision.lineOfSight(z.x, z.eyeY, z.z, px, py + 1.2, pz);
        if (closeEnough) {
          desiredX = dx / (dist || 1);
          desiredZ = dz / (dist || 1);
        } else {
          const flow = nav.direction(z.x, z.z);
          if (flow) { desiredX = flow.x; desiredZ = flow.z; }
          else { desiredX = dx / (dist || 1); desiredZ = dz / (dist || 1); }
        }
        speed = z.def.speed;

        // --- attack --------------------------------------------------------
        z.attackCd -= dt;
        const reach = z.def.reach + player.radius;
        if (dist < reach && Math.abs(dy) < 2.0) {
          if (z.attackCd <= 0) {
            z.attackCd = z.def.attackTime;
            z.swing = 0.30;
            player.damage(z.def.damage * (g.difficulty || 1), z.x, z.z, z.def.knockback || 0);
            if (audio) audio.growl(z.x, z.eyeY, z.z, z.pitchVar, true);
          }
          speed *= 0.15;
        }
      }

      // --- separation, so they flow around each other -----------------------
      let sepX = 0, sepZ = 0;
      for (const o of this.list) {
        if (o === z || !o.alive) continue;
        const ox = z.x - o.x, oz = z.z - o.z;
        const d2 = ox * ox + oz * oz;
        const rr = (z.radius + o.radius) * 1.05;
        if (d2 > rr * rr || d2 < 1e-5) continue;
        const d = Math.sqrt(d2);
        const push = (rr - d) / rr;
        sepX += (ox / d) * push;
        sepZ += (oz / d) * push;
      }
      desiredX += sepX * 1.5;
      desiredZ += sepZ * 1.5;

      const dl = Math.hypot(desiredX, desiredZ) || 1;
      // Hills cost the horde too, and by the same rule they cost the player.
      // That is what makes high ground worth taking: a runner coming up at you
      // arrives slower than one coming along the street, and the moment you
      // give the slope back you are the one climbing.
      let grade = 1;
      if (collision.terrain) {
        const t = collision.terrain, e = 1.4;
        const ux = desiredX / dl, uz = desiredZ / dl;
        const rise = t.heightAt(z.x + ux * e, z.z + uz * e) - t.heightAt(z.x - ux * e, z.z - uz * e);
        grade = 1 - clamp((rise / (2 * e) - 0.16) / 0.62, 0, 1) * 0.55;
      }
      const speedG = speed * grade;
      const targetVX = (desiredX / dl) * speedG;
      const targetVZ = (desiredZ / dl) * speedG;
      const a = z.def.accel;
      z.vx = damp(z.vx, targetVX, a, dt);
      z.vz = damp(z.vz, targetVZ, a, dt);

      // Face where they are going.
      const moveLen = Math.hypot(z.vx, z.vz);
      if (moveLen > 0.12) {
        const want = Math.atan2(z.vx, z.vz);
        z.yaw += angleDelta(z.yaw, want) * Math.min(1, dt * 7);
      }
      z.phase += moveLen * dt * (z.def.crawl ? 5.2 : 3.1) / (z.def.height * 0.5);

      this.integrate(z, dt, collision);

      // --- voice -----------------------------------------------------------
      z.growlCd -= dt;
      if (z.growlCd <= 0) {
        z.growlCd = z.state === STATE.IDLE ? this.rng.range(5, 15) : this.rng.range(2.2, 6.5);
        if (audio && dist < 40) audio.growl(z.x, z.eyeY, z.z, z.pitchVar, z.state !== STATE.IDLE);
      }
    }

    // Gibs and dropped bits.
    for (let i = this.gibs.length - 1; i >= 0; i--) {
      const g2 = this.gibs[i];
      g2.life -= dt;
      if (g2.life <= 0) { this.gibs.splice(i, 1); continue; }
      g2.vy -= 22 * dt;
      g2.x += g2.vx * dt; g2.y += g2.vy * dt; g2.z += g2.vz * dt;
      g2.spin += g2.spinSpeed * dt;
      const floor = collision.floorAt(g2.x, g2.z, g2.y + 0.4, 0.5);
      if (g2.y <= floor + 0.05) {
        g2.y = floor + 0.05;
        g2.vy *= -0.28;
        g2.vx *= 0.55; g2.vz *= 0.55;
        g2.spinSpeed *= 0.5;
        if (Math.abs(g2.vy) < 0.6) { g2.vy = 0; g2.resting = true; }
      }
    }

    this.nearest = nearest;
    this.alerted = alerted;
  }

  integrate(z, dt, collision) {
    const r = z.radius;
    const headY = z.y + z.def.height * z.scale * 0.9;
    const res = collision.moveCircle(z.x, z.z, z.vx * dt, z.vz * dt, r, z.y, headY);
    // If we barely moved but wanted to, nudge sideways — stops them grinding
    // into a corner forever.
    z.x = res.x; z.z = res.z;

    const floor = collision.floorAt(z.x, z.z, z.y, 0.62);
    if (z.y > floor + 0.02) {
      z.vy -= 20 * dt;
      z.y += z.vy * dt;
      if (z.y <= floor) { z.y = floor; z.vy = 0; }
    } else {
      z.y = floor;
      z.vy = 0;
    }
    z.floorY = floor;
  }

  /** Nearest zombie hit by a ray, using capsule-ish sphere stacks. */
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let best = null;
    for (const z of this.list) {
      if (!z.alive) continue;
      const h = z.def.height * z.scale;
      // Two spheres: body and head. Head is the reward for aiming.
      const parts = [
        { y: z.y + h * 0.50, r: z.radius * 1.5, head: false },
        { y: z.y + h * 0.88, r: z.radius * 0.72, head: true },
      ];
      for (const p of parts) {
        const cx = z.x - ox, cy = p.y - oy, cz = z.z - oz;
        const t = cx * dx + cy * dy + cz * dz;
        if (t < 0 || t > maxDist) continue;
        const px = dx * t - cx, py = dy * t - cy, pz = dz * t - cz;
        const d2 = px * px + py * py + pz * pz;
        if (d2 > p.r * p.r) continue;
        const back = Math.sqrt(p.r * p.r - d2);
        const hitT = t - back;
        if (hitT < 0) continue;
        if (!best || hitT < best.dist) {
          best = { dist: hitT, zombie: z, head: p.head, x: ox + dx * hitT, y: oy + dy * hitT, z: oz + dz * hitT };
        }
      }
    }
    return best;
  }

  spawnGibs(z, count, lib, rng) {
    for (let i = 0; i < count; i++) {
      const a = rng.range(0, TAU);
      const s = rng.range(1.5, 5.5);
      this.gibs.push({
        x: z.x, y: z.y + z.def.height * 0.6, z: z.z,
        vx: Math.cos(a) * s, vy: rng.range(2, 6.5), vz: Math.sin(a) * s,
        size: rng.range(0.09, 0.22),
        spin: rng.range(0, TAU), spinSpeed: rng.range(-9, 9),
        life: rng.range(6, 12),
        mat: rng.chance(0.7) ? z.skin : 'blood_pool',
      });
    }
  }

  // --- rendering -----------------------------------------------------------

  /** Pose and emit every visible body into the dynamic mesh builder. */
  render(mb, lib, camera, maxDist = 90) {
    const cx = camera.pos.x, cz = camera.pos.z;
    const d2max = maxDist * maxDist;
    for (const z of this.list) {
      const dx = z.x - cx, dz = z.z - cz;
      if (dx * dx + dz * dz > d2max) continue;
      this.renderOne(mb, lib, z);
    }
    // Gibs.
    for (const g of this.gibs) {
      const m = lib.m(g.mat, 0.6);
      mb.push(g.x, g.y, g.z, g.spin);
      mb.boxC(0, -g.size / 2, 0, g.size, g.size, g.size * 1.4, m, { noTess: true });
      mb.pop();
    }
  }

  renderOne(mb, lib, z) {
    const d = z.def;
    const s = z.scale;
    const skin = lib.m(z.skin, 0.9);
    const cloth = lib.m(z.cloth, 0.9);
    const dark = lib.m('cloth_dark', 0.9);

    // Death: collapse over half a second and stay down.
    let fall = 0;
    if (z.state === STATE.DEAD) fall = clamp01(z.deathT / 0.55);
    const fallAngle = fall * (Math.PI / 2) * (fall < 1 ? 1 : 1);

    const crawl = d.crawl;
    const H = d.height * s;
    const hipY = crawl ? H * 0.42 : H * 0.50;
    const walk = Math.sin(z.phase);
    const walk2 = Math.sin(z.phase + Math.PI);
    const bob = Math.abs(Math.sin(z.phase)) * 0.045 * (crawl ? 0.3 : 1);
    const speedF = clamp01(Math.hypot(z.vx, z.vz) / Math.max(d.speed, 0.01));

    // Build the pose in body-local space, then rotate into the world.
    const cy = Math.cos(z.yaw), sy = Math.sin(z.yaw);
    // Falling rotates the whole body about its own right axis.
    const fallC = Math.cos(fallAngle), fallS = Math.sin(fallAngle);
    const spin = z.state === STATE.DEAD ? (z.deathSpin || 0) * fall * 0.3 : 0;

    const toWorld = (lx, ly, lz) => {
      // Local: x right, y up, z forward.
      let px = lx, py = ly, pz = lz;
      if (fall > 0) {
        const ny = py * fallC - pz * fallS;
        const nz = py * fallS + pz * fallC;
        py = ny - fall * hipY * 0.55; pz = nz;
      }
      const rx = px * Math.cos(spin) - pz * Math.sin(spin);
      const rz = px * Math.sin(spin) + pz * Math.cos(spin);
      return [
        z.x + rx * cy + rz * sy,
        z.y + py + bob,
        z.z - rx * sy + rz * cy,
      ];
    };
    const L = (ax, ay, az, bx, by, bz, hw, hh, m) => {
      const a = toWorld(ax, ay, az), b = toWorld(bx, by, bz);
      mb.limb(a[0], a[1], a[2], b[0], b[1], b[2], hw, hh, m);
    };

    const lean = z.lean + (crawl ? 0.9 : (z.state === STATE.CHASE ? 0.22 : 0.10)) * (1 - fall);
    const shoulderY = hipY + H * (crawl ? 0.10 : 0.30);
    const headY = shoulderY + H * (crawl ? 0.10 : 0.13);
    const w = d.width * s;

    // Legs: alternate swing, with a limp on one side.
    const legLen = hipY;
    const swing = walk * 0.55 * (0.3 + speedF);
    const swing2 = walk2 * 0.55 * (0.3 + speedF);
    for (const [side, sw] of [[-1, swing], [1, swing2]]) {
      const hipX = side * w * 0.42;
      const limpF = side === z.limpSide ? 1 - z.limp * 0.5 : 1;
      const kneeY = hipY * 0.52;
      const kneeZ = Math.sin(sw) * legLen * 0.32;
      const footZ = Math.sin(sw) * legLen * 0.58;
      const footY = Math.max(0, Math.cos(sw) * 0.06);
      L(hipX, hipY, 0, hipX, kneeY, kneeZ * limpF, w * 0.20, w * 0.20, cloth);
      L(hipX, kneeY, kneeZ * limpF, hipX, footY, footZ * limpF, w * 0.17, w * 0.17, cloth);
      // Foot.
      L(hipX, footY + 0.03, footZ * limpF, hipX, footY + 0.03, footZ * limpF + 0.20, w * 0.19, w * 0.09, dark);
    }

    // Torso: leaning forward, hips to shoulders.
    const shZ = Math.sin(lean) * H * 0.16;
    L(0, hipY, 0, 0, shoulderY, shZ, w * 0.52, w * 0.34, cloth);
    // Chest plate for a bit of silhouette.
    L(-w * 0.30, shoulderY - 0.04, shZ, w * 0.30, shoulderY - 0.04, shZ, w * 0.30, w * 0.26, cloth);

    // Head, tilted.
    const headZ = shZ + Math.sin(lean) * H * 0.10;
    L(0, shoulderY, shZ, 0, headY, headZ, w * 0.26, w * 0.24, skin);
    L(-w * 0.02, headY - 0.02, headZ, -w * 0.02, headY + H * 0.085, headZ + 0.02, w * 0.30, w * 0.28, skin);

    // Arms: reaching forward when chasing, hanging when idle.
    const reach = z.state === STATE.CHASE || z.state === STATE.ATTACK ? 1 : 0.15;
    const swingA = (z.swing > 0 ? 1.4 : 0);
    if (z.swing > 0) z.swing -= 1 / 60;
    for (const [side, ph] of [[-1, walk2], [1, walk]]) {
      const shX = side * w * 0.62;
      const elbowZ = lerp(ph * 0.18, 0.42, reach) + swingA * 0.25;
      const elbowY = shoulderY - H * 0.16;
      const handZ = lerp(ph * 0.30, 0.86, reach) + swingA * 0.42;
      const handY = elbowY - H * (reach > 0.5 ? 0.02 : 0.16);
      L(shX, shoulderY - 0.02, shZ, shX * 1.05, elbowY, shZ + elbowZ, w * 0.17, w * 0.17, cloth);
      L(shX * 1.05, elbowY, shZ + elbowZ, shX * 1.05, handY, shZ + handZ, w * 0.15, w * 0.15, skin);
    }
  }
}

export { STATE };
