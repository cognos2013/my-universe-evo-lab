# WASM Migration Plan

This document captures the design for migrating the simulation
hot loop from TypeScript to Rust + WebAssembly. It is **not** an
implementation — it is a roadmap so future work can pick up without
re-deriving the boundaries.

## Why WASM

The simulation runs entirely on the main thread today (see
`src/workers/controller.ts`). For 5,120 cells the cost is
manageable; for 20,480 cells the per-step cost grows and
multi-second pauses become visible. WASM buys:

- **Predictable perf**: no JIT warmup, no GC pauses mid-step.
- **Cheap parallelism**: SIMD inside `core::arch::wasm32` and
  rayon-style data parallelism.
- **Shared core**: the same Rust crate can later power a
  Node-side batch runner for offline experiments.

The trade-offs: build complexity (Rust toolchain + wasm-pack),
a second-language surface to maintain, and an async bridge
boundary around the WASM module's `step()` call.

## What to migrate (priority order)

1. **`step_tick_core(state, dt) → new_state`** — the inner
   per-cell physics loop (temperature, nutrient, lineage
   update). This is the single biggest CPU sink.

2. **`galaxy_step(halos, dt) → new_halos`** — the gravity /
   cooling / star-formation inner loop. ~8 halos × ~30 stars
   each per tick, every 5 Myr.

3. **`chemistry_reactor(network, dt) → new_network`** — the
   mass-action reaction solver. Tight inner loop, low
   branching, ideal for WASM.

4. **`history_curve(observables) → samples`** — pure function
   over a few hundred samples. Tiny but useful as a smoke
   test for the WASM pipeline.

What stays in TypeScript:
- DOM rendering, sidebar, onboarding, toast.
- V14/3D scene (`src/rendering/planet.ts`).
- Worker dispatch + message protocol.
- Persistence (IndexedDB via `LocalWorldStore`).

## Module boundary (the seam)

`src/workers/controller.ts` already calls
`stepSimulation(state, command) → newState` for every tick.
That pure function is the only piece the worker needs to
swap. We can introduce a `SimCore` interface today:

```ts
export interface SimCore {
  step(state: WorldState, cmd: StepCommand): WorldState;
  galaxyStep(halos: HaloState[], dt: number): HaloState[];
  chemStep(network: ReactionNetwork, dt: number): ReactionNetwork;
}
```

The default implementation is the existing pure-TS code
(`simulation/...`). A future WASM build provides a drop-in
replacement that implements the same interface and is
loaded via `import('../wasm/my_universe_core.js')` (emitted
by wasm-bindgen).

The worker picks the implementation once at boot:

```ts
let core: SimCore;
if (await isWasmAvailable()) {
  core = await loadWasmCore();
} else {
  core = new TsSimCore();
}
```

## Build pipeline (target state)

- `wasm/` Rust crate (`my-universe-core`) exposes the four
  functions above with `#[wasm_bindgen]`.
- `wasm-pack build --target web` emits a JS module + `.wasm`
  binary to `src/wasm/`.
- Vite picks up the `.wasm` and bundles it. No special
  Vite plugin needed beyond the default asset handling.
- A `pnpm wasm:build` / `npm run wasm:build` script wraps
  `wasm-pack` and runs only when `wasm-bindgen-cli` is on
  PATH. Without it, the build skips the WASM step and the
  app falls back to the TypeScript core (build still
  succeeds).

## Migration phases (suggested order)

1. **Scaffold (this change)**: doc + the `SimCore` interface
   + a `core-adapter.ts` module that re-exports the existing
   TS code through the new interface. No behavioral change.
2. **Smoke test**: implement one trivial function (e.g.
   `history_curve`) in Rust, wire the dual-core switch, run
   the existing unit tests against both cores to confirm
   numerical equivalence.
3. **Hot loop**: port `step_tick_core`. This is the largest
   piece and the biggest win. Co-exist for one release: the
   WASM core runs in the worker, the TS core is kept as
   the fallback for `npm run dev` without the Rust toolchain.
4. **Galaxy + chemistry**: port the remaining two once the
   pipeline is proven.
5. **Remove fallback**: once the WASM core is stable and
   covered, drop the TS core and the dual-core switch.

## Open questions for the implementer

- How to share the `WorldState` schema between Rust and TS
  without duplication. Options: a single `.json` schema
  with codegen, or hand-written `serde` ↔ TS bindings
  (verbose but explicit).
- Whether to keep the worker abstraction or fold the
  WASM call directly into the main thread. The worker is
  useful for the "compute on a background thread" path,
  but WASM is fast enough that a synchronous call on the
  main thread might be simpler. Profile first.
- Numerical parity. The TS code is the reference; the Rust
  port must produce state that's within a documented
  tolerance (or byte-identical for unit-tested paths).

## Status

- [x] Roadmap written.
- [x] `SimCore` interface introduced in `src/simulation/core-adapter.ts`.
- [x] Existing TS code re-exported through the adapter.
- [ ] Rust crate scaffolded.
- [ ] Any WASM function implemented.
- [ ] Dual-core fallback in worker.
