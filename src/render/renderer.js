// ---------------------------------------------------------------------------
// renderer.js — the frame.
//
// Pipeline, in order:
//   1. Sky into a low-resolution offscreen target (320x240-ish).
//   2. Static world chunks, frustum + fog-distance culled, one texture-array
//      bind, alpha *tested* rather than blended — the console had no cheap
//      blending, and testing keeps the pass order-independent.
//   3. Dynamic geometry (the infected, gibs, pickups) from a rebuilt buffer.
//   4. Additive sprites: muzzle flash, fires.
//   5. The viewmodel, on a cleared depth buffer so it never clips into walls.
//   6. Post: dither to 15-bit, scanlines, grain, vignette, point-upscale.
//   7. HUD, drawn at the internal resolution so the pixels match.
// ---------------------------------------------------------------------------

import {
  createContext, createProgram, createTextureArray, uploadLayer, finalizeTextureArray,
  createRenderTarget, destroyRenderTarget, createStaticMesh, createDynamicMesh,
  updateDynamicMesh, drawMesh, VERTEX_FLOATS,
} from './gl.js';
import { WORLD_VS, WORLD_FS, SKY_VS, SKY_FS, POST_VS, POST_FS, UI_VS, UI_FS } from './shaders.js';
import {
  mat4, mat4Mul, mat4Perspective, mat4View, mat4TRS, frustumFromMatrix, aabbInFrustum, clamp,
} from '../core/math.js';
import { buildFontTexture, charCell, CELL, FONT_COLS, FONT_ROWS } from './font.js';

const MAX_LIGHTS = 8;

