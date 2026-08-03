// ---------------------------------------------------------------------------
// audio.js — everything you hear is synthesised at runtime.
//
// No samples ship with the game. Gunshots are filtered noise bursts with a
// pitched transient, the infected are formant-filtered growls, and the ambient
// bed is two detuned drones plus wind. It keeps the download tiny and it suits
// the era: early consoles synthesised far more than they streamed.
// ---------------------------------------------------------------------------

import { rightOfYaw } from './math.js';

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.noiseBuf = null;
    this.listener = { x: 0, y: 0, z: 0, yaw: 0 };
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    this.comp = this.ctx.createDynamicsCompressor();
    this.comp.threshold.value = -18;
    this.comp.ratio.value = 8;
    this.comp.connect(this.ctx.destination);
    this.master.connect(this.comp);

    // One second of white noise, reused by every noise-based voice.
    const len = this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this.startAmbient();
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  get now() { return this.ctx ? this.ctx.currentTime : 0; }
  setVolume(v) { if (this.master) this.master.gain.value = v; }

  /** Positional gain and stereo pan relative to the listener. */
  spatial(x, y, z, maxDist = 40) {
    const L = this.listener;
    const dx = x - L.x, dy = y - L.y, dz = z - L.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > maxDist) return null;
    const gain = Math.pow(1 - dist / maxDist, 1.6);
    // Project onto the listener's right vector for panning. Screen-right is
    // (-cos yaw, sin yaw) — see mat4View — so a source that appears on the
    // right of the screen pans right.
    const r = rightOfYaw(L.yaw);
    const rx = r.x, rz = r.z;
    const pan = dist > 0.01 ? Math.max(-1, Math.min(1, (dx * rx + dz * rz) / dist)) : 0;
    return { gain, pan, dist };
  }

  _voice(pan = 0, gain = 1) {
    const g = this.ctx.createGain();
    g.gain.value = gain;
    const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    if (p) { p.pan.value = pan; g.connect(p); p.connect(this.master); }
    else g.connect(this.master);
    return g;
  }

  noise(dur, out) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    s.connect(out);
    s.start();
    s.stop(this.now + dur);
    return s;
  }

  // --- weapons -------------------------------------------------------------

  gunshot(kind, x, y, z) {
    if (!this.ctx) return;
    const sp = (x === undefined) ? { gain: 1, pan: 0 } : this.spatial(x, y, z, 90);
    if (!sp) return;
    const t = this.now;
    const cfg = {
      pistol: { dur: 0.20, lp: 3200, punch: 160, vol: 0.55 },
      smg: { dur: 0.14, lp: 3800, punch: 200, vol: 0.42 },
      shotgun: { dur: 0.42, lp: 2200, punch: 90, vol: 0.85 },
      rifle: { dur: 0.34, lp: 4200, punch: 120, vol: 0.8 },
    }[kind] || { dur: 0.2, lp: 3000, punch: 150, vol: 0.5 };

    const g = this._voice(sp.pan, 0);
    g.gain.setValueAtTime(cfg.vol * sp.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + cfg.dur);

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(cfg.lp, t);
    lp.frequency.exponentialRampToValueAtTime(260, t + cfg.dur);
    lp.Q.value = 1.4;
    lp.connect(g);
    this.noise(cfg.dur, lp);

    // Low thump for body.
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(cfg.punch, t);
    o.frequency.exponentialRampToValueAtTime(38, t + cfg.dur * 0.6);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(cfg.vol * 0.5 * sp.gain, t);
    og.gain.exponentialRampToValueAtTime(0.0008, t + cfg.dur * 0.7);
    o.connect(og); og.connect(g);
    o.start(t); o.stop(t + cfg.dur);

    // Tail: a slap of reverb from the street.
    const tail = this.ctx.createGain();
    tail.gain.setValueAtTime(0.0001, t);
    tail.gain.linearRampToValueAtTime(cfg.vol * 0.22 * sp.gain, t + 0.05);
    tail.gain.exponentialRampToValueAtTime(0.0008, t + 0.9);
    const tf = this.ctx.createBiquadFilter();
    tf.type = 'bandpass'; tf.frequency.value = 900; tf.Q.value = 0.7;
    tf.connect(tail); tail.connect(this.master);
    this.noise(0.9, tf);
  }

  dryFire() {
    if (!this.ctx) return;
    const t = this.now;
    const g = this._voice(0, 0.25);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 2600;
    hp.connect(g);
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    this.noise(0.06, hp);
  }

  reload(stage) {
    if (!this.ctx) return;
    const t = this.now;
    const g = this._voice(0, 0.3);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = stage === 'in' ? 1200 : 2000;
    bp.Q.value = 3;
    bp.connect(g);
    g.gain.setValueAtTime(0.32, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
    this.noise(0.11, bp);
  }

  shellDrop(x, y, z) {
    if (!this.ctx) return;
    const sp = this.spatial(x, y, z, 20) || { gain: 0.4, pan: 0 };
    const t = this.now + 0.28;
    for (let i = 0; i < 3; i++) {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = 1800 + Math.random() * 2400;
      const g = this._voice(sp.pan, 0);
      g.gain.setValueAtTime(0.09 * sp.gain, t + i * 0.07);
      g.gain.exponentialRampToValueAtTime(0.0006, t + i * 0.07 + 0.09);
      o.connect(g);
      o.start(t + i * 0.07); o.stop(t + i * 0.07 + 0.1);
    }
  }

  impact(kind, x, y, z) {
    if (!this.ctx) return;
    const sp = this.spatial(x, y, z, 45);
    if (!sp) return;
    const t = this.now;
    const g = this._voice(sp.pan, 0);
    const f = this.ctx.createBiquadFilter();
    const flesh = kind === 'flesh';
    f.type = flesh ? 'lowpass' : 'highpass';
    f.frequency.value = flesh ? 700 : 2400;
    f.connect(g);
    g.gain.setValueAtTime((flesh ? 0.35 : 0.22) * sp.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + (flesh ? 0.13 : 0.07));
    this.noise(flesh ? 0.13 : 0.07, f);
  }

  melee(x, y, z) {
    if (!this.ctx) return;
    const t = this.now;
    const g = this._voice(0, 0);
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(2200, t + 0.16);
    f.connect(g);
    g.gain.setValueAtTime(0.20, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    this.noise(0.16, f);
  }

  // --- the infected --------------------------------------------------------

  growl(x, y, z, pitch = 1, aggressive = false) {
    if (!this.ctx) return;
    const sp = this.spatial(x, y, z, aggressive ? 46 : 26);
    if (!sp) return;
    const t = this.now;
    const dur = aggressive ? 0.7 : 1.25;
    const g = this._voice(sp.pan, 0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime((aggressive ? 0.55 : 0.28) * sp.gain, t + 0.10);
    g.gain.exponentialRampToValueAtTime(0.0006, t + dur);

    // Vocal-ish: a rasping saw through two formant bands.
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    const base = (aggressive ? 108 : 74) * pitch;
    o.frequency.setValueAtTime(base, t);
    o.frequency.linearRampToValueAtTime(base * (aggressive ? 1.5 : 0.72), t + dur);
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = aggressive ? 24 : 11;
    const lg = this.ctx.createGain();
    lg.gain.value = base * 0.30;
    lfo.connect(lg); lg.connect(o.frequency);
    lfo.start(t); lfo.stop(t + dur);

    const f1 = this.ctx.createBiquadFilter();
    f1.type = 'bandpass'; f1.frequency.value = 420 * pitch; f1.Q.value = 4;
    const f2 = this.ctx.createBiquadFilter();
    f2.type = 'bandpass'; f2.frequency.value = 1100 * pitch; f2.Q.value = 6;
    o.connect(f1); f1.connect(g);
    o.connect(f2); f2.connect(g);
    o.start(t); o.stop(t + dur);

    // Breath.
    const bf = this.ctx.createBiquadFilter();
    bf.type = 'bandpass'; bf.frequency.value = 900; bf.Q.value = 0.8;
    const bg = this._voice(sp.pan, 0);
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.linearRampToValueAtTime(0.10 * sp.gain, t + 0.18);
    bg.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    bf.connect(bg);
    this.noise(dur, bf);
  }

  gib(x, y, z) {
    if (!this.ctx) return;
    const sp = this.spatial(x, y, z, 34);
    if (!sp) return;
    const t = this.now;
    const g = this._voice(sp.pan, 0);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.setValueAtTime(1400, t);
    f.frequency.exponentialRampToValueAtTime(200, t + 0.35);
    f.connect(g);
    g.gain.setValueAtTime(0.5 * sp.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.35);
    this.noise(0.35, f);
  }

  // --- player --------------------------------------------------------------

  footstep(x, y, z, running) {
    if (!this.ctx) return;
    const t = this.now;
    const g = this._voice((Math.random() - 0.5) * 0.4, 0);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = running ? 900 : 620;
    f.connect(g);
    g.gain.setValueAtTime(running ? 0.14 : 0.08, t);
    g.gain.exponentialRampToValueAtTime(0.0006, t + 0.09);
    this.noise(0.09, f);
  }

  hurt() {
    if (!this.ctx) return;
    const t = this.now;
    const g = this._voice(0, 0);
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(190, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.3);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 800;
    o.connect(f); f.connect(g);
    o.start(t); o.stop(t + 0.3);
  }

  pickup(kind) {
    if (!this.ctx) return;
    const t = this.now;
    const notes = kind === 'health' ? [520, 700, 880] : [400, 600];
    notes.forEach((n, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = n;
      const g = this._voice(0, 0);
      g.gain.setValueAtTime(0.001, t + i * 0.06);
      g.gain.linearRampToValueAtTime(0.14, t + i * 0.06 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.06 + 0.13);
      o.connect(g);
      o.start(t + i * 0.06); o.stop(t + i * 0.06 + 0.14);
    });
  }

  waveHorn(wave) {
    if (!this.ctx) return;
    const t = this.now;
    for (let i = 0; i < 2; i++) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      const f0 = 132 - Math.min(wave, 12) * 3;
      o.frequency.setValueAtTime(f0, t + i * 0.75);
      o.frequency.linearRampToValueAtTime(f0 * 0.92, t + i * 0.75 + 0.55);
      const g = this._voice(0, 0);
      g.gain.setValueAtTime(0.0001, t + i * 0.75);
      g.gain.linearRampToValueAtTime(0.30, t + i * 0.75 + 0.10);
      g.gain.setValueAtTime(0.30, t + i * 0.75 + 0.42);
      g.gain.exponentialRampToValueAtTime(0.0006, t + i * 0.75 + 0.62);
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 1100;
      o.connect(f); f.connect(g);
      o.start(t + i * 0.75); o.stop(t + i * 0.75 + 0.65);
    }
  }

  /**
   * A cordon gate opening, a long way off: a metal groan, a rumble, and the
   * clang of whatever was holding it hitting the road. Panned and attenuated
   * from the gate's actual position, so it tells the player which way to go
   * without anything on screen saying so.
   */
  gateOpen(x, z) {
    if (!this.ctx) return;
    const t = this.now;
    // A very long reference distance: this is meant to carry across the town.
    // Out of range it still plays, quiet and centred — it is a sound the whole
    // valley hears, and going silent would lose the one cue there is.
    const sp = this.spatial(x, 2, z, 260) || { gain: 0, pan: 0 };
    const g = this._voice(sp.pan, 0);
    const peak = 0.34 + 0.30 * sp.gain;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.35);
    g.gain.setValueAtTime(peak, t + 1.5);
    g.gain.exponentialRampToValueAtTime(0.0006, t + 2.9);

    // The groan: two detuned saws grinding downward.
    for (const det of [1, 1.013]) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(74 * det, t);
      o.frequency.exponentialRampToValueAtTime(41 * det, t + 2.2);
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 560;
      o.connect(f); f.connect(g);
      o.start(t); o.stop(t + 2.9);
    }
    // The rumble underneath it.
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuf; n.loop = true;
    const nf = this.ctx.createBiquadFilter();
    nf.type = 'lowpass'; nf.frequency.value = 190;
    const ng = this.ctx.createGain(); ng.gain.value = 0.55;
    n.connect(nf); nf.connect(ng); ng.connect(g);
    n.start(t); n.stop(t + 2.6);
    // And the thing that was holding it, landing.
    const c = this.ctx.createOscillator();
    c.type = 'square';
    c.frequency.setValueAtTime(310, t + 2.05);
    c.frequency.exponentialRampToValueAtTime(88, t + 2.4);
    const cg = this.ctx.createGain();
    cg.gain.setValueAtTime(0.0001, t + 2.05);
    cg.gain.linearRampToValueAtTime(0.6, t + 2.08);
    cg.gain.exponentialRampToValueAtTime(0.0005, t + 2.55);
    c.connect(cg); cg.connect(g);
    c.start(t + 2.05); c.stop(t + 2.6);
  }

  // --- ambience ------------------------------------------------------------

  startAmbient() {
    const t = this.now;
    this.ambientGain = this.ctx.createGain();
    this.ambientGain.gain.value = 0.0;
    this.ambientGain.connect(this.master);
    this.ambientGain.gain.linearRampToValueAtTime(0.30, t + 4);

    // Wind: filtered noise with a slowly wandering cutoff.
    const wf = this.ctx.createBiquadFilter();
    wf.type = 'bandpass'; wf.frequency.value = 380; wf.Q.value = 0.55;
    const wg = this.ctx.createGain(); wg.gain.value = 0.5;
    wf.connect(wg); wg.connect(this.ambientGain);
    const ws = this.ctx.createBufferSource();
    ws.buffer = this.noiseBuf; ws.loop = true;
    ws.connect(wf); ws.start();
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.055;
    const lg = this.ctx.createGain(); lg.gain.value = 190;
    lfo.connect(lg); lg.connect(wf.frequency);
    lfo.start();

    // Two detuned drones a semitone apart — the "slightly wrong" bed.
    for (const [freq, gain, det] of [[44, 0.10, 0], [46.6, 0.075, 0.4], [88.5, 0.035, -0.3]]) {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq;
      o.detune.value = det * 20;
      const g = this.ctx.createGain(); g.gain.value = gain;
      const m = this.ctx.createOscillator();
      m.frequency.value = 0.037 + Math.random() * 0.03;
      const mg = this.ctx.createGain(); mg.gain.value = gain * 0.55;
      m.connect(mg); mg.connect(g.gain);
      o.connect(g); g.connect(this.ambientGain);
      o.start(); m.start();
    }
    this.ambientBase = 0.30;
  }

  /** Raise the drone as the horde closes in. */
  setTension(v) {
    if (!this.ambientGain) return;
    const target = this.ambientBase * (1 + v * 1.5);
    this.ambientGain.gain.setTargetAtTime(target, this.now, 1.2);
  }

  /** Distant groans, so the town never feels empty. */
  distantMoan() {
    if (!this.ctx) return;
    const t = this.now;
    const g = this._voice((Math.random() - 0.5) * 1.6, 0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.055, t + 0.9);
    g.gain.exponentialRampToValueAtTime(0.0004, t + 3.2);
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(58 + Math.random() * 26, t);
    o.frequency.linearRampToValueAtTime(44, t + 3.2);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 420;
    o.connect(f); f.connect(g);
    o.start(t); o.stop(t + 3.3);
  }
}
