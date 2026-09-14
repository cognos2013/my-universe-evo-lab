/**
 * Cosmic-to-Ground Zoom — Level Manager.
 *
 * Phase 11 (Cosmic-to-Ground Zoom) roadmap: 4 levels
 *
 *   COSMOS  →  GALAXY  →  PLANET  →  SURFACE
 *
 * This module is the state machine + camera waypoint system
 * that drives the transitions between levels. The actual
 * rendering of each level lives in the existing modules
 * (`PlanetView`, `cosmos.ts`, `galaxies.ts`); this file only
 * coordinates the transitions and exposes a small API the
 * shell UI can drive.
 *
 * Phase 11.1 (P1, this commit) ships the core state machine,
 * waypoint definitions, and a smooth cubic-eased interpolator.
 * The default waypoints are starting values; eventually the
 * "from" of each transition is derived from the current scene
 * (e.g. clicking a halo computes a waypoint at that halo's
 * position) so the user can click-through levels.
 *
 * In this commit only PLANET ↔ SURFACE are wired because those
 * are the two levels that share an existing 3D scene
 * (PlanetView). The COSMOS / GALAXY click-through wiring is
 * P1 follow-up work.
 */

import * as THREE from 'three';

/** The four zoom levels. Order matters: deeper levels are later. */
export type Level = 'cosmos' | 'galaxy' | 'planet' | 'surface';

export const ALL_LEVELS: Level[] = ['cosmos', 'galaxy', 'planet', 'surface'];

/** Camera state — position, look-at target, field of view. */
export interface CameraState {
  position: THREE.Vector3;
  lookAt: THREE.Vector3;
  fov: number;
}

/** Plain-object form of CameraState — used at the API boundary. */
export interface CameraStateLike {
  position: { x: number; y: number; z: number };
  lookAt: { x: number; y: number; z: number };
  fov: number;
}

function toCameraState(s: CameraStateLike): CameraState {
  return {
    position: new THREE.Vector3(s.position.x, s.position.y, s.position.z),
    lookAt: new THREE.Vector3(s.lookAt.x, s.lookAt.y, s.lookAt.z),
    fov: s.fov,
  };
}

/**
 * Default waypoints. Distances are in the same "world unit"
 * the existing PlanetView uses (planet radius ≈ 1).
 */
export const DEFAULT_WAYPOINTS: Record<Level, CameraState> = {
  cosmos:  { position: new THREE.Vector3(0,  8,   22), lookAt: new THREE.Vector3(0, 0, 0), fov: 55 },
  galaxy:  { position: new THREE.Vector3(0,  3,    8), lookAt: new THREE.Vector3(0, 0, 0), fov: 50 },
  // P3.6 (round 2) — push the planet waypoint from
  // 3.5 to 5.0 so the surface waypoint (3.5, picked
  // so the marker-sized-relative-to-planet ratio is
  // large enough to read at default zoom) can sit
  // closer to the origin than the planet waypoint. The
  // level-manager invariant in `tests/level-manager.test.ts`
  // asserts `cosmos > galaxy > planet > surface` in
  // distance-from-origin, and the previous surface
  // waypoint of 1.18 comfortably sat below 3.5; with
  // the new surface at 3.5 we needed to push the planet
  // up to preserve the ordering. The planet view at 5.0
  // still subtends ~23° of the 40° fov (sphere fills
  // ~58% of the viewport) — a comfortable "planet in
  // space" framing.
  planet:  { position: new THREE.Vector3(0,  0.4,  5.0), lookAt: new THREE.Vector3(0, 0, 0), fov: 40 },
  // P3.6 (round 2) — pull the surface waypoint from
  // 1.18 to 3.5. At 1.18 the planet filled ~95% of the
  // viewport and almost every layer marker was either
  // hidden by the sphere's curve or so close to the
  // camera that it was just a few pixels. The user
  // reported that toggling the four layers (settlement /
  // biomass / weather / vegetation) all looked the same
  // because at the original distance the markers were
  // either invisible or piled on top of each other on
  // the tiny visible cap. At 3.5 the sphere covers
  // ~66% of the viewport, the entire visible front
  // hemisphere is comfortably framed, and each layer's
  // markers can be seen and told apart.
  surface: { position: new THREE.Vector3(0,  0.8,  3.5), lookAt: new THREE.Vector3(0, 0, 0), fov: 50 },
};

export interface TransitionRequest {
  to: Level;
  /** Where to focus once we arrive. Defaults to the waypoint lookAt. */
  focus?: THREE.Vector3;
  /** Override the default duration (ms). */
  durationMs?: number;
  /** Called when the camera reaches the target waypoint. */
  onArrive?: () => void;
}

export type LevelChangeListener = (level: Level, previous: Level | null) => void;
export type TransitionPhaseListener = (phase: 'start' | 'progress' | 'end', progress: number) => void;

const DEFAULT_DURATION_MS = 1600;
const MIN_DURATION_MS = 600;
const MAX_DURATION_MS = 3200;