export class Renderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.gl = createContext(canvas);
    const gl = this.gl;

    this.internalHeight = opts.internalHeight || 240;
    this.pixelated = true;

    this.world = createProgram(gl, WORLD_VS, WORLD_FS, 'world');
    this.sky = createProgram(gl, SKY_VS, SKY_FS, 'sky');
    this.post = createProgram(gl, POST_VS, POST_FS, 'post');
    this.ui = createProgram(gl, UI_VS, UI_FS, 'ui');

    this.emptyVAO = gl.createVertexArray();

    this.viewProj = mat4();
    this.proj = mat4();
    this.view = mat4();
    this.invViewProj = mat4();
    this.planes = new Float32Array(24);

    this.lightPos = new Float32Array(MAX_LIGHTS * 4);
    this.lightColor = new Float32Array(MAX_LIGHTS * 3);

    this.stats = { drawCalls: 0, tris: 0, chunks: 0 };
    this.time = 0;

    this.setupUI();
    this.rt = null;
    this.hudScale = 1;
    this.resize();
  }

  // --- texture array -------------------------------------------------------

  uploadMaterials(lib) {
    const gl = this.gl;
    const maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
    if (lib.count > maxLayers) {
      throw new Error(`Material library needs ${lib.count} texture layers but this GPU allows ${maxLayers}.`);
    }
    this.atlas = createTextureArray(gl, 128, lib.count);
    for (let i = 0; i < lib.count; i++) {
      const px = lib.layers[i];
      if (px) uploadLayer(gl, this.atlas, i, px);
    }
    finalizeTextureArray(gl, this.atlas);
  }

  createMesh(vertices, indices) {
    return createStaticMesh(this.gl, this.world, vertices, indices);
  }

  createDynamic(maxVerts) {
    return createDynamicMesh(this.gl, this.world, maxVerts);
  }

  updateDynamic(mesh, verts, vertCount, indices, indexCount) {
    updateDynamicMesh(this.gl, mesh, verts, vertCount, indices, indexCount);
  }

  // --- sizing --------------------------------------------------------------

  resize() {
    const gl = this.gl;
    const dpr = 1;   // the point is chunky pixels; never supersample
    const w = Math.max(320, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(240, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const aspect = w / h;
    this.updateHudSize();
    const ih = this.pixelated ? this.internalHeight : h;
    const iw = Math.round(ih * aspect);
    if (!this.rt || this.rt.width !== iw || this.rt.height !== ih) {
      if (this.rt) destroyRenderTarget(gl, this.rt);
      this.rt = createRenderTarget(gl, iw, ih);
    }
    this.aspect = aspect;
  }

  setInternalHeight(h) {
    this.internalHeight = h;
    this.resize();
  }

  // --- frame ---------------------------------------------------------------

  beginFrame(camera, env, dt) {
    const gl = this.gl;
    this.time += dt;
    this.env = env;
    this.camera = camera;

    mat4Perspective(this.proj, camera.fov, this.rt.width / this.rt.height, 0.06, env.viewDistance || 260);
    mat4View(this.view, camera.pos, camera.yaw, camera.pitch, camera.roll || 0);
    mat4Mul(this.viewProj, this.proj, this.view);
    frustumFromMatrix(this.viewProj, this.planes);
    invert4(this.invViewProj, this.viewProj);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.rt.fbo);
    gl.viewport(0, 0, this.rt.width, this.rt.height);
    gl.clearColor(env.fogColor[0], env.fogColor[1], env.fogColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.disable(gl.BLEND);

    this.stats.drawCalls = 0;
    this.stats.tris = 0;
    this.stats.chunks = 0;
  }

  drawSky(env) {
    const gl = this.gl;
    const p = this.sky;
    gl.useProgram(p.program);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.uniformMatrix4fv(p.uniforms.uInvViewProj, false, this.invViewProj);
    gl.uniform3f(p.uniforms.uCamPos, this.camera.pos.x, this.camera.pos.y, this.camera.pos.z);
    gl.uniform3fv(p.uniforms.uSkyTop, env.skyTop);
    gl.uniform3fv(p.uniforms.uSkyHorizon, env.skyHorizon);
    gl.uniform3fv(p.uniforms.uCloudDark, env.cloudDark);
    gl.uniform3fv(p.uniforms.uCloudLight, env.cloudLight);
    gl.uniform3f(p.uniforms.uSunDir, env.sunDir.x, env.sunDir.y, env.sunDir.z);
    gl.uniform3fv(p.uniforms.uSunColor, env.sunGlow);
    gl.uniform1f(p.uniforms.uTime, this.time);
    gl.uniform1f(p.uniforms.uOvercast, env.overcast);
    gl.bindVertexArray(this.emptyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    this.stats.drawCalls++;
  }

  /** Bind the world program and push per-frame uniforms. */
  beginWorld(env, lights, torch) {
    const gl = this.gl;
    const p = this.world;
    gl.useProgram(p.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlas.tex);
    gl.uniform1i(p.uniforms.uAtlas, 0);
    gl.uniformMatrix4fv(p.uniforms.uViewProj, false, this.viewProj);
    gl.uniform1i(p.uniforms.uUseModel, 0);
    gl.uniform2f(p.uniforms.uSnap, env.snap, env.snap * 0.75);
    gl.uniform1f(p.uniforms.uAffine, env.affine);
    gl.uniform3f(p.uniforms.uCamPos, this.camera.pos.x, this.camera.pos.y, this.camera.pos.z);
    gl.uniform2f(p.uniforms.uFog, env.fogStart, env.fogEnd);
    gl.uniform3fv(p.uniforms.uFogColor, env.fogColor);
    gl.uniform1f(p.uniforms.uAmbientBoost, env.ambientBoost);
    gl.uniform4f(p.uniforms.uTint, 0, 0, 0, 0);
    gl.uniform1f(p.uniforms.uAlphaRef, 0.5);
    gl.uniform1f(p.uniforms.uOpacity, 1);

    const n = Math.min(lights.length, MAX_LIGHTS);
    for (let i = 0; i < n; i++) {
      const L = lights[i];
      this.lightPos[i * 4] = L.x; this.lightPos[i * 4 + 1] = L.y;
      this.lightPos[i * 4 + 2] = L.z; this.lightPos[i * 4 + 3] = L.r;
      this.lightColor[i * 3] = L.c[0]; this.lightColor[i * 3 + 1] = L.c[1]; this.lightColor[i * 3 + 2] = L.c[2];
    }
    gl.uniform1i(p.uniforms.uLightCount, n);
    if (n > 0) {
      gl.uniform4fv(p.uniforms.uLightPos, this.lightPos.subarray(0, n * 4));
      gl.uniform3fv(p.uniforms.uLightColor, this.lightColor.subarray(0, n * 3));
    }

    if (torch && torch.on) {
      gl.uniform3f(p.uniforms.uTorchPos, torch.pos.x, torch.pos.y, torch.pos.z);
      gl.uniform3f(p.uniforms.uTorchDir, torch.dir.x, torch.dir.y, torch.dir.z);
      gl.uniform3fv(p.uniforms.uTorchColor, torch.color);
      gl.uniform3f(p.uniforms.uTorchParams, torch.range, torch.cosInner, torch.cosOuter);
    } else {
      gl.uniform3f(p.uniforms.uTorchColor, 0, 0, 0);
      gl.uniform3f(p.uniforms.uTorchParams, 1, 1, 0);
    }
  }

  drawChunks(chunks, maxDist) {
    const gl = this.gl;
    const cam = this.camera.pos;
    const d2 = maxDist * maxDist;
    for (const c of chunks) {
      const dx = c.centre[0] - cam.x, dz = c.centre[2] - cam.z;
      if (dx * dx + dz * dz > d2) continue;
      if (!aabbInFrustum(this.planes, c.min, c.max)) continue;
      this.stats.tris += drawMesh(gl, c.mesh);
      this.stats.drawCalls++;
      this.stats.chunks++;
    }
  }

  drawDynamicMesh(mesh) {
    const gl = this.gl;
    gl.uniform1i(this.world.uniforms.uUseModel, 0);
    this.stats.tris += drawMesh(gl, mesh);
    this.stats.drawCalls++;
  }

  /** Additive pass for flashes and fire. */
  drawAdditive(mesh) {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
    gl.uniform1f(this.world.uniforms.uAlphaRef, 0.02);
    gl.uniform1f(this.world.uniforms.uAmbientBoost, 1);
    this.stats.tris += drawMesh(gl, mesh);
    this.stats.drawCalls++;
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.uniform1f(this.world.uniforms.uAlphaRef, 0.5);
  }

  /** The weapon in your hands, on its own depth range. */
  drawViewmodel(mesh, env, torch, bobYaw, bobPitch, offset) {
    if (!mesh || !mesh.count) return;
    const gl = this.gl;
    const p = this.world;
    gl.clear(gl.DEPTH_BUFFER_BIT);
    const proj = mat4();
    mat4Perspective(proj, env.viewmodelFov, this.rt.width / this.rt.height, 0.01, 6);
    const view = mat4();
    mat4View(view, { x: 0, y: 0, z: 0 }, bobYaw, bobPitch, 0);
    const vp = mat4();
    mat4Mul(vp, proj, view);
    gl.useProgram(p.program);
    gl.uniformMatrix4fv(p.uniforms.uViewProj, false, vp);
    gl.uniform3f(p.uniforms.uCamPos, 0, 0, 0);
    gl.uniform2f(p.uniforms.uFog, 40, 60);          // effectively no fog
    gl.uniform2f(p.uniforms.uSnap, env.snap * 2.2, env.snap * 1.8);
    gl.uniform3f(p.uniforms.uTorchColor, 0, 0, 0);
    gl.uniform1i(p.uniforms.uLightCount, 0);
    this.stats.tris += drawMesh(gl, mesh);
    this.stats.drawCalls++;
    // Restore for the next frame's world pass.
    gl.uniformMatrix4fv(p.uniforms.uViewProj, false, this.viewProj);
  }

  endFrame(env, fx) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    const p = this.post;
    gl.useProgram(p.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.rt.color);
    gl.uniform1i(p.uniforms.uScene, 0);
    gl.uniform2f(p.uniforms.uResolution, this.rt.width, this.rt.height);
    gl.uniform1f(p.uniforms.uTime, this.time);
    gl.uniform1f(p.uniforms.uHurt, fx.hurt || 0);
    gl.uniform1f(p.uniforms.uGrain, env.grain);
    gl.uniform1f(p.uniforms.uVignette, env.vignette);
    gl.uniform1f(p.uniforms.uScanline, env.scanline);
    gl.uniform1f(p.uniforms.uDither, env.dither);
    gl.uniform1f(p.uniforms.uFade, fx.fade || 0);
    gl.uniform3fv(p.uniforms.uGrade, env.grade);
    gl.bindVertexArray(this.emptyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.stats.drawCalls++;
  }

  // --- UI ------------------------------------------------------------------

  setupUI() {
    const gl = this.gl;
    this.uiCap = 6000;
    this.uiVerts = new Float32Array(this.uiCap * 8);
    this.uiIdx = new Uint16Array(this.uiCap * 6);
    this.uiCount = 0;
    this.uiVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uiVBO);
    gl.bufferData(gl.ARRAY_BUFFER, this.uiVerts.byteLength, gl.DYNAMIC_DRAW);
    this.uiIBO = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.uiIBO);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.uiIdx.byteLength, gl.DYNAMIC_DRAW);
    this.uiVAO = gl.createVertexArray();
    gl.bindVertexArray(this.uiVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uiVBO);
    const stride = 8 * 4;
    const bind = (name, size, off) => {
      const loc = this.ui.attribs[name];
      if (loc === undefined || loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off * 4);
    };
    bind('aPos', 2, 0); bind('aUV', 2, 2); bind('aColor', 4, 4);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.uiIBO);
    gl.bindVertexArray(null);

    const font = buildFontTexture();
    this.fontTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fontTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, font.width, font.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, font.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fontW = font.width; this.fontH = font.height;
  }

  uiBegin() { this.uiCount = 0; this.uiTextured = false; this.uiBatches = []; }

  _quad(x, y, w, h, u0, v0, u1, v1, col) {
    if (this.uiCount >= this.uiCap - 1) return;
    const i = this.uiCount * 4;
    const v = this.uiVerts;
    const set = (n, px, py, pu, pv) => {
      const o = (i + n) * 8;
      v[o] = px; v[o + 1] = py; v[o + 2] = pu; v[o + 3] = pv;
      v[o + 4] = col[0]; v[o + 5] = col[1]; v[o + 6] = col[2]; v[o + 7] = col[3];
    };
    set(0, x, y, u0, v0);
    set(1, x + w, y, u1, v0);
    set(2, x + w, y + h, u1, v1);
    set(3, x, y + h, u0, v1);
    const q = this.uiCount * 6;
    this.uiIdx[q] = i; this.uiIdx[q + 1] = i + 1; this.uiIdx[q + 2] = i + 2;
    this.uiIdx[q + 3] = i; this.uiIdx[q + 4] = i + 2; this.uiIdx[q + 5] = i + 3;
    this.uiCount++;
  }

  uiRect(x, y, w, h, col) {
    this._pushBatch(false);
    this._quad(x, y, w, h, 0, 0, 1, 1, col);
  }

  uiText(text, x, y, scale, col) {
    this._pushBatch(true);
    const cw = CELL * scale;
    let cx = x;
    for (const ch of String(text)) {
      if (ch === ' ') { cx += cw * 0.62; continue; }
      const idx = charCell(ch);
      const gx = (idx % FONT_COLS) * CELL, gy = Math.floor(idx / FONT_COLS) * CELL;
      this._quad(cx, y, cw, cw, gx / this.fontW, gy / this.fontH,
        (gx + CELL) / this.fontW, (gy + CELL) / this.fontH, col);
      cx += cw * 0.78;
    }
    return cx - x;
  }

  textWidth(text, scale) { return String(text).length * CELL * scale * 0.78; }

  _pushBatch(textured) {
    const last = this.uiBatches[this.uiBatches.length - 1];
    if (!last || last.textured !== textured) {
      this.uiBatches.push({ textured, start: this.uiCount, count: 0 });
    }
  }

  uiFlush() {
    const gl = this.gl;
    if (!this.uiCount) return;
    for (let i = 0; i < this.uiBatches.length; i++) {
      const b = this.uiBatches[i];
      const next = this.uiBatches[i + 1];
      b.count = (next ? next.start : this.uiCount) - b.start;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uiVBO);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.uiVerts, 0, this.uiCount * 32);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.uiIBO);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, this.uiIdx, 0, this.uiCount * 6);

    const p = this.ui;
    gl.useProgram(p.program);
    gl.uniform2f(p.uniforms.uResolution, this.uiWidth, this.uiHeight);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fontTex);
    gl.uniform1i(p.uniforms.uFont, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.uiVAO);
    for (const b of this.uiBatches) {
      if (!b.count) continue;
      gl.uniform1f(p.uniforms.uUseTexture, b.textured ? 1 : 0);
      gl.drawElements(gl.TRIANGLES, b.count * 6, gl.UNSIGNED_SHORT, b.start * 6 * 2);
      this.stats.drawCalls++;
    }
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  /**
   * HUD layout space.
   *
   * Deliberately derived from the *canvas*, not the internal render target: the
   * HUD is drawn to the backbuffer after the upscale, so tying it to the render
   * target made the overlay double in size whenever the render preset changed,
   * and made it enormous at the 240-line authentic preset.
   *
   * `hudScale` is an integer number of canvas pixels per virtual pixel, so the
   * 5x7 font still lands on exact pixel boundaries and stays crisp.
   */
  updateHudSize() {
    const target = 520;   // virtual lines; ~16px glyphs on a 1080p canvas
    this.hudScale = clamp(Math.round(this.canvas.height / target), 1, 8);
    this.uiWidth = Math.round(this.canvas.width / this.hudScale);
    this.uiHeight = Math.round(this.canvas.height / this.hudScale);
  }

  setUISize(w, h) { this.uiWidth = w; this.uiHeight = h; }
}

/** General 4x4 inverse — only used once per frame for the sky ray. */
function invert4(out, m) {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return out;
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}
