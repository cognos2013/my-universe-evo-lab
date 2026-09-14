/**
 * Phase 11.3 — Surface layers (P3).
 *
 * P3 introduces *layers* that sit on top of the surface mesh:
 * settlement markers, life indicators, building clusters, weather
 * cells, etc. Each layer owns its own Three.js objects, exposes
 * an `update(data)` method that the surface view calls when the
 * world changes, and a `dispose()` method to release GPU memory
 * when the user leaves the surface view.
 *
 * The interface is deliberately small:
 *
 *   - `update(data)`: re-render the layer from a fresh snapshot.
 *   - `dispose()`: free any GPU / JS resources the layer owns.
 *
 * The host (`SurfaceView`) treats layers as black boxes — it just
 * forwards `update(data)` and calls `dispose()` on teardown. This
 * keeps each layer's rendering logic self-contained and lets new
 * layers (P3.2 biology, P3.3 weather, ...) drop in without touching
 * the surface view's rendering code.
 *
 * P3.1 ships the first concrete layer: `SettlementMarkerLayer`,
 * which renders P15 settlements as instanced cones on the surface.
 * Subsequent layers will follow the same pattern.
 */

import * as THREE from 'three';

/** A 3D cell-center on the unit sphere, as produced by PlanetGrid. */
export type CellPosition = readonly [number, number, number];

/**
 * Abstract base class for a surface layer.
 *
 * Subclasses are constructed with the cell-center lookup table
 * (so they can translate `cellIndex → 3D position`) and the base
 * radius the surface mesh uses, so they can place their objects
 * at the same elevation the terrain occupies.
 */
export abstract class SurfaceLayer<TData = unknown> {
  /** A parent group the layer should add its objects to. */
  /** P3 — the group the layer adds its objects to. Public
   *  so the surface view can flip `.visible` for layer
   *  toggles without going through a custom hook on every
   *  subclass.
   *
   *  P3.6 — `group` is no longer `readonly`: the surface
   *  view's `addNamedLayer` may re-bind the host-provided
   *  shared group to a dedicated sub-group so per-layer
   *  visibility toggles are independent (see
   *  `surface-view.ts:addNamedLayer`). */
  group: THREE.Group;
  protected cellCenters: ReadonlyArray<CellPosition>;
  protected readonly baseRadius: number;
  protected readonly markerHeight: number;
  /** P3.6 — per-cell elevation (0..1, in the same units as
   *  `ELEV.BEACH` etc.). The surface view's `update()` wires
   *  this in via `setElevation()` so layers can place their
   *  markers on top of the actual surface — not at a fixed
   *  radius above it. Without this, low-elevation cells
   *  would have markers that visibly "float" above the
   *  surface, while high-elevation cells would have markers
   *  buried in the terrain. Default is an empty array (so
   *  layers that haven't been wired yet still render, just
   *  at the legacy fixed-radius position). */
  protected elevation: Float32Array = new Float32Array(0);
  /** 0.015 — the surface view's `ELEVATION_DISPLACEMENT`,
   *  exposed so layers can convert the normalized 0..1
   *  elevation into a world-space radius offset. The value
   *  is duplicated here (instead of imported) to keep this
   *  module decoupled from `surface-view.ts`. If the surface
   *  view ever changes its displacement scale, update both. */
  static readonly SURFACE_DISPLACEMENT = 0.015;

  constructor(
    group: THREE.Group,
    cellCenters: ReadonlyArray<CellPosition>,
    baseRadius: number,
    markerHeight: number,
  ) {
    this.group = group;
    this.cellCenters = cellCenters;
    this.baseRadius = baseRadius;
    this.markerHeight = markerHeight;
  }

  /**
   * Re-render the layer from a fresh data snapshot. The host
   * calls this whenever the underlying projection / world state
   * changes. Subclasses should be idempotent — calling `update`
   * twice with the same data should produce the same scene.
   */
  abstract update(data: TData): void;

  /**
   * Free GPU resources owned by the layer. The host calls this
   * when the surface view is torn down (e.g. user returns to
   * PLANET level).
   */
  abstract dispose(): void;

  /**
   * Replace the cell-centre lookup. The host (surface-view) calls
   * this whenever the cellCenters reference changes (e.g. the
   * icosphere mesh is rebuilt after a world refine, or the
   * fallback Fibonacci points arrive for a non-standard cell
   * count). The base implementation just stores the new
   * reference; subclasses that cache derived geometry (the
   * InstancedMesh) override this to also invalidate that cache
   * so the next `update()` rebuilds.
   */
  setCellCenters(centers: ReadonlyArray<CellPosition>): void {
    this.cellCenters = centers;
  }

  /**
   * P3.6 — wire the per-cell elevation field so the next
   * `update()` can place markers on the actual surface.
   * Called by the surface view after every elevation
   * rebuild. Subclasses default to the legacy fixed-radius
   * placement if they never call `this.elevation`; the
   * weather/vegetation layers override their `update()` to
   * use it.
   */
  setElevation(elev: Float32Array): void {
    this.elevation = elev;
  }

  /**
   * P3.6 — helper for subclasses: the world-space radius
   * at which a marker should sit on top of the surface mesh
   * for `cellIndex`. Returns the base sphere radius plus the
   * elevation-driven displacement (mirroring the formula
   * the surface view uses for the main mesh) plus a tiny
   * 0.001 margin to keep the marker from z-fighting with the
   * surface. Subclasses that want the legacy fixed-radius
   * placement (e.g. settlement cones whose tip is meant to
   * poke high above the city) can simply not call this.
   */
  protected surfaceRadius(cellIndex: number, margin = 0.001): number {
    const e = this.elevation[cellIndex] ?? 0;
    return 1.0 + e * SurfaceLayer.SURFACE_DISPLACEMENT + margin;
  }
}

// =====================================================================
// P3.1 — SettlementMarkerLayer
// =====================================================================

/** A minimal settlement shape the marker layer needs. The full
 *  P15 `Settlement` type satisfies this, but the layer only reads
 *  the three fields it needs to position + colour the marker. */
export interface SettlementLike {
  id: string;
  cellIndex: number;
  population: number;
  dissolved: boolean;
  /** P15 institution kind; determines marker colour. */
  institution: { kind: 'public' | 'private' | 'mixed' };
}

/** Colour mapping for the institution kinds. Picked to read
 *  clearly against the biome palette (greener forests, browner
 *  mountains, blue oceans). */
const INSTITUTION_COLOR: Record<'public' | 'private' | 'mixed', number> = {
  public:  0x4ade80, // green: shared-economy scale
  private: 0xf97316, // orange: individual incentive
  mixed:   0xeab308, // amber: tax + private mix
};
const DISSOLVED_COLOR = 0x808080; // true grey: collapsed

/** The minimum and maximum visible marker size in world units
 *  (multiplied by population-scaled factor). Small enough to
 *  not occlude the biome, large enough to be readable from
 *  the surface waypoint. */
