import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __handlers, type __InternalHandlerContext, type Reply } from '../src/workers/controller.ts';
import { getScenario } from '../src/scenarios/catalog.ts';
import { initializeWorld } from '../src/simulation/core/initialize.ts';
import { ExperimentBook } from '../src/experiments/book.ts';

// === Test harness ====================================================

/**
 * Build a controller-state-shaped object that handlers can read/write.
 * Backed by a real `ExperimentBook` so `state`, `history`, and `book`
 * remain consistent. The closure fields are simple `let`s the handlers
 * mutate via `setBook` / `setRunning` / `setEvent` etc.
 *
 * Exported (under the `__` prefix) so other test files can build a
 * harness without duplicating the wiring.
 */
export async function makeCtx(seed = 'handler-test'): Promise<__InternalHandlerContext & { _replies: Reply[]; _running: () => boolean; _target: () => number; _event: () => string; _book: () => ExperimentBook | null }> {
  const scenario = getScenario('two-lineages', 320);
  scenario.seed = seed;
  const world = await initializeWorld(scenario);
  const book = await ExperimentBook.create(world);
  const state = { _replies: [] as Reply[], _running: false, _target: 0, _event: '', _book: book as ExperimentBook | null };
  return {
    get book() { return state._book; },
    get history() { return state._book?.active ?? null; },
    get state() { return state._book?.active.state ?? null; },
    get generation() { return 0; },
    pause: () => { state._running = false; },
    publish: () => { state._replies.push({ id: 0, type: 'projection', payload: {} as never }); },
    emit: (reply: Reply) => { state._replies.push(reply); },
    setBook: (b: ExperimentBook) => { state._book = b; },
    setTarget: (n: number) => { state._target = n; },
    setRunning: (b: boolean) => { state._running = b; },
    setEvent: (s: string) => { state._event = s; },
    isRunning: () => state._running,
    getTarget: () => state._target,
    sinceEmit: () => 0,
    schedule: () => {},
    addExternalEnergy: (_j: number) => { /* no-op for unit tests */ },
    addExternalMatter: (_mu: number) => { /* no-op for unit tests */ },
    consumeExternalEnergy: (_j: number) => { /* no-op for unit tests */ },
    setLedgerEnergy: (_j: number) => { /* no-op for unit tests */ },
    cosmicStepEvery: 1000,
    planetFraction: 1e-27,
    maxEnergyPerTickJ: 1e22,
    solarToMu: 1e6,
    lastCosmicTick: 0,
    markCosmicTick: (_tick: number) => { /* no-op for unit tests */ },
    setChemistry: (_c) => { /* no-op for unit tests */ },
    setColonies: (_r) => { /* no-op for unit tests */ },
    setCognition: (_c) => { /* no-op for unit tests */ },
    setSettlement: (_s) => { /* no-op for unit tests */ },
    setEarthData: (_e) => { /* no-op for unit tests */ },
    setEarthCalibration: (_c) => { /* no-op for unit tests */ },
    pushBatch: (_b) => { /* no-op for unit tests */ },
    setBatchCalibration: (_c) => { /* no-op for unit tests */ },
    setV14Snapshot: (snap: import('../src/simulation/visual/types.ts').V14Snapshot, makeActive: boolean) => {
      if (state._book) state._book.pushSnapshot(snap, makeActive);
    },
    setV14Active: (id: string) => {
      if (state._book) state._book.selectSnapshot(id);
    },
    removeV14Snapshot: (id: string) => {
      if (state._book) state._book.removeSnapshot(id);
    },
    renameV14Snapshot: (id: string, label: string) => {
      if (state._book) state._book.renameSnapshot(id, label);
    },
    pushV14Batch: (snaps: import('../src/simulation/visual/types.ts').V14Snapshot[]) => {
      if (state._book) for (const s of snaps) state._book.v14Snapshots.push(s);
    },
    _replies: state._replies,
    _running: () => state._running,
    _target: () => state._target,
    _event: () => state._event,
    _book: () => state._book,
  };
}

// === Handler-level tests =============================================

