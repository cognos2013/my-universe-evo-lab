import type { WorldState } from './contracts.ts';

/**
 * Sum of active external forcings (W/m²) per cell for the current tick.
 *
 * Reads `state.execution.forcings` and accumulates every entry whose
 * `[startTick, endTick)` window contains `state.tick`. Pure read: never
 * mutates state, and a new `Float64Array` is returned on each call so
 * callers may freely use it as scratch space.
 *
 * Lives in `core/` (rather than `interventions/`) because the field is
 * a function of the execution state and is consumed by `stepWorld` and
 * any future cross-scale coupling (P11). Forcings themselves are still
 * written by `applyIntervention`.
 */
export function forcingField(state: WorldState): Float64Array {
  const out = new Float64Array(state.cells.areaM2.length);
  for (const f of state.execution.forcings) {
    if (state.tick >= f.startTick && state.tick < f.endTick) {
      for (const cell of f.cells) out[cell]! += f.forcingWPerM2;
    }
  }
  return out;
}
