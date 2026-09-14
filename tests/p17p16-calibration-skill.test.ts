/**
 * P17 × P16 — batch calibration skill.
 *
 * Per docs/15: P17 batch results should be directly comparable
 * to the P16 Earth series via a "calibration skill" — the
 * median of the batch's per-seed value normalised by the
 * median of the Earth series over the same quantity. The P16
 * acceptance gate says "优于透明基线才声明预测技能" — i.e.
 * the skill must beat a transparent baseline.
 *
 * These tests pin three contracts:
 *   1. `modelP50` is the median (50th percentile) of the input
 *      values, in [min, max].
 *   2. `earthP50` is the median of the Earth series over the
 *      chosen quantity, also in [min, max].
 *   3. `calibrationSkill` returns a `skill = modelP50 / earthP50`
 *      and a `beatsBaseline` flag that triggers when the model
 *      median is within 5% of the Earth median. A model
 *      that exactly matches Earth's P50 has skill 1.0; a model
 *      that's off by 50% has skill 0.5 or 1.5.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calibrationSkill, earthP50, modelP50 } from '../src/simulation/batch/compare.ts';
import { loadMarcott2013HoloceneSeries } from '../src/simulation/earth/marcott2013.ts';

test('P17×P16: modelP50 returns the median of the input values', () => {
  // Odd count: exact middle.
  assert.equal(modelP50([1, 2, 3, 4, 5]), 3);
  // Even count: linear interpolation.
  assert.equal(modelP50([1, 2, 3, 4]), 2.5);
  // Single value.
  assert.equal(modelP50([42]), 42);
  // Empty.
  assert.equal(modelP50([]), 0);
  // Out-of-order.
  assert.equal(modelP50([5, 1, 3, 2, 4]), 3);
});

test('P17×P16: earthP50 returns the median of the Marcott 2013 temperature series', () => {
  const series = loadMarcott2013HoloceneSeries();
  const p50 = earthP50(series, 'temperatureK');
  // The Marcott series spans 286.95 K (11.3 kyr BP / Younger-
  // Dryas cold tail) to 287.7 K (mid-Holocene thermal max). The
  // median sits in the mid-range; we only assert it's in the
  // physical bounds of the series.
  assert.ok(p50 >= 286 && p50 <= 289, `Marcott 2013 temperature P50 should be in physical bounds, got ${p50}`);
  // Also check the median is actually a percentile of the data.
  const temps = series.points.map((p) => p.temperatureK).sort((a, b) => a - b);
  const min = temps[0]!;
  const max = temps[temps.length - 1]!;
  assert.ok(p50 >= min && p50 <= max);
});

test('P17×P16: calibrationSkill returns skill=1.0 when model matches Earth P50', () => {
  const series = loadMarcott2013HoloceneSeries();
  const eP50 = earthP50(series, 'temperatureK');
  // Synthesise a batch whose per-seed mean matches the Earth P50
  // exactly.
  const batch = [eP50, eP50, eP50, eP50, eP50, eP50, eP50, eP50];
  const result = calibrationSkill(batch, series, 'temperatureK');
  assert.ok(result);
  if (result) {
    assert.ok(Math.abs(result.skill - 1) < 1e-9, `skill should be 1.0 for exact-match batch, got ${result.skill}`);
    assert.ok(result.beatsBaseline, 'exact-match model should beat the transparent baseline');
    assert.equal(result.modelP50, eP50);
    assert.equal(result.earthP50, eP50);
  }
});

test('P17×P16: calibrationSkill flags a 50%-off batch as not beating the baseline', () => {
  const series = loadMarcott2013HoloceneSeries();
  const eP50 = earthP50(series, 'temperatureK');
  // A batch whose median is 50% of the Earth median.
  const halfBatch = Array(8).fill(eP50 * 0.5);
  const result = calibrationSkill(halfBatch, series, 'temperatureK');
  assert.ok(result);
  if (result) {
    assert.ok(Math.abs(result.skill - 0.5) < 1e-9, `skill should be 0.5 for half-batch, got ${result.skill}`);
    assert.ok(!result.beatsBaseline, '50%-off batch should NOT beat the baseline');
  }
});

test('P17×P16: calibrationSkill returns null when the Earth series is degenerate (eP50 = 0)', () => {
  // We can't easily make the real Marcott series have a zero
  // median (it's 287 K), so this test uses a constructed
  // empty series and a co2ppm quantity that defaults to 0 in
  // a hand-built series. The contract is: when the denominator
  // is 0, the function returns null instead of dividing by 0.
  const series = loadMarcott2013HoloceneSeries();
  // Override the seaLevelM to all zeros to make the P50 = 0.
  const zeroSeries = {
    ...series,
    points: series.points.map((p) => ({ ...p, seaLevelM: 0 })),
  };
  const result = calibrationSkill([1, 2, 3], zeroSeries, 'seaLevelM');
  assert.equal(result, null, 'skill should be null when Earth P50 is zero');
});
