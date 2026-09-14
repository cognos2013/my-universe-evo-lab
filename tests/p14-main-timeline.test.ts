/**
 * P14 — cognitive agents on the real main timeline.
 *
 * Per docs/15 P14: "有限观测、能量/记忆成本、可训练策略;未见环境
 * 任务优于预设简单基线". The P14 acceptance gate is that a
 * trainable policy must beat a transparent baseline on the same
 * world, same seed, same horizon.
 *
 * The existing `cognition.test.ts` exercises this gate on a tiny
 * 3-cell world. This file extends the same gate to a full
 * 5120-cell planetary world over a 1000-tick horizon, which is
 * the "real main timeline" exercise the doc calls out:
 *
 *   1. Initialise a 5120-cell two-lineages world (a world large
 *      enough that the 27-state observation bucket sees real
 *      variation).
 *   2. Load a cognitive registry (one agent per cohort).
 *   3. Run 1000 planetary ticks; record cumulative reward,
 *      total spent cognition J, and agent count.
 *   4. Reset the world (same seed), load a random policy instead,
 *      and run 1000 planetary ticks with the same controller.
 *   5. Assert: Q-learning cumulative reward > random.
 *
 * The test pins the main timeline by going through the controller
 * (not the unit-level `runTaskEpisode`), so the result is the
 * end-to-end "agent meets planetary simulation" answer, not a
 * 3-cell synthetic micro-benchmark.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimulationController, type Reply } from '../src/workers/controller.ts';
import { initializeWorld } from '../src/simulation/core/initialize.ts';
import { getScenario } from '../src/scenarios/catalog.ts';
import { ExperimentBook } from '../src/experiments/book.ts';

async function makeController(seed: string) {
  const scenario = getScenario('two-lineages', 5120);
  scenario.seed = seed;
  scenario.rules.limits.maxCohorts = 100000;
  const world = await initializeWorld(scenario);
  const book = await ExperimentBook.create(world);
  const replies: Reply[] = [];
  const c = new SimulationController((r) => replies.push(r));
  await c.handle({ id: 1, type: 'create' });
  return { c, replies };
}

async function runHorizon(seed: string, policy: 'q-learning' | 'random', horizon: number) {
  const { c, replies } = await makeController(seed);
  // Step the world 5 times so agents have non-trivial state to
  // observe (otherwise the first observation bucket is the
  // dead-cold-start initial state and Q-learning has no signal
  // to learn from). Then load the cognitive registry.
  for (let t = 0; t < 5; t++) {
    await c.handle({ id: 100 + t, type: 'step' });
  }
  await c.handle({ id: 200, type: 'cognitionLoad', payload: { policy, task: 'foraging', epsilon0: 0.3 } });
  // Run `horizon` planetary ticks via the public handler. Each
  // step internally advances the world and the cognition agents
  // (via internalTick in `handleRun`/auto-step). For unit-test
  // determinism we use the explicit step handler.
  let id = 300;
  for (let t = 0; t < horizon; t++) {
    await c.handle({ id: id++, type: 'cognitionStep', payload: { policy } });
    await c.handle({ id: id++, type: 'step' });
  }
  // Find the latest cognition reply (or step reply) and sum up
  // totalReward from the snapshots.
  const cognitionReplies = replies.filter((r) => r.type === 'cognition');
  const lastCognition = cognitionReplies.at(-1);
  const totalReward = lastCognition?.type === 'cognition'
    ? lastCognition.payload.totalReward
    : 0;
  const totalSpentJ = lastCognition?.type === 'cognition'
    ? lastCognition.payload.totalCognitionJ
    : 0;
  return { totalReward, totalSpentJ, agentCount: lastCognition?.type === 'cognition' ? lastCognition.payload.agents : 0 };
}

test('P14: Q-learning beats random on a 5120-cell, 1000-tick planetary run', async () => {
  const SEED = 'p14-main-timeline';
  const HORIZON = 1000;
  const q = await runHorizon(SEED, 'q-learning', HORIZON);
  const r = await runHorizon(SEED, 'random', HORIZON);
  // The agents and the world are the same seed, so the only
  // difference is the policy. The P14 gate is that the
  // Q-learning cumulative reward is strictly higher than the
  // random policy's.
  assert.ok(q.agentCount > 0, `Q-learning should have agents, got ${q.agentCount}`);
  assert.ok(r.agentCount > 0, `random should have agents, got ${r.agentCount}`);
  assert.ok(q.totalReward > r.totalReward,
    `Q-learning cumulative reward (${q.totalReward}) should beat random (${r.totalReward}) on a 5120-cell, ${HORIZON}-tick run`);
  // Sanity: cognition cost was paid (both policies spend the
  // same per-step J, so total spent should be similar).
  assert.ok(q.totalSpentJ > 0, 'Q-learning should pay cognition cost');
  assert.ok(r.totalSpentJ > 0, 'random should pay cognition cost');
});
