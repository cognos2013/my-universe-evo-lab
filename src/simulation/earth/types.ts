/**
 * P16 — real-Earth data and calibration.
 *
 * Per docs/15 P16: "固定数据来源与日期、单位、缺测、校准/留出区间;
 * 优于透明基线才声明预测技能". This file defines the *contract*
 * for an Earth-data reference series. The reference series is a
 * sequence of (time, value) samples, each sample carrying a fixed
 * subset of physical quantities. Calibration compares a model's
 * trajectory against this series over a *train* window and reports
 * the residual against a transparent baseline (e.g. "constant
 * 288 K" or "linear trend") on a *holdout* window.
 *
 * Phase 1 ships:
 *
 *   - `EarthDataPoint`: a single (tickDays, temperatureK, ...) row.
 *   - `EarthDataSeries`: a parsed, sorted, validated series with
 *     a known source + citation.
 *   - `CalibrationConfig`: how to split train / holdout and which
 *     baseline to compare against.
 *   - `CalibrationReport`: the metric the P16 acceptance gate runs
 *     on (the calibrated trajectory's RMSE must beat the
 *     baseline's RMSE on the holdout).
 */
import * as v from '../core/validation.ts';

// === Reference data ===================================================

/** A single (time, value) point in the reference series. */
export interface EarthDataPoint {
  /** Days since series start. */
  tickDays: number;
  /** Surface temperature in Kelvin. */
  temperatureK: number;
  /** Sea level in metres above present. */
  seaLevelM: number;
  /** Atmospheric CO₂ in parts per million. */
  co2ppm: number;
  /** Sea-ice coverage fraction in [0, 1]. */
  iceCoverageFrac: number;
  /** Source citation / DOI. Required by the P16 contract. */
  source: string;
  /** Whether this point was *measured* (true) or *gap-filled* (false). */
  measured: boolean;
}

/** A parsed + validated Earth reference series. */
export interface EarthDataSeries {
  /** Display name (e.g. "Lisiecki 2005 LR04 stack"). */
  name: string;
  /** Citation string for the UI. */
  citation: string;
  /** Tick range covered (inclusive). */
  startTickDays: number;
  endTickDays: number;
  /** Points, sorted by `tickDays` ascending. */
  points: EarthDataPoint[];
  /** Count of points flagged `measured: false` (gap-fills). */
  gapFillCount: number;
}

// === Calibration =====================================================

/** How to compare a model trajectory against the series. */
export interface CalibrationConfig {
  /** Train / holdout split. Both must be in [0, 1] and sum to ≤ 1. */
  trainFraction: number;
  /** Baseline name (used in the report). Reference baselines:
   *   - `constant-mean`: predict the train-period mean for the
   *     holdout.
   *   - `linear-trend`: fit a line on the train period, predict
   *     on the holdout.
   *   - `persistence`: predict the last train value for the
   *     holdout.
   */
  baseline: 'constant-mean' | 'linear-trend' | 'persistence';
  /** Quantity to calibrate. Reference is `temperatureK`. */
  quantity: 'temperatureK' | 'seaLevelM' | 'co2ppm' | 'iceCoverageFrac';
}

/** Result of one calibration run. */
export interface CalibrationReport {
  /** Calibrated RMSE on the holdout window. */
  calibratedRMSE: number;
  /** Baseline RMSE on the holdout window. */
  baselineRMSE: number;
  /** Calibrated MAE on the holdout window. */
  calibratedMAE: number;
  /** Baseline MAE on the holdout window. */
  baselineMAE: number;
  /** Sample count on the holdout window. */
  holdoutN: number;
  /** Sample count on the train window. */
  trainN: number;
  /** `true` iff the calibrated trajectory beats the baseline on
   *  RMSE. The P16 acceptance gate checks this flag. */
  beatsBaseline: boolean;
  /** Baseline name (echoed for the UI). */
  baseline: string;
  /** Quantity (echoed for the UI). */
  quantity: string;
}

// === Loader ==========================================================

/** Validate + parse a raw JSON array into an `EarthDataSeries`. */
export function loadEarthData(input: unknown): EarthDataSeries {
  if (!Array.isArray(input)) v.fail('earthData', 'expected an array of points');
  if (input.length === 0) v.fail('earthData', 'must contain at least one point');
  if (input.length > 100000) v.fail('earthData', 'series > 100k points is too large for phase 1');
  const points: EarthDataPoint[] = [];
  for (let i = 0; i < input.length; i++) {
    const r = v.object(input[i], ['tickDays', 'temperatureK', 'seaLevelM', 'co2ppm', 'iceCoverageFrac', 'source', 'measured'], 'earthDataPoint');
    const tickDays = v.integer(r.tickDays, `earthData[${i}].tickDays`, 0, 1e10);
    const temperatureK = v.number(r.temperatureK, `earthData[${i}].temperatureK`, 100, 400);
    const seaLevelM = v.number(r.seaLevelM, `earthData[${i}].seaLevelM`, -200, 300);
    const co2ppm = v.number(r.co2ppm, `earthData[${i}].co2ppm`, 0, 1e5);
    const iceCoverageFrac = v.number(r.iceCoverageFrac, `earthData[${i}].iceCoverageFrac`, 0, 1);
    if (typeof r.source !== 'string') v.fail(`earthData[${i}].source`, 'must be a string');
    if (typeof r.measured !== 'boolean') v.fail(`earthData[${i}].measured`, 'must be a boolean');
    points.push({ tickDays, temperatureK, seaLevelM, co2ppm, iceCoverageFrac, source: r.source, measured: r.measured });
  }
  // Sort by tickDays, dedup.
  points.sort((a, b) => a.tickDays - b.tickDays);
  // First / last citations must be the same source (the series is
  // a single reference); a heterogeneous list is a config error.
  const citation = points[0]!.source;
  for (let i = 1; i < points.length; i++) {
    if (points[i]!.source !== citation) v.fail(`earthData[${i}].source`, 'all points in a series must share a single source citation');
  }
  return {
    name: citation,
    citation,
    startTickDays: points[0]!.tickDays,
    endTickDays: points[points.length - 1]!.tickDays,
    points,
    gapFillCount: points.filter(p => !p.measured).length,
  };
}