const MIN_MARKER_SCALE = 0.006;
const MAX_MARKER_SCALE = 0.020;
const POPULATION_REFERENCE = 200; // 1.0 scale at this population
const POPULATION_LOG_MIN = 1;     // log clamp floor

/**
 * Pure helper: pick a marker colour from a settlement's
 * institution kind. Dissolved settlements are always grey,
 * regardless of institution. Exported so unit tests can cover
 * the colour mapping without instantiating Three.js.
 */
export function markerColor(s: SettlementLike): number {
  if (s.dissolved) return DISSOLVED_COLOR;
  return INSTITUTION_COLOR[s.institution.kind];
}

/** Pure helper: a softer, *desaturated* version of the
 *  institution colour for the cluster of houses around a
 *  settlement cone. The cone uses the saturated palette so
 *  it pops; the houses lean toward pastel so the cluster
 *  reads as "a village tinted by its institution" rather
 *  than 4 mini-cones. Dissolved → grey. Exported for tests. */
export function markerHouseColor(s: SettlementLike): number {
  const base = markerColor(s);
  if (s.dissolved) return DISSOLVED_COLOR;
  const [r, g, b] = colorToRgb(base);
  // 65% base + 35% white — enough desaturated to read as
  // pastel, but still recognisably the institution colour.
  const m = 0.35;
  return rgbToPacked(r * (1 - m) + m, g * (1 - m) + m, b * (1 - m) + m);
}

/**
 * Pure helper: convert a packed 0xRRGGBB int to an `[r, g, b]`
 * triple in [0, 1]. Exported for tests.
 */
export function colorToRgb(c: number): [number, number, number] {
  return [
    ((c >> 16) & 0xff) / 255,
    ((c >> 8) & 0xff) / 255,
    (c & 0xff) / 255,
  ];
}

/**
 * Pure helper: scale factor for a settlement marker, in world
 * units. Log-scaled by population so small hamlets and large
 * cities are both readable; clamped to a band so a settlement
 * with 100k population doesn't completely cover its neighbours.
 */
export function markerScale(population: number, markerHeight: number): number {
  const pop = Math.max(POPULATION_LOG_MIN, population);
  const logScale = Math.log(pop + 1) / Math.log(POPULATION_REFERENCE + 1);
  const clamped = Math.min(1, Math.max(0, logScale));
  return Math.min(MAX_MARKER_SCALE, Math.max(MIN_MARKER_SCALE, clamped * markerHeight));
}

/**
 * Pure helper: position a marker in 3D given a cell-centre
 * (unit-sphere coordinate). The marker is offset outward by
 * `markerHeight` so the cone's base sits on the surface and
 * the tip points into space. A zero cell falls back to
 * the +Z direction so callers don't get NaN positions.
 */
export function cellToSurfaceMarkerPosition(
  cell: CellPosition,
  baseRadius: number,
  markerHeight: number,
): [number, number, number] {
  const [cx, cy, cz] = cell;
  const radial = Math.hypot(cx, cy, cz);
  if (radial < 1e-9) {
    const mid = baseRadius + markerHeight / 2;
    return [0, 0, mid];
  }
  const nx = cx / radial, ny = cy / radial, nz = cz / radial;
  const mid = baseRadius + markerHeight / 2;
  return [nx * mid, ny * mid, nz * mid];
}

/**
 * Surface layer that renders P15 settlements as instanced cones
 * placed on their parent cell. Cones (not spheres) so direction
 * is unambiguous: the tip points outward, the base sits on the
 * surface. Colour by institution kind; grey for dissolved. Size
 * scales with log(population) so small and large settlements are
 * both legible.
 *
 * P3.5 — also paints a small cluster of "houses" (cubes)
 * around each settlement's cone, so the marker reads as a
 * little village rather than a lone spike. The houses are
 * a separate InstancedMesh (shared across settlements) so
 * the total instance count is `count × HOUSES_PER_SETTLEMENT`
 * (~ 4 × N) — well within Three.js's comfort zone for
 * even thousands of settlements.
 */
export class SettlementMarkerLayer extends SurfaceLayer<SettlementLike[]> {
  #geometry: THREE.ConeGeometry;
  #material: THREE.MeshBasicMaterial;
  #instanced: THREE.InstancedMesh | null = null;
  #matrix = new THREE.Matrix4();
  #quat = new THREE.Quaternion();
  #scale = new THREE.Vector3();
  #position = new THREE.Vector3();
  #up = new THREE.Vector3(0, 1, 0);
  #lastCount = 0;
  // P3.5 — house sub-layer. A single InstancedMesh holds
  // `count × HOUSES_PER_SETTLEMENT` instances. Each
  // settlement gets HOUSES_PER_SETTLEMENT cubes arranged in
  // a small ring around the cone, slightly inside it (so the
  // cone tip still pokes out above the village).
  #houseGeometry: THREE.BoxGeometry;
  #houseMaterial: THREE.MeshBasicMaterial;
  #houseInstanced: THREE.InstancedMesh | null = null;
  #lastHouseCount = 0;
  // P3.5 — halo sub-layer. Same instance count as cones
  // (1 per settlement). The ring sits *on* the surface (at
  // baseRadius) and faces outward, so the user can see at
  // a glance "this is a settlement" even when the cone is
  // foreshortened or behind the planet's limb.
  #haloGeometry: THREE.RingGeometry;
  #haloMaterial: THREE.MeshBasicMaterial;
  #haloInstanced: THREE.InstancedMesh | null = null;
  #lastHaloCount = 0;
  // Tangent basis (used to place houses around the cone
  // without each house overlapping its neighbour). Refreshed
  // per settlement in the inner loop.
  #tangent = new THREE.Vector3();
  #bitangent = new THREE.Vector3();

  static readonly HOUSES_PER_SETTLEMENT = 4;
  // House size relative to the settlement cone — the cone is
  // ~3× as tall as a house, so a village reads as a small
  // town rather than a forest of skyscrapers.
  static readonly HOUSE_HEIGHT_RATIO = 0.18;

