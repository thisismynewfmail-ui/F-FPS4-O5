// ---------------------------------------------------------------------------
// shaders.js — the PS1 look, implemented honestly.
//
// Four techniques do almost all of the work:
//
//  1. Vertex snapping. The PS1 GTE had no sub-pixel precision, so vertices
//     landed on integer screen coordinates. We reproduce it by quantising
//     clip-space XY to a coarse grid before the perspective divide. This is
//     what makes geometry "swim" as the camera moves.
//
//  2. Affine texture mapping. The console had no perspective-correct
//     interpolation. GLSL ES 3.00 has no `noperspective` qualifier, so we
//     cancel the hardware's correction algebraically: emit uv*w and w as
//     varyings, then divide in the fragment shader. The hardware interpolates
//     (uv*w)/w = uv linearly in screen space, and (w)/w = 1 likewise, so the
//     ratio is exactly the screen-linear (affine) UV. Textures warp across
//     large triangles exactly as they did in 1997.
//
//  3. Vertex lighting. All static light is baked per vertex at build time.
//     Nothing is per-pixel except the player's flashlight cone, which needs
//     smooth falloff to be playable.
//
//  4. Low internal resolution + ordered dithering to 15-bit colour, applied in
//     a post pass and point-upscaled to the window.
// ---------------------------------------------------------------------------

export const WORLD_VS = /* glsl */`#version 300 es
precision highp float;

in vec3 aPos;
in vec2 aUV;
in float aLayer;
in vec3 aLight;
in vec3 aNormal;

uniform mat4 uViewProj;
uniform mat4 uModel;
uniform bool uUseModel;
uniform vec2 uSnap;          // snapping grid resolution in pixels; 0 disables
uniform float uAffine;       // 0 = perspective correct, 1 = full PS1 warp

uniform vec3 uCamPos;
uniform vec2 uFog;           // start, end
uniform float uAmbientBoost;

// A handful of dynamic point lights: muzzle flashes, fires, flickering signs.
#define MAX_LIGHTS 8
uniform int uLightCount;
uniform vec4 uLightPos[MAX_LIGHTS];   // xyz = position, w = radius
uniform vec3 uLightColor[MAX_LIGHTS];

uniform vec4 uTint;

out vec3 vUVW;               // xy = uv*w (affine trick), z = layer
out float vAffineW;
out vec3 vLight;
out float vFog;
out vec3 vWorld;
out vec3 vNormal;

void main() {
  vec4 world = uUseModel ? uModel * vec4(aPos, 1.0) : vec4(aPos, 1.0);
  vec3 nrm = uUseModel ? normalize(mat3(uModel) * aNormal) : aNormal;
  vWorld = world.xyz;
  vNormal = nrm;

  vec4 clip = uViewProj * world;

  // (1) vertex snapping -----------------------------------------------------
  if (uSnap.x > 0.0 && clip.w > 0.0) {
    vec2 ndc = clip.xy / clip.w;
    ndc = floor(ndc * uSnap + 0.5) / uSnap;
    clip.xy = ndc * clip.w;
  }
  gl_Position = clip;

  // (2) affine UV -----------------------------------------------------------
  float w = max(clip.w, 1e-4);
  float aw = mix(1.0, w, uAffine);
  vUVW = vec3(aUV * aw, aLayer);
  vAffineW = aw;

  // (3) vertex lighting -----------------------------------------------------
  vec3 light = aLight * uAmbientBoost + uTint.rgb;
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uLightCount) break;
    vec3 d = uLightPos[i].xyz - world.xyz;
    float dist = length(d);
    float r = uLightPos[i].w;
    if (dist < r) {
      float atten = 1.0 - dist / r;
      atten *= atten;
      float ndl = max(dot(nrm, d / max(dist, 1e-4)), 0.0);
      light += uLightColor[i] * atten * (0.30 + 0.70 * ndl);
    }
  }
  vLight = light;

  float dist = distance(uCamPos, world.xyz);
  vFog = clamp((dist - uFog.x) / max(uFog.y - uFog.x, 1e-3), 0.0, 1.0);
}
`;

export const WORLD_FS = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2DArray;

in vec3 vUVW;
in float vAffineW;
in vec3 vLight;
in float vFog;
in vec3 vWorld;
in vec3 vNormal;

uniform sampler2DArray uAtlas;
uniform vec3 uFogColor;
uniform float uAlphaRef;
uniform float uOpacity;

// Flashlight — the one per-pixel light in the game.
uniform vec3 uTorchPos;
uniform vec3 uTorchDir;
uniform vec3 uTorchColor;
uniform vec3 uTorchParams;   // range, cos(inner), cos(outer)

out vec4 fragColor;

