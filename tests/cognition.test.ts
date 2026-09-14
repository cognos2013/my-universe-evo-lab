/**
 * P14 — cognitive agents acceptance tests.
 *
 * Two layers of coverage:
 *
 *   1. **Unit tests** for the policy contract. The "foraging task"
 *      acceptance gate from docs/15 P14: a Q-learning policy must
 *      outperform the random baseline on the same world, same seed,
 *      same horizon. We run a small agent (one cell, 3 neighbour
 *      fanout) and assert average reward over the second half of
 *      the episode is higher for Q-learning than for random.
 *   2. **Sanity tests** for the registry lifecycle (cellIndex
 *      updates, ledger debits, registry totals).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, discretise, makeCognitiveAgent, observe, type CognitiveAgent } from '../src/simulation/cognition/agent.ts';
import { qLearningPolicy, randomPolicy, runTaskEpisode, seededRng } from '../src/simulation/cognition/policy.ts';
import { initializeWorld } from '../src/simulation/core/initialize.ts';
import { getScenario } from '../src/scenarios/catalog.ts';

function average(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

test('discretise maps continuous observation into 27-state bucket (3×3×3)', () => {
  const cool = { cellIndex: 0, temperatureK: 250, nutrientMu: 50, neighbours: [], tick: 0 };
  const warm = { cellIndex: 0, temperatureK: 285, nutrientMu: 500, neighbours: [], tick: 0 };
  const hot = { cellIndex: 0, temperatureK: 320, nutrientMu: 5000, neighbours: [{}, {}, {}] as never, tick: 0 };
  assert.equal(discretise(cool), 'CLF', 'cold / low nutrient / few neighbours');
  assert.equal(discretise(warm), 'WMF', 'warm / mid nutrient / few neighbours (none in test)');
  assert.equal(discretise(hot), 'HGS', 'hot / good nutrient / some neighbours (3)');
});

test('applyAction: move-best picks the richest neighbour and rewards only on the goal cell', async () => {
  const state = await buildThreeCellWorld();
  const agent = makeCognitiveAgent({ id: 'a', cellIndex: 2, lineageId: 'L', count: 1 });
  const obs = observe(state, 2, 3);
  const outcome = applyAction(agent, obs, 'move-best', state, 1);
  assert.ok(outcome.moved, 'should move');
  // From cell 2 (400 MU), neighbours are [1 (200), 3 (800)].
  // move-best picks 3.
  assert.equal(outcome.cellIndex, 3);
  assert.equal(outcome.cognitionCostJ, 1);
  // Reward is 0 here: cell 4 is the goal, not cell 3.
  assert.equal(outcome.reward, 0);
  // Now from cell 3, move-best to cell 4 yields the +50 reward.
  const obs3 = observe(state, 3, 3);
  const outcomeGoal = applyAction(agent, obs3, 'move-best', state, 1);
  assert.equal(outcomeGoal.cellIndex, 4);
  assert.equal(outcomeGoal.reward, 50);
});

test('Q-learning beats random on the foraging task (same seed, same horizon)', async () => {
  const state = await buildThreeCellWorld();
  // Run a few episodes to wash out initial ε. We compare the
  // second-half average reward per step (more meaningful than
  // totals — early steps are warm-up).
  const horizon = 200;
  const repeats = 6;
  const qHalfRewards: number[] = [];
  const randomHalfRewards: number[] = [];
  for (let r = 0; r < repeats; r++) {
    const qAgent = makeCognitiveAgent({ id: `q${r}`, cellIndex: 1, lineageId: 'L', count: 1, epsilon0: 0.3 });
    const rAgent = makeCognitiveAgent({ id: `r${r}`, cellIndex: 1, lineageId: 'L', count: 1, epsilon0: 1.0 });
    const qRng = seededRng(`q-${r}`);
    const rRng = seededRng(`r-${r}`);
    // Track per-step reward for the second half.
    const qStepRewards = runWithPerStep(qAgent, qLearningPolicy, state, horizon, qRng);
    const rStepRewards = runWithPerStep(rAgent, randomPolicy, state, horizon, rRng);
    qHalfRewards.push(average(qStepRewards.slice(horizon / 2)));
    randomHalfRewards.push(average(rStepRewards.slice(horizon / 2)));
  }
  const qMean = average(qHalfRewards);
  const rMean = average(randomHalfRewards);
  assert.ok(qMean > rMean, `Q-learner mean=${qMean.toFixed(3)} should beat random mean=${rMean.toFixed(3)}`);
});

test('Q-learner fills its Q-table over the episode (memory bound respected)', async () => {
  const state = await buildThreeCellWorld();
  const agent = makeCognitiveAgent({ id: 'q', cellIndex: 1, lineageId: 'L', count: 1, epsilon0: 0.2 });
  const rng = seededRng('q-fill');
  runTaskEpisode(agent, qLearningPolicy, state, 200, rng);
  assert.ok(agent.qTable.size > 0, 'Q-table should be populated');
  assert.ok(agent.qTable.size <= 256 + 1, 'memory bound should be respected (≤ 256 entries)');
  assert.ok(agent.epsilon < 0.2, 'epsilon should decay toward min');
});

// === Helpers =========================================================

interface MiniWorld {
  tick: number;
  cells: {
    areaM2: Float64Array;
    temperatureK: Float64Array;
    nutrientMu: Float64Array;
    landFraction: Float64Array;
    neighborOffsets: Uint32Array;
    neighborIndices: Uint32Array;
    detritusMu: Float64Array;
  };
  cohorts: { ids: string[]; cellIndices: Uint32Array; lineageIndices: Uint32Array; counts: Float64Array; energyReserveJ: Float64Array };
  traits: never[];
  lineages: { id: string; traitId: string }[];
  rng: { state: number };
  execution: { receipts: never[]; forcings: never[] };
  ledger: { initialMatterMu: number; externalMatterInMu: number; externalMatterOutMu: number; initialEnergyJ: number; externalEnergyInJ: number; externalEnergyOutJ: number };
  branch: { id: string; parentId: string | null; forkTick: number; checkpointHash: string };
  manifest: { id: string; rulesetHash: string; seed: string; createdAtTick: number };
  rules: never;
}

/**
 * Build a real `WorldState` (so types match) and overwrite the
 * neighbour adjacency and nutrient field to a 5-cell linear chain
 * with one "goal" cell (cell 4) carrying 50× the baseline nutrient.
 * The agent starts on cell 2. With 5 cells, the random policy
 * (uniform 25% per action) only lands on the goal ~ 20% of moves,
 * giving the Q-learner a clear signal to beat.
 */
