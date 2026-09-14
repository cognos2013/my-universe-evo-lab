/**
 * UI panel for P17 (scenario batches and outcome statistics).
 *
 * Wires `batchRun` into the main UI. The runner is synchronous
 * (each seed gets a fresh `SimulationController` and is driven
 * forward via its own internal scheduler), so the button click
 * blocks for the duration of the batch — phase 1 is a tool for
 * evaluation, not the main interaction loop.
 *
 * The right pane shows the *most recent* batch report in detail:
 * overall counts (completed / failures / crashes) and per-metric
 * summaries (population / temperature / lineages) with the
 * standard 7-number summary (n / mean / std / min / p5 / p50 /
 * p95 / max). A short per-seed table at the bottom shows the
 * raw outcomes.
 */
import type { Projection } from '../workers/controller.ts';
import { renderBoxPlot } from './chart.ts';
import { runBatchInWorkers, type SeedPoolResult } from '../simulation/batch/pool.ts';

type Send = (type: string, payload?: Record<string, unknown>) => Promise<unknown>;
type StatSummary = { n: number; mean: number; std: number; min: number; p5: number; p50: number; p95: number; max: number };
type BatchReport = {
  scenario: { id: string; version: string };
  seedStart: number;
  seedCount: number;
  outcomes: Array<{ seed: number; finalTick: number; population: number; meanTemperatureK: number; activeLineages: number; crashed: boolean; failed: boolean; paramValues: Record<string, number | string> }>;
  summary: { population: StatSummary; meanTemperatureK: StatSummary; activeLineages: StatSummary };
  crashes: number;
  failures: number;
  completedSeeds: number;
  done: boolean;
};

const format = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const intf = (n: number) => n.toLocaleString('zh-CN');

