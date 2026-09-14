// Trace population over 50 ticks using the actual simulator.
// Run via node --import tsx or similar — but we don't have tsx.
// Instead, leverage the project's tests by adding a one-off trace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getScenario } from '../src/scenarios/catalog.ts';
import { initializeWorld } from '../src/simulation/core/initialize.ts';
import { advanceLife } from '../src/simulation/life/advance.ts';
import { applyTick } from '../src/simulation/environment/advance.ts';

test('trace two-lineages population for 50 days', () => {
  const s = getScenario('two-lineages', 320);
  const state = initializeWorld(s);
  console.log('init: pop=', state.cohorts.counts.reduce((a, b) => a + b, 0), 'nutrientMu total=', state.cells.nutrientMu.reduce((a, b) => a + b, 0));
  for (let t = 1; t <= 100; t++) {
    applyTick(state);
    const flux = advanceLife(state, s.rules.tickSeconds);
    const pop = state.cohorts.counts.reduce((a, b) => a + b, 0);
    if (t <= 10 || t % 10 === 0) {
      const totalReserve = state.cohorts.energyReserveJ.reduce((a, b) => a + b, 0);
      const totalNutrient = state.cells.nutrientMu.reduce((a, b) => a + b, 0);
      console.log(`tick ${t}: pop=${pop.toFixed(1)} births=${flux.births.toFixed(1)} deaths=${flux.deaths.toFixed(1)} reserve=${totalReserve.toFixed(0)}J nutrient=${totalNutrient.toFixed(0)}MU temp_avg=${(state.cells.temperatureK.reduce((a, b) => a + b, 0) / state.cells.temperatureK.length).toFixed(2)}K`);
    }
  }
});