async function buildThreeCellWorld(): Promise<import('../src/simulation/core/contracts.ts').WorldState> {
  const state = await initializeWorld(getScenario('empty-planet', 320));
  // 5-cell linear chain: 0 ↔ 1 ↔ 2 ↔ 3 ↔ 4
  // neighbourOffsets: each cell has 2 neighbours (except ends which
  // we still mark with 2 to keep the format uniform).
  state.cells.areaM2 = Float64Array.from([1, 1, 1, 1, 1]);
  state.cells.temperatureK = Float64Array.from([285, 285, 285, 285, 285]);
  state.cells.nutrientMu = Float64Array.from([100, 200, 400, 800, 50000]);
  state.cells.landFraction = Float64Array.from([1, 1, 1, 1, 1]);
  state.cells.detritusMu = Float64Array.from([0, 0, 0, 0, 0]);
  // Linear 5-cell chain (CSR): 0↔1↔2↔3↔4
  //   cell 0: [1]
  //   cell 1: [0, 2]
  //   cell 2: [1, 3]
  //   cell 3: [2, 4]
  //   cell 4: [3]
  state.cells.neighborOffsets = Uint32Array.from([0, 1, 3, 5, 7, 8]);
  state.cells.neighborIndices = Uint32Array.from([1, 0, 2, 1, 3, 2, 4, 3]);
  state.ledger.externalEnergyInJ = 1e9;
  // Drop cohorts so the registry is empty — we test policies on a
  // hand-built agent, not on the scenario's cohorts.
  state.cohorts.ids = [];
  state.cohorts.cellIndices = Uint32Array.from([]);
  state.cohorts.lineageIndices = Uint32Array.from([]);
  state.cohorts.counts = Float64Array.from([]);
  state.cohorts.energyReserveJ = Float64Array.from([]);
  return state;
}

function runWithPerStep(
  agent: CognitiveAgent,
  policy: typeof qLearningPolicy,
  state: import('../src/simulation/core/contracts.ts').WorldState,
  steps: number,
  rng: () => number,
): number[] {
  const out: number[] = [];
  let prevState = '';
  let prevAction: 'move-best' | 'move-worst' | 'feed' | 'rest' = 'rest';
  for (let s = 0; s < steps; s++) {
    const obs = observe(state, agent.cellIndex);
    const action = policy.selectAction(agent, obs, rng);
    const outcome = applyAction(agent, obs, action, state, 1);
    agent.cellIndex = outcome.cellIndex;
    agent.totalReward += outcome.reward;
    agent.totalCognitionJ += outcome.cognitionCostJ;
    out.push(outcome.reward);
    if (s > 0) policy.learn(agent, prevState, prevAction, outcome.reward, discretise(outcome.nextObservation), false);
    prevState = discretise(outcome.nextObservation);
    prevAction = action;
  }
  return out;
}
