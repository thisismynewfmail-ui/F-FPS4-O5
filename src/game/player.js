// ---------------------------------------------------------------------------
// player.js — movement, camera and condition.
//
// Half-Life-era feel on purpose: high acceleration, hard stops, audible
// footsteps, a step-up that clears kerbs without a jump, crouching that lets
// you get under a half-shuttered door, and a view bob you can read your own
// speed from.
// ---------------------------------------------------------------------------

import { TAU, clamp, clamp01, damp, lerp } from '../core/math.js';

const STAND_H = 1.78;
const CROUCH_H = 1.10;
const EYE_RATIO = 0.90;

export class Player {
  constructor(x, z, yaw) {
    this.x = x; this.y = 0; this.z = z;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.yaw = yaw || 0;
    this.pitch = 0;
    this.radius = 0.36;
    this.height = STAND_H;
    this.crouching = false;
    this.grounded = true;
    this.health = 100;
    this.maxHealth = 100;
    this.armor = 0;
    this.dead = false;

    this.bob = 0;
    this.bobAmount = 0;
    this.stepTimer = 0;
    this.landDip = 0;
    this.viewKickPitch = 0;
    this.viewKickYaw = 0;
    this.roll = 0;
    this.hurtFlash = 0;
    this.lastDamageAt = -99;
    this.graceTime = 0.34;
    this.damageDirs = [];

    this.torchOn = false;      // you have to reach for it
    this.torchBattery = 1;
    this.sprintStamina = 1;
    this.footstepPhase = 0;
    this.speedScale = 1;
  }

  get eyeY() { return this.y + this.height * EYE_RATIO + this.landDip; }
  get headY() { return this.y + this.height; }

  /** Forward direction on the ground plane. */
  get forwardX() { return Math.sin(this.yaw); }
  get forwardZ() { return Math.cos(this.yaw); }

  lookDir() {
    const cp = Math.cos(this.pitch);
    return { x: Math.sin(this.yaw) * cp, y: Math.sin(this.pitch), z: Math.cos(this.yaw) * cp };
  }

