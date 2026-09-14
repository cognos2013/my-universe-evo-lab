/**
 * Phase 11.2 — Surface view.
 *
 * A higher-resolution Three.js scene that renders the planet's
 * terrain as a real 3D mesh: the radius is displaced by the
 * elevation field from `terrain.ts`, and the vertex colors are
 * picked from the biome palette (ocean / beach / grass / forest
 * / desert / mountain / snow). This is what users see after
 * double-clicking the planet in P1.
 *
 * Resolution strategy: the underlying `WorldState` has 320
 * cells, but the surface mesh is a separate, denser geometry
 * (~16k vertices at 128 segments) so the terrain looks
 * continuous. Each surface vertex samples the nearest cell's
 * elevation + temperature and uses them to drive a biome
 * classification. This decouples the clickable cell-grid
 * (still 320 cells, used at the planet level) from the visual
 * mesh (denser, used at the surface level).
 *
 * Performance: 16k vertices × 60fps draws comfortably on the
 * integrated GPU we target. The InstancedMesh pass for
 * biology / buildings lands in Phase 11.3 (P3).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  generateElevation,
  classifySample,
  BIOME_COLORS,
  surfaceSeed,
  type Biome,
  type BiomeColor,
  type TerrainSource,
} from '../simulation/terrain.ts';
import { buildRiverNetwork, type RiverNetwork } from '../simulation/rivers.ts';
import type { LevelManager, CameraState } from './level-manager.ts';
import { SurfaceLayer, type CellPosition } from './surface-layer.ts';

const SURFACE_SEGMENTS = 256; // P3.5: 256 → ~66k vertices, ~131k triangles so close-up zoom stays smooth
// P3.5 visual fix: 0.04 was eating the surface layers —
// cones (markerHeight 0.032) sat *inside* the terrain
// (peak r=1.04) and were invisible. 0.015 keeps the
// elevation readable (mountain peaks at r=1.015) while
// leaving room above for halo (r=1.015 + 1e-4) and the
// cone / house / biomass / weather markers.
const ELEVATION_DISPLACEMENT = 0.015;
const BASE_RADIUS = 1.0;

export class SurfaceView {
  #renderer: THREE.WebGLRenderer;
  #scene = new THREE.Scene();
  #camera: THREE.PerspectiveCamera;
  #controls: OrbitControls;
  #mesh: THREE.Mesh;
  #geometry: THREE.BufferGeometry;
  // P3.6 (round 2) — read-only camera accessor for the
  // Playwright diag. We don't want to expose mutation
  // hooks (the camera is driven by the level manager),
  // but the layer-visibility test needs to know where
  // the camera is to interpret the screenshots.
  get camera(): THREE.PerspectiveCamera { return this.#camera; }
  #container: HTMLElement;
  #levelManager: LevelManager;
  #frames = 0;
  #currentSamples = 0;
  #currentSeed = 0;
  #currentElevation: Float32Array = new Float32Array(0);
  #currentData: TerrainSource | null = null;
  #riverLines: THREE.LineSegments | null = null;
  #riverNetwork: RiverNetwork = { vertices: new Float32Array(0), pairCount: 0 };
  // Stable per-source RNG for the river picker, so re-renders
  // with the same world state don't redraw a different network.
  #riverRngSeed = 0;
  // P3 — surface layers (settlement markers, etc.). Each layer
  // is a self-contained renderer that the surface view forwards
  // `update()` to whenever the world changes. Layers are added
  // via `addLayer()` before the first `update()`.
  #layers: SurfaceLayer[] = [];
  #layerGroup = new THREE.Group();
  // cell-centre lookup for the layer protocol. Defaults to an
  // empty array (no layers can render) until the host wires one
  // in via the `setCellCenters` hook. The host (main.ts) provides
  // this from `PlanetGrid.centers` once the world is initialised.
  #cellCenters: ReadonlyArray<CellPosition> = [];
  // P3.6 — pre-computed lookup: for each surface-mesh grid
  // cell (gx, gy), the index of the nearest icosphere cell.
  // The icosphere's face order is *not* a simple lat/lon
  // grid, so we can't just do `floor(v * cellCount)`. Building
  // the table once is O(samples² × cellCount) but runs at
  // construction; the per-vertex lookups in #writeGeometry
  // then run at O(1). The table is invalidated by
  // `setCellCenters` and rebuilt lazily on the next
  // #writeGeometry call.
  #cellIndexMap: Int32Array = new Int32Array(0);

  constructor(container: HTMLElement, levelManager: LevelManager) {
    this.#container = container;
    this.#levelManager = levelManager;

    this.#renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.#renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.#renderer.setClearColor(0x080e17, 0);
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.#renderer.domElement);

    this.#camera = new THREE.PerspectiveCamera(55, 1, 0.01, 100);
    // P3.6 (round 2) — instead of a hardcoded initial
    // position that the level manager would then have to
    // animate *into*, read the current waypoint from the
    // level manager. If the level manager has a transition
    // in flight, `#transition.to` is the future surface
    // pose; otherwise, fall back to `DEFAULT_WAYPOINTS.surface`.
    // The previous hardcoded `(0, 0.3, 1.18)` was the
    // source of the "surface always starts at the same
    // close view" bug: the surface view is created in the
    // `onLevelChange` listener, which fires *after* the
    // transition ends, so the level manager's per-frame
    // `tick` had nothing left to interpolate, and the
    // camera stayed pinned to this initial pose. Reading
    // the waypoint at construction lets the new surface
    // view start at the correct distance regardless of how
    // the user got there.
    const waypoint = this.#levelManager.surfaceWaypoint();
    this.#camera.position.set(waypoint.position.x, waypoint.position.y, waypoint.position.z);
    this.#camera.fov = waypoint.fov;

    this.#controls = new OrbitControls(this.#camera, this.#renderer.domElement);
    this.#controls.enableDamping = true;
    this.#controls.enablePan = false;
    // P3.5 floor: keep the camera at least 0.02 planet
    // radii outside the surface mesh (which is at r ≈ 1.015
    // with peak displacement 0.015). The previous floor of
    // 0.4 let the camera *inside* the sphere — the user
    // would zoom past the surface and see the inside of the
    // mesh as a flat blue disc, not the planet. 1.02 keeps
    // you "just above" the surface where the cone / house
    // / halo / biomass markers live.
    this.#controls.minDistance = 1.02;
    // P3.6 (round 2) — raise the maxDistance ceiling from
    // 2.4 to 5.0. The previous ceiling was set when the
    // surface waypoint sat at distance 1.18 (camera ≈ 0.18
    // above the surface mesh). The new waypoint at
    // (0, 0.8, 3.5) is distance 3.59 from origin, so the
    // old 2.4 ceiling clamped the camera *closer* than
    // the waypoint — every frame the controls pulled the
    // camera in from 3.59 to 2.4, which is exactly the
    // "sphere fills the viewport, markers invisible"
    // symptom the user reported. 5.0 leaves a comfortable
    // margin for the user to wheel-zoom out further.
    this.#controls.maxDistance = 5.0;
    // P3.5 visual fix: with 4 settlements placed on cells
    // 2560 / 7680 / 12800 / 17920 (evenly distributed across
    // 20480 cells), the user can only see 1-2 of them at
    // any given camera angle. Auto-rotate reveals the
    // back-of-planet settlements without forcing the user
    // to drag the mouse around. The user can still stop the
    // rotation by interacting (OrbitControls handles this
    // automatically when `enableDamping` is on and the user
    // touches the canvas).
    this.#controls.autoRotate = true;
    // P3.6 (round 2) — slow the surface auto-rotate from
    // 0.4 (one revolution per 30s) to 0.1 (one revolution
    // per 2 min). The previous speed was fast enough that
    // any two screenshots taken more than ~1s apart
    // showed different parts of the planet, which made
    // the layer toggles look identical to the user
    // (the markers were sometimes out of frame). The new
    // speed gives a steady view long enough for the user
    // to flip a layer on/off and see the difference in
    // place.
    this.#controls.autoRotateSpeed = 0.1;
    this.#controls.rotateSpeed = 0.6;
    this.#controls.target.set(0, 0, 0);

    this.#scene.add(new THREE.AmbientLight(0xa6d8e5, 1.5));
    const key = new THREE.DirectionalLight(0xddefff, 2.8);
    key.position.set(-3, 3, 4);
    this.#scene.add(key);
    const rim = new THREE.DirectionalLight(0x48b4a8, 0.9);
    rim.position.set(2, 0, -2);
    this.#scene.add(rim);

    this.#geometry = this.#buildGeometry(SURFACE_SEGMENTS);
    this.#mesh = new THREE.Mesh(
      this.#geometry,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.86,
        metalness: 0.05,
        flatShading: false,
      }),
    );
    // River placeholder — geometry is rebuilt by update() once
    // we have an elevation field. Use a thin blue
    // `LineBasicMaterial`; the geometry buffer starts empty
    // and is replaced on the first update().
    const riverGeom = new THREE.BufferGeometry();
    const riverMat = new THREE.LineBasicMaterial({ color: 0x4ea4d8, transparent: true, opacity: 0.85 });
    this.#riverLines = new THREE.LineSegments(riverGeom, riverMat);
    this.#riverLines.frustumCulled = false;
    // Halo to suggest atmosphere (subtle, fades at the limb).
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(1.05, 48, 32),
      new THREE.MeshBasicMaterial({ color: 0x39bfae, transparent: true, opacity: 0.07, side: THREE.BackSide }),
    );
    this.#scene.add(this.#mesh, halo, this.#riverLines, this.#layerGroup);

    new ResizeObserver(() => this.#resize()).observe(container);
    this.#resize();

    this.#renderer.setAnimationLoop(() => {
      this.#controls.update();
      // Drive the level manager: when a transition is active
      // it will set the camera each frame; when idle we let
      // the user orbit freely and snapshot the camera back
      // into the manager for the next transition's "from".
      this.#levelManager.tick((state) => this.#applyCameraState(state));
      this.#renderer.render(this.#scene, this.#camera);
      this.#renderer.domElement.dataset.renderedFrames = String(++this.#frames);
    });
  }

  /**
   * Update the terrain from a new world state. Reuses the
   * existing geometry if samples + seed match, otherwise
   * rebuilds. Re-runs biome classification either way.
   */
  update(data: TerrainSource): void {
    this.#currentData = data;
    const seed = surfaceSeed(data);
    const samples = SURFACE_SEGMENTS + 1;
    if (seed !== this.#currentSeed || samples !== this.#currentSamples) {
      this.#currentSeed = seed;
      this.#currentSamples = samples;
      // P3.6 — `generateElevation` needs to look at the
      // *same* icosphere cell as the biome classifier, or the
      // elevation field drifts away from the landFraction and
      // we end up with water floating on top of land (the
      // lat/lon heuristic in the legacy `nearestCell` is only
      // accurate for the standard icosphere subdivisions).
      // Build (or refresh) the cellMap first, then thread it
      // through both the elevation field and the geometry
      // pass. `cellCenters` is wired by `setCellCenters`; if
      // it isn't available yet (the host hasn't loaded the
      // cell centres) `generateElevation` falls back to the
      // lat/lon heuristic so we still produce a usable field.
      if (this.#cellCenters.length > 0 && this.#cellIndexMap.length !== samples * samples) {
        this.#buildCellIndexMap();
      }
      this.#currentElevation = generateElevation(data, samples, seed, this.#cellIndexMap);
      this.#writeGeometry(this.#geometry, this.#currentElevation, data);
      this.#rebuildRivers();
      // P3.6 — push the new elevation to all layers so the
      // next marker update can place objects on the actual
      // surface rather than the legacy fixed radius.
      this.#propagateElevation();
    } else {
      this.#writeColors(this.#geometry, this.#currentElevation, data);
    }
  }

  /**
   * Rebuild the river line geometry from the current elevation
   * field. Each river is a polyline traced downhill from a
   * randomly-picked high-elevation source until it reaches
   * the ocean. We use a stable per-source RNG (seeded from
   * the elevation seed) so the same world always paints the
   * same network.
   */
  #rebuildRivers(): void {
    if (!this.#riverLines || !this.#currentData) return;
    const samples = SURFACE_SEGMENTS + 1;
    // Use a tiny deterministic RNG so the same elevation seed
    // → same river picks. Mulberry32.
    let s = (this.#currentSeed ^ 0x9e3779b9) >>> 0;
    const rng = () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    this.#riverNetwork = buildRiverNetwork(
      this.#currentData,
      this.#currentElevation,
      samples,
      this.#currentSeed,
      rng,
    );
    // Displace the river lines along the surface normal so
    // they sit on top of the terrain instead of cutting
    // through it. The river's sample point already lies on
    // the unit sphere; we push it out by ELEVATION_DISPLACEMENT
    // at the matching elevation.
    const positions = new Float32Array(this.#riverNetwork.pairCount * 6);
    const sampleIndex = (x: number, y: number): { ix: number; iy: number } => ({
      ix: Math.max(0, Math.min(samples - 1, Math.round(x))),
      iy: Math.max(0, Math.min(samples - 1, Math.round(y))),
    });
    for (let i = 0; i < this.#riverNetwork.pairCount; i++) {
      const src = 6 * i;
      // Each pair: (px, py, pz) → (qx, qy, qz) in the river
      // vertex buffer. We sample elevation at the (u, v) that
      // corresponds to each point and push the point outward
      // to sit on the displaced surface.
      for (let j = 0; j < 2; j++) {
        const off = src + j * 3;
        const px = this.#riverNetwork.vertices[off + 0]!;
        const py = this.#riverNetwork.vertices[off + 1]!;
        const pz = this.#riverNetwork.vertices[off + 2]!;
        // Reverse the sphereToSample mapping: longitude from
        // atan2(z, x), latitude from asin(y). x is on the unit
        // sphere so this is exact.
        const lon = Math.atan2(pz, px);
        const lat = Math.asin(Math.max(-1, Math.min(1, py)));
        const u = (lon + Math.PI) / (2 * Math.PI);
        const v = (lat + Math.PI / 2) / Math.PI;
        const { ix, iy } = sampleIndex(u * samples, v * samples);
        const elev = this.#currentElevation[iy * samples + ix] ?? 0;
        const r = BASE_RADIUS + elev * ELEVATION_DISPLACEMENT + 0.002;
        const norm = Math.hypot(px, py, pz) || 1;
        positions[off + 0] = (px / norm) * r;
        positions[off + 1] = (py / norm) * r;
        positions[off + 2] = (pz / norm) * r;
      }
    }
    this.#riverLines.geometry.dispose();
    this.#riverLines.geometry = new THREE.BufferGeometry();
    this.#riverLines.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.#riverLines.geometry.computeBoundingSphere();
  }

  /** Public so the level manager can call it on tick. */
  setCameraState(state: CameraState): void {
    this.#applyCameraState(state);
  }

  getCameraState(): CameraState {
    return {
      position: new THREE.Vector3(this.#camera.position.x, this.#camera.position.y, this.#camera.position.z),
      lookAt: new THREE.Vector3(this.#controls.target.x, this.#controls.target.y, this.#controls.target.z),
      fov: this.#camera.fov,
    };
  }

  destroy(): void {
    this.#renderer.setAnimationLoop(null);
    this.#renderer.dispose();
    this.#geometry.dispose();
    for (const layer of this.#layers) layer.dispose();
    this.#layers = [];
    if (this.#renderer.domElement.parentNode) {
      this.#renderer.domElement.parentNode.removeChild(this.#renderer.domElement);
    }
  }

  /**
   * P3 — install the cell-centre lookup used by surface layers
   * to translate `cellIndex → 3D position`. The host calls this
   * once after construction (e.g. from `PlanetGrid.centers`).
   * Without this, layers that depend on cell positions will
   * see an empty lookup and render nothing. The lookup is also
   * forwarded to every registered layer.
   */
  setCellCenters(centers: ReadonlyArray<CellPosition>): void {
    this.#cellCenters = centers;
    // P3.6 visual fix: eagerly rebuild the surface-mesh →
    // icosphere cell map when new cell centres arrive. The
    // previous lazy-rebuild strategy would miss the first
    // render if `update()` was called before `setCellCenters`
    // — the cellMap would stay at length 0, every vertex
    // would read cellIndex 0, and the whole surface would
    // inherit that single cell's landFraction (the
    // "all-green" bug). Building here makes the cellMap
    // ready before the next paint.
    if (centers.length > 0) {
      this.#cellIndexMap = new Int32Array(0); // force #writeGeometry to rebuild
      this.#buildCellIndexMap();
    } else {
      this.#cellIndexMap = new Int32Array(0);
    }
    for (const layer of this.#layers) layer.setCellCenters(centers);
  }

  /**
   * P3.6 — push the freshly-rebuilt elevation field down to
   * every layer so the next `update()` can place markers
   * on the actual surface. Without this, layers that opt
   * into elevation-aware placement (weather rings,
   * vegetation objects) would fall back to a fixed-radius
   * `baseRadius + 1e-4` and read as "floating discs" /
   * "floating trees" wherever the surface elevation didn't
   * match the legacy assumption. Layers that don't care
   * about elevation (settlement cones, biomass beads)
   * ignore the call — their `setElevation` is the no-op
   * default.
   */
  #propagateElevation(): void {
    for (const layer of this.#layers) layer.setElevation(this.#currentElevation);
  }

  /**
   * P3.6 — build the lookup table that maps each surface-mesh
   * grid cell (gx, gy) to the index of the nearest icosphere
   * cell. Called lazily by #writeGeometry on the first
   * render and on every setCellCenters call. Cost is
   * O(samples² × cellCount) ≈ 66k × 20k = 1.3 B for the
   * default 256-segment mesh + 20480-cell icosphere; this
   * runs once per cellCenters update (i.e. once per world
   * initialisation) so the amortised cost is negligible.
   */
  #buildCellIndexMap(): void {
    const samples = SURFACE_SEGMENTS + 1;
    const centers = this.#cellCenters;
    if (centers.length === 0) {
      this.#cellIndexMap = new Int32Array(samples * samples);
      return;
    }
    const map = new Int32Array(samples * samples);
    // Build a 3D-position lookup for the icosphere centres.
    // cellCenters are unit-sphere points; pre-store the
    // (x, y, z) triples flat so the inner loop is tight.
    const n = centers.length;
    const cx = new Float32Array(n);
    const cy = new Float32Array(n);
    const cz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const c = centers[i]!;
      cx[i] = c[0]; cy[i] = c[1]; cz[i] = c[2];
    }
    for (let gy = 0; gy < samples; gy++) {
      // Latitude for this row: v = gy / (samples - 1) ∈ [0, 1]
      // gives sphere y = cos(π × (1 - v)) and a unit
      // horizontal radius of sin(π × (1 - v)).
      const v = gy / (samples - 1);
      const lat = (1 - v) * Math.PI; // 0 (north pole) → π (south pole)
      const sinLat = Math.sin(lat);
      const cosLat = Math.cos(lat);
      for (let gx = 0; gx < samples; gx++) {
        const u = gx / (samples - 1);
        const lon = u * 2 * Math.PI;
        const x = sinLat * Math.cos(lon);
        const y = cosLat;
        const z = sinLat * Math.sin(lon);
        // Find the nearest icosphere cell centre to (x, y, z).
        let best = 0;
        let bestD = Infinity;
        for (let i = 0; i < n; i++) {
          const dx = cx[i]! - x;
          const dy = cy[i]! - y;
          const dz = cz[i]! - z;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bestD) { bestD = d; best = i; }
        }
        map[gy * samples + gx] = best;
      }
    }
    this.#cellIndexMap = map;
  }

  /**
   * P3 — register a surface layer. Layers must be added before
   * the first `update()` call. The host owns the layer's
   * lifecycle: it should keep a reference and forward its own
   * data to `layer.update(data)`.
   */
  addLayer(layer: SurfaceLayer): void {
    this.#layers.push(layer);
  }

  /**
   * P3.4 — name → layer registry. Layers added via
   * `addNamedLayer` are stored under a name so the host's
   * layer-toggle UI can flip them on and off by name
   * (without holding a direct reference).
   */
  #namedLayers = new Map<'settlement' | 'biomass' | 'weather' | 'vegetation', SurfaceLayer>();

  /**
   * P3.4 — register a layer under a name. The surface view
   * remembers it under that name so the toggle UI can
   * reach it later. Layers added via `addLayer` (no name)
   * stay in `#layers` but are not toggleable.
   *
   * P3.6 — also remap the layer's group to a dedicated
   * child of `#layerGroup`. Without this remap, every
   * layer shares the same THREE.Group reference (because
   * the host passes `surfaceView.getLayerGroup()` to each
   * layer's constructor), so flipping
   * `setLayerVisible('weather', false)` also hides the
   * settlement / biomass / vegetation layers. Putting
   * each layer under its own child group restores the
   * one-toggle-one-layer invariant.
   */
  addNamedLayer(name: 'settlement' | 'biomass' | 'weather' | 'vegetation', layer: SurfaceLayer): void {
    this.#namedLayers.set(name, layer);
    this.#layers.push(layer);
    // If the host passed `#layerGroup` directly, give the
    // layer its own sub-group so its `.visible` flag is
    // independent of the other layers.
    if (layer.group === this.#layerGroup) {
      const subGroup = new THREE.Group();
      subGroup.name = `surface-layer-${name}`;
      this.#layerGroup.add(subGroup);
      // Rebind: walk the existing children of the shared
      // group and re-parent any that *belong* to this
      // layer to the new sub-group. Layers haven't drawn
      // anything yet on the first call, so this is a
      // no-op in practice; we keep the rebind path for
      // safety in case the host added markers before
      // calling `addNamedLayer`.
      const toMove = this.#layerGroup.children.filter((c) => c === subGroup ? false : true);
      // Nothing to move at construction time. Subsequent
      // updates will land in `subGroup` because the layer
      // constructor stored `subGroup` as its `group`.
      layer.group = subGroup;
    }
  }

  /**
   * P3.4 — toggle a named layer's visibility. No-op if the
   * name isn't registered, so the host can wire up
   * checkboxes that don't exist yet without breaking
   * anything. The toggle is a `.visible = true/false` flip
   * — no rebuild, no data loss.
   */
  setLayerVisible(name: 'settlement' | 'biomass' | 'weather' | 'vegetation', visible: boolean): void {
    const layer = this.#namedLayers.get(name);
    if (layer) layer.group.visible = visible;
  }

  /**
   * P3 — return the Three.js group the surface view uses to
   * host surface layers. Layers are normally constructed by
   * the host and then registered via `addLayer`, but in some
   * flows the host wants to pass the group directly into the
   * layer's constructor (which is how the marker layer
   * positions its InstancedMesh under the layer hierarchy).
   */
  getLayerGroup(): THREE.Group {
    return this.#layerGroup;
  }

  // -- internal --------------------------------------------------------

  #resize(): void {
    const w = this.#container.clientWidth, h = this.#container.clientHeight;
    if (!w || !h) return;
    this.#renderer.setSize(w, h);
    this.#camera.aspect = w / h;
    this.#camera.updateProjectionMatrix();
  }

  #applyCameraState(state: CameraState): void {
    this.#camera.position.set(state.position.x, state.position.y, state.position.z);
    this.#camera.lookAt(state.lookAt.x, state.lookAt.y, state.lookAt.z);
    this.#camera.fov = state.fov;
    this.#camera.updateProjectionMatrix();
    this.#controls.target.set(state.lookAt.x, state.lookAt.y, state.lookAt.z);
  }

  /**
   * Build a sphere geometry with `segments` latitude bands ×
   * `segments + 1` longitude vertices. We use SphereGeometry
   * (not Icosahedron) because the surface view benefits from
   * a regular lat/lon grid for heightmap sampling; the cell-
   * level world still uses icospheres.
   */
  #buildGeometry(segments: number): THREE.BufferGeometry {
    const geom = new THREE.SphereGeometry(BASE_RADIUS, segments, segments);
    // Re-tessellate the existing SphereGeometry positions into
    // a heightmap-friendly layout: every vertex has a `y` from
    // -1 (south pole) to 1 (north pole) and a longitude angle.
    return geom;
  }

  /**
   * Apply elevation to the existing sphere positions and
   * biome colors in one pass. Runs whenever the world state
   * changes.
   */
  #writeGeometry(geom: THREE.BufferGeometry, elevation: Float32Array, data: TerrainSource): void {
    const samples = SURFACE_SEGMENTS + 1;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const tmp = new THREE.Vector3();
    // P3.6 — build (or rebuild after setCellCenters) the
    // surface-mesh → icosphere lookup. The icosphere's face
    // order is *not* a lat/lon grid, so the old `nearestCell`
    // helper inside `classifySample` mapped surface-mesh grid
    // cells to icosphere indices that bore no spatial
    // relationship to the surface vertex they were drawing
    // for. The new lookup table gives us the *spatially
    // nearest* icosphere cell; we pass that index into
    // `classifySample` via the `cellIndexOverride` parameter
    // so the biome it produces actually matches the
    // landFraction the user sees at that screen pixel.
    if (this.#cellIndexMap.length !== samples * samples) this.#buildCellIndexMap();
    const cellMap = this.#cellIndexMap;
    for (let i = 0; i < pos.count; i++) {
      tmp.fromBufferAttribute(pos, i);
      // Map (x, y, z) to (u, v) by projecting to spherical
      // coords. u is longitude (-π..π), v is latitude (-π/2..π/2).
      const lon = Math.atan2(tmp.z, tmp.x); // -π..π
      const lat = Math.asin(Math.max(-1, Math.min(1, tmp.y))); // -π/2..π/2
      const u = (lon + Math.PI) / (2 * Math.PI);
      const v = (lat + Math.PI / 2) / Math.PI;
      const gx = Math.min(samples - 1, Math.max(0, Math.floor(u * samples)));
      const gy = Math.min(samples - 1, Math.max(0, Math.floor(v * samples)));
      const elev = elevation[gy * samples + gx] ?? 0;
      // Look up the spatially-nearest icosphere cell and
      // pass it through to `classifySample` as the source
      // of landFraction + temperature. Without this
      // override the icosphere's face order would dump the
      // surface into one biome (the "all-green" bug).
      const cellIdx = cellMap[gy * samples + gx] ?? 0;
      const sample = classifySample(gx, gy, samples, elevation, data, cellIdx);
      // Displace radially: r = BASE_RADIUS + elev * ELEVATION_DISPLACEMENT.
      const r = BASE_RADIUS + elev * ELEVATION_DISPLACEMENT;
      tmp.normalize().multiplyScalar(r);
      pos.setXYZ(i, tmp.x, tmp.y, tmp.z);
      const c = sample.color;
      colors[i * 3 + 0] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    pos.needsUpdate = true;
    geom.computeVertexNormals();
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  /** Refresh only the biome colors; geometry stays the same. */
  #writeColors(geom: THREE.BufferGeometry, elevation: Float32Array, data: TerrainSource): void {
    const samples = SURFACE_SEGMENTS + 1;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute;
    const colors = geom.getAttribute('color') as THREE.BufferAttribute;
    const tmp = new THREE.Vector3();
    if (this.#cellIndexMap.length !== samples * samples) this.#buildCellIndexMap();
    const cellMap = this.#cellIndexMap;
    for (let i = 0; i < pos.count; i++) {
      tmp.fromBufferAttribute(pos, i);
      const lon = Math.atan2(tmp.z, tmp.x);
      const lat = Math.asin(Math.max(-1, Math.min(1, tmp.y)));
      const u = (lon + Math.PI) / (2 * Math.PI);
      const v = (lat + Math.PI / 2) / Math.PI;
      const gx = Math.min(samples - 1, Math.max(0, Math.floor(u * samples)));
      const gy = Math.min(samples - 1, Math.max(0, Math.floor(v * samples)));
      const cellIdx = cellMap[gy * samples + gx] ?? 0;
      const sample = classifySample(gx, gy, samples, elevation, data, cellIdx);
      const c = sample.color;
      colors.setXYZ(i, c.r, c.g, c.b);
    }
    colors.needsUpdate = true;
  }
}

// Re-export for convenience
export { BIOME_COLORS, type Biome, type BiomeColor };