  constructor(
    group: THREE.Group,
    cellCenters: ReadonlyArray<CellPosition>,
    baseRadius: number,
  ) {
    // P3.5 — cone is now bigger and accompanied by a
    // translucent halo so the user can't miss settlements
    // even when zoomed all the way out.
    super(group, cellCenters, baseRadius, 0.032);
    this.#geometry = new THREE.ConeGeometry(0.4, 1.0, 4, 1, false);
    // P3.5 visual fix: MeshBasicMaterial ignores scene
    // lighting so the cone colour matches the institution
    // palette exactly. (Same lesson as BiomassLayer — the
    // MeshStandardMaterial cone was getting eaten by the
    // bright biome background.)
    this.#material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
    });
    this.#material.vertexColors = false;
    // P3.5 — house geometry. A flat box so the cubes read
    // as buildings (not blobs). 1.0 × 1.0 × 1.0 in local
    // space; the per-instance scale shrinks them to ~18% of
    // the cone's marker height.
    this.#houseGeometry = new THREE.BoxGeometry(1.0, 1.0, 1.0);
    this.#houseMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
    });
    this.#houseMaterial.vertexColors = false;
    // P3.5 — halo. A flat ring on the surface, scaled with
    // the cone but ~3× its footprint, painted in the
    // institution colour at low opacity. The halo *always*
    // shows the cell a settlement is on, even when the cone
    // itself is small or behind the limb. The cone + halo
    // combo makes a settlement read at any zoom.
    //
    // P3.6 — the previous inner/outer (0.7 / 1.0) made the
    // halo's outer edge sit at world radius
    // sqrt(1.02² + 1.0²) ≈ 1.43, i.e. the halo *enveloped*
    // the planet and read as a big green disc covering the
    // whole globe (because each cell is a hemisphere-scale
    // away from its neighbour, the halos overlapped and
    // blended into a single tinted shell). Shrink to
    // 0.15 / 0.25 — the halo now sits as a small tinted
    // badge around the cone base, distinguishable from
    // climate rings (which are 0.05–0.12) and from vegetation
    // tufts (which are tiny 0.003 cones).
    this.#haloGeometry = new THREE.RingGeometry(0.15, 0.25, 18, 1);
    this.#haloMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.#haloMaterial.vertexColors = false;
  }

  update(settlements: SettlementLike[]): void {
    const count = settlements.length;
    if (count === 0) {
      this.#teardownInstance();
      this.#teardownHouses();
      this.#teardownHalo();
      return;
    }
    // --- Cone InstancedMesh ---
    if (this.#instanced === null || this.#instanced.count !== count) {
      this.#teardownInstance();
      this.#instanced = new THREE.InstancedMesh(this.#geometry, this.#material, count);
      this.#instanced.frustumCulled = false;
      this.#instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const colors = new Float32Array(count * 3);
      this.#instanced.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
      this.group.add(this.#instanced);
      this.#lastCount = count;
    }
    // --- House InstancedMesh ---
    const totalHouses = count * SettlementMarkerLayer.HOUSES_PER_SETTLEMENT;
    if (this.#houseInstanced === null || this.#lastHouseCount !== totalHouses) {
      this.#teardownHouses();
      this.#houseInstanced = new THREE.InstancedMesh(this.#houseGeometry, this.#houseMaterial, totalHouses);
      this.#houseInstanced.frustumCulled = false;
      this.#houseInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const houseColors = new Float32Array(totalHouses * 3);
      this.#houseInstanced.instanceColor = new THREE.InstancedBufferAttribute(houseColors, 3);
      this.group.add(this.#houseInstanced);
      this.#lastHouseCount = totalHouses;
    }
    // --- Halo InstancedMesh (P3.5) ---
    if (this.#haloInstanced === null || this.#lastHaloCount !== count) {
      this.#teardownHalo();
      this.#haloInstanced = new THREE.InstancedMesh(this.#haloGeometry, this.#haloMaterial, count);
      this.#haloInstanced.frustumCulled = false;
      this.#haloInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const haloColors = new Float32Array(count * 4); // RGBA so we can fade dissolved
      this.#haloInstanced.instanceColor = new THREE.InstancedBufferAttribute(haloColors, 4);
      this.group.add(this.#haloInstanced);
      this.#lastHaloCount = count;
    }

    // Render every settlement + its house cluster.
    for (let i = 0; i < count; i++) {
      const s = settlements[i]!;
      const cell = this.cellCenters[s.cellIndex];
      if (!cell) continue; // out-of-range cellIndex — skip silently
      // Place the cone's tip outward: position the cone's *base*
      // on the surface so the tip points away from the planet.
      const [px, py, pz] = cellToSurfaceMarkerPosition(cell, this.baseRadius, this.markerHeight);
      this.#position.set(px, py, pz);
      // Orient: cone's +Y axis (its tip) should align with the
      // outward normal (px, py, pz) / |position|.
      this.#quat.setFromUnitVectors(this.#up, this.#position.clone().normalize());
      // Scale by log(population), clamped to a readable band.
      const scale = markerScale(s.population, this.markerHeight);
      this.#scale.set(scale, scale * 3, scale);
      this.#matrix.compose(this.#position, this.#quat, this.#scale);
      this.#instanced.setMatrixAt(i, this.#matrix);
      // Per-instance cone colour (saturated, exact palette).
      const coneRGB = colorToRgb(markerColor(s));
      this.#instanced.instanceColor!.setXYZ(i, coneRGB[0], coneRGB[1], coneRGB[2]);

      // --- Houses ---
      // Build a tangent basis on the sphere surface around the
      // outward normal so the houses sit on the local tangent
      // plane (not floating into space). We pick a world-up
      // reference, then derive tangent = normalize(N × up) and
      // bitangent = N × tangent.
      const outNormal = this.#position.clone().normalize();
      const worldUp = Math.abs(outNormal.y) < 0.95
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(1, 0, 0);
      this.#tangent.copy(outNormal).cross(worldUp).normalize();
      this.#bitangent.copy(outNormal).cross(this.#tangent).normalize();
      // The cone tip is at distance `markerHeight` from the
      // base. Houses sit at ~60% of the way up the cone, in a
      // small ring around the cone's local +Y axis. House size
      // is a fraction of the cone's marker height.
      const houseR = scale * 0.35; // ring radius in world units
      const houseH = scale * SettlementMarkerLayer.HOUSE_HEIGHT_RATIO * 6;
      // House colour: a softer tint of the institution colour
      // (mixed toward white) so the cluster reads as a
      // village rather than 4 mini-cones.
      const houseRGB = colorToRgb(markerHouseColor(s));
      for (let h = 0; h < SettlementMarkerLayer.HOUSES_PER_SETTLEMENT; h++) {
        const angle = (h / SettlementMarkerLayer.HOUSES_PER_SETTLEMENT) * Math.PI * 2;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        // Position on the tangent plane around the cone, at
        // 60% of the cone's height, plus a small radial
        // offset so houses sit *around* the cone, not on it.
        const hx = px
          + (this.#tangent.x * cos + this.#bitangent.x * sin) * houseR * 0.6
          + outNormal.x * scale * 1.5;
        const hy = py
          + (this.#tangent.y * cos + this.#bitangent.y * sin) * houseR * 0.6
          + outNormal.y * scale * 1.5;
        const hz = pz
          + (this.#tangent.z * cos + this.#bitangent.z * sin) * houseR * 0.6
          + outNormal.z * scale * 1.5;
        this.#position.set(hx, hy, hz);
        // Orient the cube so its +Y face points outward
        // (otherwise houses look like they're lying down).
        this.#quat.setFromUnitVectors(this.#up, outNormal);
        this.#scale.set(houseH, houseH, houseH);
        this.#matrix.compose(this.#position, this.#quat, this.#scale);
        const instanceIdx = i * SettlementMarkerLayer.HOUSES_PER_SETTLEMENT + h;
        this.#houseInstanced.setMatrixAt(instanceIdx, this.#matrix);
        this.#houseInstanced.instanceColor!.setXYZ(instanceIdx, houseRGB[0], houseRGB[1], houseRGB[2]);
      }
      // --- Halo (P3.5) ---
      // Place a flat ring on the surface at the cell's
      // baseRadius, oriented so the ring's +Z normal points
      // outward. Scale by the same factor as the cone so a
      // large settlement paints a wide halo and a small one
      // a tight ring.
      const haloR = scale * 4;
      this.#position.set(outNormal.x * this.baseRadius, outNormal.y * this.baseRadius, outNormal.z * this.baseRadius);
      const haloUp = new THREE.Vector3(0, 0, 1);
      this.#quat.setFromUnitVectors(haloUp, outNormal);
      this.#scale.set(haloR, haloR, haloR);
      this.#matrix.compose(this.#position, this.#quat, this.#scale);
      this.#haloInstanced!.setMatrixAt(i, this.#matrix);
      // Halo colour: same institution colour but with alpha
      // tied to opacity, so dissolved settlements read as
      // faint grey rings and live ones as bright halos.
      const [hr, hg, hb] = colorToRgb(markerColor(s));
      const haloAlpha = s.dissolved ? 0.25 : 0.65;
      this.#haloInstanced!.instanceColor!.setXYZW(i, hr, hg, hb, haloAlpha);
    }
    this.#instanced.instanceMatrix.needsUpdate = true;
    this.#instanced.instanceColor!.needsUpdate = true;
    this.#houseInstanced.instanceMatrix.needsUpdate = true;
    this.#houseInstanced.instanceColor!.needsUpdate = true;
    this.#haloInstanced!.instanceMatrix.needsUpdate = true;
    this.#haloInstanced!.instanceColor!.needsUpdate = true;
  }

  dispose(): void {
    this.#teardownInstance();
    this.#teardownHouses();
    this.#teardownHalo();
    this.#geometry.dispose();
    this.#material.dispose();
    this.#houseGeometry.dispose();
    this.#houseMaterial.dispose();
    this.#haloGeometry.dispose();
    this.#haloMaterial.dispose();
  }

  /** P3.5 — tear down the halo InstancedMesh. */
  #teardownHalo(): void {
    if (this.#haloInstanced) {
      this.group.remove(this.#haloInstanced);
      this.#haloInstanced.dispose();
      this.#haloInstanced = null;
    }
  }

  /** P3.5 — tear down the house InstancedMesh. Symmetric to
   *  `#teardownInstance` for the cone. */
  #teardownHouses(): void {
    if (this.#houseInstanced) {
      this.group.remove(this.#houseInstanced);
      this.#houseInstanced.dispose();
      this.#houseInstanced = null;
    }
  }

  /** P3 — install the cell-centre lookup. The host calls this
   *  when the lookup becomes available (it may arrive after
   *  the surface view is first constructed). On the next
   *  `update()` the layer will use the new lookup. */
  override setCellCenters(centers: ReadonlyArray<CellPosition>): void {
    this.cellCenters = centers;
    // Force the next update to rebuild the InstancedMesh so
    // instance counts and per-instance matrices pick up the
    // new lookup.
    this.#lastCount = -1;
  }

  #teardownInstance(): void {
    if (this.#instanced) {
      this.group.remove(this.#instanced);
      this.#instanced.dispose();
      this.#instanced = null;
    }
  }
}

// =====================================================================
// P3.2 — BiomassLayer
// =====================================================================

/** A pure helper that hashes a lineage id to a stable RGB
 *  colour. Two runs of the same world always paint the same
 *  lineage the same hue; distinct lineages get visually
 *  distinct hues (the hash spreads them across the HSL wheel).
 *
 *  Exported so tests can pin the mapping. The implementation
 *  is a tiny FNV-1a over the id's bytes, mapped onto a
 *  360° hue circle with a fixed saturation / lightness. */
export function lineageIdToColor(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Map to hue. Bit-mix to spread the bits evenly: the FNV
  // hash low bits are reasonably well-distributed for short
  // ids but we still xor-shift to break alignment.
  const mixed = (h ^ (h >>> 16)) >>> 0;
  // P3.6 — restrict the hue range to the warm half of the
  // wheel (30°–300° skipping the pure-green band 80°–140°).
  // The previous full 0°–360° range often landed near
  // 120° (pure green), which collided visually with the
  // climate ring (288 K → green) and the public-
  // institution settlement marker. The new band covers
  // red → orange → yellow → teal → blue → magenta →
  // red, skipping only the leafy-green slice, so biomass
  // beads read as "warm jewel tones" against the biome
  // palette rather than "more green stuff".
  const rawHue = mixed % 270; // 0°–270° after the shift below
  const hue = (rawHue + 30) % 360; // shift to 30°–300°; pure-green band (80°–140°) lands between the two ranges we excluded
  // HSL → RGB. Saturation 0.7, lightness 0.55 — saturated
  // enough to read against the muted biome palette, but not
  // so bright that small markers burn out. Bumped from
  // 0.55 → 0.7 so biomass beads pop against the climate
  // ring (which is opacity 0.55 and washes out at distance).
  return hslToRgb(hue, 0.7, 0.55);
}

/** Pure helper: HSL (h ∈ [0, 360), s ∈ [0, 1], l ∈ [0, 1])
 *  to a packed 0xRRGGBB int. Standard formula. Exported for
 *  tests. */
export function hslToRgb(h: number, s: number, l: number): number {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1)      { r = c; g = x; b = 0; }
  else if (hp < 2) { r = x; g = c; b = 0; }
  else if (hp < 3) { r = 0; g = c; b = x; }
  else if (hp < 4) { r = 0; g = x; b = c; }
  else if (hp < 5) { r = x; g = 0; b = c; }
  else             { r = c; g = 0; b = x; }
  const m = l - c / 2;
  const ri = Math.round((r + m) * 255);
  const gi = Math.round((g + m) * 255);
  const bi = Math.round((b + m) * 255);
  return (ri << 16) | (gi << 8) | bi;
}

/** Pure helper: scale a biomass value (in MU) to a marker
 *  size in world units. Log-scaled so an empty cell falls to
 *  zero (skipped by the layer) and a saturated cell caps
 *  well below the next biome. Exported for tests. */
export function biomassToScale(biomassMu: number, markerHeight: number): number {
  if (biomassMu <= 0) return 0;
  // 1 MU = near floor; 1e5 MU = full marker height.
  const logBiomass = Math.log10(biomassMu);
  const t = Math.min(1, Math.max(0, (logBiomass - 0) / 5));
  // P3.4 visual fix: cap at 100% of the surface view's
  // marker height (was 50%). At the previous cap, biomass
  // beads maxed out at 0.0075 of the planet radius, which
  // was visually smaller than the settlement cones and
  // easy to miss against the busy biome background.
  // P3.6 — floor at 0.2 of markerHeight so even the
  // smallest live cell paints a visible bead. The
  // previous 0..1 linear mapping collapsed cells with
  // ~10 MU of biomass to scale ≈ 0.0005 (a single
  // pixel), which the user could not distinguish from
  // the underlying biome.
  // P3.6 (round 2) — raise the floor from 0.2 to 0.5 and
  // the cap accordingly. The user's complaint was that
  // toggling the biomass / weather / vegetation layers
  // all looked identical at the default camera distance:
  // the 0.2 floor gave a 3-pixel sphere, which the busy
  // biome background swallowed. With a 0.5 floor the
  // smallest bead is now 0.0125 world units (≈ 7 px on
  // screen at the default waypoint), clearly distinct
  // from the surface. Log-scale banding is preserved —
  // we still don't paint the same size for a 1-MU cell
  // and a 1e5-MU cell, just compressed to a more
  // visible range.
  const tBiased = 0.5 + 0.5 * t;
  return tBiased * markerHeight;
}

/** Payload for `BiomassLayer.update`. The host (main.ts)
 *  builds this from the latest Projection:
 *    - `biomass[i]`: cell i's biomass in MU
 *    - `dominant[i]`: cell i's dominant lineage index, or -1
 *      when no cohort lives there
 *    - `palette[dom]`: 0xRRGGBB colour for lineage `dom`.
 *
 *  We accept `ArrayLike<number>` for the float arrays so the
 *  layer can consume either the `Float32Array` produced by
 *  `generateElevation` / the river builder or the `Float64Array`
 *  the controller emits in its Projection. */
export interface BiomassPayload {
  biomass: ArrayLike<number>;
  dominant: ArrayLike<number>;
  palette: number[];
}

/**
 * Surface layer that renders per-cell biomass as instanced
 * spheres placed on each cell. The cell's dominant lineage
 * determines the colour (via the host-supplied palette) and
 * the cell's biomass determines the size (log-scaled). Cells
 * with no life (dominant = -1 or biomass = 0) are skipped.
 *
 * Spheres (not cones) so the layer reads as a separate
 * visual language from `SettlementMarkerLayer`: the surface
 * looks like a living planet — little coloured beads floating
 * on each cell — rather than the larger cone markers that
 * represent civilisation.
 */
export class BiomassLayer extends SurfaceLayer<BiomassPayload> {
  #geometry: THREE.SphereGeometry;
  #material: THREE.MeshBasicMaterial;
  #instanced: THREE.InstancedMesh | null = null;
  #matrix = new THREE.Matrix4();
  #scale = new THREE.Vector3();
  #position = new THREE.Vector3();
  #quat = new THREE.Quaternion(); // identity
  #lastCount = -1;

  constructor(
    group: THREE.Group,
    cellCenters: ReadonlyArray<CellPosition>,
    baseRadius: number,
  ) {
    // P3.6 — bump markerHeight from 0.020 to 0.05 so the
    // smallest biomass bead (with the 0.5 floor → scale =
    // 0.025, sphere radius = 0.0125 world units) is
    // visibly distinct from the biome-coloured surface at
    // the default camera distance. Earlier rounds tried
    // 0.020 → 0.025 with a 0.2 floor; the resulting
    // ~3-pixel beads vanished into the biomes and the
    // user reported the four layers all looking the same.
    // Doubling markerHeight + raising the floor pushes
    // the smallest bead to ~7 px on screen.
    super(group, cellCenters, baseRadius, 0.05);
    // Low-poly icosphere (8 segs) — the per-cell markers
    // are small enough that smoother shading is invisible.
    this.#geometry = new THREE.SphereGeometry(0.5, 8, 6);
    // P3.4 visual fix: MeshBasicMaterial ignores scene
    // lighting so the bead's colour matches the lineage
    // palette exactly. MeshStandardMaterial with roughness
    // 0.7 absorbed most of the directional light and the
    // beads disappeared into the biome background.
    this.#material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
    });
    this.#material.vertexColors = false;
  }

  update(data: BiomassPayload): void {
    const cells = this.cellCenters;
    if (cells.length === 0) {
      this.#teardownInstance();
      return;
    }
    // P3.4 visual fix: at high cell counts (20,480 after a
    // refine), drawing a sphere on *every* cell paints the
    // entire planet with a uniform blob texture. Sample
    // every Nth cell so the layer still shows *where* life
    // lives, without hiding the underlying biome.
    const SAMPLE_STRIDE = Math.max(1, Math.floor(cells.length / 1500));
    // Collect the indices we'll render: cells with life,
    // every SAMPLE_STRIDE-th one. (Stride-0 → render all.)
    const indices: number[] = [];
    for (let i = 0; i < cells.length; i++) {
      if (data.dominant[i]! >= 0 && data.biomass[i]! > 0
          && (indices.length === 0 || (i % SAMPLE_STRIDE === 0))) {
        indices.push(i);
      }
    }
    const liveCount = indices.length;
    if (liveCount === 0) {
      this.#teardownInstance();
      return;
    }
    if (this.#instanced === null || this.#lastCount !== liveCount) {
      this.#teardownInstance();
      this.#instanced = new THREE.InstancedMesh(this.#geometry, this.#material, liveCount);
      this.#instanced.frustumCulled = false;
      this.#instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const colors = new Float32Array(liveCount * 3);
      this.#instanced.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
      this.group.add(this.#instanced);
      this.#lastCount = liveCount;
    }
    for (let k = 0; k < liveCount; k++) {
      const i = indices[k]!;
      const dom = data.dominant[i]!;
      const bio = data.biomass[i]!;
      const cell = cells[i]!;
      const [px, py, pz] = cellToSurfaceMarkerPosition(cell, this.baseRadius, this.markerHeight * 0.5);
      this.#position.set(px, py, pz);
      const s = biomassToScale(bio, this.markerHeight);
      this.#scale.set(s, s, s);
      this.#matrix.compose(this.#position, this.#quat, this.#scale);
      this.#instanced.setMatrixAt(k, this.#matrix);
      // Per-instance colour from the host palette; fall back
      // to a neutral grey when the dominant index is out of
      // range (defensive — shouldn't happen in normal use).
      const color = data.palette[dom] ?? 0x808080;
      const [cr, cg, cb] = colorToRgb(color);
      this.#instanced.instanceColor!.setXYZ(k, cr, cg, cb);
    }
    this.#instanced.instanceMatrix.needsUpdate = true;
    this.#instanced.instanceColor!.needsUpdate = true;
  }

  dispose(): void {
    this.#teardownInstance();
    this.#geometry.dispose();
    this.#material.dispose();
  }

  #teardownInstance(): void {
    if (this.#instanced) {
      this.group.remove(this.#instanced);
      this.#instanced.dispose();
      this.#instanced = null;
    }
  }
}

// =====================================================================
// P3.3 — WeatherLayer
// =====================================================================

/** Pure helper: map a temperature (K) to a 0xRRGGBB colour
 *  using a 5-stop gradient (deep blue → cyan → green → yellow →
 *  red). The stops are chosen so the common planetary range
 *  250 K — 320 K spans the whole spectrum, while the
 *  out-of-range tails clamp to the end stops. Exported for
 *  tests. */
export function temperatureToColor(kelvin: number): number {
  // Stop table: (temperature K, RGB 0..1)
  const stops: ReadonlyArray<readonly [number, number, number, number]> = [
    [250, 0.10, 0.30, 0.85], // deep blue — frozen
    [270, 0.20, 0.65, 0.85], // cyan — cold temperate
    [290, 0.30, 0.75, 0.30], // green — temperate
    [305, 0.95, 0.80, 0.20], // yellow — warm
    [320, 0.95, 0.30, 0.20], // red — hot
  ];
  if (kelvin <= stops[0]![0]) return rgbToPacked(stops[0]![1]!, stops[0]![2]!, stops[0]![3]!);
  if (kelvin >= stops[stops.length - 1]![0]) return rgbToPacked(stops[stops.length - 1]![1]!, stops[stops.length - 1]![2]!, stops[stops.length - 1]![3]!);
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    if (kelvin >= a[0] && kelvin <= b[0]) {
      const t = (kelvin - a[0]) / (b[0] - a[0]);
      const r = a[1]! + (b[1]! - a[1]!) * t;
      const g = a[2]! + (b[2]! - a[2]!) * t;
      const bl = a[3]! + (b[3]! - a[3]!) * t;
      return rgbToPacked(r, g, bl);
    }
  }
  // Unreachable; fall through to green.
  return rgbToPacked(stops[2]![1]!, stops[2]![2]!, stops[2]![3]!);
}

/** Pure helper: pack normalised (r, g, b) ∈ [0, 1] to a
 *  0xRRGGBB int. Exported for tests. */
export function rgbToPacked(r: number, g: number, b: number): number {
  const ri = Math.max(0, Math.min(255, Math.round(r * 255)));
  const gi = Math.max(0, Math.min(255, Math.round(g * 255)));
  const bi = Math.max(0, Math.min(255, Math.round(b * 255)));
  return (ri << 16) | (gi << 8) | bi;
}

/** Payload for `WeatherLayer.update`. The host (main.ts)
 *  builds this from the latest Projection:
 *    - `temperature[i]`: cell i's temperature in K
 *    - `land[i]`: cell i's landFraction (0 = ocean, 1 = full land)
 *    - `landOpacity`: host-chosen opacity for land cells;
 *      ocean cells use half this so the temperature signal
 *      stays clear over water without drowning the marine view. */
export interface WeatherPayload {
  temperature: ArrayLike<number>;
  land: ArrayLike<number>;
  landOpacity: number;
}

/**
 * Surface layer that renders per-cell temperature as a
 * translucent instanced ring. Rings (not spheres) so the
 * layer doesn't overlap visually with `BiomassLayer`'s
 * beads. The ring sits just above the surface and uses
 * transparency so the underlying biome stays readable
 * through the ring.
 *
 * Colour comes from `temperatureToColor`; ocean cells get
 * a half-opacity variant so a planet's "climate bands" are
 * still visible from a high orbit even when the camera
 * shows mostly ocean.
 */
export class WeatherLayer extends SurfaceLayer<WeatherPayload> {
  #geometry: THREE.RingGeometry;
  #material: THREE.MeshBasicMaterial;
  #instanced: THREE.InstancedMesh | null = null;
  #matrix = new THREE.Matrix4();
  #scale = new THREE.Vector3();
  #position = new THREE.Vector3();
  #quat = new THREE.Quaternion();
  #lastCount = -1;

  constructor(
    group: THREE.Group,
    cellCenters: ReadonlyArray<CellPosition>,
    baseRadius: number,
  ) {
    super(group, cellCenters, baseRadius, 0.005);
    // P3.6 — the previous inner/outer radii (0.42 / 0.5)
    // gave each ring a world-space reach of 0.5 from its
    // cell centre. Because the ring is *flat* (tangent to
    // the sphere at the marker), the ring's outer edge
    // sat at radius sqrt(1.016² + 0.5²) ≈ 1.13 in world
    // space — 0.12 above the surface. The rings then read
    // as a green "atmosphere" floating far above the
    // planet.
    //
    // The next pass shrank both the ring AND the
    // vegetation object to the same 0.05 size, which made
    // them visually indistinguishable: a tiny green ring
    // and a tiny green cone look like the same dot. The
    // current sizes split the two layers: a *wider* thin
    // ring (inner 0.03 / outer 0.05, visible as a thin
    // tinted halo around the cell) for climate, and a
    // *narrower* 0.003 object (barely a spike) for
    // vegetation. The ring's outer edge sits at radius
    // sqrt(1.016² + 0.05²) ≈ 1.017, only ~0.002 above
    // the surface — still readable as a tinted disk, but
    // tight enough that 300+ rings don't blend into a
    // single "green atmosphere". The vegetation dot is
    // essentially flush with the surface.
    // P3.6 (round 2) — widen the climate ring from
    // (0.03, 0.05) to (0.05, 0.10). The previous size was
    // 0.05 outer (≈ 27 px on screen at the default
    // waypoint), which the user could distinguish from
    // the biomes only when the camera was at a steep
    // angle. Doubling the outer radius makes the ring
    // clearly readable as a tinted disc even at the
    // default front-on view (~55 px), so toggling
    // climate on/off produces an unambiguous visual
    // change.
    this.#geometry = new THREE.RingGeometry(0.05, 0.10, 20, 1);
    this.#material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.#material.vertexColors = false;
  }

  update(data: WeatherPayload): void {
    const cells = this.cellCenters;
    if (cells.length === 0) {
      this.#teardownInstance();
      return;
    }
    // P3.4 visual fix: only draw rings on LAND cells, and
    // thin the layer out by sampling every Nth cell. Without
    // this, ~5120 rings × 24 segments paint the entire
    // sphere with a horizontal-stripe texture that
    // overwhelms the underlying biome. The visual goal of
    // the weather layer is "tint the climate zones", not
    // "wrap the planet in lines" — the sphere mesh already
    // does the latter via biome colours.
    //
    // P3.6 — bumped the stride from 4 → 12. At 5120 cells
    // and ~25% land coverage, the previous stride drew
    // ~320 rings; combined with each ring's ~58 px
    // projected footprint at the default surface waypoint,
    // those 320 rings overlapped heavily and read as a
    // continuous "green atmosphere" rather than discrete
    // climate tints. A stride of 12 cuts the count to
    // ~100 rings, leaving visible gaps between adjacent
    // cells so each ring's hue stands on its own.
    const LAND_THRESHOLD = 0.5;
    const SAMPLE_STRIDE = 12; // every 12th land cell → ~8% of land
    const indices: number[] = [];
    for (let i = 0; i < cells.length; i++) {
      const land = data.land[i] ?? 0;
      if (land >= LAND_THRESHOLD && (indices.length === 0 || (i % SAMPLE_STRIDE === 0))) {
        indices.push(i);
      }
    }
    const count = indices.length;
    if (count === 0) {
      this.#teardownInstance();
      return;
    }
    if (this.#instanced === null || this.#lastCount !== count) {
      this.#teardownInstance();
      this.#instanced = new THREE.InstancedMesh(this.#geometry, this.#material, count);
      this.#instanced.frustumCulled = false;
      this.#instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Per-instance RGBA so we can fade ocean cells.
      const colors = new Float32Array(count * 4);
      this.#instanced.instanceColor = new THREE.InstancedBufferAttribute(colors, 4);
      this.group.add(this.#instanced);
      this.#lastCount = count;
    }
    const upZ = new THREE.Vector3(0, 0, 1);
    for (let k = 0; k < count; k++) {
      const i = indices[k]!;
      const cell = cells[i]!;
      const [cx, cy, cz] = cell;
      const radial = Math.hypot(cx, cy, cz) || 1;
      const nx = cx / radial, ny = cy / radial, nz = cz / radial;
      // P3.6 — sit the ring *on the actual surface* at this
      // cell, not at a fixed `baseRadius + 1e-4` above it.
      // The fixed-radius placement made every ring hover
      // 5–10 mm above the terrain in world space, which
      // read as "floating discs" — especially on ocean
      // cells where the surface is at radius 1.005 and the
      // ring was at 1.020. With elevation-aware placement
      // the ring sits 1 mm above whatever the local
      // surface happens to be.
      const r = this.surfaceRadius(i, 0.001);
      this.#position.set(nx * r, ny * r, nz * r);
      // RingGeometry's normal is +Z; rotate the local +Z onto
      // the outward radial direction.
      const out = this.#position.clone().normalize();
      this.#quat.setFromUnitVectors(upZ, out);
      this.#scale.set(1, 1, 1);
      this.#matrix.compose(this.#position, this.#quat, this.#scale);
      this.#instanced.setMatrixAt(k, this.#matrix);
      // Per-instance RGBA colour.
      const t = data.temperature[i] ?? 290;
      const color = temperatureToColor(t);
      const [cr, cg, cb] = colorToRgb(color);
      this.#instanced.instanceColor!.setXYZW(k, cr, cg, cb, data.landOpacity);
    }
    this.#instanced.instanceMatrix.needsUpdate = true;
    this.#instanced.instanceColor!.needsUpdate = true;
  }

  dispose(): void {
    this.#teardownInstance();
    this.#geometry.dispose();
    this.#material.dispose();
  }

  #teardownInstance(): void {
    if (this.#instanced) {
      this.group.remove(this.#instanced);
      this.#instanced.dispose();
      this.#instanced = null;
    }
  }
}

// =====================================================================
// P3.6 — SurfaceVegetationLayer
// =====================================================================

/** A sparse description of one piece of procedural vegetation
 *  the host wants the layer to draw. The layer is data-driven
 *  so the same layer can be reused with different "recipes"
 *  (e.g. "forest-mode" vs "desert-mode" vs "no-life-mode")
 *  without changing the rendering code. */
export interface VegetationSpec {
  /** Pre-computed cell index in the icosphere (from
   *  `getCellCenters` / the surface-mesh cellMap). */
  cellIndex: number;
  /** (lat, lon) in radians; used to deterministically place
   *  the object inside the cell so two rebuilds produce the
   *  same scene. */
  lat: number;
  lon: number;
  /** Object variant. 0 = tree (cone), 1 = rock (icosphere),
   *  2 = grass tuft (small cone), 3 = shrub (low icosphere). */
  variant: number;
  /** Optional size factor 0..1 (default 1). */
  size?: number;
}

export interface VegetationPayload {
  /** Sparse list of vegetation placements. The host picks
   *  the cells (via a deterministic noise over the cellMap)
   *  and the variant, then hands the result here. */
  specs: VegetationSpec[];
  /** Total land-cell count, used as a denominator for the
   *  log-scaled height. */
  totalLandCells: number;
}

/** Per-variant geometry profile. Kept tiny so the total
 *  vertex / triangle count stays well under a million even
 *  with 3000 specimens. */
function makeVegetationGeometry(variant: number): THREE.BufferGeometry {
  switch (variant) {
    case 0: return new THREE.ConeGeometry(0.5, 1.0, 5, 1, false); // tree
    case 1: return new THREE.IcosahedronGeometry(0.5, 0);       // rock
    case 2: return new THREE.ConeGeometry(0.4, 0.6, 4, 1, false); // grass tuft
    case 3: return new THREE.IcosahedronGeometry(0.5, 1);       // shrub
    default: return new THREE.ConeGeometry(0.5, 1.0, 5, 1, false);
  }
}

/** Per-variant colour: trees dark green, rocks mid grey,
 *  grass lighter green, shrubs olive. MeshBasicMaterial so
 *  the colour is exactly the instance colour regardless of
 *  scene lighting. */
function makeVegetationMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: 0xffffff });
}

