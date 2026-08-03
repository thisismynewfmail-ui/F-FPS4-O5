// ---------------------------------------------------------------------------
// director.js — wave pacing.
//
// Modelled on the Left 4 Dead director rather than a fixed spawn table: it
// tracks how hard the last minute has been and decides when to squeeze and when
// to let go. Waves still escalate, but within a wave the pressure breathes.
//
// Spawning always happens out of sight and beyond a minimum distance, using the
// spawn points the world generator left in closets, stockrooms, alleys and
// wrecked cars — so the infected come out of the town rather than out of thin
// air.
// ---------------------------------------------------------------------------

import { RNG, clamp, clamp01, dist2D, lerp } from '../core/math.js';

const PHASE = { PREPARE: 'prepare', BUILD: 'build', PEAK: 'peak', RELAX: 'relax', CLEAR: 'clear' };

export class Director {
  constructor(world, horde, opts = {}) {
    this.world = world;
    this.horde = horde;
    this.rng = new RNG(opts.seed || 20250802);
    this.wave = 0;
    this.phase = PHASE.PREPARE;
    this.phaseT = 6;
    this.remaining = 0;
    this.killed = 0;
    this.totalKilled = 0;
    this.spawnAcc = 0;
    this.tension = 0;
    this.stress = 0;
    this.maxAlive = 34;
    this.waveActive = false;
    this.betweenWaves = true;
    this.message = 'HOLD OUT';
    this.submessage = 'Wave 1 begins shortly';
    this.notice = null;
    this.noticeT = 0;
    this.panic = 0;
    this.difficulty = opts.difficulty || 1;
    // The horde comes out of the town the player is standing in, not out of
    // the sectors still behind a cordon. Without this the first wave arrives
    // from three streets away through a welded coach.
    this.progression = opts.progression || null;

    // Sort spawn points into buckets so we can prefer interior spawns when the
    // player is inside and street spawns when they are out in the open.
    this.spawnPoints = world.spawns.filter((s) => s && s.p);
    this.streetSpawns = this.spawnPoints.filter((s) => s.kind === 'street' || s.kind === 'alley' || s.kind === 'yard');
    this.interiorSpawns = this.spawnPoints.filter((s) => !['street', 'alley', 'yard'].includes(s.kind));
    if (!this.streetSpawns.length) this.streetSpawns = this.spawnPoints;
    if (!this.interiorSpawns.length) this.interiorSpawns = this.spawnPoints;
  }

  /** Composition of a wave: what walks, what runs, what you should flee. */
  composition(wave) {
    const w = wave;
    const table = [];
    table.push(['shambler', Math.max(4, 42 - w * 1.6)]);
    table.push(['worker', clamp(w * 2.2, 0, 26)]);
    if (w >= 2) table.push(['runner', clamp(2 + w * 2.6, 0, 34)]);
    if (w >= 3) table.push(['crawler', clamp(w * 1.5, 0, 18)]);
    if (w >= 5) table.push(['officer', clamp((w - 4) * 1.6, 0, 14)]);
    if (w >= 4) table.push(['hulk', clamp((w - 3) * 0.9, 0, 7)]);
    return table;
  }

  waveBudget(wave) {
    return Math.round((10 + wave * 6 + wave * wave * 0.6) * this.difficulty);
  }

  startWave() {
    this.wave++;
    this.killed = 0;
    this.remaining = this.waveBudget(this.wave);
    this.phase = PHASE.BUILD;
    this.phaseT = 0;
    this.waveActive = true;
    this.betweenWaves = false;
    this.maxAlive = Math.min(64, 22 + this.wave * 3);
    this.message = `WAVE ${this.wave}`;
    this.submessage = `${this.remaining} hostile signatures`;
    this.notice = `WAVE ${this.wave}`;
    this.noticeT = 3.4;
    return this.wave;
  }

  endWave() {
    this.waveActive = false;
    this.betweenWaves = true;
    this.phase = PHASE.PREPARE;
    this.phaseT = Math.max(18, 34 - this.wave * 0.8);
    this.message = 'AREA CLEAR';
    this.submessage = `Wave ${this.wave + 1} in ${Math.ceil(this.phaseT)}s`;
    this.notice = 'AREA CLEAR';
    this.noticeT = 3.2;
  }

