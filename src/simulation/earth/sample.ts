/**
 * P16 — sample Earth data series.
 *
 * The phase-1 reference series is a *synthetic* Holocene-like
 * temperature curve, hand-constructed to look like the real
 * thing (an early-Holocene thermal maximum, a mid-Holocene
 * cooling, and a late-Holocene warming that pre-figures the
 * industrial era). The numbers are **not** observational — the
 * series is shipped inline so the P16 acceptance gate has
 * something to calibrate against without bundling a multi-MB
 * file. The citation string is honest about this:
 *
 *     "synthetic-Holocene-placeholder, phase-1 demo data"
 *
 * Phase 2 will replace this with a downloaded real dataset
 * (e.g. Marcott 2013, Lisiecki 2005) following the
 * third-party-licensing rules in docs/04. The loader is the
 * only place that needs to change.
 */
import type { EarthDataPoint, EarthDataSeries } from './types.ts';

const SYNTHETIC_HOLOCENE_SOURCE = 'synthetic-Holocene-placeholder, phase-1 demo data';

/**
 * Build the synthetic Holocene temperature series. The series
 * spans 0 → 10 000 years (in days, since 1 yr = 365.25 d) with
 * monthly samples (≈ 120k points). To keep the phase-1 file
 * under control, we actually ship a coarser 1-year resolution
 * (10 000 points) which is plenty for an RMSE / MAE check.
 */
export function syntheticHoloceneSeries(): EarthDataSeries {
  const startDays = 0;
  const endDays = 10_000 * 365;
  const stepDays = 365; // 1-year resolution
  const points: EarthDataPoint[] = [];
  for (let t = startDays; t <= endDays; t += stepDays) {
    const years = t / 365;
    // Holocene curve: early warm (T ≈ 290 K), mid cooling (T ≈
    // 287 K), late warming (T ≈ 288.5 K at present). The numbers
    // are illustrative, not observational.
    // Use `Math.pow` to keep the `exp(-x²)` semantics unambiguous —
    // JavaScript's `**` is right-associative and `-x ** 2` parses as
    // `-(x ** 2)`, which would silently break the curve.
    const early = Math.exp(-Math.pow((years - 1500) / 1500, 2)) * 1.5;
    const mid = -1.2 * Math.exp(-Math.pow((years - 5500) / 2000, 2));
    const late = Math.exp(-Math.pow((years - 9700) / 500, 2)) * 0.7;
    const temperatureK = 288 + early + mid + late;
    // Sea level slowly drops as ice grows, then climbs late.
    const seaLevelM = -1.5 * Math.exp(-Math.pow((years - 5500) / 2000, 2)) + 0.1 * (years / 10_000);
    // CO₂ roughly flat at 280 ppm until late, climbing in the
    // last 200 years.
    const co2ppm = years < 9800 ? 280 : 280 + (years - 9800) * 1.0;
    // Ice coverage: 0 early, 0.05 mid, 0.02 late.
    const iceCoverageFrac = years < 4500 ? 0 : years < 8000 ? 0.05 : 0.02;
    points.push({
      tickDays: t,
      temperatureK,
      seaLevelM,
      co2ppm,
      iceCoverageFrac,
      source: SYNTHETIC_HOLOCENE_SOURCE,
      measured: true,
    });
  }
  return {
    name: SYNTHETIC_HOLOCENE_SOURCE,
    citation: SYNTHETIC_HOLOCENE_SOURCE,
    startTickDays: points[0]!.tickDays,
    endTickDays: points[points.length - 1]!.tickDays,
    points,
    gapFillCount: 0,
  };
}