function vegetationColor(variant: number): number {
  switch (variant) {
    case 0: return 0x1f6f2a; // tree: deep green
    case 1: return 0x8c8a85; // rock: warm grey
    case 2: return 0x4ea84a; // grass: bright green
    // P3.6 — bump the shrub to a vivid lime so it pops
    // against both the dark forest biome and the
    // light-blue ocean backdrop. The previous 0x6b8a3a
    // olive was too close to the public-institution
    // green (0x4ade80) and the user reported the four
    // layers as "indistinguishable".
    case 3: return 0xa3e635; // shrub: bright lime
    default: return 0x4ea84a;
  }
}

/**
 * Surface layer that scatters small 3D vegetation / rocks
 * across the planet. The host computes the placement list
 * (a `VegetationSpec[]`) — typically by iterating the
 * icosphere cells, hashing a deterministic noise per cell,
 * and choosing a variant based on the cell's biome and
 * terrain roughness. The layer is then a thin renderer that
 * packs each spec into a single InstancedMesh and bakes
 * colour and matrix per instance.
 *
 * The point of the layer is to break up the otherwise
 * monolithic biome surface with *objects* — pine-cone trees
 * in the forests, icosphere rocks in the mountains, grass
 * tufts on the grass biomes. The user can toggle the layer
 * off from the right-hand panel, so dense vegetation doesn't
 * always have to dominate the surface view.
 */
