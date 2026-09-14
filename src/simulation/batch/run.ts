/**
 * P17 — batch runner.
 *
 * `runBatch` runs a scenario across `seedCount` seeds and returns
 * a `BatchReport`. The reference runner is sequential; future
 * phases can introduce parallelism once a worker pool exists.
 *
 * For each seed, we:
 *   1. Build a `SimulationController` and a fresh `ExperimentBook`.
 *   2. Initialise the world with the scenario + seed.
 *   3. Step the world for `scenario.ticks` planetary ticks (each
 *      driven by the controller's own internal scheduler — we just
 *      kick `run` and wait for completion via a polled snapshot).
 *   4. Record the final population, mean temperature, and active
 *      lineages. If the world crashed, record `crashed: true`.
 *
 * The reference scenario in phase 1 is `empty-planet` with a
 * single known scenario config — see `tests/p17.test.ts` for
 * the acceptance gate.
 */
import { SimulationController, type Reply } from '../../workers/controller.ts';
import { ExperimentBook } from '../../experiments/book.ts';
import { getScenario } from '../../scenarios/catalog.ts';
import { initializeWorld } from '../core/initialize.ts';
import { summarize } from '../metrics/summary.ts';
import type { BatchConfig, BatchOutcome, BatchReport, ParamSweep, Scenario, StatSummary } from './types.ts';

/** Make a synthetic seeded `seed-{n}`-style string. */
function seedToString(n: number): string {
  return `p17-seed-${n.toString(36)}-${n.toString(16).padStart(4, '0')}`;
}

/** Build a scenario config from the (id, version) pair by
 *  looking up a known catalog. Phase 1 supports `empty-planet` and
 *  `two-lineages`; the catalog is the source of truth for
 *  scenario defaults. */
function lookupScenario(id: string, version: string, ticks: number, resolution: 320 | 1280 | 5120 | 20480): Scenario {
  if (version !== 'v1') throw new Error(`未知 scenario version: ${version}（仅支持 v1）`);
  const description = id === 'empty-planet'
    ? '无生命星球，观察多种子演化分布'
    : id === 'two-lineages'
      ? '两种生命，同一颗星球，分布'
      : `scenario: ${id}`;
  return {
    id, version, description, resolution, ticks,
    assumptions: { scenarioId: id },
  };
}

/** Compute the per-metric summary statistics. Empty input → all
 *  zeros except `n = 0`. */
export function summarise(outcomes: BatchOutcome[]): BatchReport['summary'] {
  const fields: Array<'population' | 'meanTemperatureK' | 'activeLineages'> = [
    'population', 'meanTemperatureK', 'activeLineages',
  ];
  const out: BatchReport['summary'] = {
    population: emptySummary(),
    meanTemperatureK: emptySummary(),
    activeLineages: emptySummary(),
  };
  for (const f of fields) {
    const xs = outcomes.map(o => (o as unknown as Record<string, number>)[f] as number).filter(Number.isFinite);
    if (xs.length === 0) continue;
    xs.sort((a, b) => a - b);
    const n = xs.length;
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance);
    out[f] = {
      n,
      mean,
      std,
      min: xs[0]!,
      p5: quantile(xs, 0.05),
      p50: quantile(xs, 0.5),
      p95: quantile(xs, 0.95),
      max: xs[n - 1]!,
    };
  }
  return out;
}

function emptySummary(): StatSummary {
  return { n: 0, mean: 0, std: 0, min: 0, p5: 0, p50: 0, p95: 0, max: 0 };
}

/** Linear-interpolated quantile from a *sorted* array. */
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

/** Run a batch. Returns a *completed* report (synchronous in
 *  phase 1: we step the world as fast as we can for each seed
 *  and stop at `scenario.ticks`). For interactive use, future
 *  phases can stream a partial report. */
export async function runBatch(
  scenario: { id: string; version: string },
  config: BatchConfig,
): Promise<BatchReport> {
  if (config.seedCount < 1) throw new Error('seedCount 必须 ≥ 1');
  if (config.seedCount > 64) throw new Error('seedCount 必须 ≤ 64');
  if (config.seedStart < 0) throw new Error('seedStart 必须 ≥ 0');
  if (config.paramSweeps) {
    for (const sw of config.paramSweeps) {
      if (sw.param !== 'resolution' && sw.param !== 'ticks') {
        throw new Error(`不支持的参数扫描: ${sw.param}（仅 resolution / ticks）`);
      }
      if (!Array.isArray(sw.values) || sw.values.length === 0 || sw.values.length > 16) {
        throw new Error(`${sw.param} 扫描值数 1—16`);
      }
    }
  }
  // Expand the cartesian product of `paramSweeps` × `seedCount`.
  // Each combination is one "job" producing a single outcome.
  const jobs = expandJobs(config);
  const allOutcomes: BatchOutcome[] = [];
  for (const job of jobs) {
    const sub = await runOneParameterSet(scenario, config, job.resolution, job.ticks, job.paramValues);
    allOutcomes.push(...sub);
  }
  const crashes = allOutcomes.filter(o => o.crashed).length;
  const failures = allOutcomes.filter(o => o.failed).length;
  return {
    scenario: { id: scenario.id, version: scenario.version },
    seedStart: config.seedStart,
    seedCount: config.seedCount,
    outcomes: allOutcomes,
    summary: summarise(allOutcomes),
    crashes,
    failures,
    completedSeeds: allOutcomes.length,
    done: true,
  };
}

