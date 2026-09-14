/**
 * P17-3 — single-seed worker runner.
 *
 * One `SeedRunner` per worker. The main thread `runBatchInWorkers`
 * spawns one of these per seed and posts an `init` message; the
 * worker instantiates a fresh `SimulationController`, runs it for
 * the requested ticks, snapshots the final state, and posts back
 * a `done` message with the per-seed outcome.
 *
 * The worker is intentionally stateless across messages — each
 * `init` creates a new controller, so the main thread can spawn
 * N workers in parallel and trust that state never leaks between
 * seeds.
 *
 * This is the P17-3 worker-pool primitive. The actual pool lives
 * in `main.ts`; this file is the per-seed worker body.
 */
import { SimulationController } from './controller.ts';

export interface SeedRunnerInit {
  type: 'init';
  /** Scenario id from `getScenario`. */
  scenario: string;
  /** Resolution (cells). */
  resolution: 320 | 1280 | 5120 | 20480;
  /** Seed string (any string; the runner forwards it to `create`). */
  seed: string;
  /** Planetary ticks to advance. */
  ticks: number;
}

export interface SeedRunnerProgress {
  type: 'progress';
  seed: string;
  finalTick: number;
}

export interface SeedRunnerDone {
  type: 'done';
  seed: string;
  finalTick: number;
  population: number;
  meanTemperatureK: number;
  activeLineages: number;
  crashed: boolean;
  durationMs: number;
}

export interface SeedRunnerError {
  type: 'error';
  seed: string;
  message: string;
}

export type SeedRunnerMessage = SeedRunnerProgress | SeedRunnerDone | SeedRunnerError;

self.onmessage = async (event: MessageEvent<SeedRunnerInit>) => {
  const msg = event.data;
  if (msg.type !== 'init') return;
  const t0 = performance.now();
  const controller = new SimulationController(() => { /* drop unsolicited replies */ });
  try {
    await controller.handle({ id: 1, type: 'create', payload: {
      scenario: msg.scenario, cells: msg.resolution, seed: msg.seed,
    }});
    await controller.handle({ id: 2, type: 'run', payload: { ticks: msg.ticks } });
    // Poll until the controller reaches the requested tick.
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const s = controller.snapshotState();
      if (s.tick >= msg.ticks) break;
      await new Promise<void>(r => setTimeout(r, 20));
    }
    const s = controller.snapshotState();
    const pop = s.cohorts.ids.reduce((a, _id, i) => a + (s.cohorts.counts[i] ?? 0), 0);
    const meanTemp = meanOf(s.cells.temperatureK);
    const lineages = s.lineages.length;
    const crashed = pop <= 0;
    const durationMs = performance.now() - t0;
    const done: SeedRunnerDone = {
      type: 'done', seed: msg.seed, finalTick: s.tick, population: pop,
      meanTemperatureK: meanTemp, activeLineages: lineages,
      crashed, durationMs,
    };
    (self as unknown as { postMessage: (m: SeedRunnerDone) => void }).postMessage(done);
  } catch (e) {
    const err: SeedRunnerError = {
      type: 'error', seed: msg.seed, message: e instanceof Error ? e.message : String(e),
    };
    (self as unknown as { postMessage: (m: SeedRunnerError) => void }).postMessage(err);
  }
};

function meanOf(xs: Float64Array): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i]!;
  return s / xs.length;
}