export class SurfaceVegetationLayer extends SurfaceLayer<VegetationPayload> {
  #instanced: THREE.InstancedMesh | null = null;
  #geometry: THREE.BufferGeometry;
  #material: THREE.MeshBasicMaterial;
  #matrix = new THREE.Matrix4();
  #scale = new THREE.Vector3();
  #position = new THREE.Vector3();
  #quat = new THREE.Quaternion();
  #lastCount = -1;

  constructor(
    group: THREE.Group,
    cellCenters: ReadonlyArray<CellPosition>,
    baseRadius: number,
  ) {
    // P3.6 — shrink the marker so the object doesn't poke
    // far above the surface. With the previous 0.012
    // markerHeight, a tree of `size=1.0` scaled to
    // (0.012, 0.018, 0.012) put the tip at radius
    // 1.005 + 0.018 = 1.023 — 0.018 above the surface
    // mesh, which read as "floating sticks".
    //
    // The next pass set markerHeight to 0.005, which
    // matched the climate ring's apparent size and made
    // the two layers visually indistinguishable (the user
    // reported "勾选气候，或者植被显示的图层内容是一样的").
    //
    // Current sizing: the climate ring is now 0.03–0.05
    // (down from 0.05–0.12). The vegetation marker is
    // scaled by `markerHeight` to (0.025, 0.0375, 0.025)
    // for a size-1 shrub — that's 2.5 cm × 3.75 cm × 2.5 cm
    // in world units, sitting on the surface at radius
    // ~1.005 + 0.001 = 1.006. Visually it's a small
    // raised green bump (~14 px on screen at the
    // default surface waypoint), distinguishable from a
    // climate ring (which is a flat tinted disk) and from
    // a settlement cone (which is taller and a different
    // colour). The 0.025 floor (up from 0.005) keeps
    // each tuft readable at the default surface waypoint
    // — the previous 5 mm half-axis collapsed to ~3 px
    // on screen, which vanished into the biome.
    // P3.6 (round 2) — bump vegetation markerHeight from
    // 0.025 to 0.05. The previous size (with the (size ×
    // 1.0, 1.5, 1.0) scale) produced a ~10-px shrub at the
    // default surface waypoint, which was hard to
    // distinguish from the climate ring's tinted disc.
    // Doubling the size gives a 20-px tuft — a clearly
    // raised green bump, visually distinct from both
    // the ring and the settlement cone.
    super(group, cellCenters, baseRadius, 0.05);
    // The geometry is replaced every time the host reorders
    // the specs (different variant counts per rebuild), so
    // start with a placeholder shrub icosphere. The first
    // update() call disposes and replaces it.
    this.#geometry = makeVegetationGeometry(3);
    this.#material = makeVegetationMaterial();
  }