test('handlePause emits ack and a projection', async () => {
  const ctx = await makeCtx();
  await __handlers.pause({}, ctx, 1);
  const types = ctx._replies.map((r: Reply) => r.type);
  assert.ok(types.includes('projection'));
  assert.ok(types.includes('ack'));
});

test('handleCreate with default params succeeds and emits ack', async () => {
  const ctx = await makeCtx();
  await __handlers.create({}, ctx, 2);
  assert.equal(ctx._replies.at(-1)?.type, 'ack');
  assert.ok(ctx.book, 'create should set the book');
  assert.equal(ctx.state?.tick, 0);
});

test('handleCreate rejects invalid cell count', async () => {
  const ctx = await makeCtx();
  await assert.rejects(
    __handlers.create({ cells: 9999 }, ctx, 3),
    /无效观察精度/,
  );
});

test('handleRun validates tick range and updates target', async () => {
  const ctx = await makeCtx();
  await __handlers.run({ ticks: 50 }, ctx, 4);
  assert.equal(ctx._target(), 50);
  assert.equal(ctx.isRunning(), true);
  assert.equal(ctx._replies.at(-1)?.type, 'ack');
  await assert.rejects(__handlers.run({ ticks: 0 }, ctx, 5), /推进天数/);
  await assert.rejects(__handlers.run({ ticks: 200_000 }, ctx, 6), /推进天数/);
});

test('handleStep advances exactly one tick and updates event', async () => {
  const ctx = await makeCtx();
  await __handlers.step({}, ctx, 7);
  assert.equal(ctx.state?.tick, 1);
  assert.match(ctx._event(), /第 1 日/);
});

test('handleInspect requires a valid cell and emits inspection reply', async () => {
  const ctx = await makeCtx();
  await __handlers.inspect({ cell: 0 }, ctx, 8);
  const last = ctx._replies.at(-1);
  assert.equal(last?.type, 'inspection');
  if (last?.type === 'inspection') {
    assert.equal(last.payload.cell, 0);
    assert.ok(last.payload.cohorts.length > 0, '320-cell two-lineages fixture has cohorts at cell 0');
  }
  await assert.rejects(__handlers.inspect({ cell: 9999 }, ctx, 9), /无效地表单元/);
  await assert.rejects(__handlers.inspect({ cell: 'oops' }, ctx, 10), /无效地表单元/);
});

test('handleInspect does not require a book (reads from state) and tolerates typed-array undefined via ?? 0', async () => {
  // Even when ctx.history is technically null (no book), inspect fails before
  // touching TypedArrays — it short-circuits on the `!s` check. This guards
  // against the regression where we used TypedArray[i] without `?? 0`.
  const ctx = await makeCtx();
  // Force a corrupted-looking cell to make sure the display-time guards fire
  // only on valid (in-range) cells, otherwise inspect refuses first.
  await assert.rejects(
    __handlers.inspect({ cell: -1 }, ctx, 11),
    /无效地表单元/,
  );
});

test('handleSnapshot emits the serialized state', async () => {
  const ctx = await makeCtx();
  await __handlers.snapshot({}, ctx, 12);
  const last = ctx._replies.at(-1);
  assert.equal(last?.type, 'snapshot');
  if (last?.type === 'snapshot') {
    // canonicalJson wraps the envelope; assert on `format` rather than the prefix.
    assert.match(last.payload, /"format":"my-universe-state"/);
  }
});

test('handleInternalTick on a non-running controller is a no-op', async () => {
  const ctx = await makeCtx();
  const before = ctx.state?.tick ?? -1;
  await __handlers.internalTick({ generation: 0 }, ctx, 13);
  assert.equal(ctx.state?.tick, before, 'no advance when not running');
});

test('handleFork requires a fresh branch id and label', async () => {
  const ctx = await makeCtx();
  await assert.rejects(
    __handlers.fork({ id: 123, label: 456 }, ctx, 14),
    /无效分支/,
  );
  await __handlers.fork({ id: 'branch-x', label: '实验' }, ctx, 15);
  assert.match(ctx._event(), /复制世界/);
});
