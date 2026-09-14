export type Vector3 = [number, number, number];
export interface PlanetGrid {
  vertices: Vector3[];
  faces: [number, number, number][];
  centers: Vector3[];
  areaM2: Float64Array;
  neighborOffsets: Uint32Array;
  neighborIndices: Uint32Array;
}
const normalize = (v: Vector3): Vector3 => {
  const n = Math.hypot(...v); return [v[0] / n, v[1] / n, v[2] / n];
};
const dot = (a: Vector3, b: Vector3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Fixed face ordering and midpoint cache make cell IDs stable. */
export function createGrid(cellCount: number, radiusM: number): PlanetGrid {
  if (![320, 1280, 5120, 20480].includes(cellCount) || !Number.isFinite(radiusM) || radiusM <= 0) throw new Error('Invalid grid parameters');
  const t = (1 + Math.sqrt(5)) / 2;
  const vertices = ([[-1,t,0],[1,t,0],[-1,-t,0],[1,-t,0],[0,-1,t],[0,1,t],[0,-1,-t],[0,1,-t],[t,0,-1],[t,0,1],[-t,0,-1],[-t,0,1]] as Vector3[]).map(normalize);
  let faces: [number, number, number][] = [[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],[3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]];
  while (faces.length < cellCount) {
    const cache = new Map<string, number>();
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const old = cache.get(key); if (old !== undefined) return old;
      const x = vertices[a]!, y = vertices[b]!;
      const index = vertices.length;
      vertices.push(normalize([x[0] + y[0], x[1] + y[1], x[2] + y[2]]));
      cache.set(key, index); return index;
    };
    const next: typeof faces = [];
    for (const [a,b,c] of faces) {
      const ab = midpoint(a,b), bc = midpoint(b,c), ca = midpoint(c,a);
      next.push([a,ab,ca],[b,bc,ab],[c,ca,bc],[ab,bc,ca]);
    }
    faces = next;
  }
  const areaM2 = new Float64Array(cellCount), centers: Vector3[] = [];
  const adjacency: number[][] = Array.from({ length: cellCount }, () => []);
  const edges = new Map<string, number>();
  faces.forEach(([ai,bi,ci], index) => {
    const a = vertices[ai]!, b = vertices[bi]!, c = vertices[ci]!;
    centers.push(normalize([a[0]+b[0]+c[0],a[1]+b[1]+c[1],a[2]+b[2]+c[2]]));
    const det = a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]);
    areaM2[index] = 2 * Math.atan2(Math.abs(det), 1 + dot(a,b) + dot(b,c) + dot(c,a)) * radiusM ** 2;
    for (const [x,y] of [[ai,bi],[bi,ci],[ci,ai]] as [number,number][]) {
      const key = x < y ? `${x}:${y}` : `${y}:${x}`;
      const other = edges.get(key);
      if (other === undefined) edges.set(key,index);
      else { adjacency[index]!.push(other); adjacency[other]!.push(index); edges.delete(key); }
    }
  });
  if (edges.size || adjacency.some(a => a.length !== 3)) throw new Error('Sphere topology is not closed');
  const neighborOffsets = Uint32Array.from({ length: cellCount + 1 }, (_,i) => i * 3);
  const neighborIndices = Uint32Array.from(adjacency.flatMap(a => a.sort((x,y) => x-y)));
  return { vertices, faces, centers, areaM2, neighborOffsets, neighborIndices };
}

/**
 * P3.6 — synthetic uniform sphere sampling for cell counts that
 * `createGrid` doesn't accept. The icosphere subdivision only
 * produces counts of 20 × 4^k (320, 1280, 5120, 20480, ...).
 * Older saves — or future scenarios — may hold a state whose
 * `cells.areaM2.length` is e.g. 16280. The controller's
 * `getCellCenters` handler then throws, `loadCellCenters` caches
 * nothing, and the surface view ends up mapping every vertex to
 * cell 0 (the "all green" / "all blue" bug). This Fibonacci
 * spiral is not as spatially uniform as the icosphere but gives
 * us *some* cell-to-position mapping so the surface renders the
 * actual landFraction / temperature pattern instead of one
 * uniform color.
 *
 * Cost: O(n). Deterministic — the same `n` always yields the
 * same `n` points, so the surface view's cellMap cache is
 * stable across re-renders.
 */
export function fallbackCellCenters(n: number): Vector3[] {
  if (!Number.isFinite(n) || n <= 0) throw new Error('fallbackCellCenters: n must be a positive finite number');
  const out: Vector3[] = new Array(n);
  // Golden angle in radians — produces a near-uniform spiral
  // without clustering at the poles.
  const phi = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    // Map i to y in [-1, 1] (linear so the poles are not over-sampled).
    const y = 1 - (i / Math.max(1, n - 1)) * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = phi * i;
    out[i] = [Math.cos(theta) * radius, y, Math.sin(theta) * radius];
  }
  return out;
}