  update(data: VegetationPayload): void {
    const count = data.specs.length;
    if (count === 0) {
      this.#teardownInstance();
      return;
    }
    // Build a single InstancedMesh of the dominant variant for
    // the scene. We don't bother with a per-variant
    // InstancedMesh in P3.6; trees dominate forests, so a
    // single-mesh approach is fine for the v1.
    //
    // P3.6 — pick the *shrub* variant (3, an icosphere) as
    // the default instead of tree (0, a cone). The cone
    // shape collided with the SettlementMarkerLayer's cone
    // — both layers painted a 4–5-sided green spike on the
    // same cell, and the user could not tell whether they
    // were looking at a tree or a city. The icosphere is
    // visually distinct (a small green bump) and the
    // markerHeight of 0.003 keeps it flush with the
    // surface, so it reads as "vegetation tuft" rather
    // than "settlement".
    const variant = 3; // shrub icosphere
    if (this.#geometry !== undefined) this.#geometry.dispose();
    this.#geometry = makeVegetationGeometry(variant);
    if (this.#instanced === null || this.#lastCount !== count) {
      this.#teardownInstance();
      this.#instanced = new THREE.InstancedMesh(this.#geometry, this.#material, count);
      this.#instanced.frustumCulled = false;
      this.#instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const colors = new Float32Array(count * 3);
      this.#instanced.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
      this.group.add(this.#instanced);
      this.#lastCount = count;
    }
    const outNormal = new THREE.Vector3();
    const upZ = new THREE.Vector3(0, 0, 1);
    for (let k = 0; k < count; k++) {
      const s = data.specs[k]!;
      const cell = this.cellCenters[s.cellIndex];
      if (!cell) continue;
      const [cx, cy, cz] = cell;
      const radial = Math.hypot(cx, cy, cz) || 1;
      const nx = cx / radial, ny = cy / radial, nz = cz / radial;
      // P3.6 — same elevation-aware fix as the weather
      // layer. The legacy `baseRadius + markerHeight * 0.4`
      // placement put the tree base 4–5 mm above the
      // surface in world space, so the trunk looked like
      // it was floating; on low-elevation cells the gap
      // was even larger. Sit the base on the actual
      // surface and let the geometry stick upward from
      // there.
      const localOffset = this.#markerOffset(s.lat, s.lon, this.markerHeight);
      const r = this.surfaceRadius(s.cellIndex, 0.001);
      this.#position.set(
        nx * r + localOffset.x,
        ny * r + localOffset.y,
        nz * r + localOffset.z,
      );
      outNormal.copy(this.#position).normalize();
      this.#quat.setFromUnitVectors(upZ, outNormal);
      const size = (s.size ?? 1) * this.markerHeight;
      this.#scale.set(size, size * 1.5, size);
      this.#matrix.compose(this.#position, this.#quat, this.#scale);
      this.#instanced.setMatrixAt(k, this.#matrix);
      const [cr, cg, cb] = colorToRgb(vegetationColor(s.variant));
      this.#instanced.instanceColor!.setXYZ(k, cr, cg, cb);
    }
    this.#instanced.instanceMatrix.needsUpdate = true;
    this.#instanced.instanceColor!.needsUpdate = true;
  }

  dispose(): void {
    this.#teardownInstance();
    this.#geometry.dispose();
    this.#material.dispose();
  }

  #teardownInstance(): void {
    if (this.#instanced) {
      this.group.remove(this.#instanced);
      this.#instanced.dispose();
      this.#instanced = null;
    }
  }

  /** Pure helper: place a small (lat, lon) offset on the
   *  sphere tangent plane so two adjacent cells don't share
   *  the same vegetation instance position. Returns a
   *  Vector3 of the *delta* from the cell centre; the
   *  caller adds it to the cell-centre * r vector. */
  #markerOffset(lat: number, lon: number, scale: number): THREE.Vector3 {
    const out = new THREE.Vector3();
    // tangent basis: (cos lon, 0, -sin lon) (east) and
    // (-sin lat sin lon, cos lat, -sin lat cos lon) (north).
    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);
    const cosLon = Math.cos(lon);
    const sinLon = Math.sin(lon);
    const eastX = cosLon;
    const eastZ = -sinLon;
    const northX = -sinLat * sinLon;
    const northY = cosLat;
    const northZ = -sinLat * cosLon;
    // Hash lat/lon into a small offset in [-1, 1]² so the
    // tree doesn't sit on the cell centre. The host picks
    // the (lat, lon) deterministically, so the user sees
    // a stable pattern across rebuilds.
    const h1 = Math.sin(lat * 12.9898 + lon * 78.233) * 43758.5453;
    const h2 = Math.sin(lat * 39.346 + lon * 11.135) * 24634.6345;
    const dx = (h1 - Math.floor(h1)) - 0.5;
    const dz = (h2 - Math.floor(h2)) - 0.5;
    const s = scale * 0.5;
    out.set(
      eastX * dx * s + northX * dz * s,
      northY * dz * s,
      eastZ * dx * s + northZ * dz * s,
    );
    return out;
  }
}
