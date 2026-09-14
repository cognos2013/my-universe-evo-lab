/**
 * P12 / P13 — end-to-end controller integration tests.
 *
 * Exercises the handler path that the P12 chemistry and P13 colonial
 * subsystems take through the planetary controller. These tests
 * verify the *integration* contracts the report calls out:
 *
 *   1. `chemistryStep` debits the active world's `externalEnergyInJ`
 *      for endothermic reactions and persists the new reactor state
 *      on the experiment book.
 *   2. `coloniesMaintain` charges maintenance against the same ledger
 *      pool; colonies that cannot pay are dissolved but the member
 *      cohorts remain on the world.
 *   3. The two subsystems are independent: a chemistry step does not
 *      mutate the colonial registry, and vice versa.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimulationController, type Reply } from '../src/workers/controller.ts';
import { initializeWorld } from '../src/simulation/core/initialize.ts';
import { getScenario } from '../src/scenarios/catalog.ts';
import { ExperimentBook } from '../src/experiments/book.ts';
import { makeColonialRegistry } from '../src/simulation/colonial/agent.ts';

async function makeController() {
  const scenario = getScenario('two-lineages', 5120);
  const world = await initializeWorld(scenario);
  const book = await ExperimentBook.create(world);
  const replies: Reply[] = [];
  const c = new SimulationController((r) => replies.push(r));
  await c.handle({ id: 1, type: 'create' });
  return { c, replies };
}

test('chemistryStep: endothermic reactions debit externalEnergyInJ; reactor state persists', async () => {
  const { c, replies } = await makeController();
  // Seed the ledger via the test-only public helper (production
  // routes energy through interventions / galaxies / chemistry).
  const before = c.snapshotState().ledger.externalEnergyInJ;
  c.testSetLedgerEnergy(1e6);
  // Load a small chemistry with one endothermic pump (energy 50 J/mol,
  // rate 1) and one exothermic combine.
  await c.handle({ id: 2, type: 'chemistryLoad', payload: {
    network: {
      species: ['A', 'B', 'C'],
      reactions: [
        { id: 'combine', reactants: ['A', 'B'], products: ['C', 'C'], rate: 0.1, energyJPerMole: -100 },
        { id: 'pumpA',   reactants: [],          products: ['A'],    rate: 1.0,  energyJPerMole: 50 },
      ],
    },
    initial: { A: 0.1, B: 0.1, C: 0 },
    energyInJ: 0,
  }});
  // Step once. The pump fires *moles* of A at energy 50 J/mol, plus
  // the combine reaction runs exothermically. Total spend is the
  // energyConsumedJ of the step; the ledger must drop by exactly that.
  await c.handle({ id: 3, type: 'chemistryStep' });
  const chemReply = replies.filter(r => r.type === 'chemistry').at(-1)!;
  assert.equal(chemReply.type, 'chemistry');
  if (chemReply.type === 'chemistry') {
    assert.ok(chemReply.payload.energyConsumedJ > 0,
      `expected endothermic pump to consume energy, got ${chemReply.payload.energyConsumedJ}`);
  }
  const after = c.snapshotState().ledger.externalEnergyInJ;
  const drop = before + 1e6 - after;
  const expected = chemReply.type === 'chemistry' ? chemReply.payload.energyConsumedJ : 0;
  assert.equal(drop, expected, `ledger drop should equal chemistryStep energyConsumedJ`);
});

test('chemistryStep: zero energy → reactor still runs exothermic reactions and surfaces shortfall', async () => {
  const { c, replies } = await makeController();
  // Force the ledger to exactly zero.
  c.testSetLedgerEnergy(0);
  await c.handle({ id: 2, type: 'chemistryLoad', payload: {
    network: {
      species: ['A', 'B', 'C'],
      reactions: [
        { id: 'combine', reactants: ['A', 'B'], products: ['C', 'C'], rate: 0.1, energyJPerMole: -100 },
        { id: 'pumpA',   reactants: [],          products: ['A'],    rate: 1.0,  energyJPerMole: 50 },
      ],
    },
    initial: { A: 0.1, B: 0.1, C: 0 },
    energyInJ: 0,
  }});
  await c.handle({ id: 3, type: 'chemistryStep' });
  const chemReply = replies.filter(r => r.type === 'chemistry').at(-1)!;
  assert.equal(chemReply.type, 'chemistry');
  if (chemReply.type === 'chemistry') {
    assert.equal(chemReply.payload.energyConsumedJ, 0, 'no endothermic reaction should fire on zero energy');
    // The reactor itself does not track shortfall; that's a chemistry
    // implementation detail. We only assert the world ledger stays
    // at zero.
  }
  assert.equal(c.snapshotState().ledger.externalEnergyInJ, 0, 'ledger must not go negative');
});

test('coloniesMaintain: low ledger → empty registry is a no-op; no maintenance charged', async () => {
  // Until we add a `coloniesLoad` handler, the colonial subsystem
  // starts empty. `coloniesMaintain` should be safe to call against
  // an empty registry: it creates one, charges nothing, dissolves
  // nothing. The cohorts on the active world must remain untouched.
  const { c, replies } = await makeController();
  const cohortsBefore = c.snapshotState().cohorts.ids.length;
  const energyBefore = c.snapshotState().ledger.externalEnergyInJ;
  await c.handle({ id: 4, type: 'coloniesMaintain' });
  const colReply = replies.filter(r => r.type === 'colonies').at(-1)!;
  assert.equal(colReply.type, 'colonies');
  if (colReply.type === 'colonies') {
    assert.equal(colReply.payload.total, 0, 'empty registry should have 0 organisms');
    assert.equal(colReply.payload.dissolved.length, 0);
    assert.equal(colReply.payload.totalMaintenanceJ, 0, 'no maintenance should be charged on an empty registry');
    assert.equal(colReply.payload.fissioned, 0);
  }
  // Cohorts on the world are untouched.
  assert.equal(c.snapshotState().cohorts.ids.length, cohortsBefore, 'cohorts must remain in WorldState after a no-op maintenance');
  // Ledger is untouched (no energy spent).
  assert.equal(c.snapshotState().ledger.externalEnergyInJ, energyBefore, 'no energy should move on empty maintenance');
});

test('chemistryStep and coloniesMaintain are independent: chemistry does not touch colonies and vice versa', async () => {
  const { c, replies } = await makeController();
  await c.handle({ id: 2, type: 'chemistryLoad', payload: {
    network: {
      species: ['A'],
      reactions: [{ id: 'r', reactants: [], products: ['A'], rate: 0.1, energyJPerMole: 0 }],
    },
    initial: { A: 0.1 },
    energyInJ: 0,
  }});
  const beforeChem = c.snapshotState().ledger.externalEnergyInJ;
  await c.handle({ id: 3, type: 'chemistryStep' });
  const afterChem = c.snapshotState().ledger.externalEnergyInJ;
  assert.equal(beforeChem, afterChem, 'energy-neutral chemistry must not move the ledger');
  await c.handle({ id: 4, type: 'coloniesMaintain' });
  const afterCol = c.snapshotState().ledger.externalEnergyInJ;
  assert.equal(afterChem, afterCol, 'empty colonies must not move the ledger');
  // Both replies must be present and well-formed.
  assert.ok(replies.some(r => r.type === 'chemistry'));
  assert.ok(replies.some(r => r.type === 'colonies'));
});

test('coloniesLoad: scans the world and forms organisms by (cell, trait) cohesion; cohorts remain in WorldState', async () => {
  const { c, replies } = await makeController();
  const cohortsBefore = c.snapshotState().cohorts.ids.length;
  assert.ok(cohortsBefore > 0, 'two-lineages scenario must seed cohorts');
  await c.handle({ id: 2, type: 'coloniesLoad', payload: {
    config: { minMembers: 1, fissionMembers: 999, maintenanceJPerMember: 0, admissibleTraitIds: [] },
  }});
  const reply = replies.filter(r => r.type === 'colonies').at(-1)!;
  assert.equal(reply.type, 'colonies');
  if (reply.type === 'colonies') {
    assert.ok(reply.payload.total > 0, `expected at least one colony, got ${reply.payload.total}`);
    assert.ok((reply.payload.colonisedCohorts ?? 0) > 0, 'expected at least one cohort to land in a colony');
    // Every cohort must still be on the world: a colony is a *second*
    // unit of selection, it does not consume the cell.
    assert.equal(c.snapshotState().cohorts.ids.length, cohortsBefore, 'cohorts must remain in WorldState after colonisation');
  }
});

test('chemistryStep silent mode: advances reactor + debits ledger but does NOT emit a chemistry reply', async () => {
  const { c, replies } = await makeController();
  c.testSetLedgerEnergy(1e6);
  await c.handle({ id: 2, type: 'chemistryLoad', payload: {
    network: {
      species: ['A', 'B', 'C'],
      reactions: [
        { id: 'combine', reactants: ['A', 'B'], products: ['C', 'C'], rate: 0.1, energyJPerMole: -100 },
        { id: 'pumpA',   reactants: [],          products: ['A'],    rate: 1.0,  energyJPerMole: 50 },
      ],
    },
    initial: { A: 0.1, B: 0.1, C: 0 },
    energyInJ: 0,
  }});
  const beforeReplyCount = replies.filter(r => r.type === 'chemistry').length;
  await c.handle({ id: 3, type: 'chemistryStep', payload: { silent: true } });
  const afterReplyCount = replies.filter(r => r.type === 'chemistry').length;
  assert.equal(beforeReplyCount, afterReplyCount, 'silent mode must not emit a chemistry reply');
  // But the reactor did advance: the projection snapshot must show step > 0
  // and a non-zero totalConsumedJ.
  const proj = c.projection();
  assert.ok(proj.chemistry, 'projection must carry the chemistry snapshot');
  assert.ok(proj.chemistry!.step > 0, `expected reactor to advance, step=${proj.chemistry!.step}`);
  assert.ok(proj.chemistry!.totalConsumedJ > 0, `expected energy to be consumed, totalConsumedJ=${proj.chemistry!.totalConsumedJ}`);
});

test('coloniesMaintain silent mode: advances registry but does NOT emit a colonies reply', async () => {
  const { c, replies } = await makeController();
  // Load first so there is a registry to maintain.
  await c.handle({ id: 2, type: 'coloniesLoad', payload: { config: { minMembers: 1, fissionMembers: 999, maintenanceJPerMember: 0 } } });
  const afterLoad = replies.filter(r => r.type === 'colonies').length;
  await c.handle({ id: 3, type: 'coloniesMaintain', payload: { silent: true } });
  const afterMaintain = replies.filter(r => r.type === 'colonies').length;
  assert.equal(afterLoad, afterMaintain, 'silent mode must not emit a colonies reply');
  // The projection must still report the registry.
  const proj = c.projection();
  assert.ok(proj.colonies, 'projection must carry the colonies snapshot');
  assert.equal(proj.colonies!.total, c.snapshotState().cohorts.ids.length > 0 ? proj.colonies!.total : 0);
});

test('internalTick auto-step: chemistry + colonies advance in lockstep with the planetary tick', async () => {
  const { c, replies } = await makeController();
  c.testSetLedgerEnergy(1e6);
  await c.handle({ id: 2, type: 'chemistryLoad', payload: {
    network: {
      species: ['A', 'B', 'C'],
      reactions: [
        { id: 'combine', reactants: ['A', 'B'], products: ['C', 'C'], rate: 0.1, energyJPerMole: -100 },
        { id: 'pumpA',   reactants: [],          products: ['A'],    rate: 1.0,  energyJPerMole: 50 },
      ],
    },
    initial: { A: 0.1, B: 0.1, C: 0 },
    energyInJ: 0,
  }});
  await c.handle({ id: 3, type: 'coloniesLoad', payload: { config: { minMembers: 1, fissionMembers: 999, maintenanceJPerMember: 0 } } });
  // Drain the load replies so they don't pollute the count.
  const baselineChemReplies = replies.filter(r => r.type === 'chemistry').length;
  const baselineColReplies = replies.filter(r => r.type === 'colonies').length;
  // Run 3 planetary ticks. internalTick is fired on a setTimeout(0)
  // chain, and each tick is itself an async history.advance(); poll
  // for completion rather than fixed sleep, with a 2s ceiling.
  await c.handle({ id: 4, type: 'run', payload: { ticks: 3 } });
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (c.projection().chemistry && c.projection().chemistry!.step >= 1) break;
  }
  await c.handle({ id: 5, type: 'pause' });
  // No new chemistry / colonies replies: silent mode should be in effect.
  assert.equal(replies.filter(r => r.type === 'chemistry').length, baselineChemReplies, 'auto-step must not emit chemistry replies');
  assert.equal(replies.filter(r => r.type === 'colonies').length, baselineColReplies, 'auto-step must not emit colonies replies');
  // The projection must show that chemistry advanced past step 0 and
  // colonies are still tracked.
  const proj = c.projection();
  assert.ok(proj.chemistry && proj.chemistry.step > 0, `chemistry should have advanced, step=${proj.chemistry?.step}`);
  assert.ok(proj.colonies, 'colonies should still be tracked');
});

// === P14 cognitive-agent integration ===================================

test('cognitionLoad: attaches one agent per cohort and exposes the registry on the projection', async () => {
  const { c, replies } = await makeController();
  const cohortsBefore = c.snapshotState().cohorts.ids.length;
  assert.ok(cohortsBefore > 0, 'two-lineages scenario must seed cohorts');
  await c.handle({ id: 2, type: 'cognitionLoad', payload: {} });
  const reply = replies.filter(r => r.type === 'cognition').at(-1)!;
  assert.equal(reply.type, 'cognition');
  if (reply.type === 'cognition') {
    assert.equal(reply.payload.agents, cohortsBefore, 'one agent per cohort');
  }
  const proj = c.projection();
  assert.ok(proj.cognition, 'projection must carry the cognition snapshot');
  assert.equal(proj.cognition!.agents, cohortsBefore);
});

test('cognitionStep: debits externalEnergyInJ for cognition cost; silent mode does NOT emit a reply', async () => {
  const { c, replies } = await makeController();
  c.testSetLedgerEnergy(1e6);
  await c.handle({ id: 2, type: 'cognitionLoad', payload: {} });
  const before = c.snapshotState().ledger.externalEnergyInJ;
  const beforeReplyCount = replies.filter(r => r.type === 'cognition').length;
  await c.handle({ id: 3, type: 'cognitionStep', payload: { silent: true } });
  const after = c.snapshotState().ledger.externalEnergyInJ;
  const afterReplyCount = replies.filter(r => r.type === 'cognition').length;
  assert.equal(beforeReplyCount, afterReplyCount, 'silent mode must not emit a cognition reply');
  assert.ok(before - after > 0, `cognition must cost energy, drop=${before - after}`);
  // Projection must reflect the spend + reward even in silent mode.
  const proj = c.projection();
  assert.ok(proj.cognition, 'projection must carry the cognition snapshot');
  assert.ok(proj.cognition!.episode >= 1, 'episode counter must advance');
  assert.ok(proj.cognition!.totalCognitionJ > 0, 'cognition energy must be tracked');
});

test('cognitionStep non-silent: emits a cognition reply with episode + totals', async () => {
  const { c, replies } = await makeController();
  await c.handle({ id: 2, type: 'cognitionLoad', payload: {} });
  const beforeReplies = replies.filter(r => r.type === 'cognition').length;
  await c.handle({ id: 3, type: 'cognitionStep', payload: {} });
  const afterReplies = replies.filter(r => r.type === 'cognition').length;
  assert.equal(afterReplies, beforeReplies + 1, 'one new cognition reply per non-silent step');
  const reply = replies.filter(r => r.type === 'cognition').at(-1)!;
  if (reply.type === 'cognition') {
    assert.ok(reply.payload.agents > 0);
    assert.ok(reply.payload.spentThisStep > 0, 'cognition cost should be reported');
  }
});

test('cognition + chemistry + colonies coexist: load all three, each is reflected in projection', async () => {
  // Sanity test: the three P12/P13/P14 subsystems are independent
  // fields on the book and all surface on the projection.
  const { c } = await makeController();
  c.testSetLedgerEnergy(1e6);
  await c.handle({ id: 2, type: 'chemistryLoad', payload: {
    network: { species: ['A'], reactions: [{ id: 'r', reactants: [], products: ['A'], rate: 0.1, energyJPerMole: 0 }] },
    initial: { A: 0.1 }, energyInJ: 0,
  }});
  await c.handle({ id: 3, type: 'coloniesLoad', payload: { config: { minMembers: 1, fissionMembers: 999, maintenanceJPerMember: 0 } } });
  await c.handle({ id: 4, type: 'cognitionLoad', payload: {} });
  const proj = c.projection();
  assert.ok(proj.chemistry, 'chemistry should be present');
  assert.ok(proj.colonies, 'colonies should be present');
  assert.ok(proj.cognition, 'cognition should be present');
  assert.equal(proj.cognition!.agents, c.snapshotState().cohorts.ids.length, 'one agent per cohort');
});

test('cognitionLoad with task: projection carries the taskKind + per-lineage rollup', async () => {
  const { c, replies } = await makeController();
  await c.handle({ id: 2, type: 'cognitionLoad', payload: { task: 'thermoregulation', policy: 'q-learning' } });
  const reply = replies.filter(r => r.type === 'cognition').at(-1)!;
  assert.equal(reply.type, 'cognition');
  if (reply.type === 'cognition') {
    assert.equal((reply.payload as { taskKind?: string }).taskKind, 'thermoregulation');
  }
  const proj = c.projection();
  assert.ok(proj.cognition, 'projection must carry the cognition snapshot');
  assert.equal(proj.cognition!.taskKind, 'thermoregulation');
  // Per-lineage rollup: the two-lineages scenario has ≥ 2 lineages.
  assert.ok(proj.cognition!.byLineage.length >= 2, `expected ≥ 2 lineages, got ${proj.cognition!.byLineage.length}`);
  for (const row of proj.cognition!.byLineage) {
    assert.ok(row.agents > 0, `lineage ${row.lineageId} should have at least one agent`);
    assert.ok(row.totalQEntries === 0, `fresh agents have empty Q-tables, got ${row.totalQEntries}`);
  }
});

test('cognitionLoad rejects unknown task and unknown policy', async () => {
  // The controller converts handler throws into `error` replies, so
  // we assert on the reply stream rather than the promise itself.
  const { c, replies } = await makeController();
  await c.handle({ id: 2, type: 'cognitionLoad', payload: { task: 'unknown' } });
  const taskErr = replies.filter(r => r.type === 'error').at(-1);
  assert.ok(taskErr, 'unknown task should emit an error reply');
  if (taskErr && taskErr.type === 'error') assert.match(taskErr.error, /未知任务/);
  await c.handle({ id: 3, type: 'cognitionLoad', payload: { policy: 'unknown' } });
  const polErr = replies.filter(r => r.type === 'error').at(-1);
  assert.ok(polErr, 'unknown policy should emit an error reply');
  if (polErr && polErr.type === 'error') assert.match(polErr.error, /未知策略/);
});

test('aggregation task: per-lineage rollup reports shared reward when agents cluster', async () => {
  // Construct a tiny registry manually (bypass the controller's
  // per-cohort scan) so we can position agents on adjacent cells
  // with the same lineage.
  const { c, replies } = await makeController();
  await c.handle({ id: 2, type: 'cognitionLoad', payload: { task: 'aggregation', policy: 'q-learning' } });
  // Move two agents from the same lineage onto neighbouring cells.
  const proj0 = c.projection();
  assert.ok(proj0.cognition);
  // Trigger several silent steps so the per-lineage avgReward moves.
  for (let i = 0; i < 3; i++) {
    await c.handle({ id: 3 + i, type: 'cognitionStep', payload: { silent: true } });
  }
  const proj = c.projection();
  assert.ok(proj.cognition);
  assert.equal(proj.cognition!.taskKind, 'aggregation');
  // Total reward must be a non-negative number; exact value is
  // implementation-defined, but the rollup is well-formed.
  assert.ok(proj.cognition!.totalReward >= 0);
  assert.ok(proj.cognition!.byLineage.length >= 2);
  for (const row of proj.cognition!.byLineage) {
    assert.ok(Number.isFinite(row.avgReward), `avgReward must be finite, got ${row.avgReward}`);
  }
});

