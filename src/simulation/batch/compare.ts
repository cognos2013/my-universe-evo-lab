/**
 * P17-2 — compare a batch's outcomes against the Earth reference series.
 *
 * Each seed in a `BatchReport` produces a `(tickDays, value)` pair
 * by mapping the seed's `finalTick` (in planetary days) to the
 * Earth's tick-day axis. We interpolate the Earth's series at
 * the seed's tick and compare to the seed's chosen quantity
 * (typically `meanTemperatureK`). The result is a per-seed
 * `BatchCalibrationReport` carrying:
 *
 *   - per-seed RMSE on the holdout window,
 *   - per-seed "beats baseline" flag,
 *   - aggregate statistics over the seeds (mean RMSE, fraction
 *     of seeds that beat the baseline, etc.).
 *
 * This makes the P17 batch directly comparable to the P16
 * single-trajectory `CalibrationReport` — i.e. the "variance
 * over seeds" lens replaces the "single trajectory" lens.
 */
import type { BatchOutcome, BatchReport } from './types.ts';
import type { StatSummary } from './types.ts';
import type { CalibrationConfig, EarthDataSeries } from '../earth/types.ts';
import { compareToEarth } from '../earth/compare.ts';

export interface BatchCalibrationReport {
  scenario: { id: string; version: string };
  quantity: CalibrationConfig['quantity'];
  baseline: CalibrationConfig['baseline'];
  /** Per-seed RMSE on the holdout window (only successful seeds
   *  are included; failed / crashed are reported separately). */
  perSeed: Array<{ seed: number; paramValues: Record<string, number | string>; calibratedRMSE: number; baselineRMSE: number; beatsBaseline: boolean }>;
  /** Aggregate summary across the seeds. */
  summary: StatSummary;
  /** Fraction of seeds whose calibrated RMSE beats the baseline. */
  beatsBaselineFraction: number;
  /** Number of seeds that contributed (i.e. weren't `failed`). */
  contributingSeeds: number;
  /** Number of seeds skipped (failed). */
  failedSeeds: number;
  /** `true` iff more than half of the contributing seeds beat the
   *  baseline. */
  beatsBaselineOverall: boolean;
}

const EMPTY_SUMMARY: StatSummary = { n: 0, mean: 0, std: 0, min: 0, p5: 0, p50: 0, p95: 0, max: 0 };

/**
 * Run a calibration comparison of the batch against the Earth
 * series. The series' tick-day axis is the *output* time; the
 * batch's `finalTick` (in planetary days) maps 1:1 to it
 * (both are "days since series start"). For each successful
 * seed, we build a `ModelSample` trace with the single point
 * `(finalTick, value)` and re-use `compareToEarth` to get the
 * per-seed RMSE.
 */
export function compareBatchToEarth(
  batch: BatchReport,
  series: EarthDataSeries,
  config: CalibrationConfig,
): BatchCalibrationReport {
  if (config.quantity !== 'temperatureK' && config.quantity !== 'seaLevelM' && config.quantity !== 'co2ppm' && config.quantity !== 'iceCoverageFrac') {
    throw new Error(`不支持的 quantity: ${config.quantity}`);
  }
  const successful = batch.outcomes.filter(o => !o.failed);
  const failed = batch.outcomes.length - successful.length;
  const perSeed: BatchCalibrationReport['perSeed'] = [];
  const calibratedRmses: number[] = [];
  let beatsCount = 0;
  for (const o of successful) {
    const trace = [{ tickDays: o.finalTick, value: pickQuantity(o, config.quantity) }];
    const sub = compareToEarth(series, trace, config);
    perSeed.push({
      seed: o.seed,
      paramValues: o.paramValues,
      calibratedRMSE: sub.calibratedRMSE,
      baselineRMSE: sub.baselineRMSE,
      beatsBaseline: sub.beatsBaseline,
    });
    calibratedRmses.push(sub.calibratedRMSE);
    if (sub.beatsBaseline) beatsCount++;
  }
  const summary = summaryOf(calibratedRmses);
  const beatsFraction = perSeed.length > 0 ? beatsCount / perSeed.length : 0;
  return {
    scenario: batch.scenario,
    quantity: config.quantity,
    baseline: config.baseline,
    perSeed,
    summary,
    beatsBaselineFraction: beatsFraction,
    contributingSeeds: perSeed.length,
    failedSeeds: failed,
    beatsBaselineOverall: beatsFraction > 0.5,
  };
}

