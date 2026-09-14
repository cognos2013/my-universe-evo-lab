/**
 * V14 in-repo procedural backend — five realistic-looking
 * generators.
 *
 * Per docs/01-02 the V route (World Labs Marble / Atlas / Spark)
 * is paused, but the route surface itself is useful as soon
 * as a credible mesh shows up. The in-repo backend ships five
 * procedural generators, each driven by a hashed seed + a
 * style hint. Every output is a complete `V14WorldResult`
 * (vertices / colours / indices / bounding radius) ready for
 * any WebGL frontend (Three.js, regl, raw GL).
 *
 * Generators:
 *   - `terrain`   — heightmap with multi-octave noise; valleys,
 *                    ridges, lakes, beaches (style-dependent).
 *   - `tree`      — fractal trunk + layered canopy cones.
 *   - `building`  — wall + sloped roof + window cutouts.
 *   - `rock`      — irregular icosphere displaced by angular
 *                    noise.
 *   - `humanoid`  — capsule torso + sphere head + capsule
 *                    arms / legs, limb-articulated.
 *
 * All generators share the same `V14WorldResult` contract so
 * the router and the UI never have to know which kind is
 * active.
 */
import type { ProceduralKind, V14BackendImpl, V14WorldResult, V14WorldSpec } from './types.ts';
import { ALL_PROCEDURAL_KINDS } from './types.ts';

// === Deterministic PRNG (xfnv1a) ======================================

function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Mulberry32 — fast, deterministic, 32-bit state. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cheap 2D value-noise: bilinear interpolation of a hashed
 *  lattice. Sufficient for terrain heights. */
function noise2D(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const fade = (t: number) => t * t * (3 - 2 * t);
  // Use 32-bit modular arithmetic via `Math.imul` so different
  // seeds give different lattice hashes. (The previous version
  // multiplied `seed` by a 50-bit constant in a Number, which lost
  // precision and collapsed many distinct seeds to the same output.)
  const h = (ix: number, iy: number) => {
    const k = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 0x9e3779b1)) >>> 0;
    return Math.imul(k ^ (k >>> 13), 1274126177) >>> 0;
  };
  const a = h(xi, yi) / 4294967295;
  const b = h(xi + 1, yi) / 4294967295;
  const c = h(xi, yi + 1) / 4294967295;
  const d = h(xi + 1, yi + 1) / 4294967295;
  const u = fade(xf);
  const v = fade(yf);
  return (1 - u) * (1 - v) * a + u * (1 - v) * b + (1 - u) * v * c + u * v * d;
}

/** Fractal Brownian motion: 4 octaves of value noise. */
function fbm2D(x: number, y: number, seed: number): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < 4; o++) {
    sum += amp * noise2D(x * freq, y * freq, seed + o * 31);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

// === Mesh primitives ===================================================

/** Build a `V14WorldResult` from raw vertex / colour / index
 *  arrays. Computes the bounding radius and stamps the
 *  metadata so the UI can render a banner. */
function makeResult(
  backend: 'inRepo',
  sourceLabel: string,
  vertices: Float32Array,
  colors: Float32Array,
  indices: Uint32Array,
  durationMs: number,
): V14WorldResult {
  let maxR2 = 0;
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i]!;
    const y = vertices[i + 1]!;
    const z = vertices[i + 2]!;
    const r2 = x * x + y * y + z * z;
    if (r2 > maxR2) maxR2 = r2;
  }
  return { backend, sourceLabel, vertices, colors, indices, boundingRadius: Math.sqrt(maxR2), durationMs };
}

/** Convert a 2D heightmap into a triangulated colour-shaded
 *  terrain mesh. The output has `(n - 1)² × 2` triangles
 *  forming a regular grid. */
function heightmapToMesh(
  heights: Float32Array,
  n: number,
  size: number,
  baseColor: [number, number, number],
  peakColor: [number, number, number],
  waterLevel: number | null,
  waterColor: [number, number, number] | null,
): { vertices: Float32Array; colors: Float32Array; indices: Uint32Array } {
  const vertices = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const h = heights[j * n + i]!;
      const x = (i / (n - 1) - 0.5) * size;
      const z = (j / (n - 1) - 0.5) * size;
      const k = (j * n + i) * 3;
      vertices[k] = x;
      vertices[k + 1] = h;
      vertices[k + 2] = z;
      // Colour by elevation (or water).
      let r: number, g: number, b: number;
      if (waterLevel !== null && waterColor !== null && h <= waterLevel) {
        // Underwater → blend with water.
        const t = Math.max(0, (h - (waterLevel - 0.4)) / 0.4);
        r = waterColor[0] * (1 - t) + baseColor[0] * t;
        g = waterColor[1] * (1 - t) + baseColor[1] * t;
        b = waterColor[2] * (1 - t) + baseColor[2] * t;
      } else {
        const norm = Math.max(0, Math.min(1, (h + 1) / 2));
        r = baseColor[0] * (1 - norm) + peakColor[0] * norm;
        g = baseColor[1] * (1 - norm) + peakColor[1] * norm;
        b = baseColor[2] * (1 - norm) + peakColor[2] * norm;
      }
      colors[k] = r;
      colors[k + 1] = g;
      colors[k + 2] = b;
    }
  }
  const indices = new Uint32Array((n - 1) * (n - 1) * 6);
  let p = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices[p++] = a; indices[p++] = c; indices[p++] = b;
      indices[p++] = b; indices[p++] = c; indices[p++] = d;
    }
  }
  return { vertices, colors, indices };
}

