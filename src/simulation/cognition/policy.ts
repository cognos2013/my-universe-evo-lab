/**
 * P14 — policies for cognitive agents.
 *
 * Ships two policies plus a one-episode harness:
 *
 *   - `randomPolicy`: ε = 1.0, never learns. The "simple baseline"
 *     P14 requires every trained policy to beat.
 *   - `qLearningPolicy`: tabular Q-learning with ε-greedy exploration
 *     and a small ε decay. The P14 reference learner.
 *   - `runTaskEpisode`: roll one episode (N steps) of a policy on the
 *     foraging task; the test in `tests/cognition.test.ts` runs this
 *     for both policies on the same seed and asserts the Q-learner
 *     wins on average reward.
 *
 * Keeping the two policies in one file makes their contract
 * comparison easy: a future P14 phase that swaps the Q-table for a
 * neural net will live next to `qLearningPolicy` and use the same
 * `Policy` interface, so the acceptance test does not change.
 */
import { ALL_ACTIONS, applyAction, discretise, observe, type Action, type CognitiveAgent, type CognitiveRegistry, type Observation, type Policy } from './agent.ts';
import type { WorldState } from '../core/contracts.ts';

// Re-export the Policy interface so callers can write
// `Policy`-typed helpers without reaching into agent.ts.
export type { Policy };

// === Random baseline ==================================================

export const randomPolicy: Policy = {
  name: 'random',
  selectAction(_agent, _obs, rng) {
    const i = Math.floor(rng() * ALL_ACTIONS.length);
    return ALL_ACTIONS[i]!;
  },
  learn() { /* no-op */ },
};

// === Q-learning policy ================================================

/** Hyper-parameters for the tabular Q-learner. */
export interface QLearningConfig {
  /** Learning rate α. */
  alpha: number;
  /** Discount factor γ. */
  gamma: number;
  /** Initial exploration rate. */
  epsilon0: number;
  /** Minimum ε after decay. */
  epsilonMin: number;
  /** ε decay per step (multiplicative). */
  epsilonDecay: number;
  /** Maximum number of (state, action) entries before the agent forgets oldest. */
  memoryEntries: number;
  /** Energy cost per cognition step (J per agent). */
  cognitionCostJ: number;
}

export const DEFAULT_QL_CONFIG: QLearningConfig = {
  alpha: 0.2,
  gamma: 0.9,
  epsilon0: 0.2,
  epsilonMin: 0.02,
  epsilonDecay: 0.995,
  memoryEntries: 256,
  cognitionCostJ: 1,
};

export const qLearningPolicy: Policy = {
  name: 'q-learning',
  selectAction(agent, obs, rng) {
    if (rng() < agent.epsilon) {
      const i = Math.floor(rng() * ALL_ACTIONS.length);
      return ALL_ACTIONS[i]!;
    }
    // Greedy: pick action with the highest Q value (unseen = 0).
    const stateKey = discretise(obs);
    const row = agent.qTable.get(stateKey);
    if (!row) return 'rest';
    let best: Action = 'rest';
    let bestQ = -Infinity;
    for (const a of ALL_ACTIONS) {
      const q = row.get(a) ?? 0;
      if (q > bestQ) { bestQ = q; best = a; }
    }
    return best;
  },
  learn(agent, prevState, action, reward, nextState, _done) {
    // Q(s,a) ← Q(s,a) + α (r + γ max_a' Q(s',a') − Q(s,a))
    let row = agent.qTable.get(prevState);
    if (!row) { row = new Map(); agent.qTable.set(prevState, row); }
    const oldQ = row.get(action) ?? 0;
    const nextRow = agent.qTable.get(nextState);
    let maxNext = 0;
    if (nextRow) {
      for (const a of ALL_ACTIONS) {
        const q = nextRow.get(a) ?? 0;
        if (q > maxNext) maxNext = q;
      }
    }
    const cfg = DEFAULT_QL_CONFIG;
    const newQ = oldQ + cfg.alpha * (reward + cfg.gamma * maxNext - oldQ);
    row.set(action, newQ);
    // Decay ε and bump age.
    agent.epsilon = Math.max(DEFAULT_QL_CONFIG.epsilonMin, agent.epsilon * DEFAULT_QL_CONFIG.epsilonDecay);
    agent.age++;
    // Memory bound: drop the oldest state if the table grows.
    if (agent.qTable.size > DEFAULT_QL_CONFIG.memoryEntries) {
      const firstKey = agent.qTable.keys().next().value;
      if (firstKey !== undefined) agent.qTable.delete(firstKey);
    }
  },
};