  /** Pick a spawn point: unseen, far enough away, but not so far it never arrives. */
  pickSpawn(player, camera, collision, indoorBias) {
    const pool = indoorBias ? this.interiorSpawns : this.streetSpawns;
    const alt = indoorBias ? this.streetSpawns : this.interiorSpawns;
    const fovCos = Math.cos(0.95);
    const dirX = Math.sin(camera.yaw), dirZ = Math.cos(camera.yaw);

    const open = this.progression ? this.progression.open : 99;
    for (let attempt = 0; attempt < 24; attempt++) {
      const list = attempt < 16 ? pool : alt;
      if (!list.length) return null;
      const s = list[Math.floor(this.rng.next() * list.length)];
      if ((s.district ?? 0) > open) continue;
      const p = s.p;
      const d = dist2D(p.x, p.z, player.x, player.z);
      if (d < 13 || d > 78) continue;
      // In front of the player and visible? Try again.
      const toX = (p.x - player.x) / d, toZ = (p.z - player.z) / d;
      const facing = toX * dirX + toZ * dirZ;
      if (facing > fovCos && d < 55) {
        if (collision.lineOfSight(player.x, player.eyeY, player.z, p.x, p.y + 1.5, p.z)) continue;
      }
      return p;
    }
    return null;
  }

  update(dt, player, camera, collision, audio) {
    this.phaseT -= dt;
    if (this.noticeT > 0) this.noticeT -= dt;

    const alive = this.horde.liveCount;
    const near = this.horde.nearest ?? 999;

    // Stress: how much pressure the player is under right now.
    const proximity = clamp01(1 - near / 22);
    const crowd = clamp01(alive / Math.max(this.maxAlive, 1));
    const wounded = 1 - clamp01(player.health / player.maxHealth);
    const target = clamp01(proximity * 0.45 + crowd * 0.4 + wounded * 0.3);
    this.stress = lerp(this.stress, target, 1 - Math.exp(-dt * 0.7));
    this.tension = clamp01(this.stress * 0.8 + (this.waveActive ? 0.2 : 0));
    if (audio) audio.setTension(this.tension);

    if (this.betweenWaves) {
      this.submessage = `Wave ${this.wave + 1} in ${Math.max(0, Math.ceil(this.phaseT))}s`;
      if (this.phaseT <= 0) {
        this.startWave();
        if (audio) audio.waveHorn(this.wave);
      }
      // A few stragglers wander in during the lull so it never feels safe.
      this.spawnAcc += dt;
      if (this.spawnAcc > 6 && alive < 6) {
        this.spawnAcc = 0;
        this.trySpawn(player, camera, collision, 1, true);
      }
      return;
    }

    // --- pacing ------------------------------------------------------------
    // Build up, hold the peak, then back off so the player can move and reload.
    if (this.phase === PHASE.BUILD && this.stress > 0.62) { this.phase = PHASE.PEAK; this.phaseT = this.rng.range(6, 11); }
    else if (this.phase === PHASE.PEAK && this.phaseT <= 0) { this.phase = PHASE.RELAX; this.phaseT = this.rng.range(4, 8); }
    else if (this.phase === PHASE.RELAX && this.phaseT <= 0) { this.phase = PHASE.BUILD; this.phaseT = 0; }

    let rate;
    switch (this.phase) {
      case PHASE.PEAK: rate = 4.2 + this.wave * 0.30; break;
      case PHASE.RELAX: rate = 0.35; break;
      default: rate = 1.5 + this.wave * 0.16; break;
    }
    if (this.panic > 0) { this.panic -= dt; rate *= 3.2; }

    this.spawnAcc += dt * rate;
    while (this.spawnAcc >= 1 && this.remaining > 0 && alive + 1 <= this.maxAlive) {
      this.spawnAcc -= 1;
      if (!this.trySpawn(player, camera, collision, 1, false)) break;
    }

    if (this.remaining <= 0 && alive === 0) this.endWave();
    this.submessage = `${this.remaining + alive} remaining`;
  }

  trySpawn(player, camera, collision, count, straggler) {
    const indoorBias = player.y > 0.6 || this.rng.chance(0.35);
    const p = this.pickSpawn(player, camera, collision, indoorBias);
    if (!p) return false;
    const table = this.composition(straggler ? 1 : this.wave);
    for (let i = 0; i < count; i++) {
      const type = this.rng.weighted(table);
      const jitterX = p.x + this.rng.range(-1.2, 1.2);
      const jitterZ = p.z + this.rng.range(-1.2, 1.2);
      const y = collision.floorAt(jitterX, jitterZ, (p.y || 0) + 0.5, 1.2);
      this.horde.spawn(type, jitterX, y, jitterZ);
      if (!straggler) this.remaining = Math.max(0, this.remaining - 1);
    }
    return true;
  }

  /** Called when a gunshot or a broken window should draw a crowd. */
  makeNoise(strength) {
    if (strength > 40 && this.rng.chance(0.05) && this.waveActive) this.panic = 3.5;
  }

  onKill(z) {
    this.killed++;
    this.totalKilled++;
  }
}

export { PHASE };