/** Cubic ease-in-out. `t` ∈ [0, 1]. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

interface ActiveTransition {
  from: CameraState;
  to: CameraState;
  start: number;
  duration: number;
  onArrive: () => void;
}

/**
 * LevelManager — owns the current level and the in-flight
 * transition. Mounted once at shell startup; consumers
 * subscribe to `onLevelChange` for UI updates and call
 * `requestTransition()` to move between levels.
 */
export class LevelManager {
  #current: Level = 'planet';
  #previous: Level | null = null;
  #lastFrom: CameraState = { ...DEFAULT_WAYPOINTS.planet };
  #transition: ActiveTransition | null = null;
  #listeners = new Set<LevelChangeListener>();
  #phaseListeners = new Set<TransitionPhaseListener>();

  get current(): Level { return this.#current; }
  get previous(): Level | null { return this.#previous; }
  get isTransitioning(): boolean { return this.#transition !== null; }

  /**
   * P3.6 (round 2) — return the camera waypoint for the
   * surface level, regardless of whether the transition
   * is in flight, just finished, or hasn't started yet.
   * Used by the surface view at construction time so the
   * initial render sits at the correct distance even
   * though the level manager's `tick` is no longer
   * animating (the transition already completed before
   * the listener fired and created the surface view).
   */
  surfaceWaypoint(): { position: THREE.Vector3; lookAt: THREE.Vector3; fov: number } {
    if (this.#transition && this.#transition.to) {
      return { position: this.#transition.to.position.clone(), lookAt: this.#transition.to.lookAt.clone(), fov: this.#transition.to.fov };
    }
    const w = DEFAULT_WAYPOINTS.surface;
    return { position: w.position.clone(), lookAt: w.lookAt.clone(), fov: w.fov };
  }

  /** Register a listener for level changes. Returns unsubscribe. */
  onLevelChange(listener: LevelChangeListener): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** Subscribe to per-frame transition progress (0..1). */
  onTransitionPhase(listener: TransitionPhaseListener): () => void {
    this.#phaseListeners.add(listener);
    return () => { this.#phaseListeners.delete(listener); };
  }

  /**
   * Request a transition to `req.to`. If already at that level
   * and no transition is in flight, resolves immediately. If
   * a transition is in flight, the request is ignored (the
   * caller can chain after via `.then`).
   */
  requestTransition(req: TransitionRequest): Promise<Level> {
    if (this.#transition) return Promise.resolve(this.#current);
    if (req.to === this.#current) return Promise.resolve(this.#current);
    return new Promise((resolve) => this.#startTransition(req, resolve));
  }

  /**
   * Drive the in-flight transition one frame. The host
   * (SceneController) calls this from its render loop with
   * the current time. `apply` is called every frame with
   * the interpolated camera state.
   */
  tick(apply: (state: CameraState) => void): void {
    const tr = this.#transition;
    if (!tr) return;
    const t = now();
    const raw = (t - tr.start) / tr.duration;
    const clamped = clamp(raw, 0, 1);
    const eased = easeInOutCubic(clamped);
    const state: CameraState = {
      position: tr.from.position.clone().lerp(tr.to.position, eased),
      lookAt: tr.from.lookAt.clone().lerp(tr.to.lookAt, eased),
      fov: tr.from.fov + (tr.to.fov - tr.from.fov) * eased,
    };
    apply(state);
    this.#phaseListeners.forEach((l) => l('progress', clamped));
    if (clamped >= 1) {
      const arrived = this.#current;
      this.#transition = null;
      this.#lastFrom = state;
      this.#phaseListeners.forEach((l) => l('end', 1));
      const cb = tr.onArrive;
      this.#listeners.forEach((l) => l(arrived, this.#previous));
      cb?.();
    }
  }

  /**
   * Tell the manager where the camera currently is (e.g. after
   * the user manually orbited the planet). The next transition
   * starts from this snapshot, so it doesn't snap. Accepts the
   * plain-object form so the host (PlanetView) can pass its
   * own `{x, y, z}` shape without a conversion.
   */
  setCurrentCamera(state: CameraStateLike): void {
    if (this.#transition) return; // ignore mid-transition updates
    this.#lastFrom = toCameraState(state);
  }

  #startTransition(req: TransitionRequest, resolve: (l: Level) => void): void {
    const target = DEFAULT_WAYPOINTS[req.to];
    const focus = req.focus ?? target.lookAt;
    const duration = clamp(req.durationMs ?? DEFAULT_DURATION_MS, MIN_DURATION_MS, MAX_DURATION_MS);
    this.#previous = this.#current;
    this.#current = req.to;
    this.#transition = {
      from: { ...this.#lastFrom },
      to: { position: target.position.clone(), lookAt: focus.clone(), fov: target.fov },
      start: now(),
      duration,
      onArrive: () => resolve(this.#current),
    };
    this.#phaseListeners.forEach((l) => l('start', 0));
  }
}