void main() {
  vec2 uv = vUVW.xy / vAffineW;
  vec4 texel = texture(uAtlas, vec3(uv, vUVW.z));
  if (texel.a < uAlphaRef) discard;

  vec3 light = vLight;

  if (uTorchColor.r + uTorchColor.g + uTorchColor.b > 0.001) {
    vec3 d = vWorld - uTorchPos;
    float dist = length(d);
    vec3 dir = d / max(dist, 1e-4);
    float c = dot(dir, uTorchDir);
    float cone = smoothstep(uTorchParams.z, uTorchParams.y, c);
    float atten = clamp(1.0 - dist / uTorchParams.x, 0.0, 1.0);
    atten *= atten;
    float ndl = max(dot(normalize(vNormal), -dir), 0.0);
    light += uTorchColor * cone * atten * (0.22 + 0.78 * ndl);
  }

  vec3 col = texel.rgb * light;
  col = mix(col, uFogColor, vFog);
  fragColor = vec4(col, texel.a * uOpacity);
}
`;

// --- sky -------------------------------------------------------------------
// A single full-screen triangle; direction is reconstructed per pixel from the
// inverse view-projection. Cloud banding is deliberately coarse so the dither
// pass reads as a 15-bit gradient rather than a smooth modern sky.

export const SKY_VS = /* glsl */`#version 300 es
precision highp float;
out vec2 vNdc;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vNdc = p * 2.0 - 1.0;
  gl_Position = vec4(vNdc, 1.0, 1.0);
}
`;

export const SKY_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vNdc;

uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uCloudDark;
uniform vec3 uCloudLight;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uTime;
uniform float uOvercast;

out vec4 fragColor;

float hash(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}

void main() {
  vec4 far = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(far.xyz / far.w - uCamPos);

  float h = clamp(dir.y, -1.0, 1.0);
  vec3 col = mix(uSkyHorizon, uSkyTop, pow(clamp(h, 0.0, 1.0), 0.55));

  // Sun/moon disc smear — kept subtle, the sky is heavily overcast.
  float sd = max(dot(dir, normalize(uSunDir)), 0.0);
  col += uSunColor * pow(sd, 26.0) * 0.85;
  col += uSunColor * pow(sd, 4.0) * 0.10;

  // Flat cloud plane projected from the view ray.
  if (h > 0.005) {
    vec2 cp = dir.xz / (h + 0.10);
    float drift = uTime * 0.0045;
    float n = fbm(cp * 1.30 + vec2(drift, drift * 0.55));
    float n2 = fbm(cp * 3.10 - vec2(drift * 1.7, drift * 0.4));
    float mask = smoothstep(0.34, 0.86, n * 0.72 + n2 * 0.28);
    mask *= smoothstep(0.0, 0.16, h);
    vec3 cloud = mix(uCloudDark, uCloudLight, smoothstep(0.30, 0.95, n2));
    col = mix(col, cloud, mask * uOvercast);
  }

  // Haze band welding the sky to the fog colour at the horizon.
  col = mix(col, uSkyHorizon, smoothstep(0.16, -0.06, h));
  fragColor = vec4(col, 1.0);
}
`;

// --- post ------------------------------------------------------------------

export const POST_VS = /* glsl */`#version 300 es
precision highp float;
out vec2 vUV;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const POST_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUV;

uniform sampler2D uScene;
uniform vec2 uResolution;      // internal render resolution
uniform float uTime;
uniform float uHurt;           // 0..1 red vignette on damage
uniform float uGrain;
uniform float uVignette;
uniform float uScanline;
uniform float uDither;
uniform float uFade;           // 0 = normal, 1 = black
uniform vec3 uGrade;           // per-channel gain

out vec4 fragColor;

// 4x4 Bayer matrix — the classic PS1 dither pattern.
const float bayer[16] = float[16](
   0.0,  8.0,  2.0, 10.0,
  12.0,  4.0, 14.0,  6.0,
   3.0, 11.0,  1.0,  9.0,
  15.0,  7.0, 13.0,  5.0
);

float rand(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 uv = vUV;
  vec2 px = uv * uResolution;

  // Tiny chromatic split; reads as composite-video bleed at low res.
  vec2 off = (uv - 0.5) * (0.55 / uResolution.x);
  vec3 col;
  col.r = texture(uScene, uv + off).r;
  col.g = texture(uScene, uv).g;
  col.b = texture(uScene, uv - off).b;

  col *= uGrade;

  // Ordered dither down to 15-bit colour (32 levels per channel).
  float b = bayer[int(mod(px.y, 4.0)) * 4 + int(mod(px.x, 4.0))] / 16.0 - 0.5;
  col += b * (uDither / 32.0);
  col = floor(col * 31.0 + 0.5) / 31.0;

  // Scanlines and grain.
  float scan = 1.0 - uScanline * (0.5 + 0.5 * sin(px.y * 3.14159));
  col *= scan;
  col += (rand(px + fract(uTime) * 91.7) - 0.5) * uGrain;

  // Vignette, then the damage flash on top of it.
  float d = length(uv - 0.5);
  col *= 1.0 - uVignette * smoothstep(0.34, 0.86, d);
  if (uHurt > 0.001) {
    float edge = smoothstep(0.20, 0.78, d);
    col = mix(col, vec3(0.42, 0.02, 0.02), edge * uHurt * 0.92);
    col.r += uHurt * 0.06;
  }

  col *= (1.0 - uFade);
  fragColor = vec4(col, 1.0);
}
`;

// --- HUD / 2D --------------------------------------------------------------

export const UI_VS = /* glsl */`#version 300 es
precision highp float;
in vec2 aPos;      // pixels, origin top-left of the internal resolution
in vec2 aUV;
in vec4 aColor;
uniform vec2 uResolution;
out vec2 vUV;
out vec4 vColor;
void main() {
  vec2 ndc = vec2(aPos.x / uResolution.x * 2.0 - 1.0,
                  1.0 - aPos.y / uResolution.y * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  vUV = aUV;
  vColor = aColor;
}
`;

export const UI_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUV;
in vec4 vColor;
uniform sampler2D uFont;
uniform float uUseTexture;
out vec4 fragColor;
void main() {
  vec4 c = vColor;
  if (uUseTexture > 0.5) {
    float a = texture(uFont, vUV).a;
    c.a *= a;
    if (c.a < 0.02) discard;
  }
  fragColor = c;
}
`;
