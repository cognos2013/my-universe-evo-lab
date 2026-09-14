/**
 * P14 — perception, learning, and intelligent behaviour.
 *
 * Per docs/15 P14: "有限观测、能量/记忆成本、可训练策略；未见环境任务
 * 优于预设简单基线". This file is the **interface contract** for
 * cognitive agents. It defines:
 *
 *   - `CognitiveAgent`: a learning agent anchored to a (cell, lineage)
 *     pair on the world. Independent of `Cohort` so a colony (P13) can
 *     host a cognitive agent that decides its members' behaviour.
 *   - `Observation`: the local view an agent sees (its own cell +
 *     neighbour cells' temperature / nutrient, plus a tiny categorical
 *     discretisation for tabular learning).
 *   - `Action`: the discrete set of choices (`move`, `feed`, `rest`).
 *   - `Policy`: pluggable decision function. The package ships a
 *     random baseline and a tabular Q-learner (see `policy.ts`).
 *
 * The key P14 rule is: cognition **costs energy**. Every step the
 * agent spends `cognitionCostJ` from the world's
 * `externalEnergyInJ` ledger, and its in-memory Q-table is bounded
 * by `memoryEntries`. A colony of thousands of agents can starve the
 * ledger — by design.
 *
 * The reference task is "foraging": at every step the agent receives
 * a reward proportional to the local nutrient (and a one-time bonus
 * if it just moved to a richer cell). The acceptance test in
 * `policy.ts` runs both the Q-learner and a random baseline on the
 * same task for many episodes and asserts the Q-learner wins.
 */
import type { WorldState } from '../core/contracts.ts';

// === Observation =====================================================

/** A single neighbour cell snapshot in the agent's local view. */
export interface NeighbourView {
  cellIndex: number;
  temperatureK: number;
  nutrientMu: number;
}

/**
 * The agent's local view of the world. We deliberately **do not**
 * expose the full state — P14 requires "limited observation". The
 * view is built from the world each tick by `observe()`.
 */
export interface Observation {
  cellIndex: number;
  temperatureK: number;
  nutrientMu: number;
  neighbours: NeighbourView[];
  /** Tick when the view was taken (for the agent's internal clock). */
  tick: number;
}

/**
 * Discretise a continuous observation into a string key the tabular
 * Q-learner can index on. Three bins per axis (cold/warm/hot, low/
 * mid/high, few/many neighbours) gives 3×3×3 = 27 distinct states —
 * enough for the foraging task to be learnable but small enough to
 * fit in `memoryEntries`. The exact binning is part of the P14
 * contract; changing it invalidates trained agents.
 */
export function discretise(obs: Observation): string {
  const temp = obs.temperatureK < 270 ? 'C' : obs.temperatureK < 300 ? 'W' : 'H';
  const nut = obs.nutrientMu < 100 ? 'L' : obs.nutrientMu < 1000 ? 'M' : 'G';
  const deg = obs.neighbours.length < 2 ? 'F' : obs.neighbours.length < 4 ? 'S' : 'M';
  return `${temp}${nut}${deg}`;
}

// === Action ===========================================================

/** A discrete choice available to the agent. */
export type Action = 'move-best' | 'move-worst' | 'feed' | 'rest';

/** The full action set in a fixed order — used to size Q-tables. */
export const ALL_ACTIONS: readonly Action[] = ['move-best', 'move-worst', 'feed', 'rest'] as const;

// === Tasks ============================================================

/**
 * The P14 task the agent is currently learning. Each task has a
 * different reward shaping so the same `Action` set produces
 * different optimal policies.
 *
 *   - `foraging`: land on the globally richest cell (+50).
 *   - `thermoregulation`: stay close to 290 K (max 50 at the optimum,
 *     linear fall-off to 0 over a 30 K band).
 *   - `aggregation`: be on a cell whose neighbour is occupied by an
 *     agent with the same `lineageId` (+10).
 *
 * Adding a new task is a one-line change here plus the matching
 * `applyAction` branch — the Q-learning policy itself is
 * task-agnostic.
 */
export type TaskKind = 'foraging' | 'thermoregulation' | 'aggregation';

export const ALL_TASK_KINDS: readonly TaskKind[] = ['foraging', 'thermoregulation', 'aggregation'] as const;

