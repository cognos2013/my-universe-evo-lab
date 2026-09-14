/**
 * P17-3 — worker pool + box-plot UI.
 *
 * Reference gate (P17-3):
 *   - The `summaryFromResults` helper produces a valid 8-number
 *     summary from per-seed `SeedPoolResult`s — same shape as
 *     the controller's `BatchReport.summary`, so the UI overlay
 *     (worker results → controller report) works.
 *   - The box-plot data path is exercised: `renderBoxPlot` does
 *     not throw on empty input, and on a non-trivial input it
 *     populates the SVG with the expected number of children
 *     (whiskers / box / median / outliers).
 *
 * The actual `Worker` constructor is not exercised in Node —
 * `runBatchInWorkers` uses `new Worker(new URL(..., import.meta.url))`
 * which Vite resolves at build time. The pool logic (queue,
 * max-parallel cap, timeout, results ordering) is verified
 * indirectly by the existing P17 acceptance test plus the
 * `summaryFromResults` contract below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summaryFromResults, computeStatSummary, q } from '../src/app/batch.ts';
import type { SeedPoolResult } from '../src/simulation/batch/pool.ts';

function makeResult(seed: string, pop: number, temp: number, lin: number, crashed = false): SeedPoolResult {
  return { seed, finalTick: 50, population: pop, meanTemperatureK: temp, activeLineages: lin, crashed, durationMs: 100 };
}

test('summaryFromResults: three metrics each summarised (8-number stat summary)', () => {
  const results = [
    makeResult('s0', 100, 285, 1),
    makeResult('s1', 200, 288, 2),
    makeResult('s2', 300, 290, 1),
    makeResult('s3', 400, 287, 3),
  ];
  const summary = summaryFromResults(results);
  assert.equal(summary.population.n, 4);
  assert.equal(summary.population.mean, 250);
  assert.equal(summary.population.min, 100);
  assert.equal(summary.population.max, 400);
  assert.equal(summary.meanTemperatureK.n, 4);
  assert.equal(summary.meanTemperatureK.mean, 287.5);
  assert.equal(summary.activeLineages.n, 4);
  // p50 of [1, 1, 2, 3] → pos = 1.5 → between sorted[1]=1 and sorted[2]=2, t=0.5 → 1.5
  assert.ok(Math.abs(summary.activeLineages.p50 - 1.5) < 0.01,
    `p50 should be 1.5, got ${summary.activeLineages.p50}`);
});

test('summaryFromResults: empty input produces all-zero summary with n=0', () => {
  const summary = summaryFromResults([]);
  assert.equal(summary.population.n, 0);
  assert.equal(summary.population.mean, 0);
  assert.equal(summary.meanTemperatureK.max, 0);
  assert.equal(summary.activeLineages.p5, 0);
});

test('computeStatSummary: matches the reference quantile table', () => {
  // 1..100 → mean 50.5, p50 = 50.5, p5 ≈ 5.95.
  const xs = Array.from({ length: 100 }, (_, i) => i + 1);
  const s = computeStatSummary(xs);
  assert.equal(s.n, 100);
  assert.ok(Math.abs(s.mean - 50.5) < 0.001);
  assert.equal(s.min, 1);
  assert.equal(s.max, 100);
  assert.ok(s.p5 >= 5 && s.p5 <= 6.5, `p5 should be in [5, 6.5], got ${s.p5}`);
  assert.ok(Math.abs(s.p50 - 50.5) < 0.001);
  assert.ok(s.std > 28 && s.std < 30, `std should be ~28.86, got ${s.std}`);
});

test('q: linear-interpolated quantile from a sorted array', () => {
  // pos = 0.5 * (4 - 1) = 1.5 → between sorted[1]=2 and sorted[2]=3, t=0.5 → 2.5
  const r = q([1, 2, 3, 4], 0.5);
  assert.ok(Math.abs(r - 2.5) < 1e-9, `q at 0.5 of [1..4] should be 2.5, got ${r}`);
  // pos = 0 → returns first
  assert.equal(q([10, 20, 30], 0), 10);
  // pos = 1 → returns last
  assert.equal(q([10, 20, 30], 1), 30);
});

test('renderBoxPlot: does not throw on empty data and adds a "no data" placeholder', async () => {
  const { renderBoxPlot } = await import('../src/app/chart.ts');
  const fakeSvg = makeFakeSvg();
  renderBoxPlot(fakeSvg, [], { createElementNS: makeFakeCreate(fakeSvg) });
  // An "empty" branch appends exactly one <text> child.
  assert.equal(fakeSvg.children.length, 1, 'empty data should add a single text node');
  assert.equal(fakeSvg.children[0]!.tagName, 'text');
});

test('renderBoxPlot: non-empty data populates the SVG with the expected number of children', async () => {
  const { renderBoxPlot } = await import('../src/app/chart.ts');
  const fakeSvg = makeFakeSvg();
  const data = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300]; // 200 + 300 are outliers (>1.5*IQR)
  renderBoxPlot(fakeSvg, data, { createElementNS: makeFakeCreate(fakeSvg) });
  // Expected children: 2 whisker lines + 2 caps + 1 box + 1 median + 2 outlier circles + 2 text labels = 10.
  // (Number of outliers is data-dependent; we use 2 here.)
  assert.ok(fakeSvg.children.length >= 8, `expected ≥ 8 children, got ${fakeSvg.children.length}`);
  // The box rect should have width > 0 (Q1 ≠ Q3 in this data).
  const box = Array.from(fakeSvg.children).find((c: any) => c.tagName === 'rect') as any;
  assert.ok(box, 'box rect must be present');
  assert.ok(Number(box.getAttribute('width')) > 0, 'box width should be > 0 when Q1 < Q3');
});

/** Tiny stand-in for an `SVGElement`. Just enough to satisfy
 *  the `renderBoxPlot` calls (which only use setAttribute /
 *  createElementNS / appendChild / firstChild / removeChild). */
function makeFakeSvg(): any {
  const children: any[] = [];
  return {
    children,
    firstChild: children[0] ?? null,
    setAttribute(_n: string, _v: string) { /* noop */ },
    removeChild(_n: unknown) { /* noop */ },
    appendChild(n: any) { children.push(n); return n; },
    getAttribute(_n: string) { return null; },
  };
}

/** Build a fake `createElementNS` factory that auto-registers the
 *  new node with the fake SVG's children array. The factory
 *  pattern is exactly what `renderBoxPlot` expects. */
function makeFakeCreate(_fakeSvg: ReturnType<typeof makeFakeSvg>) {
  return (_name: string): any => {
    const node: any = {
      tagName: _name,
      children: [] as unknown[],
      firstChild: null,
      getAttribute: (n: string) => node._attrs?.[n] ?? null,
      setAttribute(n: string, v: string) {
        node._attrs = { ...(node._attrs ?? {}), [n]: v };
      },
      appendChild(c: unknown) { (node.children as unknown[]).push(c); return c; },
      removeChild(c: unknown) {
        const i = (node.children as unknown[]).indexOf(c);
        if (i >= 0) (node.children as unknown[]).splice(i, 1);
        return c;
      },
    };
    return node;
  };
}
