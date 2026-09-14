/**
 * P16 — calibration comparison.
 *
 * `compareToEarth` takes a *model trajectory* (a sparse series of
 * `(tickDays, value)` samples produced by running the simulation)
 * and an `EarthDataSeries` + `CalibrationConfig`, and produces a
 * `CalibrationReport`. The report contains both the model's
 * RMSE / MAE and the baseline's, on the *holdout* window only;
 * the train window is used to fit the baseline.
 *
 * The P16 acceptance gate runs `compareToEarth` with the model
 * trajectory nudged slightly toward the real series (e.g. by
 * setting the scenario's `initialTemperatureK` close to the
 * early-Holocene anchor) and asserts `report.beatsBaseline` is
 * true. A "win" on RMSE means the calibration framework is
 * wired correctly; a "win" on a transparent baseline means the
 * model is doing real work.
 */
import type { CalibrationConfig, CalibrationReport, EarthDataPoint, EarthDataSeries } from './types.ts';

export interface ModelSample {
  tickDays: number;
  value: number;
}

/** Split a series into train / holdout. */
function splitByFraction<T>(arr: T[], trainFraction: number): { train: T[]; holdout: T[] } {
  if (trainFraction < 0 || trainFraction > 1) throw new Error('trainFraction must be in [0, 1]');
  const cut = Math.floor(arr.length * trainFraction);
  return { train: arr.slice(0, cut), holdout: arr.slice(cut) };
}

/** Mean of an array. */
function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Simple least-squares slope + intercept on (x, y). */
function linearFit(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = xs.length;
  if (n === 0) return { slope: 0, intercept: 0 };
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = my - slope * mx;
  return { slope, intercept };
}

/** Compute baseline predictions on the holdout. */
function predictBaseline(
  baseline: CalibrationConfig['baseline'],
  trainPoints: { x: number; y: number }[],
  holdoutPoints: { x: number; y: number }[],
): number[] {
  if (baseline === 'constant-mean') {
    const m = mean(trainPoints.map(p => p.y));
    return holdoutPoints.map(() => m);
  }
  if (baseline === 'persistence') {
    const last = trainPoints.length > 0 ? trainPoints[trainPoints.length - 1]!.y : 0;
    return holdoutPoints.map(() => last);
  }
  // linear-trend
  const fit = linearFit(trainPoints.map(p => p.x), trainPoints.map(p => p.y));
  return holdoutPoints.map(p => fit.slope * p.x + fit.intercept);
}

/** RMSE / MAE helpers. */
function rmse(pred: number[], actual: number[]): number {
  if (pred.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < pred.length; i++) {
    const d = (pred[i]! - actual[i]!);
    s += d * d;
  }
  return Math.sqrt(s / pred.length);
}
function mae(pred: number[], actual: number[]): number {
  if (pred.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < pred.length; i++) s += Math.abs(pred[i]! - actual[i]!);
  return s / pred.length;
}

/** Pick the chosen quantity out of an EarthDataPoint. */
function pickQuantity(p: EarthDataPoint, q: CalibrationConfig['quantity']): number {
  switch (q) {
    case 'temperatureK': return p.temperatureK;
    case 'seaLevelM': return p.seaLevelM;
    case 'co2ppm': return p.co2ppm;
    case 'iceCoverageFrac': return p.iceCoverageFrac;
  }
}

/**
 * Compare a model trajectory to the Earth series on the
 * configured quantity + baseline. The model's value is
 * linearly interpolated at the Earth's tick days — that way
 * the two series don't have to be sampled on the same grid.
 */
export function compareToEarth(
  series: EarthDataSeries,
  model: ModelSample[],
  config: CalibrationConfig,
): CalibrationReport {
  if (model.length === 0) throw new Error('model trajectory is empty');
  // Build (x, y) pairs for the chosen quantity.
  const train = splitByFraction(series.points, config.trainFraction);
  const trainPairs = train.train.map(p => ({ x: p.tickDays, y: pickQuantity(p, config.quantity) }));
  const holdoutPairs = train.holdout.map(p => ({ x: p.tickDays, y: pickQuantity(p, config.quantity) }));
  if (holdoutPairs.length === 0) throw new Error('holdout window is empty — increase series size or decrease trainFraction');
  // Sort model by tickDays for interpolation.
  const modelSorted = [...model].sort((a, b) => a.tickDays - b.tickDays);
  // For each holdout point, interpolate the model's value at the
  // Earth's tickDays.
  const modelPred: number[] = holdoutPairs.map(p => interp(modelSorted, p.x));
  const actual = holdoutPairs.map(p => p.y);
  // Baseline predictions.
  const baselinePred = predictBaseline(config.baseline, trainPairs, holdoutPairs);
  const calibratedRMSE = rmse(modelPred, actual);
  const baselineRMSE = rmse(baselinePred, actual);
  const calibratedMAE = mae(modelPred, actual);
  const baselineMAE = mae(baselinePred, actual);
  return {
    calibratedRMSE,
    baselineRMSE,
    calibratedMAE,
    baselineMAE,
    holdoutN: holdoutPairs.length,
    trainN: trainPairs.length,
    beatsBaseline: calibratedRMSE < baselineRMSE,
    baseline: config.baseline,
    quantity: config.quantity,
  };
}

/** Linear interpolation on a sorted (x, y) array. */
function interp(model: ModelSample[], x: number): number {
  if (model.length === 0) return 0;
  if (x <= model[0]!.tickDays) return model[0]!.value;
  if (x >= model[model.length - 1]!.tickDays) return model[model.length - 1]!.value;
  let lo = 0;
  let hi = model.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (model[mid]!.tickDays <= x) lo = mid;
    else hi = mid;
  }
  const a = model[lo]!;
  const b = model[hi]!;
  const t = (x - a.tickDays) / (b.tickDays - a.tickDays);
  return a.value + t * (b.value - a.value);
}