// === Generator 1: terrain =============================================

function generateTerrain(spec: V14WorldSpec, seed: number): V14WorldResult {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const n = Math.max(8, spec.resolution);
  const size = 4;
  const heights = new Float32Array(n * n);
  // Multi-octave FBM with style-dependent exponents.
  const baseRoughness = spec.style === 'rocky' ? 1.2
    : spec.style === 'crystal' ? 0.8
    : spec.style === 'organic' ? 1.0
    : /* smooth */ 0.5;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 4 - 2;
      const y = (j / (n - 1)) * 4 - 2;
      const cx = x;
      const cy = y;
      // Big shape: radial fall-off → island feel.
      const radial = Math.exp(-(cx * cx + cy * cy) * 0.18);
      const noise = fbm2D(x * 0.9, y * 0.9, seed) * 2 - 1;
      const ridge = (1 - Math.abs(fbm2D(x * 1.8 + 11, y * 1.8 + 17, seed + 7) * 2 - 1)) * 0.4;
      const h = (radial * 0.5 + noise * baseRoughness * 0.5 + ridge) * 1.2;
      heights[j * n + i] = h;
    }
  }
  // Style-specific palette + water level.
  let baseColor: [number, number, number];
  let peakColor: [number, number, number];
  let waterLevel: number | null = null;
  let waterColor: [number, number, number] | null = null;
  if (spec.style === 'smooth') {
    baseColor = [0.55, 0.45, 0.30]; peakColor = [0.85, 0.82, 0.74];
    waterLevel = -0.1; waterColor = [0.20, 0.45, 0.65];
  } else if (spec.style === 'rocky') {
    baseColor = [0.45, 0.38, 0.32]; peakColor = [0.78, 0.76, 0.70];
  } else if (spec.style === 'crystal') {
    baseColor = [0.55, 0.65, 0.80]; peakColor = [0.92, 0.96, 1.0];
    waterLevel = -0.3; waterColor = [0.30, 0.55, 0.78];
  } else {
    baseColor = [0.30, 0.55, 0.30]; peakColor = [0.55, 0.72, 0.40];
  }
  const { vertices, colors, indices } = heightmapToMesh(heights, n, size, baseColor, peakColor, waterLevel, waterColor);
  const durationMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return makeResult('inRepo',
    'in-repo procedural terrain (heightmap + FBM + style-tinted water)',
    vertices, colors, indices, durationMs);
}

// === Generator 2: tree ===============================================

function generateTree(spec: V14WorldSpec, seed: number): V14WorldResult {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const rng = makeRng(seed);
  const vertices: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const baseColor: [number, number, number] = spec.style === 'crystal' ? [0.60, 0.85, 0.95]
    : spec.style === 'rocky' ? [0.40, 0.30, 0.20]
    : spec.style === 'organic' ? [0.30, 0.60, 0.30]
    : [0.50, 0.32, 0.20];
  const leafColor: [number, number, number] = spec.style === 'crystal' ? [0.85, 0.95, 1.0]
    : spec.style === 'rocky' ? [0.30, 0.50, 0.20]
    : spec.style === 'organic' ? [0.25, 0.70, 0.30]
    : [0.30, 0.65, 0.30];
  // Trunk: recursive branching — main + 3 sub-branches, each
  // sub-branch spawns 1-2 child branches. Total ~30 segments.
  interface Branch { from: [number, number, number]; to: [number, number, number]; r0: number; r1: number; }
  const branches: Branch[] = [];
  function grow(from: [number, number, number], dir: [number, number, number], length: number, r0: number, depth: number) {
    if (depth <= 0 || length < 0.05) return;
    const to: [number, number, number] = [
      from[0] + dir[0] * length,
      from[1] + dir[1] * length,
      from[2] + dir[2] * length,
    ];
    const r1 = r0 * 0.7;
    branches.push({ from, to, r0, r1 });
    // Tilt direction slightly + spawn children.
    const nChildren = depth > 1 ? 3 : 2 + Math.floor(rng() * 2);
    for (let i = 0; i < nChildren; i++) {
      const angle = (i / nChildren) * Math.PI * 2 + rng() * 0.6;
      const tilt = 0.4 + rng() * 0.3;
      const childDir: [number, number, number] = [
        dir[0] * 0.6 + Math.cos(angle) * tilt * 0.5,
        dir[1] * 0.5 + 0.3,
        dir[2] * 0.6 + Math.sin(angle) * tilt * 0.5,
      ];
      const norm = Math.hypot(...childDir);
      childDir[0]! /= norm; childDir[1]! /= norm; childDir[2]! /= norm;
      grow(to, childDir, length * 0.7, r1, depth - 1);
    }
  }
  grow([0, 0, 0], [0, 1, 0], 1.4, 0.12, 4);
  // Convert branches to cylinder meshes (8 sides).
  for (const b of branches) {
    const sides = 6;
    const segments = 2;
    const start = vertices.length / 3;
    for (let s = 0; s <= segments; s++) {
      const t = s / segments;
      const cx = b.from[0] + (b.to[0] - b.from[0]) * t;
      const cy = b.from[1] + (b.to[1] - b.from[1]) * t;
      const cz = b.from[2] + (b.to[2] - b.from[2]) * t;
      const r = b.r0 * (1 - t) + b.r1 * t;
      for (let side = 0; side < sides; side++) {
        const ang = (side / sides) * Math.PI * 2;
        const dx = Math.cos(ang) * r;
        const dz = Math.sin(ang) * r;
        vertices.push(cx + dx, cy, cz + dz);
        colors.push(...baseColor);
      }
    }
    for (let s = 0; s < segments; s++) {
      for (let side = 0; side < sides; side++) {
        const a = start + s * sides + side;
        const b2 = start + s * sides + ((side + 1) % sides);
        const c = start + (s + 1) * sides + side;
        const d = start + (s + 1) * sides + ((side + 1) % sides);
        indices.push(a, c, b2, b2, c, d);
      }
    }
  }
  // Canopy: layered cones at the tips of leaves.
  const tips = branches.filter(b => b.r1 < 0.04).map(b => b.to);
  for (const tip of tips) {
    const layers = 3;
    for (let L = 0; L < layers; L++) {
      const radius = 0.18 - L * 0.04;
      const cy0 = tip[1] + L * 0.10;
      const cy1 = tip[1] + (L + 1) * 0.18;
      const sides = 8;
      const start = vertices.length / 3;
      for (let s = 0; s <= sides; s++) {
        const ang = (s / sides) * Math.PI * 2;
        vertices.push(tip[0] + Math.cos(ang) * radius, cy0, tip[2] + Math.sin(ang) * radius);
        colors.push(...leafColor);
      }
      for (let s = 0; s < sides; s++) {
        const base = start + s;
        const next = start + s + 1;
        vertices.push(tip[0], cy1, tip[2]);
        colors.push(...leafColor);
        indices.push(base, next, start + sides);
      }
    }
  }
  const durationMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return makeResult('inRepo',
    'in-repo procedural tree (recursive branching + canopy cones)',
    new Float32Array(vertices), new Float32Array(colors), new Uint32Array(indices), durationMs);
}