  damage(amount, fromX, fromZ, knockback = 0) {
    if (this.dead) return;
    // A short grace window after any hit. Without it, being surrounded by a
    // dozen infected removes a full health bar inside a second and there is no
    // play in the fight at all.
    const now = performance.now() / 1000;
    if (now - this.lastDamageAt < 0.34) {
      if (knockback && fromX !== undefined) {
        const dx = this.x - fromX, dz = this.z - fromZ;
        const l = Math.hypot(dx, dz) || 1;
        this.vx += (dx / l) * knockback * 0.4;
        this.vz += (dz / l) * knockback * 0.4;
      }
      return;
    }
    let dmg = amount;
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, dmg * 0.55);
      this.armor -= absorbed;
      dmg -= absorbed;
    }
    this.health -= dmg;
    this.hurtFlash = Math.min(1, this.hurtFlash + clamp01(dmg / 32) * 0.9 + 0.18);
    this.lastDamageAt = performance.now() / 1000;
    if (fromX !== undefined) {
      const ang = Math.atan2(fromX - this.x, fromZ - this.z);
      this.damageDirs.push({ ang, t: 1.4 });
      this.viewKickPitch -= 0.035 + dmg * 0.0016;
      this.viewKickYaw += (Math.random() - 0.5) * 0.05;
      if (knockback) {
        const dx = this.x - fromX, dz = this.z - fromZ;
        const l = Math.hypot(dx, dz) || 1;
        this.vx += (dx / l) * knockback;
        this.vz += (dz / l) * knockback;
      }
    }
    if (this.health <= 0) { this.health = 0; this.dead = true; }
  }

  heal(n) { this.health = Math.min(this.maxHealth, this.health + n); }
  addArmor(n) { this.armor = Math.min(100, this.armor + n); }

  update(dt, input, collision, audio, opts = {}) {
    // --- look ---------------------------------------------------------------
    if (input.locked && !this.dead) {
      // Yaw increases toward world +X, but the camera basis puts screen-right
      // at world -X (right = forward x up, with +Z forward and +Y up), so
      // moving the mouse right must *decrease* yaw. mirrorX flips that, and
      // flips strafe below with it; it ships ON — see input.js.
      this.yaw -= input.mouse.dx * input.sensitivity * (input.mirrorX ? -1 : 1);
      this.pitch -= input.mouse.dy * input.sensitivity * (input.invertY ? -1 : 1);
      this.pitch = clamp(this.pitch, -1.53, 1.53);
      if (this.yaw > Math.PI) this.yaw -= TAU;
      if (this.yaw < -Math.PI) this.yaw += TAU;
    }

    if (this.dead) {
      // Collapse: drop the camera and roll it over.
      this.height = damp(this.height, 0.42, 4, dt);
      this.roll = damp(this.roll, 0.6, 2.5, dt);
      this.pitch = damp(this.pitch, -0.25, 2, dt);
      this.hurtFlash = damp(this.hurtFlash, 0.45, 2, dt);
      this.y = collision.floorAt(this.x, this.z, this.y, 0.6);
      return;
    }

    // --- crouch -------------------------------------------------------------
    const wantCrouch = input.down('ControlLeft') || input.down('KeyC');
    if (!wantCrouch && this.crouching) {
      // Only stand if there is room.
      const ceil = collision.ceilingAt(this.x, this.z, this.y);
      if (ceil - this.y > STAND_H + 0.05) this.crouching = false;
    } else if (wantCrouch) this.crouching = true;
    const targetH = this.crouching ? CROUCH_H : STAND_H;
    this.height = damp(this.height, targetH, 12, dt);

    // --- wish direction -----------------------------------------------------
    let fwd = 0, strafe = 0;
    if (input.down('KeyW') || input.down('ArrowUp')) fwd += 1;
    if (input.down('KeyS') || input.down('ArrowDown')) fwd -= 1;
    if (input.down('KeyD') || input.down('ArrowRight')) strafe += 1;
    if (input.down('KeyA') || input.down('ArrowLeft')) strafe -= 1;
    const len = Math.hypot(fwd, strafe);
    if (len > 1) { fwd /= len; strafe /= len; }

    const sprinting = input.down('ShiftLeft') && fwd > 0.1 && !this.crouching && this.sprintStamina > 0.05;
    if (sprinting) this.sprintStamina = clamp01(this.sprintStamina - dt * 0.22);
    else this.sprintStamina = clamp01(this.sprintStamina + dt * (this.crouching ? 0.34 : 0.17));

    const baseSpeed = this.crouching ? 1.85 : (sprinting ? 6.05 : 3.75);

    // --- terrain --------------------------------------------------------
    // A hill is only tactical if climbing it costs you something. Uphill work
    // is charged against speed in proportion to the grade you are actually
    // attacking, so traversing a bank sideways is cheap and going straight up
    // it is not; downhill gives a little of it back, up to a point.
    let slopeMul = 1;
    this.grade = 0;
    if (this.grounded && collision.terrain) {
      const t = collision.terrain;
      const e = 1.1;
      const gx = (t.heightAt(this.x + e, this.z) - t.heightAt(this.x - e, this.z)) / (2 * e);
      const gz = (t.heightAt(this.x, this.z + e) - t.heightAt(this.x, this.z - e)) / (2 * e);
      const mag = Math.hypot(gx, gz);
      if (mag > 0.001) {
        const wl = Math.hypot(this.vx, this.vz) || 1;
        // Grade along the direction of travel: + uphill, - downhill.
        this.grade = (gx * (this.vx / wl) + gz * (this.vz / wl));
        const up = clamp01((this.grade - 0.16) / 0.62);
        const down = clamp01((-this.grade - 0.20) / 0.70);
        slopeMul = 1 - up * 0.62 + down * 0.13;
      }
    }
    const speed = baseSpeed * this.speedScale * (opts.slow || 1) * slopeMul;

    // Camera-relative. forward = (sin yaw, cos yaw); the view basis puts
    // screen-right at (-cos yaw, sin yaw), so D strafes along that.
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const st = input.mirrorX ? -strafe : strafe;
    const wishX = sy * fwd - cy * st;
    const wishZ = cy * fwd + sy * st;

    // --- accelerate ---------------------------------------------------------
    const accel = this.grounded ? 46 : 8;
    const friction = this.grounded ? 12 : 0.4;
    const targetVX = wishX * speed, targetVZ = wishZ * speed;
    if (len > 0.01) {
      this.vx += (targetVX - this.vx) * Math.min(1, accel * dt / Math.max(speed, 1));
      this.vz += (targetVZ - this.vz) * Math.min(1, accel * dt / Math.max(speed, 1));
    } else if (this.grounded) {
      const f = Math.max(0, 1 - friction * dt);
      this.vx *= f; this.vz *= f;
    }

    // --- jump / gravity -----------------------------------------------------
    if (input.down('Space') && this.grounded && !this.crouching) {
      this.vy = 5.2;
      this.grounded = false;
    }
    this.vy -= 21 * dt;
    if (this.vy < -60) this.vy = -60;

    // --- integrate ----------------------------------------------------------
    const res = collision.moveCircle(this.x, this.z, this.vx * dt, this.vz * dt,
      this.radius, this.y, this.y + this.height);
    // Kill the velocity component we lost to a wall so we don't stick.
    const actualDX = res.x - this.x, actualDZ = res.z - this.z;
    this.x = res.x; this.z = res.z;
    if (dt > 0) {
      this.vx = lerp(this.vx, actualDX / dt, 0.5);
      this.vz = lerp(this.vz, actualDZ / dt, 0.5);
    }

    const prevY = this.y;
    const wasGrounded = this.grounded;
    this.y += this.vy * dt;
    const floor = collision.floorAt(this.x, this.z, prevY, 0.62);
    // Walking off the crown of a hill should not launch you. If we were on the
    // ground and the ground has merely fallen away under us by less than a
    // step, stay glued to it.
    if (wasGrounded && this.vy <= 0 && this.y > floor && this.y - floor < 0.55) {
      this.y = floor;
      this.vy = 0;
    }
    if (this.y <= floor) {
      if (!this.grounded && this.vy < -7) {
        this.landDip = clamp(this.vy * 0.014, -0.34, 0);
        if (audio) audio.footstep(this.x, this.y, this.z, true);
        if (this.vy < -14) this.damage((-this.vy - 14) * 3.2);
      }
      this.y = floor;
      this.vy = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
      const ceil = collision.ceilingAt(this.x, this.z, prevY);
      if (this.y + this.height > ceil) { this.y = ceil - this.height; this.vy = Math.min(0, this.vy); }
    }

    // --- feel ---------------------------------------------------------------
    const groundSpeed = Math.hypot(this.vx, this.vz);
    this.bobAmount = damp(this.bobAmount, this.grounded ? clamp01(groundSpeed / 6) : 0, 8, dt);
    this.bob += groundSpeed * dt * 1.9;
    this.landDip = damp(this.landDip, 0, 8, dt);
    this.viewKickPitch = damp(this.viewKickPitch, 0, 9, dt);
    this.viewKickYaw = damp(this.viewKickYaw, 0, 9, dt);
    this.roll = damp(this.roll, -strafe * 0.022 * clamp01(groundSpeed / 4), 7, dt);
    this.hurtFlash = damp(this.hurtFlash, 0, 2.2, dt);

    // Footsteps, timed off the bob so they land with the stride.
    if (this.grounded && groundSpeed > 0.6) {
      this.stepTimer -= dt * groundSpeed;
      if (this.stepTimer <= 0) {
        this.stepTimer = sprinting ? 2.35 : 2.9;
        if (audio) audio.footstep(this.x, this.y, this.z, sprinting);
        this.madeNoise = sprinting ? 14 : 7;
      }
    }

    for (let i = this.damageDirs.length - 1; i >= 0; i--) {
      this.damageDirs[i].t -= dt;
      if (this.damageDirs[i].t <= 0) this.damageDirs.splice(i, 1);
    }

    if (this.torchOn) this.torchBattery = clamp01(this.torchBattery - dt * 0.0022);
    else this.torchBattery = clamp01(this.torchBattery + dt * 0.004);
    if (this.torchBattery <= 0.001) this.torchOn = false;
  }

  /** Camera state for the renderer, including bob and kick. */
  camera(fov) {
    const b = this.bobAmount;
    const bobY = Math.sin(this.bob * 2) * 0.035 * b;
    const bobX = Math.cos(this.bob) * 0.028 * b;
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    return {
      pos: {
        x: this.x + cy * bobX,
        y: this.eyeY + bobY,
        z: this.z - sy * bobX,
      },
      yaw: this.yaw + this.viewKickYaw,
      pitch: clamp(this.pitch + this.viewKickPitch, -1.55, 1.55),
      roll: this.roll + Math.sin(this.bob) * 0.006 * b,
      fov,
    };
  }
}
