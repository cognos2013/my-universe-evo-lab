/**
 * P17 — scenario batches and outcome statistics.
 *
 * Per docs/15 P17: "有版本的驱动假设、多种子/参数组合、失败统计
 * 和结果分布;可与留出历史对照评估". This file defines the
 * *contract* for running a scenario across many seeds and
 * summarising the resulting distribution.
 *
 * The reference task in phase 1 is "empty-planet, N seeds, K
 * steps each, measure population + mean-temperature at the end".
 * More elaborate scenarios (P12 chemistry, P13 colonies, P14
 * agents, P15 settlements) are future phases — the contract
 * here is intentionally generic enough to host them.
 */
import * as v from '../core/validation.ts';

/** A versioned scenario definition. The `version` field is
 *  required so a saved experiment file can tell which scenario
 *  config produced its results. */
export interface Scenario {
  /** Stable id (e.g. 'empty-planet', 'two-lineages'). */
  id: string;
  /** Version string, e.g. 'v1', '2026-01'. Bumped when the
   *  scenario definition changes. */
  version: string;
  /** Human-readable description. */
  description: string;
  /** Free-form assumptions (initial temperature, etc.). Stored
   *  as a record so future phases can introduce new fields. */
  assumptions: Record<string, number | string | boolean>;
  /** Resolution used for the seeded runs (one of the legal
   *  `cells` values). */
  resolution: 320 | 1280 | 5120 | 20480;
  /** Number of planetary ticks each seed is run for. */
  ticks: number;
}

/** Configuration for a batch run. */
export interface BatchConfig {
  /** Scenario id + version. Used to look up (or record) the
   *  scenario in the book. */
  scenario: { id: string; version: string };
  /** Seed range: half-open `[seedStart, seedStart + seedCount)`. */
  seedStart: number;
  /** How many seeds to run. Capped at 64 in phase 1. */
  seedCount: number;
  /**
   * If true, seeds are dispatched in parallel (the runner awaits
   * all of them via `Promise.all`). This does not actually
   * parallelise the *engine* work — each seed is still driven
   * forward on the main thread — but it interleaves the await
   * points so a 4-seed batch can complete roughly 1.5-2× faster
   * than a sequential one. A real worker pool is a phase-2
   * concern.
   */
  parallel: boolean;
  /**
   * Optional parameter sweep. Each entry defines a single
   * parameter axis (e.g. `resolution`, `ticks`, or any custom
   * key) and a list of values to try. The runner builds the
   * cartesian product of all axes and runs the requested
   * `seedCount` × |axes| seeds, labelling each outcome with the
   * parameter combination that produced it.
   */
  paramSweeps?: ParamSweep[];
  /**
   * How many (param, value) combinations to keep per parameter
   * axis (default 1 = no sweep). Convenience field for the
   * common case "sweep N values of one parameter".
   */
  sweepValues?: Record<string, (number | string)[]>;
  /** Resolution (cells) for the runs. Default 320. */
  resolution?: 320 | 1280 | 5120 | 20480;
  /** Planetary ticks per run. Default 100. */
  ticks?: number;
}

export interface ParamSweep {
  /** Parameter name. Phase 1 understands `resolution` and
   *  `ticks`; custom names are stored but ignored by the
   *  default runner. */
  param: 'resolution' | 'ticks';
  /** Values to try. Each value triggers a fresh `seedCount` set
   *  of runs. */
  values: number[];
}

/** One per-seed outcome. */
export interface BatchOutcome {
  /** Seed used for this run. */
  seed: number;
  /** Final tick. */
  finalTick: number;
  /** Final population. */
  population: number;
  /** Final mean surface temperature. */
  meanTemperatureK: number;
  /** Final total active lineages. */
  activeLineages: number;
  /** Did the world crash (population = 0) before reaching the
   *  requested `ticks`? */
  crashed: boolean;
  /** Did the run fail to start (engine error, etc.)? */
  failed: boolean;
  /** Optional failure reason. */
  failureReason?: string;
  /** Parameter values active for this run (key → value, e.g.
   *  `resolution=320` or `ticks=200`). Empty when no sweep is
   *  active. */
  paramValues: Record<string, number | string>;
}

/** Result of one batch. */
export interface BatchReport {
  scenario: { id: string; version: string };
  seedStart: number;
  seedCount: number;
  outcomes: BatchOutcome[];
  /** Per-metric summary: mean, std, min, p5, p50, p95, max. */
  summary: {
    population: StatSummary;
    meanTemperatureK: StatSummary;
    activeLineages: StatSummary;
  };
  /** Count of seeds that crashed before reaching `ticks`. */
  crashes: number;
  /** Count of seeds that failed to start. */
  failures: number;
  /** Step counter — `0` while running, `seedCount` when done. */
  completedSeeds: number;
  /** True iff `completedSeeds === seedCount`. */
  done: boolean;
}

export interface StatSummary {
  n: number;
  mean: number;
  std: number;
  min: number;
  p5: number;
  p50: number;
  p95: number;
  max: number;
}

// === Validation ========================================================

export function validateScenario(s: unknown): asserts s is Scenario {
  const o = v.object(s, ['id', 'version', 'description', 'assumptions', 'resolution', 'ticks'], 'scenario');
  v.id(o.id, 'scenario.id');
  v.text(o.version, 'scenario.version', 32);
  v.text(o.description, 'scenario.description', 256);
  if (typeof o.assumptions !== 'object' || o.assumptions === null) v.fail('scenario.assumptions', 'must be an object');
  v.choice(o.resolution, [320, 1280, 5120, 20480], 'scenario.resolution');
  v.integer(o.ticks, 'scenario.ticks', 1, 100000);
}