export function mountBatch(
  send: Send,
  onStatus: (msg: string, isError?: boolean) => void,
  onClose: () => void = () => undefined,
): (snapshot: Projection) => void {
  const dialog = document.getElementById('batch-dialog') as HTMLElement;
  const scenarioEl = document.getElementById('batch-scenario') as HTMLSelectElement;
  const resolutionEl = document.getElementById('batch-resolution') as HTMLSelectElement;
  const ticksEl = document.getElementById('batch-ticks') as HTMLInputElement;
  const seedsEl = document.getElementById('batch-seeds') as HTMLInputElement;
  const seedStartEl = document.getElementById('batch-seed-start') as HTMLInputElement;
  const statusEl = document.getElementById('batch-status')!;
  const summaryEl = document.getElementById('batch-summary')!;
  const popEl = document.getElementById('batch-pop')!;
  const tempEl = document.getElementById('batch-temp')!;
  const linEl = document.getElementById('batch-lin')!;
  const perSeedEl = document.getElementById('batch-per-seed')!;

  function setStatus(msg: string, isError = false) {
    statusEl.textContent = msg;
    statusEl.className = isError ? 'muted small' : 'muted small';
  }
  function row(ul: HTMLElement, label: string, value: string, cls = 'muted') {
    const li = document.createElement('li');
    const left = document.createElement('strong'); left.textContent = label;
    const right = document.createElement('span'); right.className = cls; right.textContent = value;
    li.append(left, right);
    ul.append(li);
  }
  function statRow(ul: HTMLElement, label: string, s: StatSummary, formatter: (n: number) => string) {
    row(ul, label, `n=${s.n} · mean=${formatter(s.mean)} · std=${formatter(s.std)} · p5=${formatter(s.p5)} · p50=${formatter(s.p50)} · p95=${formatter(s.p95)} · min=${formatter(s.min)} · max=${formatter(s.max)}`);
  }

  document.getElementById('close-batch')!.addEventListener('click', () => {
    void send('pause');
    onClose();
  });

  document.getElementById('batch-run')!.addEventListener('click', async () => {
    const scenarioId = scenarioEl.value;
    const resolution = Number(resolutionEl.value) as 320 | 1280 | 5120 | 20480;
    const ticks = Math.max(1, Math.floor(Number(ticksEl.value) || 50));
    const seedCount = Math.max(1, Math.min(64, Math.floor(Number(seedsEl.value) || 4)));
    const seedStart = Math.max(0, Math.floor(Number(seedStartEl.value) || 0));
    setStatus(`运行中 · ${scenarioId} · ${seedCount} seeds · ${ticks} ticks · res ${resolution}（Web Worker pool）…`);
    const t0 = performance.now();
    // P17-3: true-parallel via the Web Worker pool. We run the
    // batch locally and post the report to the controller so
    // the projection snapshot is updated as well.
    const jobs = Array.from({ length: seedCount }, (_, i) => ({
      seed: `p17-worker-${(seedStart + i).toString(36)}`,
      scenario: scenarioId, resolution, ticks,
    }));
    try {
      const results: SeedPoolResult[] = await runBatchInWorkers(jobs, {
        maxParallel: Math.min(4, seedCount),
        onProgress: (done, total) => setStatus(`运行中 · ${done}/${total} seeds 完成（Web Worker pool）`),
      });
      // Hand the result back to the controller so the projection
      // snapshot is updated.
      const reply = await send('batchRun', {
        scenario: { id: scenarioId, version: 'v1' }, resolution, ticks, seedCount, seedStart,
      }) as { report?: BatchReport } | undefined;
      // The controller ran its own (main-thread) batch. We
      // overlay the *worker* results so the UI shows real CPU
      // parallelism, not the co-operative main-thread pass.
      if (reply?.report) {
        reply.report.outcomes = results.map((r, i) => ({
          seed: seedStart + i, finalTick: r.finalTick, population: r.population,
          meanTemperatureK: r.meanTemperatureK, activeLineages: r.activeLineages,
          crashed: r.crashed, failed: false, paramValues: {},
        }));
        reply.report.completedSeeds = results.length;
        reply.report.done = true;
        reply.report.crashes = results.filter(r => r.crashed).length;
        reply.report.failures = 0;
        reply.report.summary = summaryFromResults(results);
      }
      const dt = ((performance.now() - t0) / 1000).toFixed(1);
      const r = reply?.report;
      if (r) {
        setStatus(`完成 · ${r.scenario.id} · ${r.completedSeeds}/${r.seedCount} 完成 · 失败 ${r.failures} · 崩溃 ${r.crashes} · 耗时 ${dt}s（Web Worker pool）`);
        onStatus(`P17 批量完成 (${r.completedSeeds} seeds, ${dt}s, 4-worker pool)`);
      } else {
        setStatus('完成');
        onStatus('P17 批量完成');
      }
    } catch (e) {
      setStatus(`失败：${e instanceof Error ? e.message : String(e)}`, true);
      onStatus(`P17 批量失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  return (snapshot: Projection) => {
    const last = snapshot.batches.length > 0 ? snapshot.batches[snapshot.batches.length - 1]! : null;
    summaryEl.replaceChildren();
    popEl.replaceChildren();
    tempEl.replaceChildren();
    linEl.replaceChildren();
    perSeedEl.replaceChildren();
    if (!last) {
      row(summaryEl, 'Scenario', '—');
      row(summaryEl, 'Seed 范围', '—');
      row(summaryEl, '完成 / 失败 / 崩溃', '—');
      const li = document.createElement('li'); li.className = 'muted'; li.textContent = '尚无批量';
      perSeedEl.append(li);
      return;
    }
    row(summaryEl, 'Scenario', `${last.scenario.id} @ ${last.scenario.version}`);
    row(summaryEl, 'Seed 范围', `${last.seedStart}..${last.seedStart + last.seedCount - 1}（共 ${last.seedCount}）`);
    row(summaryEl, '完成 / 失败 / 崩溃', `${last.completedSeeds} / ${last.failures} / ${last.crashes}`);
    statRow(popEl, 'population', last.summary.population, intf);
    statRow(tempEl, 'temperature K', last.summary.meanTemperatureK, format);
    statRow(linEl, 'lineages', last.summary.activeLineages, intf);
    // P17-3: SVG box plots for the three metrics.
    drawChartRow(popEl, 'population (箱线图)', last.outcomes.map(o => o.population), intf);
    drawChartRow(tempEl, 'temperature K (箱线图)', last.outcomes.map(o => o.meanTemperatureK), format);
    drawChartRow(linEl, 'lineages (箱线图)', last.outcomes.map(o => o.activeLineages), intf);
    // Per-seed (first 16).
    const show = last.outcomes.slice(0, 16);
    for (const o of show) {
      const li = document.createElement('li');
      const left = document.createElement('strong'); left.textContent = `seed ${o.seed} · tick ${o.finalTick}`;
      const right = document.createElement('span');
      right.className = o.crashed ? 'muted crashed' : o.failed ? 'muted' : 'muted';
      right.textContent = `pop ${intf(o.population)} · T ${format(o.meanTemperatureK)} K · lin ${o.activeLineages}${o.crashed ? ' · 崩溃' : ''}${o.failed ? ' · 失败' : ''}`;
      li.append(left, right);
      perSeedEl.append(li);
    }
    if (last.outcomes.length > 16) {
      const li = document.createElement('li'); li.className = 'muted';
      li.textContent = `…另有 ${last.outcomes.length - 16} 条（未显示）`;
      perSeedEl.append(li);
    }
  };
}

/** Render a row label + a box plot in the given `<ul>`. */
function drawChartRow(ul: HTMLElement, title: string, data: number[], formatter: (n: number) => string) {
  const li = document.createElement('li');
  li.style.flexDirection = 'column';
  li.style.alignItems = 'stretch';
  const head = document.createElement('div');
  head.style.display = 'flex';
  head.style.justifyContent = 'space-between';
  const left = document.createElement('strong'); left.textContent = title;
  const right = document.createElement('span'); right.className = 'muted';
  right.textContent = `n=${data.length} · min=${formatter(Math.min(...data))} · max=${formatter(Math.max(...data))}`;
  head.append(left, right);
  li.append(head);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGElement;
  svg.setAttribute('role', 'img');
  li.append(svg);
  ul.append(li);
  renderBoxPlot(svg, data, { width: 280, height: 60, format: formatter });
}

/** Compute the standard 8-number summary for an array of
 *  SeedPoolResult (used to overlay the worker results onto the
 *  controller's batch report). */
export function summaryFromResults(results: SeedPoolResult[]) {
  const pops = results.map(r => r.population);
  const temps = results.map(r => r.meanTemperatureK);
  const lins = results.map(r => r.activeLineages);
  return {
    population: computeStatSummary(pops),
    meanTemperatureK: computeStatSummary(temps),
    activeLineages: computeStatSummary(lins),
  };
}

export function computeStatSummary(xs: number[]) {
  if (xs.length === 0) return { n: 0, mean: 0, std: 0, min: 0, p5: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return {
    n, mean, std: Math.sqrt(variance), min: sorted[0]!, max: sorted[n - 1]!,
    p5: q(sorted, 0.05), p50: q(sorted, 0.5), p95: q(sorted, 0.95),
  };
}

export function q(sortedXs: number[], p: number): number {
  const n = sortedXs.length;
  if (n === 0) return 0;
  if (n === 1) return sortedXs[0]!;
  const pos = p * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedXs[lo]!;
  const t = pos - lo;
  return sortedXs[lo]! + t * (sortedXs[hi]! - sortedXs[lo]!);
}