// === Generator 3: building ==========================================

function generateBuilding(spec: V14WorldSpec, seed: number): V14WorldResult {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const rng = makeRng(seed);
  const vertices: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const wallColor: [number, number, number] = spec.style === 'crystal' ? [0.85, 0.92, 1.0]
    : spec.style === 'rocky' ? [0.55, 0.50, 0.40]
    : spec.style === 'organic' ? [0.70, 0.55, 0.40]
    : [0.82, 0.78, 0.68];
  const roofColor: [number, number, number] = spec.style === 'crystal' ? [0.55, 0.75, 0.95]
    : spec.style === 'rocky' ? [0.40, 0.30, 0.25]
    : spec.style === 'organic' ? [0.55, 0.32, 0.20]
    : [0.50, 0.30, 0.20];
  const windowColor: [number, number, number] = [0.95, 0.85, 0.45];
  // Sizing.
  const w = 1.0, d = 0.8, h = 0.9;
  const roofH = 0.4;
  const floors = 2;
  // Walls (4 quads). Door + windows are coloured patches inside
  // the wall — we just paint the wall colour uniformly, the UI
  // renders the texture detail.
  const w0: [number, number, number][] = [
    [-w / 2, 0, -d / 2], [w / 2, 0, -d / 2], [w / 2, h, -d / 2], [-w / 2, h, -d / 2],
  ];
  const w1: [number, number, number][] = [
    [w / 2, 0, -d / 2], [w / 2, 0, d / 2], [w / 2, h, d / 2], [w / 2, h, -d / 2],
  ];
  const w2: [number, number, number][] = [
    [w / 2, 0, d / 2], [-w / 2, 0, d / 2], [-w / 2, h, d / 2], [w / 2, h, d / 2],
  ];
  const w3: [number, number, number][] = [
    [-w / 2, 0, d / 2], [-w / 2, 0, -d / 2], [-w / 2, h, -d / 2], [-w / 2, h, d / 2],
  ];
  for (const wall of [w0, w1, w2, w3]) pushQuad(vertices, colors, indices, wall, wallColor);
  // Windows: small yellow quads on each wall.
  for (let f = 0; f < floors; f++) {
    const yMid = (f + 0.5) * (h / floors);
    for (const side of [-d / 2, d / 2]) {
      const xJit = (rng() - 0.5) * 0.1;
      pushQuad(vertices, colors, indices, [
        [-w / 4 + xJit, yMid - 0.07, -d / 2 - 0.001], [w / 4 + xJit, yMid - 0.07, -d / 2 - 0.001],
        [w / 4 + xJit, yMid + 0.07, -d / 2 - 0.001], [-w / 4 + xJit, yMid + 0.07, -d / 2 - 0.001],
      ], windowColor);
    }
  }
  // Roof: a sloped gable (4 triangles) + ridge cap.
  const roofBaseY = h;
  const ridgeY = h + roofH;
  const roof: [number, number, number][] = [
    [-w / 2, roofBaseY, -d / 2], [w / 2, roofBaseY, -d / 2], [0, ridgeY, 0],
    [w / 2, roofBaseY, -d / 2], [w / 2, roofBaseY, d / 2], [0, ridgeY, 0],
    [w / 2, roofBaseY, d / 2], [-w / 2, roofBaseY, d / 2], [0, ridgeY, 0],
    [-w / 2, roofBaseY, d / 2], [-w / 2, roofBaseY, -d / 2], [0, ridgeY, 0],
  ];
  for (let i = 0; i < 4; i++) {
    const a = roof[i * 3]!;
    const b = roof[i * 3 + 1]!;
    const c = roof[i * 3 + 2]!;
    const start = vertices.length / 3;
    vertices.push(...a, ...b, ...c);
    colors.push(...roofColor, ...roofColor, ...roofColor);
    indices.push(start, start + 1, start + 2);
  }
  // Door (front, centred).
  pushQuad(vertices, colors, indices, [
    [-0.10, 0, d / 2 + 0.001], [0.10, 0, d / 2 + 0.001], [0.10, 0.35, d / 2 + 0.001], [-0.10, 0.35, d / 2 + 0.001],
  ], [0.40, 0.25, 0.15]);
  const durationMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return makeResult('inRepo',
    'in-repo procedural building (sloped gable + windows + door)',
    new Float32Array(vertices), new Float32Array(colors), new Uint32Array(indices), durationMs);
}

