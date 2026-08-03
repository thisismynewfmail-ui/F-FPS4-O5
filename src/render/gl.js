// ---------------------------------------------------------------------------
// gl.js — thin WebGL2 helpers. No abstractions we don't actually use.
// ---------------------------------------------------------------------------

export function createContext(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,          // PS1 hardware had none; we want hard pixels
    depth: true,
    stencil: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error('WebGL2 is required. Try a recent Chrome, Firefox or Safari.');
  return gl;
}

export function compileShader(gl, type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join('\n');
    throw new Error(`Shader compile failed (${label}):\n${log}\n${numbered}`);
  }
  return sh;
}

export function createProgram(gl, vsSrc, fsSrc, label = 'program') {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc, `${label}.vert`);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc, `${label}.frag`);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`Program link failed (${label}): ${gl.getProgramInfoLog(p)}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  // Cache every active uniform / attribute location up front.
  const uniforms = {};
  const nU = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < nU; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    uniforms[name] = gl.getUniformLocation(p, name);
  }
  const attribs = {};
  const nA = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < nA; i++) {
    const info = gl.getActiveAttrib(p, i);
    attribs[info.name] = gl.getAttribLocation(p, info.name);
  }
  return { program: p, uniforms, attribs, label };
}

/**
 * A 2D texture array. Every world material is one layer, so the entire town
 * draws with a single texture bind — the modern equivalent of the PS1's
 * texture-page discipline.
 */
export function createTextureArray(gl, size, layers) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  const levels = Math.floor(Math.log2(size)) + 1;
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.RGBA8, size, size, layers);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
  return { tex, size, layers, levels };
}

export function uploadLayer(gl, texArray, layer, pixels) {
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texArray.tex);
  gl.texSubImage3D(
    gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer,
    texArray.size, texArray.size, 1,
    gl.RGBA, gl.UNSIGNED_BYTE, pixels,
  );
}

export function finalizeTextureArray(gl, texArray) {
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texArray.tex);
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
}

/** Offscreen colour+depth target used for the low internal render resolution. */
export function createRenderTarget(gl, w, h) {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);

  const color = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, color);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);

  const depth = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);

  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Framebuffer incomplete: 0x${status.toString(16)}`);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, color, depth, width: w, height: h };
}

export function destroyRenderTarget(gl, rt) {
  gl.deleteFramebuffer(rt.fbo);
  gl.deleteTexture(rt.color);
  gl.deleteRenderbuffer(rt.depth);
}

// --- vertex layout ---------------------------------------------------------
// pos(3f) uv(2f) layer(1f) light(3f) normal(3f) wind(1f) = 13 floats = 52 bytes.
//
// `wind` is how far this vertex is allowed to be pushed around by the wind, in
// metres. It is zero on everything structural and non-zero only on the tops of
// foliage cards, which is the whole of the vegetation animation system: no
// skinning, no per-object update, just one number per vertex and a sine wave
// in the vertex shader. That is exactly how the era did it.
export const VERTEX_FLOATS = 13;
export const VERTEX_STRIDE = VERTEX_FLOATS * 4;

export function setupVAO(gl, program, vbo, ibo) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  const bind = (name, size, offset) => {
    const loc = program.attribs[name];
    if (loc === undefined || loc < 0) return;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, VERTEX_STRIDE, offset * 4);
  };
  bind('aPos', 3, 0);
  bind('aUV', 2, 3);
  bind('aLayer', 1, 5);
  bind('aLight', 3, 6);
  bind('aNormal', 3, 9);
  bind('aWind', 1, 12);
  if (ibo) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bindVertexArray(null);
  return vao;
}

/** Upload an immutable mesh; returns a handle the renderer can draw directly. */
export function createStaticMesh(gl, program, vertices, indices) {
  if (!indices.length) return null;
  // Binding ELEMENT_ARRAY_BUFFER while a VAO is bound rewrites *that VAO's*
  // index binding, so always detach first.
  gl.bindVertexArray(null);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  const use32 = vertices.length / VERTEX_FLOATS > 65535;
  const idxData = use32 ? new Uint32Array(indices) : new Uint16Array(indices);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idxData, gl.STATIC_DRAW);
  const vao = setupVAO(gl, program, vbo, ibo);
  return {
    vao, vbo, ibo,
    count: indices.length,
    type: use32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
    tris: indices.length / 3,
  };
}

/** A growable, re-uploaded-every-frame mesh (characters, gibs, viewmodel). */
export function createDynamicMesh(gl, program, maxVerts) {
  gl.bindVertexArray(null);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, maxVerts * VERTEX_STRIDE, gl.DYNAMIC_DRAW);
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, maxVerts * 3 * 4, gl.DYNAMIC_DRAW);
  const vao = setupVAO(gl, program, vbo, ibo);
  return { vao, vbo, ibo, maxVerts, count: 0, type: gl.UNSIGNED_INT };
}

export function updateDynamicMesh(gl, mesh, vertices, vertCount, indices, indexCount) {
  mesh.count = 0;
  if (!indexCount) return;
  if (vertCount > mesh.maxVerts) {
    // Better to drop the overflow than to draw indices past the end of the
    // buffer, which is a GL error and renders nothing at all.
    console.warn(`dynamic mesh overflow: ${vertCount} > ${mesh.maxVerts} verts`);
    return;
  }
  mesh.count = indexCount;
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices, 0, vertCount * VERTEX_FLOATS);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
  gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, indices, 0, indexCount);
}

export function drawMesh(gl, mesh) {
  if (!mesh || !mesh.count) return 0;
  gl.bindVertexArray(mesh.vao);
  gl.drawElements(gl.TRIANGLES, mesh.count, mesh.type, 0);
  return mesh.count / 3;
}