/** Expand a `BatchConfig` into a list of (parameterValues, resolution,
 *  ticks) jobs. The cartesian product of the `paramSweeps` axes is
 *  built here. For each combination, `resolution` and `ticks` are
 *  read from the sweep entry if present, otherwise they fall back
 *  to `BatchConfig.resolution` / `BatchConfig.ticks` (defaulted by
 *  the controller). */
function expandJobs(config: BatchConfig): Array<{
  paramValues: Record<string, number | string>;
  resolution: 320 | 1280 | 5120 | 20480;
  ticks: number;
}> {
  const sweeps: ParamSweep[] = config.paramSweeps ?? [];
  const defaultResolution = (config.resolution ?? 320) as 320 | 1280 | 5120 | 20480;
  const defaultTicks = config.ticks ?? 100;
  if (sweeps.length === 0) {
    return [{ paramValues: {}, resolution: defaultResolution, ticks: defaultTicks }];
  }
  // Cartesian product.
  let combos: Array<Record<string, number | string>> = [{}];
  for (const sweep of sweeps) {
    const next: Array<Record<string, number | string>> = [];
    for (const cur of combos) {
      for (const v of sweep.values) {
        next.push({ ...cur, [sweep.param]: v });
      }
    }
    combos = next;
  }
  return combos.map(cv => ({
    paramValues: cv,
    resolution: (cv.resolution as 320 | 1280 | 5120 | 20480) ?? defaultResolution,
    ticks: (cv.ticks as number) ?? defaultTicks,
  }));
}

/** Run one parameter setting × N seeds. The seeds may be
 *  dispatched in parallel via `Promise.all` when `parallel: true`
 *  — engine work is still on the main thread but the await
 *  points interleave. */
async function runOneParameterSet(
  scenario: { id: string; version: string },
  config: BatchConfig,
  resolution: 320 | 1280 | 5120 | 20480,
  ticks: number,
  paramValues: Record<string, number | string>,
): Promise<BatchOutcome[]> {
  const fullScenario = lookupScenario(scenario.id, scenario.version, ticks, resolution);
  const tasks: Promise<BatchOutcome>[] = [];
  for (let i = 0; i < config.seedCount; i++) {
    const seedInt = config.seedStart + i;
    tasks.push(runOneSeed(fullScenario, seedInt, paramValues));
  }
  if (config.parallel) {
    return Promise.all(tasks);
  } else {
    const out: BatchOutcome[] = [];
    for (const t of tasks) out.push(await t);
    return out;
  }
}

/** Run one seed. Builds a fresh controller, initialises the
 *  world, runs `ticks` planetary steps, records the outcome. */
async function runOneSeed(scenario: Scenario, seedInt: number, paramValues: Record<string, number | string>): Promise<BatchOutcome> {
  const seedStr = seedToString(seedInt);
  const replies: Reply[] = [];
  const controller = new SimulationController((r) => replies.push(r));
  try {
    await controller.handle({ id: 1, type: 'create', payload: {
      scenario: scenario.id, cells: scenario.resolution, seed: seedStr,
    }});
    // The controller has the world ready; kick a `run` of the
    // requested length. `run` triggers `internalTick` repeatedly
    // via setTimeout(0); we wait for the world tick to reach
    // `scenario.ticks` with a small polling loop.
    await controller.handle({ id: 2, type: 'run', payload: { ticks: scenario.ticks } });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const s = controller.snapshotState();
      if (s.tick >= scenario.ticks) break;
      await new Promise(r => setTimeout(r, 20));
    }
    const s = controller.snapshotState();
    const sum = summarize(s);
    const crashed = sum.population <= 0;
    return {
      seed: seedInt,
      finalTick: s.tick,
      population: sum.population,
      meanTemperatureK: sum.temperatureK,
      activeLineages: sum.activeLineages,
      crashed,
      failed: false,
      paramValues,
    };
  } catch (error) {
    return {
      seed: seedInt,
      finalTick: 0,
      population: 0,
      meanTemperatureK: 0,
      activeLineages: 0,
      crashed: false,
      failed: true,
      failureReason: error instanceof Error ? error.message : String(error),
      paramValues,
    };
  }
}