function pushQuad(
  vertices: number[], colors: number[], indices: number[],
  quad: [number, number, number][],
  col: [number, number, number],
) {
  const start = vertices.length / 3;
  for (const v of quad) {
    vertices.push(v[0], v[1], v[2]);
    colors.push(col[0], col[1], col[2]);
  }
  indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
}

// === Generator 4: rock ===============================================

function generateRock(spec: V14WorldSpec, seed: number): V14WorldResult {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const rng = makeRng(seed);
  // Subdivisions scale with resolution but cap at 5 (20,480 tri). Beyond
  // that, the z-sort in the UI renderer becomes the bottleneck and
  // `push(...newI)` on the per-iteration 4× grow hits a stack limit.
  const n = Math.max(1, Math.min(5, Math.floor((spec.resolution - 4) / 12) + 1));
  const radius = 0.7;
  // Generate icosphere vertices + triangle indices.
  const t_ = (1.0 + Math.sqrt(5.0)) / 2.0;
  const icoV: [number, number, number][] = [
    [-1, t_, 0], [1, t_, 0], [-1, -t_, 0], [1, -t_, 0],
    [0, -1, t_], [0, 1, t_], [0, -1, -t_], [0, 1, -t_],
    [t_, 0, -1], [t_, 0, 1], [-t_, 0, -1], [-t_, 0, 1],
  ];
  const icoI: [number, number, number][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  // Subdivide.
  const verts: [number, number, number][] = icoV.map(([x, y, z]) => {
    const m = Math.hypot(x, y, z);
    return [x / m, y / m, z / m];
  });
  for (let s = 0; s < n; s++) {
    const newI: [number, number, number][] = [];
    const cache = new Map<string, number>();
    const mid = (a: number, b: number): number => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const va = verts[a]!;
      const vb = verts[b]!;
      const mx = (va[0] + vb[0]) / 2;
      const my = (va[1] + vb[1]) / 2;
      const mz = (va[2] + vb[2]) / 2;
      const norm = Math.hypot(mx, my, mz);
      const idx = verts.length;
      verts.push([mx / norm, my / norm, mz / norm]);
      cache.set(key, idx);
      return idx;
    };
    for (const [a, b, c] of icoI) {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      newI.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    icoI.length = 0;
    icoI.push(...newI);
  }
  // Displace each vertex along its normal.
  const baseColor: [number, number, number] = spec.style === 'crystal' ? [0.70, 0.85, 1.0]
    : spec.style === 'rocky' ? [0.45, 0.40, 0.34]
    : spec.style === 'organic' ? [0.50, 0.55, 0.30]
    : [0.60, 0.55, 0.48];
  const rough = spec.style === 'crystal' ? 0.05
    : spec.style === 'rocky' ? 0.40
    : spec.style === 'organic' ? 0.25
    : 0.18;
  const flatVerts: number[] = [];
  const flatColors: number[] = [];
  for (const v of verts) {
    const dx = (rng() - 0.5) * rough;
    const dy = (rng() - 0.5) * rough;
    const dz = (rng() - 0.5) * rough;
    const len = Math.hypot(v[0] + dx, v[1] + dy, v[2] + dz);
    flatVerts.push((v[0] + dx) / len * radius, (v[1] + dy) / len * radius, (v[2] + dz) / len * radius);
    flatColors.push(baseColor[0], baseColor[1], baseColor[2]);
  }
  const flatIndices: number[] = [];
  for (const [a, b, c] of icoI) flatIndices.push(a, b, c);
  const durationMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return makeResult('inRepo',
    'in-repo procedural rock (icosphere + angular displacement)',
    new Float32Array(flatVerts), new Float32Array(flatColors), new Uint32Array(flatIndices), durationMs);
}

// === Generator 5: humanoid ==========================================

function generateHumanoid(spec: V14WorldSpec, seed: number): V14WorldResult {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const vertices: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const skin: [number, number, number] = [0.90, 0.78, 0.66];
  const cloth: [number, number, number] = spec.style === 'crystal' ? [0.60, 0.85, 1.0]
    : spec.style === 'rocky' ? [0.50, 0.50, 0.50]
    : spec.style === 'organic' ? [0.30, 0.60, 0.30]
    : [0.40, 0.50, 0.75];
  // Sphere (head) — icosphere at the top, low subdivisions.
  pushSphere(vertices, colors, indices, [0, 1.65, 0], 0.18, 2, skin);
  // Capsule (torso) — two hemispheres + cylinder.
  pushCapsule(vertices, colors, indices, [0, 0.9, 0], [0, 1.45, 0], 0.22, 6, cloth);
  // Arms.
  const armColor: [number, number, number] = skin;
  const armR = 0.06;
  pushCapsule(vertices, colors, indices, [-0.25, 1.40, 0], [-0.30, 0.95, 0], armR, 6, armColor);
  pushCapsule(vertices, colors, indices, [0.25, 1.40, 0], [0.30, 0.95, 0], armR, 6, armColor);
  // Hands.
  pushSphere(vertices, colors, indices, [-0.30, 0.92, 0], armR * 1.1, 2, skin);
  pushSphere(vertices, colors, indices, [0.30, 0.92, 0], armR * 1.1, 2, skin);
  // Legs.
  const legR = 0.08;
  pushCapsule(vertices, colors, indices, [-0.10, 0.9, 0], [-0.12, 0.0, 0], legR, 6, cloth);
  pushCapsule(vertices, colors, indices, [0.10, 0.9, 0], [0.12, 0.0, 0], legR, 6, cloth);
  // Feet.
  pushBox(vertices, colors, indices, [-0.12 - legR, -0.05, -legR * 1.5], [0.24 + legR, 0.05, legR * 1.5], [0.20, 0.15, 0.05]);
  // Head highlight: a small tuft of hair / antenna.
  const tipY = 1.83;
  const tipR = 0.04;
  const segments = 8;
  const start = vertices.length / 3;
  for (let i = 0; i <= segments; i++) {
    const ang = (i / segments) * Math.PI * 2;
    vertices.push(0 + Math.cos(ang) * tipR, tipY, Math.sin(ang) * tipR);
    colors.push(...cloth);
  }
  for (let i = 0; i < segments; i++) {
    indices.push(start + i, start + i + 1, vertices.length / 3);
  }
  vertices.push(0, tipY + 0.08, 0); colors.push(...cloth);
  const tipCenter = vertices.length / 3 - 1;
  for (let i = 0; i < segments; i++) {
    indices.push(start + i, start + i + 1, tipCenter);
  }
  void seed;
  const durationMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return makeResult('inRepo',
    'in-repo procedural humanoid (capsules + icosphere head + sphere joints)',
    new Float32Array(vertices), new Float32Array(colors), new Uint32Array(indices), durationMs);
}

function pushSphere(
  vertices: number[], colors: number[], indices: number[],
  c: [number, number, number], r: number, subdiv: number,
  col: [number, number, number],
) {
  const t_ = (1.0 + Math.sqrt(5.0)) / 2.0;
  const icoV: [number, number, number][] = [
    [-1, t_, 0], [1, t_, 0], [-1, -t_, 0], [1, -t_, 0],
    [0, -1, t_], [0, 1, t_], [0, -1, -t_], [0, 1, -t_],
    [t_, 0, -1], [t_, 0, 1], [-t_, 0, -1], [-t_, 0, 1],
  ];
  const icoI: [number, number, number][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const verts: [number, number, number][] = icoV.map(([x, y, z]) => {
    const m = Math.hypot(x, y, z);
    return [x / m, y / m, z / m];
  });
  for (let s = 0; s < subdiv; s++) {
    const newI: [number, number, number][] = [];
    const cache = new Map<string, number>();
    const mid = (a: number, b: number) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const va = verts[a]!;
      const vb = verts[b]!;
      const mx = (va[0] + vb[0]) / 2;
      const my = (va[1] + vb[1]) / 2;
      const mz = (va[2] + vb[2]) / 2;
      const norm = Math.hypot(mx, my, mz);
      const idx = verts.length;
      verts.push([mx / norm, my / norm, mz / norm]);
      cache.set(key, idx);
      return idx;
    };
    for (const [a, b, c] of icoI) {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      newI.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    icoI.length = 0;
    icoI.push(...newI);
  }
  const start = vertices.length / 3;
  for (const v of verts) {
    vertices.push(c[0] + v[0] * r, c[1] + v[1] * r, c[2] + v[2] * r);
    colors.push(col[0], col[1], col[2]);
  }
  for (const [a, b, c] of icoI) indices.push(start + a, start + b, start + c);
}

function pushCapsule(
  vertices: number[], colors: number[], indices: number[],
  a: [number, number, number], b: [number, number, number], r: number, sides: number,
  col: [number, number, number],
) {
  // Cylinder body.
  const ax = a[0], ay = a[1], az = a[2];
  const bx = b[0], by = b[1], bz = b[2];
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return;
  // Build orthonormal frame.
  const ux = dx / len, uy = dy / len, uz = dz / len;
  // Pick helper axis.
  let hx = 1, hy = 0, hz = 0;
  if (Math.abs(ux) > 0.9) { hx = 0; hy = 1; hz = 0; }
  // n = u × h.
  let nx = uy * hz - uz * hy;
  let ny = uz * hx - ux * hz;
  let nz = ux * hy - uy * hx;
  const nlen = Math.hypot(nx, ny, nz);
  nx /= nlen; ny /= nlen; nz /= nlen;
  // b = n × u.
  const bx2 = ny * uz - nz * uy;
  const by2 = nz * ux - nx * uz;
  const bz2 = nx * uy - ny * ux;
  const start = vertices.length / 3;
  for (let s = 0; s <= sides; s++) {
    const ang = (s / sides) * Math.PI * 2;
    const cosA = Math.cos(ang);
    const sinA = Math.sin(ang);
    const ox = nx * cosA + bx2 * sinA;
    const oy = ny * cosA + by2 * sinA;
    const oz = nz * cosA + bz2 * sinA;
    vertices.push(ax + ox * r, ay + oy * r, az + oz * r);
    colors.push(col[0], col[1], col[2]);
    vertices.push(bx + ox * r, by + oy * r, bz + oz * r);
    colors.push(col[0], col[1], col[2]);
  }
  for (let s = 0; s < sides; s++) {
    const a2 = start + s * 2;
    const b2 = start + s * 2 + 1;
    const c2 = start + ((s + 1) % sides) * 2;
    const d = start + ((s + 1) % sides) * 2 + 1;
    indices.push(a2, c2, b2, b2, c2, d);
  }
  // Hemispheres at both ends.
  const startA = vertices.length / 3;
  const startB = startA;
  for (let s = 0; s < sides; s++) {
    const ang = (s / sides) * Math.PI * 2;
    const cosA = Math.cos(ang);
    const sinA = Math.sin(ang);
    const ox = nx * cosA + bx2 * sinA;
    const oy = ny * cosA + by2 * sinA;
    const oz = nz * cosA + bz2 * sinA;
    vertices.push(ax + ox * r, ay + oy * r, az + oz * r);
    colors.push(col[0], col[1], col[2]);
  }
  // Cap a: 1 fan from a center.
  vertices.push(ax, ay, az); colors.push(col[0], col[1], col[2]);
  const capAcenter = vertices.length / 3 - 1;
  for (let s = 0; s < sides; s++) {
    indices.push(startA + s, startA + ((s + 1) % sides), capAcenter);
  }
  // Cap b: 1 fan from b center.
  const startB2 = vertices.length / 3;
  for (let s = 0; s < sides; s++) {
    const ang = (s / sides) * Math.PI * 2;
    const cosA = Math.cos(ang);
    const sinA = Math.sin(ang);
    const ox = nx * cosA + bx2 * sinA;
    const oy = ny * cosA + by2 * sinA;
    const oz = nz * cosA + bx2 * sinA * 0 + 0;
    void oz;
    vertices.push(bx + ox * r, by + oy * r, bz + (nz * cosA + bz2 * sinA) * r);
    colors.push(col[0], col[1], col[2]);
  }
  vertices.push(bx, by, bz); colors.push(col[0], col[1], col[2]);
  const capBcenter = vertices.length / 3 - 1;
  for (let s = 0; s < sides; s++) {
    indices.push(startB2 + s, startB2 + ((s + 1) % sides), capBcenter);
  }
}

function pushBox(
  vertices: number[], colors: number[], indices: number[],
  lo: [number, number, number], hi: [number, number, number],
  col: [number, number, number],
) {
  const lx = lo[0], ly = lo[1], lz = lo[2];
  const hx = hi[0], hy = hi[1], hz = hi[2];
  const corners: [number, number, number][] = [
    [lx, ly, lz], [hx, ly, lz], [hx, hy, lz], [lx, hy, lz],
    [lx, ly, hz], [hx, ly, hz], [hx, hy, hz], [lx, hy, hz],
  ];
  const faces: [number, number, number, number][] = [
    [0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0],
  ];
  for (const f of faces) {
    const start = vertices.length / 3;
    for (const idx of f) {
      const c = corners[idx]!;
      vertices.push(c[0], c[1], c[2]);
      colors.push(col[0], col[1], col[2]);
    }
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }
}

// === Generator 6: cityscape (P15 settlement-driven) ==================

/**
 * Procedural 3D cityscape whose layout / height / roof style /
 * colour palette all mirror a P15 settlement's state.
 *
 * The generator reads `spec.city` (resolved by the controller
 * from the active settlement registry) and produces:
 *
 *   - `buildingCount = clamp(2, 50, round(population / 5))`
 *     A modest settlement of 50 people gets 10 buildings; a
 *     city of 5,000 caps at 50. This keeps the mesh bounded
 *     regardless of the population value.
 *   - `maxHeight` scales with `knowledgeLevel + techCount`.
 *     Knowledge gives vertical growth (skyscrapers need
 *     engineering); technology gives detail.
 *   - `roofKind` is picked from the institution: public =
 *     dome (temple / market), private = spire (workshop /
 *     tower), mixed = flat (warehouse / factory). A
 *     deterministic seed picks the building footprint layout.
 *   - The building grid occupies a square of side
 *     `sqrt(cellAreaM2) * 0.6`, centred at the origin. The
 *     cell area comes from the planet state; the city fills
 *     the middle 60% so it's clearly visible from any angle.
 *   - `cellNutrientMu` tints the walls (rich soil = warm
 *     sandstone, poor soil = cool stone). `food` reserves
 *     brighten the roofs (abundant food = golden roofs,
 *     scarcity = grey).
 *
 * The function falls back to a small generic city when
 * `spec.city` is null (the user can still ask for a cityscape
 * without picking a settlement; it just looks generic).
 */
function generateCityscape(spec: V14WorldSpec, seed: number): V14WorldResult {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const rng = makeRng(seed);
  const city = spec.city;
  const pop = city?.population ?? 30;
  const know = city?.knowledgeLevel ?? 0;
  const tech = city?.techCount ?? 0;
  const inst = city?.institution ?? 'mixed';
  const food = city?.food ?? 0;
  const nutrient = city?.cellNutrientMu ?? 0;
  const areaM2 = city?.cellAreaM2 ?? 1e9;
  const citySide = Math.max(2, Math.min(8, Math.sqrt(areaM2) * 1e-3 * 0.6));
  const buildingCount = Math.max(2, Math.min(50, Math.round(pop / 5)));
  // Height grows with knowledge + technology. Knowledge is the
  // dominant term (0—6 level maps to 0—2.4 extra height), tech
  // adds up to 1.0. Public institutions get a slight bonus to
  // height (collective projects reach higher).
  const heightBonus = know * 0.4 + tech * 0.15 + (inst === 'public' ? 0.4 : 0);
  const baseHeight = 0.8 + heightBonus;
  // Colour palette: warmth ∝ food / population (how well-fed
  // the city is), saturation ∝ nutrient. Cold / poor cities
  // get a desaturated blue-grey.
  const wealth = food / Math.max(1, pop);
  const warm = Math.max(0, Math.min(1, 0.45 + wealth * 0.2));
  const sat = Math.max(0.2, Math.min(0.9, 0.4 + nutrient * 0.001));
  const wallColor: [number, number, number] = [
    Math.min(1, warm * 0.95),
    Math.min(1, warm * 0.85),
    Math.min(1, warm * 0.55),
  ];
  // Roof colour: gold if food is plentiful, grey if scarce.
  const roofGold = Math.max(0, Math.min(1, food / Math.max(50, pop * 0.5)));
  const roofColor: [number, number, number] = [
    0.45 + roofGold * 0.45,
    0.42 + roofGold * 0.35,
    0.35 + roofGold * 0.05,
  ];
  const verts: number[] = [];
  const cols: number[] = [];
  const idxs: number[] = [];
  // Lay buildings on a square grid; pick `buildingCount` cells.
  const gridSide = Math.max(1, Math.ceil(Math.sqrt(buildingCount)));
  const cell = citySide / gridSide;
  let placed = 0;
  // First cell is the "civic centre" (taller, central, always
  // at the grid origin so it's the visual focal point).
  for (let gy = 0; gy < gridSide && placed < buildingCount; gy++) {
    for (let gx = 0; gx < gridSide && placed < buildingCount; gx++) {
      const cx = (gx + 0.5) * cell - citySide / 2;
      const cz = (gy + 0.5) * cell - citySide / 2;
      // Each building gets a random footprint 0.5—0.9 of the
      // grid cell. The civic centre is full-size and a touch
      // taller.
      const isCivic = placed === 0;
      const w = isCivic ? cell * 0.8 : cell * (0.5 + rng() * 0.4);
      const d = isCivic ? cell * 0.8 : cell * (0.5 + rng() * 0.4);
      // Per-building height varies by ±20 % around the global
      // base; civic centre is the tallest.
      const h = isCivic
        ? baseHeight * 1.6
        : baseHeight * (0.8 + rng() * 0.4);
      const x0 = cx - w / 2, x1 = cx + w / 2;
      const z0 = cz - d / 2, z1 = cz + d / 2;
      // Four wall quads.
      pushQuad(verts, cols, idxs, [
        [x0, 0, z0], [x1, 0, z0], [x1, h, z0], [x0, h, z0],
      ], wallColor);
      pushQuad(verts, cols, idxs, [
        [x1, 0, z0], [x1, 0, z1], [x1, h, z1], [x1, h, z0],
      ], wallColor);
      pushQuad(verts, cols, idxs, [
        [x1, 0, z1], [x0, 0, z1], [x0, h, z1], [x1, h, z1],
      ], wallColor);
      pushQuad(verts, cols, idxs, [
        [x0, 0, z1], [x0, 0, z0], [x0, h, z0], [x0, h, z1],
      ], wallColor);
      // Roof. The shape is dictated by the institution: public
      // → dome (4-sided pyramid at low resolution), private →
      // spire (cone via 8-side ring), mixed → flat slab. The
      // civic centre always gets the public roof so the visual
      // is unambiguous.
      const roofKind = isCivic ? 'public' : inst;
      if (roofKind === 'public') {
        // Pyramid (dome-like at low res): apex at (cx, h + 0.4, cz)
        const apex: [number, number, number] = [cx, h + 0.4, cz];
        pushQuad(verts, cols, idxs, [
          [x0, h, z0], [x1, h, z0], [apex[0], apex[1], apex[2]], [x0, h, z0],
        ], roofColor);
        // Three more triangular faces, sharing the apex.
        const v0: [number, number, number] = [x0, h, z0];
        const v1: [number, number, number] = [x1, h, z0];
        const v2: [number, number, number] = [x1, h, z1];
        const v3: [number, number, number] = [x0, h, z1];
        const ap: [number, number, number] = apex;
        const start = verts.length / 3;
        verts.push(v0[0], v0[1], v0[2], v1[0], v1[1], v1[2], ap[0], ap[1], ap[2]);
        cols.push(roofColor[0], roofColor[1], roofColor[2], roofColor[0], roofColor[1], roofColor[2], roofColor[0], roofColor[1], roofColor[2]);
        idxs.push(start, start + 1, start + 2);
        const s2 = verts.length / 3;
        verts.push(v1[0], v1[1], v1[2], v2[0], v2[1], v2[2], ap[0], ap[1], ap[2]);
        cols.push(roofColor[0], roofColor[1], roofColor[2], roofColor[0], roofColor[1], roofColor[2], roofColor[0], roofColor[1], roofColor[2]);
        idxs.push(s2, s2 + 1, s2 + 2);
        const s3 = verts.length / 3;
        verts.push(v2[0], v2[1], v2[2], v3[0], v3[1], v3[2], ap[0], ap[1], ap[2]);
        cols.push(roofColor[0], roofColor[1], roofColor[2], roofColor[0], roofColor[1], roofColor[2], roofColor[0], roofColor[1], roofColor[2]);
        idxs.push(s3, s3 + 1, s3 + 2);
        const s4 = verts.length / 3;
        verts.push(v3[0], v3[1], v3[2], v0[0], v0[1], v0[2], ap[0], ap[1], ap[2]);
        cols.push(roofColor[0], roofColor[1], roofColor[2], roofColor[0], roofColor[1], roofColor[2], roofColor[0], roofColor[1], roofColor[2]);
        idxs.push(s4, s4 + 1, s4 + 2);
      } else if (roofKind === 'private') {
        // Spire: 8-sided cone above the roof slab.
        const N = 8;
        const peakY = h + 0.6;
        const peakX = cx, peakZ = cz;
        const r = Math.min(w, d) * 0.5;
        const ring: [number, number, number][] = [];
        for (let i = 0; i < N; i++) {
          const a = (i / N) * Math.PI * 2;
          ring.push([cx + Math.cos(a) * r, h, cz + Math.sin(a) * r]);
        }
        for (let i = 0; i < N; i++) {
          const a = ring[i]!;
          const b = ring[(i + 1) % N]!;
          const start = verts.length / 3;
          verts.push(a[0], a[1], a[2], b[0], b[1], b[2], peakX, peakY, peakZ);
          cols.push(roofColor[0], roofColor[1], roofColor[2], roofColor[0], roofColor[1], roofColor[2], roofColor[0], roofColor[1], roofColor[2]);
          idxs.push(start, start + 1, start + 2);
        }
      } else {
        // Flat slab: a single quad 0.05 above the wall top.
        pushQuad(verts, cols, idxs, [
          [x0, h + 0.05, z0], [x1, h + 0.05, z0], [x1, h + 0.05, z1], [x0, h + 0.05, z1],
        ], roofColor);
      }
      placed++;
    }
  }
  // Ground plate: a single large quad at y = -0.01 so the
  // buildings don't z-fight with the floor.
  pushQuad(verts, cols, idxs, [
    [-citySide / 2, -0.01, -citySide / 2],
    [ citySide / 2, -0.01, -citySide / 2],
    [ citySide / 2, -0.01,  citySide / 2],
    [-citySide / 2, -0.01,  citySide / 2],
  ], [Math.max(0, warm * 0.5), Math.max(0, warm * 0.45), Math.max(0, warm * 0.3)]);
  // Source label includes the settlement label so the UI
  // banner can show the city's name verbatim.
  const sourceLabel = `in-repo procedural cityscape (${buildingCount} buildings, ${inst} inst, knowledge ${know.toFixed(2)}, food ${food.toFixed(0)})`;
  const durationMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return makeResult(
    'inRepo', sourceLabel,
    new Float32Array(verts), new Float32Array(cols), new Uint32Array(idxs), durationMs,
  );
}

// === Public backend entry point =======================================

export const inRepoBackend: V14BackendImpl = {
  kind: 'inRepo',
  sourceLabel: 'in-repo procedural generator (5 kinds: terrain / tree / building / rock / humanoid)',
  async generate(spec: V14WorldSpec): Promise<V14WorldResult> {
    const seed = hashString(spec.seed ?? `${spec.prompt}|${spec.kind}|${spec.style}|${spec.resolution}`);
    if (!ALL_PROCEDURAL_KINDS.includes(spec.kind)) {
      throw new Error(`unsupported kind: ${spec.kind}`);
    }
    switch (spec.kind) {
      case 'terrain': return generateTerrain(spec, seed);
      case 'tree': return generateTree(spec, seed);
      case 'building': return generateBuilding(spec, seed);
      case 'rock': return generateRock(spec, seed);
      case 'humanoid': return generateHumanoid(spec, seed);
      case 'cityscape': return generateCityscape(spec, seed);
    }
  },
};
