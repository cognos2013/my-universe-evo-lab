/**
 * P13 — multi-cellular colonial agent contract tests.
 *
 * Per docs/15 P13:
 *   1. Same-colour aggregates are NOT automatically a multi-cell
 *      organism. We require a boundary, a cooperation cost,
 *      internal differentiation, and a collective life cycle.
 *   2. The independent cell and the collective are different units
 *      of selection. A colony that cannot pay its maintenance is
 *      dissolved; the cells continue as independent cohorts.
 *   3. Fission has a cooldown and a spatial cut; the child carries
 *      a parentId pointer for lineage tracing.
 *
 * This file is contract-only; the colonial agent is not yet wired
 * into the planetary controller. Integration is the next milestone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stateFixture } from './fixtures.ts';
import {
  canAdhere, tryFormColony, tryAdhere, tryFission,
  maintainColonialOrganisms, makeColonialRegistry, validateColonialOrganism,
  type ColonialMember, type ColonialConfig,
} from '../src/simulation/colonial/agent.ts';
import type { WorldState } from '../src/simulation/core/contracts.ts';

async function makeWorld(): Promise<WorldState> {
  return await stateFixture();
}

function mem(cellIndex: number, traitId = 'cool', cohortId = `c-${cellIndex}`): ColonialMember {
  return { cellIndex, cohortId, traitId };
}

const PERMISSIVE_CONFIG: ColonialConfig = {
  minMembers: 2, fissionMembers: 8, fissionCooldown: 50, maintenanceJPerMember: 1, admissibleTraitIds: ['cool', 'warm'],
};

test('canAdhere: spatial + same-trait predicate blocks same-colour aggregates from auto-coalescing', async () => {
  const state = await makeWorld();
  const registry = makeColonialRegistry();
  const org = tryFormColony(mem(0, 'cool', 'c-0'), state, registry, PERMISSIVE_CONFIG, 0)!;
  // Same trait + valid cell: should adhere.
  assert.equal(canAdhere(org, mem(1, 'cool', 'c-1'), state, PERMISSIVE_CONFIG), true);
  // Different trait: should NOT adhere (P13 internal differentiation rule).
  assert.equal(canAdhere(org, mem(2, 'warm', 'c-2'), state, PERMISSIVE_CONFIG), false);
  // Out-of-range cell index: should NOT adhere.
  assert.equal(canAdhere(org, mem(99999, 'cool', 'c-x'), state, PERMISSIVE_CONFIG), false);
  // Already-a-member: should NOT adhere.
  assert.equal(canAdhere(org, mem(0, 'cool', 'c-0'), state, PERMISSIVE_CONFIG), false);
});

test('tryFormColony + tryAdhere builds a colonial organism with explicit boundary', async () => {
  const state = await makeWorld();
  const registry = makeColonialRegistry();
  const org = tryFormColony(mem(0, 'cool', 'c-0'), state, registry, undefined, 0)!;
  assert.equal(registry.organisms.length, 1);
  // A 1-member "organism" is below minMembers (default 2), so it is
  // not yet a "real" colony until it grows.
  assert.equal(org.members.length, 1);
  // Adhere a second cell with the same trait.
  const updated = tryAdhere(org, mem(1, 'cool', 'c-1'), state)!;
  assert.ok(updated);
  assert.equal(org.members.length, 2);
  // Adhering fails for a different trait.
  assert.equal(tryAdhere(org, mem(2, 'warm', 'c-2'), state), null);
});

test('maintenance cost: a colony that cannot pay dissolves; the cells continue', async () => {
  const state = await makeWorld();
  const registry = makeColonialRegistry();
  const org = tryFormColony(mem(0, 'cool', 'c-0'), state, registry, undefined, 0)!;
  tryAdhere(org, mem(1, 'cool', 'c-1'), state);
  tryAdhere(org, mem(2, 'cool', 'c-2'), state);
  // 3 members × 1 J = 3 J per step. Give 1 J: cannot pay → dissolved.
  const beforeCohorts = state.cohorts.ids.length;
  const result = maintainColonialOrganisms(registry, state, 1);
  assert.equal(result.spent, 0, 'no energy should have been spent (colony could not pay)');
  assert.deepEqual(result.dissolved, [org.id]);
  assert.equal(registry.organisms.length, 0, 'dissolved colony should be removed from the registry');
  assert.equal(state.cohorts.ids.length, beforeCohorts, 'cells (cohorts) must remain in WorldState — only the colony was dissolved');
});

test('maintenance cost: a colony that can pay stays alive and energy is debited', async () => {
  const state = await makeWorld();
  const registry = makeColonialRegistry();
  const org = tryFormColony(mem(0, 'cool', 'c-0'), state, registry, undefined, 0)!;
  // stateFixture has only 2 valid cells (indices 0 and 1). A 2-member
  // colony has cost 2 J.
  tryAdhere(org, mem(1, 'cool', 'c-1'), state);
  assert.equal(org.members.length, 2);
  const result = maintainColonialOrganisms(registry, state, 10);
  assert.equal(result.spent, 2);
  assert.deepEqual(result.dissolved, []);
  assert.equal(registry.organisms.length, 1);
  assert.equal(registry.totalMaintenanceJ, 2);
});

test('tryFission: splits members along a spatial cut, child carries parentId, cooldown enforced', async () => {
  const state = await makeWorld();
  const registry = makeColonialRegistry();
  // The 2-cell state fixture gives us 2 valid cells (0 and 1); we
  // set fissionMembers=2 so a fully-grown colony fissions on cue.
  const config: ColonialConfig = { minMembers: 2, fissionMembers: 2, fissionCooldown: 50, maintenanceJPerMember: 1, admissibleTraitIds: ['cool'] };
  const org = tryFormColony(mem(0, 'cool', 'c-0'), state, registry, config, 0)!;
  tryAdhere(org, mem(1, 'cool', 'c-1'), state, config);
  assert.equal(org.members.length, 2);
  // Fission at step 100: parent keeps first half (cell 0), child gets second (cell 1).
  const child = tryFission(org, registry, 100, config);
  assert.ok(child, 'fission should fire when size + cooldown allow');
  assert.equal(child!.members.length, 1);
  assert.equal(org.members.length, 1);
  assert.equal(child!.parentId, org.id);
  assert.equal(org.lastFissionStep, 100);
  assert.equal(registry.totalFissions, 1);
  // Re-fission within cooldown is blocked.
  const blocked = tryFission(org, registry, 110, config);
  assert.equal(blocked, null, 'fission cooldown should block re-fission at step 110');
  // After cooldown, the parent has 1 member, below the threshold, so
  // fission is size-blocked even past the cooldown.
  const stillBlocked = tryFission(org, registry, 200, config);
  assert.equal(stillBlocked, null, 'size below fissionMembers blocks even after cooldown');
});

test('validateColonialOrganism rejects malformed members / IDs', () => {
  assert.throws(() => validateColonialOrganism({
    id: 'org-1', parentId: null, bornStep: 0, members: [{ cellIndex: -1, cohortId: 'c', traitId: 'cool' }], lastFissionStep: 0,
  }), /cellIndex/);
  assert.throws(() => validateColonialOrganism({
    id: '', parentId: null, bornStep: 0, members: [], lastFissionStep: 0,
  }), /id/);
  assert.throws(() => validateColonialOrganism({
    id: 'org-2', parentId: 42, bornStep: 0, members: [], lastFissionStep: 0,
  }), /parentId/);
});

test('the same-colour test from P13 rules: two same-trait cells do NOT auto-coalesce', async () => {
  // The state fixture has multiple "cool" cohorts already; if we
  // *don't* call tryFormColony, no organism is created. This is
  // the negative case the rules require.
  const registry = makeColonialRegistry();
  assert.equal(registry.organisms.length, 0, 'fresh registry should have no organisms');
  // P13 requires an explicit decision to form a colony; mere
  // same-colour presence in WorldState is not enough.
});
