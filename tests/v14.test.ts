/**
 * V14-2 visual route tests.
 *
 * The V14 route (per docs/04) is the World Labs / Marble / Atlas /
 * Spark integration. Phase 1 shipped an in-repo procedural backend
 * with 5 kinds; phase 2 (this round) adds:
 *
 *  - persistent snapshot list (book.v14Snapshots[] + v14ActiveId)
 *  - v14Generate handler pushes a new snapshot and makes it active
 *  - v14Select / v14Delete / v14Rename handlers (book ↔ projection)
 *  - book round-trips the list through export/import (legacy
 *    v14-1 single-result archives migrate to a one-snapshot list)
 *  - controller projection carries `{ snapshots, activeId }`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld, resolveBackend } from '../src/simulation/visual/router.ts';
import { inRepoBackend } from '../src/simulation/visual/inRepo.ts';
import { worldLabsBackend, atlasBackend, sparkBackend } from '../src/simulation/visual/worldLabs.ts';
import { validateV14Spec, ALL_PROCEDURAL_KINDS, makeV14Snapshot, type V14Snapshot, type V14WorldResult, type V14WorldSpec } from '../src/simulation/visual/types.ts';
import { __handlers } from '../src/workers/controller.ts';
import { makeCtx } from './handlers.test.ts';

function meshOk(r: V14WorldResult): void {
  assert.equal(r.backend, 'inRepo');
  assert.equal(typeof r.sourceLabel, 'string');
  assert.ok(r.sourceLabel.length > 0, 'sourceLabel must be non-empty');
  assert.equal(r.colors.length, r.vertices.length, 'colors / vertices length match');
  assert.equal(r.indices.length % 3, 0, 'indices count is multiple of 3');
  assert.ok(r.indices.length > 0, 'must have at least one triangle');
  assert.ok(r.boundingRadius > 0, 'bounding radius must be > 0');
  assert.ok(r.durationMs >= 0, 'durationMs must be >= 0');
  const vertCount = r.vertices.length / 3;
  for (let i = 0; i < r.indices.length; i++) {
    assert.ok(r.indices[i]! < vertCount, `indices[${i}] out of range`);
  }
  for (let i = 0; i < r.colors.length; i++) {
    const c = r.colors[i]!;
    assert.ok(c >= 0 && c <= 1, `colors[${i}] out of [0,1]: ${c}`);
  }
}

test('validateV14Spec accepts the 5 procedural kinds', () => {
  for (const kind of ALL_PROCEDURAL_KINDS) {
    const s: V14WorldSpec = { prompt: 'demo', kind, resolution: 32, style: 'smooth' };
    assert.doesNotThrow(() => validateV14Spec(s), `kind=${kind}`);
  }
});

test('validateV14Spec rejects unknown kind', () => {
  assert.throws(() => validateV14Spec({ prompt: 'demo', kind: 'spaceship', resolution: 32, style: 'smooth' }), /kind/);
});

test('validateV14Spec rejects resolution out of [4, 256]', () => {
  assert.throws(() => validateV14Spec({ prompt: 'demo', kind: 'terrain', resolution: 1, style: 'smooth' }), /resolution/);
  assert.throws(() => validateV14Spec({ prompt: 'demo', kind: 'terrain', resolution: 999, style: 'smooth' }), /resolution/);
  assert.throws(() => validateV14Spec({ prompt: 'demo', kind: 'terrain', resolution: 12.5, style: 'smooth' }), /resolution/);
});

test('validateV14Spec rejects unknown style', () => {
  assert.throws(() => validateV14Spec({ prompt: 'demo', kind: 'terrain', resolution: 32, style: 'plasma' }), /style/);
});

test('ALL_PROCEDURAL_KINDS has 6 entries (cityscape added in V14-4)', () => {
  assert.equal(ALL_PROCEDURAL_KINDS.length, 6);
  assert.ok(ALL_PROCEDURAL_KINDS.includes('cityscape'));
});

test('inRepoBackend generates a valid mesh for terrain', async () => {
  const r = await inRepoBackend.generate({ prompt: 'coast', kind: 'terrain', resolution: 16, style: 'smooth', seed: 't1' });
  meshOk(r);
  assert.equal(r.indices.length, 1350);
  assert.equal(r.vertices.length / 3, 16 * 16);
});

test('inRepoBackend is deterministic for the same seed', async () => {
  const a = await inRepoBackend.generate({ prompt: 'a', kind: 'terrain', resolution: 16, style: 'smooth', seed: 'same' });
  const b = await inRepoBackend.generate({ prompt: 'a', kind: 'terrain', resolution: 16, style: 'smooth', seed: 'same' });
  for (let i = 0; i < a.vertices.length; i++) {
    assert.equal(a.vertices[i], b.vertices[i]);
  }
});

test('inRepoBackend different seeds produce different meshes', async () => {
  const a = await inRepoBackend.generate({ prompt: 'a', kind: 'terrain', resolution: 24, style: 'rocky', seed: 'seed-a' });
  const b = await inRepoBackend.generate({ prompt: 'a', kind: 'terrain', resolution: 24, style: 'rocky', seed: 'seed-b' });
  let anyDiff = false;
  for (let i = 0; i < a.vertices.length; i++) {
    if (a.vertices[i] !== b.vertices[i]) { anyDiff = true; break; }
  }
  assert.ok(anyDiff, 'different seeds should produce different vertex data');
});

test('resolveBackend defaults to inRepo for unknown backends', () => {
  assert.equal(resolveBackend('mystery').kind, 'inRepo');
  assert.equal(resolveBackend(undefined).kind, 'inRepo');
});

test('worldLabsBackend / atlasBackend / sparkBackend throw with honest API-key message', async () => {
  for (const backend of [worldLabsBackend, atlasBackend, sparkBackend]) {
    await assert.rejects(
      () => backend.generate({ prompt: 'demo', kind: 'terrain', resolution: 16, style: 'smooth', seed: 'x' }),
      /API key.*commercial|commercial.*API key/i,
    );
  }
});

test('generateWorld (router) routes to the requested backend', async () => {
  const inRepoResult = await generateWorld({ prompt: 'demo', kind: 'terrain', resolution: 16, style: 'smooth', seed: 'r1' });
  assert.equal(inRepoResult.backend, 'inRepo');
  await assert.rejects(
    () => generateWorld({ prompt: 'demo', kind: 'terrain', resolution: 16, style: 'smooth', seed: 'r1' }, { backend: 'worldLabs' }),
    /API key/i,
  );
});

// === V14-2 controller + book integration ==============================

test('handleV14Generate: pushes a new snapshot and makes it active', async () => {
  const ctx = await makeCtx();
  await __handlers.v14Generate({ prompt: 'coast', kind: 'terrain', resolution: 16, style: 'smooth', seed: 'v14-h1' }, ctx, 1);
  // Book must carry the snapshot list.
  assert.equal(ctx.book?.v14Snapshots.length, 1);
  const snap = ctx.book!.v14Snapshots[0]!;
  assert.equal(snap.spec.kind, 'terrain');
  assert.equal(snap.spec.seed, 'v14-h1');
  assert.equal(snap.backend, 'inRepo');
  assert.equal(snap.vertices.length, 16 * 16 * 3);
  assert.equal(ctx.book?.v14ActiveId, snap.id);
  // The v14 reply carries the new snapshot.
  const v14Reply = ctx._replies.find((r) => r.type === 'v14');
  assert.ok(v14Reply);
  const payload = (v14Reply as { type: 'v14'; payload: { snapshot: V14Snapshot; activeId: string | null } }).payload;
  assert.equal(payload.snapshot.id, snap.id);
  assert.equal(payload.activeId, snap.id);
});

test('handleV14Generate: two calls produce two snapshots; the second becomes active', async () => {
  const ctx = await makeCtx();
  await __handlers.v14Generate({ prompt: 'a', kind: 'terrain', resolution: 16, style: 'smooth', seed: 's1' }, ctx, 1);
  const firstId = ctx.book!.v14ActiveId;
  await __handlers.v14Generate({ prompt: 'b', kind: 'rock', resolution: 16, style: 'rocky', seed: 's2' }, ctx, 2);
  assert.equal(ctx.book!.v14Snapshots.length, 2);
  assert.notEqual(ctx.book!.v14ActiveId, firstId, 'active should rotate to the new snapshot');
  assert.equal(ctx.book!.v14Snapshots.find((s) => s.id === firstId)?.spec.kind, 'terrain');
  assert.equal(ctx.book!.v14Snapshots.find((s) => s.id === ctx.book!.v14ActiveId)?.spec.kind, 'rock');
});

test('handleV14Generate: keepActive: false does not change the active pointer', async () => {
  const ctx = await makeCtx();
  await __handlers.v14Generate({ prompt: 'a', kind: 'terrain', resolution: 16, style: 'smooth', seed: 's1' }, ctx, 1);
  const originalActive = ctx.book!.v14ActiveId;
  await __handlers.v14Generate({ prompt: 'b', kind: 'rock', resolution: 16, style: 'rocky', seed: 's2', keepActive: false }, ctx, 2);
  assert.equal(ctx.book!.v14ActiveId, originalActive, 'active should NOT change with keepActive: false');
  assert.equal(ctx.book!.v14Snapshots.length, 2);
});

test('handleV14Select: switches the active snapshot by id', async () => {
  const ctx = await makeCtx();
  await __handlers.v14Generate({ prompt: 'a', kind: 'terrain', resolution: 16, style: 'smooth', seed: 's1' }, ctx, 1);
  const first = ctx.book!.v14ActiveId;
  await __handlers.v14Generate({ prompt: 'b', kind: 'rock', resolution: 16, style: 'rocky', seed: 's2' }, ctx, 2);
  await __handlers.v14Select({ id: first }, ctx, 3);
  assert.equal(ctx.book!.v14ActiveId, first);
  // v14List reply must reflect the new state.
  const listReply = ctx._replies.filter((r) => r.type === 'v14List').at(-1) as { type: 'v14List'; payload: { snapshots: unknown[]; activeId: string | null } } | undefined;
  assert.ok(listReply);
  assert.equal(listReply.payload.activeId, first);
  assert.equal(listReply.payload.snapshots.length, 2);
});

test('handleV14Select: rejects unknown id', async () => {
  const ctx = await makeCtx();
  await assert.rejects(
    __handlers.v14Select({ id: 'no-such-id' }, ctx, 1),
    /snapshot 不存在|无效 V14 snapshot id/,
  );
});

test('handleV14Delete: removes a snapshot and rotates the active pointer', async () => {
  const ctx = await makeCtx();
  await __handlers.v14Generate({ prompt: 'a', kind: 'terrain', resolution: 16, style: 'smooth', seed: 's1' }, ctx, 1);
  const first = ctx.book!.v14ActiveId;
  await __handlers.v14Generate({ prompt: 'b', kind: 'rock', resolution: 16, style: 'rocky', seed: 's2' }, ctx, 2);
  await __handlers.v14Delete({ id: first }, ctx, 3);
  assert.equal(ctx.book!.v14Snapshots.length, 1);
  assert.notEqual(ctx.book!.v14ActiveId, first);
  assert.equal(ctx.book!.v14ActiveId, ctx.book!.v14Snapshots[0]!.id);
});

test('handleV14Delete: removing the last snapshot clears the active pointer', async () => {
  const ctx = await makeCtx();
  await __handlers.v14Generate({ prompt: 'a', kind: 'terrain', resolution: 16, style: 'smooth', seed: 's1' }, ctx, 1);
  const id = ctx.book!.v14ActiveId!;
  await __handlers.v14Delete({ id }, ctx, 2);
  assert.equal(ctx.book!.v14Snapshots.length, 0);
  assert.equal(ctx.book!.v14ActiveId, null);
  // Convenience getters must return null.
  assert.equal(ctx.book!.v14Spec, null);
  assert.equal(ctx.book!.v14Result, null);
});

test('handleV14Delete: rejects unknown id', async () => {
  const ctx = await makeCtx();
  await __handlers.v14Generate({ prompt: 'a', kind: 'terrain', resolution: 16, style: 'smooth', seed: 's1' }, ctx, 1);
  await assert.rejects(
    __handlers.v14Delete({ id: 'no-such-id' }, ctx, 2),
    /snapshot 不存在/,
  );
});

test('handleV14Rename: relabels a snapshot in place', async () => {
  const ctx = await makeCtx();
  await __handlers.v14Generate({ prompt: 'a', kind: 'terrain', resolution: 16, style: 'smooth', seed: 's1' }, ctx, 1);
  const id = ctx.book!.v14ActiveId!;
  await __handlers.v14Rename({ id, label: 'first coastline' }, ctx, 2);
  assert.equal(ctx.book!.v14Snapshots[0]!.label, 'first coastline');
});

test('handleV14Rename: rejects empty / over-long labels', async () => {
  const ctx = await makeCtx();
  await __handlers.v14Generate({ prompt: 'a', kind: 'terrain', resolution: 16, style: 'smooth', seed: 's1' }, ctx, 1);
  const id = ctx.book!.v14ActiveId!;
  await assert.rejects(__handlers.v14Rename({ id, label: '   ' }, ctx, 2), /不能为空/);
  await assert.rejects(__handlers.v14Rename({ id, label: 'x'.repeat(200) }, ctx, 3), /不能为空|80/);
});

test('handleV14Generate: rejects invalid spec / unknown backend / worldLabs', async () => {
  const ctx = await makeCtx();
  await assert.rejects(
    __handlers.v14Generate({ prompt: 'demo', kind: 'spaceship', resolution: 16, style: 'smooth' }, ctx, 1),
    /kind/,
  );
  await assert.rejects(
    __handlers.v14Generate({ prompt: 'demo', kind: 'terrain', resolution: 1, style: 'smooth' }, ctx, 2),
    /resolution/,
  );
  await assert.rejects(
    __handlers.v14Generate({ prompt: 'demo', kind: 'terrain', resolution: 16, style: 'smooth', backend: 'mystery' }, ctx, 3),
    /V14 backend/,
  );
  await assert.rejects(
    __handlers.v14Generate({ prompt: 'demo', kind: 'terrain', resolution: 16, style: 'smooth', backend: 'worldLabs' }, ctx, 4),
    /API key/i,
  );
});

test('handleV14Generate: 5 kinds all produce non-empty snapshots via the controller', async () => {
  for (const kind of ALL_PROCEDURAL_KINDS) {
    const ctx = await makeCtx();
    await __handlers.v14Generate({ prompt: kind, kind, resolution: 16, style: 'smooth', seed: `k-${kind}` }, ctx, 1);
    const reply = ctx._replies.find((r) => r.type === 'v14');
    assert.ok(reply, `kind=${kind} should produce a v14 reply`);
    const payload = (reply as { type: 'v14'; payload: { snapshot: V14Snapshot; activeId: string | null } }).payload;
    assert.ok(payload.snapshot.indices.length > 0, `kind=${kind} has zero indices`);
  }
});

test('ExperimentBook round-trips the v14 snapshot list through export / import', async () => {
  const ctx = await makeCtx();
  await __handlers.v14Generate({ prompt: 'a', kind: 'tree', resolution: 16, style: 'organic', seed: 'exp-1' }, ctx, 1);
  await __handlers.v14Generate({ prompt: 'b', kind: 'rock', resolution: 16, style: 'rocky', seed: 'exp-2' }, ctx, 2);
  await __handlers.v14Select({ id: ctx.book!.v14Snapshots[0]!.id }, ctx, 3);
  const exported = await ctx.book!.export();
  const { ExperimentBook } = await import('../src/experiments/book.ts');
  const restored = await ExperimentBook.import(exported);
  assert.equal(restored.v14Snapshots.length, 2);
  assert.equal(restored.v14ActiveId, ctx.book!.v14Snapshots[0]!.id);
  // Mesh data must round-trip (typed arrays re-instantiated).
  for (let i = 0; i < restored.v14Snapshots.length; i++) {
    const orig = ctx.book!.v14Snapshots[i]!;
    const back = restored.v14Snapshots[i]!;
    assert.equal(back.vertices.length, orig.vertices.length, `snap[${i}].vertices length`);
    assert.equal(back.indices.length, orig.indices.length, `snap[${i}].indices length`);
    assert.equal(back.spec.kind, orig.spec.kind);
  }
  // Convenience getter mirrors the active snapshot.
  assert.equal(restored.v14Spec?.kind, ctx.book!.v14Snapshots[0]!.spec.kind);
  assert.equal(restored.v14Result?.vertices.length, ctx.book!.v14Snapshots[0]!.vertices.length);
});

test('ExperimentBook imports legacy v14-1 archives as a one-snapshot list', async () => {
  // Build a v14-1 archive by taking a v14-2 export and stripping
  // the v14Snapshots / v14ActiveId fields. The import side must
  // migrate the legacy single-result triple to a one-snapshot
  // list so the rest of the pipeline only has to know about the
  // list shape.
  const r = await inRepoBackend.generate({ prompt: 'legacy', kind: 'terrain', resolution: 8, style: 'smooth', seed: 'l' });
  const [{ ExperimentBook }, { getScenario }, { initializeWorld }] = await Promise.all([
    import('../src/experiments/book.ts'),
    import('../src/scenarios/catalog.ts'),
    import('../src/simulation/core/initialize.ts'),
  ]);
  const seedBook = await ExperimentBook.create(await initializeWorld(getScenario('empty-planet', 320)));
  seedBook.pushSnapshot(makeV14Snapshot({
    id: 'legacy-x',
    spec: { prompt: 'legacy', kind: 'terrain', resolution: 8, style: 'smooth', seed: 'l' },
    result: r,
    tick: 0,
    branch: 'main',
  }));
  const v2Json = await seedBook.export();
  const v1Json = v2Json.replace(/"v14Snapshots":\[[^\]]*\],"v14ActiveId":"[^"]*"/, '');
  // Round-trip: import the legacy blob.
  const restored = await ExperimentBook.import(v1Json);
  assert.equal(restored.v14Snapshots.length, 1);
  assert.equal(restored.v14ActiveId, restored.v14Snapshots[0]!.id);
  assert.equal(restored.v14Spec?.kind, 'terrain');
  assert.equal(restored.v14Result?.vertices.length, r.vertices.length);
});

// === V14-3 batch scan (G) + cross-branch (F) ==========================

test('handleV14BatchScan: pushes N×K×S snapshots and returns a v14Batch reply with histograms', async () => {
  const ctx = await makeCtx();
  const before = ctx.book!.v14Snapshots.length;
  await __handlers.v14BatchScan({
    prompt: 'batch-test',
    seeds: [0, 1, 2],
    kinds: ['terrain', 'rock'],
    styles: ['smooth', 'rocky'],
    resolution: 16,
  }, ctx, 1);
  const expectedNew = 3 * 2 * 2; // 12
  assert.equal(ctx.book!.v14Snapshots.length, before + expectedNew, 'should append 12 new snapshots');
  // The active pointer should NOT change after a batch scan.
  assert.equal(ctx.book!.v14ActiveId, null, 'no snapshot was active before, and the batch must not change that');
  // The v14Batch reply must carry a report.
  const batchReply = ctx._replies.find((r) => r.type === 'v14Batch');
  assert.ok(batchReply, 'must emit a v14Batch reply');
  const payload = (batchReply as { type: 'v14Batch'; payload: { report: import('../src/simulation/visual/types.ts').V14BatchReport; snapshots: unknown[]; activeId: string | null } }).payload;
  assert.equal(payload.report.totalRuns, expectedNew);
  // Per-kind counts must sum to total.
  const perKindSum = Object.values(payload.report.perKind).reduce((s, n) => s + n, 0);
  assert.equal(perKindSum, expectedNew, 'perKind counts must sum to total');
  // Per-style counts must sum to total.
  const perStyleSum = Object.values(payload.report.perStyle).reduce((s, n) => s + n, 0);
  assert.equal(perStyleSum, expectedNew);
  // Histograms must have positive counts summing to total.
  const vertSum = payload.report.vertexHistogram.reduce((s, b) => s + b.count, 0);
  assert.equal(vertSum, expectedNew, 'vertex histogram must sum to total');
  const durSum = payload.report.durationHistogram.reduce((s, b) => s + b.count, 0);
  assert.equal(durSum, expectedNew);
  // Each run's snapshot id appears in report.snapshotIds.
  assert.equal(payload.report.snapshotIds.length, expectedNew);
  // The book snapshots list must include all those ids.
  const bookIds = new Set(ctx.book!.v14Snapshots.map((s) => s.id));
  for (const id of payload.report.snapshotIds) {
    assert.ok(bookIds.has(id), `book must contain snapshot id ${id}`);
  }
});

test('handleV14BatchScan: rejects out-of-range parameters', async () => {
  const ctx = await makeCtx();
  await assert.rejects(
    __handlers.v14BatchScan({ seeds: [], kinds: ['terrain'], styles: ['smooth'], resolution: 16 }, ctx, 1),
    /seeds/,
  );
  await assert.rejects(
    __handlers.v14BatchScan({ seeds: [0], kinds: ['spaceship'], styles: ['smooth'], resolution: 16 }, ctx, 2),
    /kinds/,
  );
  await assert.rejects(
    __handlers.v14BatchScan({ seeds: [0], kinds: ['terrain'], styles: ['plasma'], resolution: 16 }, ctx, 3),
    /styles/,
  );
  await assert.rejects(
    __handlers.v14BatchScan({ seeds: [0], kinds: ['terrain'], styles: ['smooth'], resolution: 999 }, ctx, 4),
    /resolution/,
  );
  await assert.rejects(
    __handlers.v14BatchScan({ seeds: Array.from({ length: 17 }, (_, i) => i), kinds: ['terrain'], styles: ['smooth'], resolution: 16 }, ctx, 5),
    /seeds/,
  );
});

test('handleV14BatchScan: labelPrefix is reflected in the snapshot labels', async () => {
  const ctx = await makeCtx();
  await __handlers.v14BatchScan({
    seeds: [0],
    kinds: ['terrain'],
    styles: ['smooth'],
    resolution: 16,
    labelPrefix: 'scanA',
  }, ctx, 1);
  const labels = ctx.book!.v14Snapshots.map((s) => s.label);
  assert.ok(labels.some((l) => l.startsWith('scanA ')), `at least one label should start with "scanA"; got ${JSON.stringify(labels)}`);
});

test('Cross-branch (F): snapshots created on different branches are listed together', async () => {
  const ctx = await makeCtx();
  // Simulate two fork branches by directly appending snapshots
  // with different createdAtBranch values (the controller is
  // single-branch, so we set the field via the snapshot
  // factory).
  const r1 = await inRepoBackend.generate({ prompt: 'main-coast', kind: 'terrain', resolution: 16, style: 'smooth', seed: 'main' });
  const r2 = await inRepoBackend.generate({ prompt: 'fork-coast', kind: 'terrain', resolution: 16, style: 'rocky', seed: 'fork' });
  const r3 = await inRepoBackend.generate({ prompt: 'fork2-coast', kind: 'rock', resolution: 16, style: 'rocky', seed: 'fork2' });
  ctx.book!.pushSnapshot(makeV14Snapshot({ id: 's1', spec: { prompt: 'main-coast', kind: 'terrain', resolution: 16, style: 'smooth', seed: 'main' }, result: r1, tick: 100, branch: 'main' }), true);
  ctx.book!.pushSnapshot(makeV14Snapshot({ id: 's2', spec: { prompt: 'fork-coast', kind: 'terrain', resolution: 16, style: 'rocky', seed: 'fork' }, result: r2, tick: 250, branch: 'fork-a' }), false);
  ctx.book!.pushSnapshot(makeV14Snapshot({ id: 's3', spec: { prompt: 'fork2-coast', kind: 'rock', resolution: 16, style: 'rocky', seed: 'fork2' }, result: r3, tick: 400, branch: 'fork-b' }), false);
  // The list should contain all 3 snapshots and span 3 branches.
  assert.equal(ctx.book!.v14Snapshots.length, 3);
  const branches = new Set(ctx.book!.v14Snapshots.map((s) => s.createdAtBranch));
  assert.equal(branches.size, 3);
  assert.ok(branches.has('main'));
  assert.ok(branches.has('fork-a'));
  assert.ok(branches.has('fork-b'));
  // Summaries should expose byBranch.
  const summaries = ctx.book!.v14Summaries();
  const byBranch: Record<string, number> = {};
  for (const s of summaries) {
    const k = s.createdAtBranch ?? '<no-branch>';
    byBranch[k] = (byBranch[k] ?? 0) + 1;
  }
  assert.deepEqual(byBranch, { main: 1, 'fork-a': 1, 'fork-b': 1 });
});

test('Book round-trip preserves createdAtBranch across branches', async () => {
  const ctx = await makeCtx();
  const r1 = await inRepoBackend.generate({ prompt: 'a', kind: 'terrain', resolution: 8, style: 'smooth', seed: 'a' });
  const r2 = await inRepoBackend.generate({ prompt: 'b', kind: 'rock', resolution: 8, style: 'rocky', seed: 'b' });
  ctx.book!.pushSnapshot(makeV14Snapshot({ id: 'a', spec: { prompt: 'a', kind: 'terrain', resolution: 8, style: 'smooth', seed: 'a' }, result: r1, tick: 50, branch: 'main' }));
  ctx.book!.pushSnapshot(makeV14Snapshot({ id: 'b', spec: { prompt: 'b', kind: 'rock', resolution: 8, style: 'rocky', seed: 'b' }, result: r2, tick: 100, branch: 'fork-z' }), true);
  const exported = await ctx.book!.export();
  const { ExperimentBook } = await import('../src/experiments/book.ts');
  const restored = await ExperimentBook.import(exported);
  assert.equal(restored.v14Snapshots.length, 2);
  assert.equal(restored.v14Snapshots[0]!.createdAtBranch, 'main');
  assert.equal(restored.v14Snapshots[1]!.createdAtBranch, 'fork-z');
  assert.equal(restored.v14ActiveId, 'b');
});

// === V14-4 cityscape (P15 settlement-driven) =========================

test('cityscape generator with no city context still produces a mesh', async () => {
  const r = await inRepoBackend.generate({
    prompt: 'generic', kind: 'cityscape', resolution: 16, style: 'smooth', seed: 'g',
  });
  assert.equal(r.backend, 'inRepo');
  assert.ok(r.indices.length > 0);
  assert.ok(r.boundingRadius > 0);
  // Generic city: small population (default 30) → 6 buildings
  // × 4 wall quads + 1 ground + 1 roof per building + civic roof.
  // We just check it's a non-trivial mesh.
  assert.ok(r.vertices.length / 3 >= 100, 'cityscape must have at least 100 vertices');
});

test('cityscape generator scales building count with population', async () => {
  const small = await inRepoBackend.generate({
    prompt: 'small', kind: 'cityscape', resolution: 16, style: 'smooth', seed: 's',
    city: { settlementId: 's', population: 30, knowledgeLevel: 0, institution: 'mixed', taxRate: 0, techCount: 0, food: 0, cellIndex: 0, cellAreaM2: 1e9, cellNutrientMu: 0, cellTemperatureK: 288 },
  });
  const big = await inRepoBackend.generate({
    prompt: 'big', kind: 'cityscape', resolution: 16, style: 'smooth', seed: 'b',
    city: { settlementId: 'b', population: 1000, knowledgeLevel: 0, institution: 'mixed', taxRate: 0, techCount: 0, food: 0, cellIndex: 0, cellAreaM2: 1e9, cellNutrientMu: 0, cellTemperatureK: 288 },
  });
  // A bigger population must produce more vertices (more
  // buildings = more walls + roof). The default cap is 50
  // buildings so the difference is monotonic up to that cap.
  assert.ok(big.vertices.length > small.vertices.length, `big (${big.vertices.length / 3} verts) should have more vertices than small (${small.vertices.length / 3})`);
});

test('cityscape source label includes settlement state for the UI banner', async () => {
  const r = await inRepoBackend.generate({
    prompt: 'a', kind: 'cityscape', resolution: 16, style: 'smooth', seed: 'a',
    city: { settlementId: 'a', population: 200, knowledgeLevel: 3, institution: 'public', taxRate: 0.3, techCount: 2, food: 500, cellIndex: 0, cellAreaM2: 1e9, cellNutrientMu: 1000, cellTemperatureK: 288 },
  });
  assert.ok(r.sourceLabel.includes('public'), 'sourceLabel should include institution');
  assert.ok(r.sourceLabel.includes('200') || r.sourceLabel.includes('knowledge'), 'sourceLabel should reference settlement state');
});

test('handleV14Generate with kind: cityscape falls back to a small generic city when no P15 settlement loaded', async () => {
  const ctx = await makeCtx();
  await __handlers.v14Generate({
    prompt: 'demo', kind: 'cityscape', resolution: 16, style: 'smooth', seed: 'cb-1',
  }, ctx, 1);
  const reply = ctx._replies.find((r) => r.type === 'v14');
  assert.ok(reply);
  const payload = (reply as { type: 'v14'; payload: { snapshot: import('../src/simulation/visual/types.ts').V14Snapshot; activeId: string | null } }).payload;
  // The snapshot's spec must still be a cityscape; the
  // generator produced a default-style mesh.
  assert.equal(payload.snapshot.spec.kind, 'cityscape');
  assert.ok(payload.snapshot.indices.length > 0);
});

test('handleV14Generate with kind: cityscape resolves a real P15 settlement into the spec', async () => {
  // We need a P15 settlement registry on the book. The test
  // builds one by directly constructing the registry and
  // attaching it.
  const ctx = await makeCtx();
  const { makeSettlementRegistry } = await import('../src/simulation/settlement/types.ts');
  const { seedSettlements } = await import('../src/simulation/settlement/simulate.ts');
  const reg = makeSettlementRegistry();
  // Seed 1 settlement of 80 people + knowledge 4 + public
  // institution + 2 tech on cell 5.
  const { getScenario } = await import('../src/scenarios/catalog.ts');
  const scenario = getScenario('empty-planet', 320);
  scenario.seed = 'city-test';
  const state = ctx.state;
  // Use the initializeWorld + Timeline path so the book has a
  // valid active state.
  // (The handler reads ctx.state.cells + ctx.state.tick, so
  // we need a state — makeCtx already provides one via
  // ExperimentBook.create(initializeWorld(...)).
  if (!state) throw new Error('expected active state');
  // Pick the first cell area for the city.
  const cellAreaM2 = state.cells.areaM2[0] ?? 1e9;
  const cellNutrientMu = state.cells.nutrientMu[0] ?? 0;
  seedSettlements(reg, [{
    label: 'Aurelian', cellIndex: 0,
    population: 80, initialFood: 500, initialKnowledgeLevel: 4,
    institution: { kind: 'public', taxRate: 0.3, publicGoodsShare: 0.5 },
    technology: { unlocked: ['irrigation', 'writing'] },
  }], state.tick);
  ctx.book!.settlement = reg;
  await __handlers.v14Generate({
    prompt: 'city', kind: 'cityscape', resolution: 16, style: 'smooth', seed: 'cb-2',
  }, ctx, 1);
  const reply = ctx._replies.find((r) => r.type === 'v14');
  assert.ok(reply);
  const payload = (reply as { type: 'v14'; payload: { snapshot: import('../src/simulation/visual/types.ts').V14Snapshot; activeId: string | null } }).payload;
  // The snapshot's spec must have the city field filled with
  // values from the loaded settlement.
  assert.equal(payload.snapshot.spec.kind, 'cityscape');
  const city = payload.snapshot.spec.city;
  assert.ok(city, 'controller must fill spec.city from the loaded P15 settlement');
  assert.equal(city!.label, 'Aurelian');
  assert.equal(city!.population, 80);
  assert.equal(city!.knowledgeLevel, 4);
  assert.equal(city!.institution, 'public');
  assert.equal(city!.techCount, 2);
  assert.equal(city!.food, 500);
  assert.equal(city!.cellAreaM2, cellAreaM2);
  assert.equal(city!.cellNutrientMu, cellNutrientMu);
  // The snapshot label should reference the settlement name.
  assert.ok(payload.snapshot.label.includes('Aurelian'), `snapshot label should include the settlement name; got "${payload.snapshot.label}"`);
});

test('handleV14Generate with kind: cityscape and a specific settlementId that does not exist throws', async () => {
  const ctx = await makeCtx();
  const { makeSettlementRegistry } = await import('../src/simulation/settlement/types.ts');
  const reg = makeSettlementRegistry();
  ctx.book!.settlement = reg; // empty
  await assert.rejects(
    __handlers.v14Generate({
      prompt: 'city', kind: 'cityscape', resolution: 16, style: 'smooth', seed: 'cb-3',
      city: {
        settlementId: 'no-such-settlement', population: 50, knowledgeLevel: 0,
        institution: 'mixed', taxRate: 0, techCount: 0, food: 0, cellIndex: 0,
        cellAreaM2: 1e9, cellNutrientMu: 0, cellTemperatureK: 288,
      },
    }, ctx, 1),
    /settlement 不存在|no-such-settlement/,
  );
});