/** Apply `action` to the world. Pure: returns the *consequences*, not a mutation. */
export interface ActionOutcome {
  /** New cell index the agent ends up on. `feed` and `rest` stay in place. */
  cellIndex: number;
  /** Energy drawn from `externalEnergyInJ` (cognition cost). */
  cognitionCostJ: number;
  /** Whether the agent physically moved (used by the policy to compute the move reward). */
  moved: boolean;
  /** Reward for this step (pre-shape). The task policy decides the shaping. */
  reward: number;
  /** Snapshot for the next-state in Q-learning. */
  nextObservation: Observation;
}

// === Policy ===========================================================

/**
 * A policy picks an action given the current observation and the
 * agent's internal state (Q-table, exploration rate, etc). Policies
 * are pure functions of (state, observation, rng) and **must not**
 * mutate the world directly — `act()` resolves the action through
 * `applyAction` to keep the side-effects explicit.
 */
export interface Policy {
  /** The policy's name (used in test diagnostics). */
  readonly name: string;
  /**
   * Pick an action for `agent` observing `obs`. May consult / mutate
   * `agent.qTable` and `agent.epsilon` (the policy owns the learning
   * state, not the world).
   */
  selectAction(agent: CognitiveAgent, obs: Observation, rng: () => number): Action;
  /**
   * Update the policy's internal state after observing the
   * `outcome`. Called by the controller once per agent per step.
   */
  learn(agent: CognitiveAgent, prevState: string, action: Action, reward: number, nextState: string, done: boolean): void;
}

// === Agent ============================================================

/**
 * A learning agent. Anchored to a (cell, lineage) pair so it can
 * ride along with `Cohort` and `Colony` (P13) without changing their
 * data. Multiple agents may share a `lineageId` if a lineage is
 * sub-divided for cognitive modelling; the contract does not enforce
 * uniqueness on `lineageId` because a future P14 phase may want
 * one agent per cohort-member batch.
 */
export interface CognitiveAgent {
  id: string;
  cellIndex: number;
  lineageId: string;
  /** Population this agent represents (for ledger accounting). */
  count: number;
  /**
   * Q-table: discrete state key → action → expected return. We do
   * not initialise unseen entries — they are treated as 0.
   */
  qTable: Map<string, Map<Action, number>>;
  /** ε for ε-greedy exploration. Decreases as the agent learns. */
  epsilon: number;
  /** Step counter since the agent was created (used for ε decay). */
  age: number;
  /** Cumulative reward over the agent's lifetime. */
  totalReward: number;
  /** Last observation seen (kept on the agent for debugging / projection). */
  lastObservation: Observation | null;
  /** Last action taken. */
  lastAction: Action | null;
  /** Cumulative energy cost paid by this agent since creation. */
  totalCognitionJ: number;
  /** Current P14 task. Defaults to `foraging` for back-compat with phase-1 tests. */
  taskKind: TaskKind;
}

/**
 * Build a new agent. `qTable` starts empty; `epsilon` is taken from
 * `config.epsilon0` (defaults to 0.1 — 10% exploration).
 */
export function makeCognitiveAgent(args: {
  id: string; cellIndex: number; lineageId: string; count: number; epsilon0?: number; taskKind?: TaskKind;
}): CognitiveAgent {
  return {
    id: args.id,
    cellIndex: args.cellIndex,
    lineageId: args.lineageId,
    count: args.count,
    qTable: new Map(),
    epsilon: args.epsilon0 ?? 0.1,
    age: 0,
    totalReward: 0,
    lastObservation: null,
    lastAction: null,
    totalCognitionJ: 0,
    taskKind: args.taskKind ?? 'foraging',
  };
}

// === Acting on the world =============================================

/**
 * Build an `Observation` for the agent at `cellIndex` from `state`.
 * Pulls the cell's own temperature / nutrient and the first
 * `neighbourFanout` neighbours' readings. Bound the fanout to keep
 * the observation O(1) regardless of grid density (P14's
 * "limited observation" rule).
 */
export function observe(state: WorldState, cellIndex: number, neighbourFanout = 3): Observation {
  const c = state.cells;
  const t = c.temperatureK[cellIndex] ?? 0;
  const n = c.nutrientMu[cellIndex] ?? 0;
  const edges: NeighbourView[] = [];
  if (cellIndex >= 0 && cellIndex < c.neighborOffsets.length) {
    const start = c.neighborOffsets[cellIndex]!;
    const end = c.neighborOffsets[cellIndex + 1] ?? start;
    for (let e = start; e < end && edges.length < neighbourFanout; e++) {
      const j = c.neighborIndices[e]!;
      edges.push({
        cellIndex: j,
        temperatureK: c.temperatureK[j] ?? 0,
        nutrientMu: c.nutrientMu[j] ?? 0,
      });
    }
  }
  return { cellIndex, temperatureK: t, nutrientMu: n, neighbours: edges, tick: state.tick };
}