// === Episode runner ===================================================

export interface EpisodeResult {
  agentId: string;
  steps: number;
  totalReward: number;
  finalEpsilon: number;
  qTableSize: number;
}

/**
 * Roll one episode of `policy` for `agent` on the foraging task.
 * The agent observes the world each step, picks an action, accrues
 * reward, and updates its policy. The agent's `cellIndex` and
 * `count` are **not** persisted to the world here — the controller
 * is responsible for those effects (or for treating the cognitive
 * state as a parallel model).
 *
 * Returns summary stats used by the test harness.
 */
export function runTaskEpisode(
  agent: CognitiveAgent,
  policy: Policy,
  state: WorldState,
  steps: number,
  rng: () => number,
): EpisodeResult {
  let totalReward = 0;
  let prevState = '';
  let prevAction: Action = 'rest';
  for (let s = 0; s < steps; s++) {
    const obs = observe(state, agent.cellIndex);
    const action = policy.selectAction(agent, obs, rng);
    const outcome = applyAction(agent, obs, action, state, DEFAULT_QL_CONFIG.cognitionCostJ);
    agent.cellIndex = outcome.cellIndex;
    agent.lastObservation = obs;
    agent.lastAction = action;
    agent.totalReward += outcome.reward;
    agent.totalCognitionJ += outcome.cognitionCostJ;
    totalReward += outcome.reward;
    const nextState = discretise(outcome.nextObservation);
    if (s > 0) policy.learn(agent, prevState, prevAction, outcome.reward, nextState, false);
    prevState = nextState;
    prevAction = action;
  }
  return {
    agentId: agent.id,
    steps,
    totalReward,
    finalEpsilon: agent.epsilon,
    qTableSize: agent.qTable.size,
  };
}

/**
 * Drive every agent in `registry` through one step on the current
 * task. Updates `agent.cellIndex`, `agent.lastObservation`,
 * `agent.lastAction`, `agent.totalReward`, `agent.totalCognitionJ`,
 * and `registry.totalCognitionJ` / `registry.totalReward`.
 *
 * `siblings` defaults to the whole registry so the aggregation
 * task can see where other agents are. Callers can pass a smaller
 * list for unit tests that don't want cross-agent visibility.
 */
export function stepCognitiveRegistry(
  registry: CognitiveRegistry,
  state: WorldState,
  policy: Policy = qLearningPolicy,
  rng: () => number = Math.random,
  cognitionCostJ: number = DEFAULT_QL_CONFIG.cognitionCostJ,
  siblings: CognitiveAgent[] = registry.agents,
): { spent: number; totalReward: number } {
  let spent = 0;
  let totalReward = 0;
  for (const agent of registry.agents) {
    const obs = observe(state, agent.cellIndex);
    const action = policy.selectAction(agent, obs, rng);
    const outcome = applyAction(agent, obs, action, state, cognitionCostJ, siblings);
    // Charge the cost against the registry; the controller then
    // debits `externalEnergyInJ` for the same amount.
    spent += outcome.cognitionCostJ * agent.count;
    // Per-agent state machine: simple tabular Q-learning.
    const prevState = agent.lastObservation ? discretise(agent.lastObservation) : '';
    agent.cellIndex = outcome.cellIndex;
    agent.lastObservation = obs;
    agent.lastAction = action;
    agent.totalReward += outcome.reward;
    agent.totalCognitionJ += outcome.cognitionCostJ;
    totalReward += outcome.reward;
    if (prevState !== '') {
      policy.learn(agent, prevState, action, outcome.reward, discretise(outcome.nextObservation), false);
    } else {
      // First observation — still update the policy's internal
      // counters (e.g. ε decay) without an actual TD update.
      agent.age++;
      agent.epsilon = Math.max(DEFAULT_QL_CONFIG.epsilonMin, agent.epsilon * DEFAULT_QL_CONFIG.epsilonDecay);
    }
  }
  registry.totalCognitionJ += spent;
  registry.totalReward += totalReward;
  registry.episode++;
  return { spent, totalReward };
}

/** Build a deterministic PRNG returning a function in [0, 1). Seeded with xfnv1a. */
export function seededRng(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >>> 17;
    h ^= h << 5; h >>>= 0;
    return (h >>> 0) / 4294967296;
  };
}
