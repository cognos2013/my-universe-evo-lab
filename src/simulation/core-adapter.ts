/**
 * Simulation core seam — design sketch.
 *
 * The worker (`src/workers/controller.ts`) drives the per-tick
 * simulation. Today the pure-TS code in `src/simulation/...`
 * does all the work. The plan in `docs/guides/wasm-migration.md`
 * is to eventually swap that for a Rust + WASM core. This
 * module currently only documents the intended interface.
 *
 * ## Why not wrap the TS code today?
 *
 * The TS core functions have signatures that evolved
 * alongside the simulation:
 *   - `stepWorld` is async and returns a richer object
 *     (`{ state, life, environment }`) than just the next
 *     world state.
 *   - `stepReactor(state, network, config)` takes a separate
 *     `state` envelope and returns `{ state, events }`.
 *   - `stepGalaxies(state, dtMyr)` is the simplest of the
 *     three but the others constrain the interface.
 *
 * Forcing every caller to go through a unifying interface
 * would mean a refactor of the worker today, before we have
 * a concrete second implementation to validate the shape
 * against. That's the wrong order.
 *
 * ## What this module provides today
 *
 * - `SimCore`: the *target* interface a future WASM core
 *   must satisfy. Documented but not yet wired.
 * - `tsCore`: a thin reference object pointing at the TS
 *   functions. Useful for type-checking future code that
 *   takes a `SimCore` parameter.
 *
 * When the Rust core lands, the worker gains:
 *
 * ```ts
 * const core = await isWasmAvailable()
 *   ? await loadWasmCore()
 *   : tsCore;
 * ```
 *
 * At that point the worker's call sites are updated to go
 * through `core` instead of importing the TS modules
 * directly. The interface in this file is the contract
 * between the worker and either core.
 */

import { stepWorld } from './core/step.ts';
import type { WorldState } from './core/contracts.ts';
import { stepGalaxies } from './cosmos/galaxies.ts';
import type { GalaxyState } from './cosmos/galaxies.ts';
import { stepReactor } from './chemistry/reactor.ts';
import type { ReactorState, ReactorStepEvent } from './chemistry/reactor.ts';
import type { ReactionNetwork } from './chemistry/network.ts';

/**
 * The interface a WASM core must satisfy. This is a sketch,
 * not yet wired. Field names match the existing TS core's
 * behavior; parameter types are the inputs the worker
 * already passes today.
 */
export interface SimCore {
  /** Advance the world by one tick. Returns the new world + life / environment deltas. */
  stepWorld(state: WorldState): Promise<StepResult>;
  /** Advance the galaxy assembly by `dtMyr` million years. */
  stepGalaxies(state: GalaxyState, dtMyr: number): GalaxyState;
  /** Advance the chemistry reactor by `dtSeconds` seconds. */
  stepReactor(reactor: ReactorState, network: ReactionNetwork): { state: ReactorState; events: ReactorStepEvent };
}

/** What `stepWorld` returns — a richer object than just the next world. */
export interface StepResult {
  state: WorldState;
  life: { births: number; deaths: number };
  environment: { incomingJ: number; outgoingJ: number; recycledMu: number };
}

/**
 * TypeScript reference implementation. Behavior is the same
 * as before — this class only exists to give future code a
 * type-checked handle on the TS functions.
 */
export const tsCore: SimCore = {
  stepWorld: (state) => stepWorld(state),
  stepGalaxies: (state, dtMyr) => stepGalaxies(state, dtMyr),
  stepReactor: (reactor, network) => stepReactor(reactor, network),
};