/**
 * Resolve `action` for `agent` at `obs` against `state`. Returns the
 * outcome the policy sees (cognition cost is always paid; the world
 * is **not** mutated by this call — the caller is responsible for
 * moving the agent, charging the ledger, etc.).
 *
 * Reward shaping depends on `agent.taskKind`:
 *
 *   - `foraging`:          land on the globally richest cell → +50.
 *   - `thermoregulation`:  closer to 290 K is better (max 50 at the
 *                          optimum, linear fall-off to 0 over 30 K).
 *   - `aggregation`:       same-`lineageId` neighbour present → +10
 *                          per neighbour, 0 otherwise.
 *
 * The `siblings` argument is required only for `aggregation` —
 * it lists the other agents on the world so the policy can see who
 * is nearby. Other tasks ignore it.
 */
export function applyAction(
  agent: CognitiveAgent,
  obs: Observation,
  action: Action,
  state: WorldState,
  cognitionCostJ: number,
  siblings: CognitiveAgent[] = [],
): ActionOutcome {
  let cellIndex = obs.cellIndex;
  let moved = false;
  if (action === 'move-best' || action === 'move-worst') {
    if (obs.neighbours.length > 0) {
      let pick = obs.neighbours[0]!;
      for (const n of obs.neighbours) {
        if (action === 'move-best' ? n.nutrientMu > pick.nutrientMu : n.nutrientMu < pick.nutrientMu) {
          pick = n;
        }
      }
      if (pick.cellIndex !== obs.cellIndex) {
        cellIndex = pick.cellIndex;
        moved = true;
      }
    }
  } else if (action === 'feed') {
    // Feed: no spatial reward; agents learn to position first.
  } else {
    // 'rest' — no spatial reward.
  }
  // Reward shaping per task.
  let reward = 0;
  if (agent.taskKind === 'foraging') {
    let richest = 0;
    for (let i = 1; i < state.cells.nutrientMu.length; i++) {
      if (state.cells.nutrientMu[i]! > state.cells.nutrientMu[richest]!) richest = i;
    }
    reward = cellIndex === richest ? 50 : 0;
  } else if (agent.taskKind === 'thermoregulation') {
    // Reward = max(0, 50 − 50 × |T − 290| / 30). 0 at 320 K or 260 K.
    const T = state.cells.temperatureK[cellIndex] ?? 290;
    const penalty = Math.min(50, 50 * Math.abs(T - 290) / 30);
    reward = 50 - penalty;
  } else {
    // aggregation: count same-lineage siblings in the chosen cell's
    // neighbours (the world, not the agent's local view, so we
    // need the siblings list).
    const here = new Set<number>([cellIndex]);
    const off = state.cells.neighborOffsets[cellIndex]!;
    const end = state.cells.neighborOffsets[cellIndex + 1] ?? off;
    for (let e = off; e < end; e++) here.add(state.cells.neighborIndices[e]!);
    let k = 0;
    for (const s of siblings) {
      if (s.id === agent.id) continue;
      if (s.lineageId !== agent.lineageId) continue;
      if (here.has(s.cellIndex)) k++;
    }
    reward = k > 0 ? 10 * k : 0;
  }
  return {
    cellIndex,
    cognitionCostJ,
    moved,
    reward,
    nextObservation: observe(state, cellIndex, obs.neighbours.length || 3),
  };
}

// === Registry =========================================================

/** A registry of cognitive agents maintained outside `WorldState`. */
export interface CognitiveRegistry {
  agents: CognitiveAgent[];
  nextId: number;
  /** Cumulative energy charged against `externalEnergyInJ`. */
  totalCognitionJ: number;
  /** Cumulative reward earned across all agents. */
  totalReward: number;
  /** Episode counter (one episode = one `cognitionStep` over all agents). */
  episode: number;
}

export function makeCognitiveRegistry(): CognitiveRegistry {
  return { agents: [], nextId: 1, totalCognitionJ: 0, totalReward: 0, episode: 0 };
}
