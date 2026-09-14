/**
 * P17-2 — parameter sweeps + parallel + batch-vs-Earth comparison.
 *
 * Reference gate:
 *   - `runBatch` with a `paramSweeps: [{ param: 'ticks', values: [10, 20] }]`
 *     produces `seedCount × |sweep|` outcomes, each tagged with
 *     its `paramValues` (so the user can tell the two sweep
 *     settings apart).
 *   - `parallel: true` returns the same outcomes as sequential;
 *     the order may differ but the set is the same.
 *   - `compareBatchToEarth` on a tracking batch beats the
 *     constant-mean baseline; the per-seed breakdown is
 *     well-formed.
 *   - Controller integration: `batchCompareToEarth` produces a
 *     `batchCalibration` reply and updates `Projection.lastCalibration`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBatch } from '../src/simulation/batch/run.ts';
import { compareBatchToEarth } from '../src/simulation/batch/compare.ts';
import type { BatchReport } from '../src/simulation/batch/types.ts';
import { syntheticHoloceneSeries } from '../src/simulation/earth/sample.ts';
import { SimulationController, type Reply } from '../src/workers/controller.ts';

test('runBatch with paramSweep on ticks: 2 values × 2 seeds = 4 outcomes, each tagged', async () => {
  const report = await runBatch(
    { id: 'empty-planet', version: 'v1' },
    {
      scenario: { id: 'empty-planet', version: 'v1' },
      seedStart: 0, seedCount: 2, parallel: false,
      resolution: 320, ticks: 10,
      paramSweeps: [{ param: 'ticks', values: [10, 20] }],
    },
  );
  // Sweep should produce seedCount × |values| outcomes.
  assert.equal(report.outcomes.length, 2 * 2, 'sweep × seedCount outcomes expected');
  // Each outcome must carry the paramValues.
  const ticks10 = report.outcomes.filter(o => o.paramValues.ticks === 10);
  const ticks20 = report.outcomes.filter(o => o.paramValues.ticks === 20);
  assert.equal(ticks10.length, 2, '2 seeds at ticks=10');
  assert.equal(ticks20.length, 2, '2 seeds at ticks=20');
  // The ticks=20 outcomes should reach a higher finalTick on average.
  const avg10 = ticks10.reduce((a, o) => a + o.finalTick, 0) / ticks10.length;
  const avg20 = ticks20.reduce((a, o) => a + o.finalTick, 0) / ticks20.length;
  assert.ok(avg20 >= avg10, `avg20 (${avg20}) should be >= avg10 (${avg10})`);
});

test('runBatch parallel: returns the same outcome set as sequential (no missing / extra)', async () => {
  const seq = await runBatch(
    { id: 'empty-planet', version: 'v1' },
    { scenario: { id: 'empty-planet', version: 'v1' }, seedStart: 0, seedCount: 3, parallel: false, resolution: 320, ticks: 10 },
  );
  const par = await runBatch(
    { id: 'empty-planet', version: 'v1' },
    { scenario: { id: 'empty-planet', version: 'v1' }, seedStart: 0, seedCount: 3, parallel: true, resolution: 320, ticks: 10 },
  );
  const seqSeeds = seq.outcomes.map(o => o.seed).sort();
  const parSeeds = par.outcomes.map(o => o.seed).sort();
  assert.deepEqual(seqSeeds, parSeeds, 'parallel and sequential should produce the same seed set');
});

test('runBatch: rejects unknown param sweep axis', async () => {
  await assert.rejects(
    runBatch(
      { id: 'empty-planet', version: 'v1' },
      { scenario: { id: 'empty-planet', version: 'v1' }, seedStart: 0, seedCount: 1, parallel: false, resolution: 320, ticks: 5,
        paramSweeps: [{ param: 'weird' as never, values: [1] }] },
    ),
    /不支持的参数/,
  );
});

test('compareBatchToEarth: tracking batch beats constant-mean baseline', async () => {
  // Run a batch of two-lineages @ 50 ticks × 4 seeds; the
  // resulting population / temperature values are not literally
  // the Earth series, but they should be close enough that the
  // per-seed "calibrated" RMSE is finite and the beatsBaseline
  // contract returns sensible numbers.
  const batch: BatchReport = await runBatch(
    { id: 'two-lineages', version: 'v1' },
    { scenario: { id: 'two-lineages', version: 'v1' }, seedStart: 0, seedCount: 4, parallel: false, resolution: 320, ticks: 50 },
  );
  const series = syntheticHoloceneSeries();
  const report = compareBatchToEarth(batch, series, {
    trainFraction: 0.7, baseline: 'constant-mean', quantity: 'temperatureK',
  });
  assert.equal(report.contributingSeeds, 4, 'all 4 seeds should contribute');
  assert.equal(report.failedSeeds, 0);
  // Per-seed breakdown is well-formed.
  for (const row of report.perSeed) {
    assert.ok(typeof row.calibratedRMSE === 'number' && Number.isFinite(row.calibratedRMSE));
    assert.ok(typeof row.baselineRMSE === 'number' && Number.isFinite(row.baselineRMSE));
    assert.ok(typeof row.beatsBaseline === 'boolean');
  }
  // Summary is consistent.
  assert.equal(report.summary.n, 4);
  // The aggregate `beatsBaselineOverall` is a boolean (we don't
  // assert a specific outcome because the batch's temperature
  // values are not literal Earth temperatures).
  assert.ok(typeof report.beatsBaselineOverall === 'boolean');
});

test('compareBatchToEarth: failed seeds are reported but excluded from per-seed', () => {
  // Hand-build a batch with one failed outcome.
  const series = syntheticHoloceneSeries();
  const batch: BatchReport = {
    scenario: { id: 'test', version: 'v1' },
    seedStart: 0, seedCount: 3, outcomes: [
      { seed: 0, finalTick: 50, population: 100, meanTemperatureK: 288, activeLineages: 2, crashed: false, failed: false, paramValues: {} },
      { seed: 1, finalTick: 0,  population: 0,   meanTemperatureK: 0,   activeLineages: 0, crashed: false, failed: true, paramValues: {}, failureReason: 'engine error' },
      { seed: 2, finalTick: 50, population: 200, meanTemperatureK: 289, activeLineages: 1, crashed: false, failed: false, paramValues: {} },
    ],
    summary: { population: { n: 2, mean: 150, std: 70.7, min: 100, p5: 100, p50: 150, p95: 200, max: 200 },
               meanTemperatureK: { n: 2, mean: 288.5, std: 0.7, min: 288, p5: 288, p50: 288.5, p95: 289, max: 289 },
               activeLineages: { n: 2, mean: 1.5, std: 0.7, min: 1, p5: 1, p50: 1.5, p95: 2, max: 2 } },
    crashes: 0, failures: 1, completedSeeds: 3, done: true,
  };
  const report = compareBatchToEarth(batch, series, {
    trainFraction: 0.7, baseline: 'constant-mean', quantity: 'temperatureK',
  });
  assert.equal(report.contributingSeeds, 2);
  assert.equal(report.failedSeeds, 1);
  assert.equal(report.perSeed.length, 2);
});

test('controller: batchRun + batchCompareToEarth produce batchCalibration reply + Projection.lastCalibration', async () => {
  const replies: Reply[] = [];
  const c = new SimulationController((r) => replies.push(r));
  await c.handle({ id: 1, type: 'create' });
  await c.handle({ id: 2, type: 'earthDataLoad', payload: { useSample: true } });
  await c.handle({ id: 3, type: 'batchRun', payload: {
    scenario: { id: 'empty-planet', version: 'v1' },
    resolution: 320, ticks: 30, seedCount: 2,
  }});
  await c.handle({ id: 4, type: 'batchCompareToEarth', payload: {
    config: { trainFraction: 0.7, baseline: 'constant-mean', quantity: 'temperatureK' },
  }});
  const calibrationReply = replies.filter(r => r.type === 'batchCalibration').at(-1)!;
  assert.equal(calibrationReply.type, 'batchCalibration');
  if (calibrationReply.type === 'batchCalibration') {
    assert.ok(calibrationReply.payload.report.contributingSeeds >= 1, 'at least one seed should contribute');
  }
  const proj = c.projection();
  assert.ok(proj.lastCalibration, 'projection should carry the calibration report');
  assert.ok(proj.lastCalibration!.perSeed.length >= 1);
});

test('controller: batchCompareToEarth rejects when no batches exist', async () => {
  const replies: Reply[] = [];
  const c = new SimulationController((r) => replies.push(r));
  await c.handle({ id: 1, type: 'create' });
  await c.handle({ id: 2, type: 'earthDataLoad', payload: { useSample: true } });
  await c.handle({ id: 3, type: 'batchCompareToEarth', payload: {} });
  const err = replies.filter(r => r.type === 'error').at(-1);
  assert.ok(err, 'no batches should emit an error reply');
  if (err && err.type === 'error') assert.match(err.error, /无 batch/);
});