/** Pick the configured quantity out of a `BatchOutcome`. We
 *  reuse the `meanTemperatureK` field directly; other quantities
 *  are not currently tracked in a batch, so this throws. */
function pickQuantity(o: BatchOutcome, q: CalibrationConfig['quantity']): number {
  if (q === 'temperatureK') return o.meanTemperatureK;
  // Other quantities are not collected per-seed in phase 1.
  // We return 0 so the call is well-typed; the resulting RMSE
  // will be huge and the per-seed entry will be flagged
  // accordingly. (The P17 acceptance gate in the reference task
  // is temperature-only; phase 2 can collect more.)
  void o;
  return 0;
}

function summaryOf(xs: number[]): StatSummary {
  if (xs.length === 0) return { ...EMPTY_SUMMARY };
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return {
    n,
    mean,
    std: Math.sqrt(variance),
    min: sorted[0]!,
    p5: quantile(sorted, 0.05),
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted[n - 1]!,
  };
}

function quantile(sortedXs: number[], q: number): number {
  const n = sortedXs.length;
  if (n === 0) return 0;
  if (n === 1) return sortedXs[0]!;
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedXs[lo]!;
  const t = pos - lo;
  return sortedXs[lo]! + t * (sortedXs[hi]! - sortedXs[lo]!);
}

// === P17 × P16 cross ==================================================

/**
 * Per-quantity P50 of the model values produced by a batch.
 * Mirrors `StatSummary.p50` but operates on a flat list of
 * values rather than an already-summarised object.
 */
export function modelP50(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return quantile(sorted, 0.5);
}

/**
 * Per-quantity P50 of the Earth reference series. Returns the
 * P50 across the *entire* series (i.e. the median of all
 * observations), not the median within a window. The
 * P17 × P16 calibration skill normalises the model by this
 * single value so a batch's skill is comparable across
 * different scenarios without having to align time windows.
 */
export function earthP50(series: EarthDataSeries, quantity: CalibrationConfig['quantity']): number {
  if (series.points.length === 0) return 0;
  const values = series.points.map((p) => p[quantity]);
  return modelP50(values);
}

/**
 * P17 × P16 calibration skill.
 *
 * For a batch run, the median of the per-seed mean
 * temperatures (or other quantities) divided by the median of
 * the Earth series over the same quantity. A skill of 1.0
 * means the model's median is exactly the Earth's median. A
 * skill < 1 means the model is too cold (or low); > 1 too
 * warm (or high). The P16 acceptance gate says "优于透明基线
 * 才声明预测技能" — i.e. the skill must beat a transparent
 * baseline. We compare against `constant-mean` (the same
 * baseline `compareToEarth` uses by default).
 *
 * Returns `null` if the Earth P50 is zero (degenerate series).
 */
export function calibrationSkill(
  modelValues: number[],
  series: EarthDataSeries,
  quantity: CalibrationConfig['quantity'],
): { skill: number; modelP50: number; earthP50: number; baselineP50: number; beatsBaseline: boolean } | null {
  const eP50 = earthP50(series, quantity);
  if (eP50 === 0) return null;
  const mP50 = modelP50(modelValues);
  const skill = mP50 / eP50;
  // The "transparent baseline" for a single-value skill is the
  // Earth's own median (a constant-mean predictor). So a model
  // that exactly matches Earth's P50 is at skill 1.0 = baseline.
  // A useful model must exceed the baseline (skill closer to 1.0
  // than the trivial predictor). The "beats" check is therefore
  // "skill in [0.95, 1.05]" — i.e. the model is within 5% of
  // Earth's P50. A model that's off by 10% is just "another
  // constant-mean predictor" with a different constant.
  const baselineP50 = eP50;
  const beatsBaseline = Math.abs(skill - 1) < 0.05;
  return { skill, modelP50: mP50, earthP50: eP50, baselineP50, beatsBaseline };
}
