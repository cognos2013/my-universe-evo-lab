/**
 * P3.6 — Spatial noise utilities for sampling the unit sphere.
 *
 * The 2D fbm in `terrain.ts` works on a flat lat/lon grid, but
 * for ocean/land assignment (and any future "noise sampled at
 * every icosphere cell centre" use case) we need a 3D variant.
 * Cells with nearly-identical 3D positions on the unit sphere
 * are spatially adjacent, so 3D fbm gives us the
 * "salt-and-pepper → continent" clustering we need for a
 * realistic ocean/land split.
 *
 * Same FBM structure as `terrain.ts` — value noise on a
 * integer lattice, bilinearly (or trilinearly) smoothed,
 * summed across octaves with halving amplitude.
 */

/** Hash 3 integer coordinates to a deterministic value in [0, 1). */
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 1274126177 + seed * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177 | 0;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

/** Smoothstep — used to interpolate the lattice noise smoothly. */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * 3D value noise on an integer lattice, trilinearly smoothed.
 * Range: [0, 1].
 */
export function valueNoise3D(x: number, y: number, z: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const x1 = x0 + 1, y1 = y0 + 1, z1 = z0 + 1;
  const tx = smoothstep(x - x0), ty = smoothstep(y - y0), tz = smoothstep(z - z0);
  const v000 = hash3(x0, y0, z0, seed);
  const v100 = hash3(x1, y0, z0, seed);
  const v010 = hash3(x0, y1, z0, seed);
  const v110 = hash3(x1, y1, z0, seed);
  const v001 = hash3(x0, y0, z1, seed);
  const v101 = hash3(x1, y0, z1, seed);
  const v011 = hash3(x0, y1, z1, seed);
  const v111 = hash3(x1, y1, z1, seed);
  // Trilinear interpolation.
  const x00 = (1 - tx) * v000 + tx * v100;
  const x10 = (1 - tx) * v010 + tx * v110;
  const x01 = (1 - tx) * v001 + tx * v101;
  const x11 = (1 - tx) * v011 + tx * v111;
  const y0i = (1 - ty) * x00 + ty * x10;
  const y1i = (1 - ty) * x01 + ty * x11;
  return (1 - tz) * y0i + tz * y1i;
}

/**
 * 3D fractal Brownian motion. 4 octaves at
 * (1, 0.5, 0.25, 0.125) amplitudes — the same composition as
 * `fbm2D` in `terrain.ts`, extended to 3D so it has spatial
 * coherence on the surface of a unit sphere.
 */
export function fbm3D(x: number, y: number, z: number, seed: number, octaves = 4): number {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise3D(x * freq, y * freq, z * freq, seed + i * 1013) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}
