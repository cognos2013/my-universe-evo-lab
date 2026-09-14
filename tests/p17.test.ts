/**
 * P17 — scenario batch acceptance tests.
 *
 * Reference gate (P17 docs/15):
 *   - Multiple seeds across the same scenario produce a *non-trivial*
 *     outcome distribution (variance > 0 across seeds).
 *   - The `BatchReport` summary statistics match the raw outcomes
 *     (mean / std / quantiles consistent).
 *   - A failing seed is reported as `failed: true` and counted
 *     in `failures` without polluting the summary.
 *   - Controller integration: `batchRun` produces a `batch` reply
 *     + updates `Projection.batches`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBatch, summarise } from '../src/simulation/batch/run.ts';
import type { BatchOutcome, BatchReport } from '../src/simulation/batch/types.ts';
import { SimulationController, type Reply } from '../src/workers/controller.ts';

test('summarise: produces consistent mean / std / quantiles from raw outcomes', () => {
  // Construct outcomes by hand: a synthetic distribution.
  const outcomes: BatchOutcome[] = [];
  for (let i = 0; i < 100; i++) {
    outcomes.push({
      seed: i, finalTick: 100, population: i + 1, meanTemperatureK: 288, activeLineages: 3, crashed: false, failed: false, paramValues: {},
    });
  }
  const summary = summarise(outcomes);
  assert.equal(summary.population.n, 100);
  // mean of 1..100 = 50.5
  assert.ok(Math.abs(summary.population.mean - 50.5) < 0.001,
    `mean should be 50.5, got ${summary.population.mean}`);
  assert.equal(summary.population.min, 1);
  assert.equal(summary.population.max, 100);
  // p50 of 1..100 (linear interp on sorted, pos = 0.5*99 = 49.5) = 50.5
  assert.ok(Math.abs(summary.population.p50 - 50.5) < 0.001,
    `p50 should be 50.5, got ${summary.population.p50}`);
  // p5: pos = 0.05*99 = 4.95 → between sorted[4]=5 and sorted[5]=6, t=0.95 → 5 + 0.95*1 = 5.95
  assert.ok(summary.population.p5 >= 5 && summary.population.p5 <= 6.5,
    `p5 should be in [5, 6.5], got ${summary.population.p5}`);
  // std > 0 since the data has spread
  assert.ok(summary.population.std > 28 && summary.population.std < 30,
    `std should be ~28.86, got ${summary.population.std}`);
});

test('summarise: empty input returns zero-valued summary with n=0', () => {
  const summary = summarise([]);
  assert.equal(summary.population.n, 0);
  assert.equal(summary.population.mean, 0);
  assert.equal(summary.population.max, 0);
});

test('runBatch: two seeds at 10 ticks produce two outcomes + non-empty summary', async () => {
  const report = await runBatch(
    { id: 'empty-planet', version: 'v1' },
    { scenario: { id: 'empty-planet', version: 'v1' }, seedStart: 0, seedCount: 2, parallel: false, resolution: 320, ticks: 10 },
  );
  assert.equal(report.scenario.id, 'empty-planet');
  assert.equal(report.seedCount, 2);
  assert.equal(report.completedSeeds, 2);
  assert.equal(report.done, true);
  assert.equal(report.outcomes.length, 2);
  for (const o of report.outcomes) {
    assert.equal(typeof o.seed, 'number');
    assert.equal(typeof o.finalTick, 'number');
    assert.equal(typeof o.population, 'number');
    assert.ok(typeof o.paramValues === 'object', 'paramValues field must be present');
    assert.ok(o.finalTick >= 10, `finalTick should be ≥ 10, got ${o.finalTick}`);
  }
  assert.equal(report.summary.population.n, 2);
  assert.equal(report.summary.meanTemperatureK.n, 2);
});

test('runBatch: outcomes across many seeds at 50 ticks have non-zero variance (acceptance gate)', async () => {
  const report = await runBatch(
    { id: 'two-lineages', version: 'v1' },
    { scenario: { id: 'two-lineages', version: 'v1' }, seedStart: 0, seedCount: 4, parallel: false, resolution: 320, ticks: 50 },
  );
  assert.equal(report.completedSeeds, 4);
  // Population should vary across seeds — that's the whole point
  // of running multiple seeds. We accept std > 0 OR p95-p5 > 0.
  const s = report.summary.population;
  assert.ok(s.std > 0 || (s.p95 - s.p5) > 0,
    `seeds should produce a non-trivial distribution; got mean=${s.mean} std=${s.std} p5=${s.p5} p95=${s.p95}`);
  // Failures / crashes counts should be 0 for a healthy scenario
  // at 50 ticks (no need to crash).
  assert.equal(report.failures, 0, 'no seed should fail to start');
});

test('runBatch: rejects seedCount > 64', async () => {
  await assert.rejects(
    runBatch(
      { id: 'empty-planet', version: 'v1' },
      { scenario: { id: 'empty-planet', version: 'v1' }, seedStart: 0, seedCount: 100, parallel: false, resolution: 320, ticks: 10 },
    ),
    /seedCount/,
  );
});

test('runBatch: rejects unknown scenario version', async () => {
  await assert.rejects(
    runBatch(
      { id: 'empty-planet', version: 'v999' },
      { scenario: { id: 'empty-planet', version: 'v999' }, seedStart: 0, seedCount: 1, parallel: false, resolution: 320, ticks: 10 },
    ),
    /未知 scenario version/,
  );
});

// === Controller integration ============================================

async function makeController() {
  const replies: Reply[] = [];
  const c = new SimulationController((r) => replies.push(r));
  await c.handle({ id: 1, type: 'create' });
  return { c, replies };
}

test('controller: batchRun produces a `batch` reply + adds to Projection.batches', async () => {
  const { c, replies } = await makeController();
  await c.handle({ id: 2, type: 'batchRun', payload: {
    scenario: { id: 'empty-planet', version: 'v1' },
    resolution: 320, ticks: 10, seedStart: 0, seedCount: 2,
  }});
  const batchReply = replies.filter(r => r.type === 'batch').at(-1)!;
  assert.equal(batchReply.type, 'batch');
  if (batchReply.type === 'batch') {
    const report = batchReply.payload.report as BatchReport;
    assert.equal(report.seedCount, 2);
    assert.equal(report.completedSeeds, 2);
    assert.equal(report.scenario.id, 'empty-planet');
  }
  // Projection must carry the batch list.
  const proj = c.projection();
  assert.equal(proj.batches.length, 1, 'projection should have one batch report');
  assert.equal(proj.batches[0]!.seedCount, 2);
});

test('controller: batchRun rejects unknown scenario', async () => {
  const { c, replies } = await makeController();
  await c.handle({ id: 2, type: 'batchRun', payload: {
    scenario: { id: 'empty-planet', version: 'v999' }, resolution: 320, ticks: 5, seedCount: 1,
  }});
  const err = replies.filter(r => r.type === 'error').at(-1);
  assert.ok(err, 'unknown version should emit an error reply');
});
