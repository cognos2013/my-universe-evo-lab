import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as THREE from 'three';
import { LevelManager, DEFAULT_WAYPOINTS, type Level, type CameraState } from '../src/rendering/level-manager.ts';

/**
 * Phase 11.1 unit tests for the cosmic-to-ground level manager.
 *
 * The manager is pure (no Three.js scene), so it can be tested
 * in node:test. We drive `tick()` manually and assert the
 * interpolated state at each step.
 */

function snapshotState(state: CameraState) {
  return {
    position: { x: state.position.x, y: state.position.y, z: state.position.z },
    lookAt: { x: state.lookAt.x, y: state.lookAt.y, z: state.lookAt.z },
    fov: state.fov,
  };
}

test('LevelManager starts at planet', () => {
  const lm = new LevelManager();
  assert.equal(lm.current, 'planet');
  assert.equal(lm.isTransitioning, false);
});

test('requestTransition to current level resolves immediately', async () => {
  const lm = new LevelManager();
  const result = await lm.requestTransition({ to: 'planet' });
  assert.equal(result, 'planet');
  assert.equal(lm.isTransitioning, false);
});

test('requestTransition to a new level fires start + end phase events', async () => {
  const lm = new LevelManager();
  const phases: string[] = [];
  lm.onTransitionPhase((p) => { phases.push(p); });
  let levelChangedTo: Level | null = null;
  lm.onLevelChange((level) => { levelChangedTo = level; });
  // Start the transition (returns a promise that resolves when
  // tick() advances past progress=1).
  const transitionPromise = lm.requestTransition({ to: 'surface', durationMs: 50 });
  // Pump tick manually. Each tick advances the transition by the
  // wall-clock time delta. We use real time so the transition
  // actually progresses.
  let safety = 100;
  while (lm.isTransitioning && safety-- > 0) {
    await new Promise((r) => setTimeout(r, 20));
    lm.tick(() => undefined);
  }
  await transitionPromise;
  // First event must be 'start', last must be 'end'. Progress
  // events fire on every tick (variable count).
  assert.equal(phases[0], 'start', `expected first phase to be start, got ${phases[0]}`);
  assert.equal(phases[phases.length - 1], 'end', `expected last phase to be end, got ${phases[phases.length - 1]}`);
  assert.ok(phases.includes('start') && phases.includes('end'), 'should fire both start and end');
  assert.equal(levelChangedTo, 'surface');
  assert.equal(lm.current, 'surface');
});

test('tick() with no active transition is a no-op', () => {
  const lm = new LevelManager();
  let called = false;
  lm.tick(() => { called = true; });
  assert.equal(called, false);
});

test('tick() interpolates position during a transition', async () => {
  const lm = new LevelManager();
  const captured: ReturnType<typeof snapshotState>[] = [];
  // Start transition (sync).
  void lm.requestTransition({ to: 'surface', durationMs: 1000 });
  // Pump tick a few times.
  for (let i = 0; i < 3; i++) {
    lm.tick((state) => { captured.push(snapshotState(state)); });
  }
  assert.ok(captured.length > 0, 'tick() should have produced interpolated states');
  // All captured states should be within the bounds of the from/to.
  for (const s of captured) {
    assert.ok(s.position.x >= -1 && s.position.x <= DEFAULT_WAYPOINTS.surface.position.x + 1,
      `position.x out of bounds: ${s.position.x}`);
  }
});

test('setCurrentCamera becomes the "from" of the next transition', async () => {
  const lm = new LevelManager();
  lm.setCurrentCamera({ position: { x: 1, y: 2, z: 3 }, lookAt: { x: 0, y: 0, z: 0 }, fov: 50 });
  let firstState: ReturnType<typeof snapshotState> | null = null;
  const unsub = lm.onTransitionPhase((p) => {
    if (p === 'progress' && firstState === null) {
      lm.tick((state) => { firstState = snapshotState(state); });
    }
  });
  const transitionPromise = lm.requestTransition({ to: 'surface', durationMs: 200 });
  // Pump tick until firstState is captured, then unsubscribe.
  let safety = 100;
  while (firstState === null && safety-- > 0) {
    await new Promise((r) => setTimeout(r, 20));
    lm.tick(() => undefined);
  }
  // Drain the rest of the transition.
  while (lm.isTransitioning && safety-- > 0) {
    await new Promise((r) => setTimeout(r, 20));
    lm.tick(() => undefined);
  }
  await transitionPromise;
  unsub();
  assert.ok(firstState !== null, 'first state should be captured');
  const s = firstState as ReturnType<typeof snapshotState>;
  // The first tick after a transition starts should be very close
  // to the user's custom position (1, 2, 3).
  assert.ok(Math.abs(s.position.x - 1) < 0.5, `expected x≈1, got ${s.position.x}`);
  assert.ok(Math.abs(s.position.y - 2) < 0.5, `expected y≈2, got ${s.position.y}`);
  assert.ok(Math.abs(s.position.z - 3) < 0.5, `expected z≈3, got ${s.position.z}`);
});

test('unsubscribe from onLevelChange', () => {
  const lm = new LevelManager();
  const unsub = lm.onLevelChange(() => undefined);
  assert.equal(typeof unsub, 'function');
  unsub();
  // Subscribing again after unsub should still work.
  const unsub2 = lm.onLevelChange(() => undefined);
  unsub2();
});

test('DEFAULT_WAYPOINTS covers all 4 levels with consistent distance ordering', () => {
  const levels: Level[] = ['cosmos', 'galaxy', 'planet', 'surface'];
  for (const level of levels) {
    assert.ok(DEFAULT_WAYPOINTS[level], `waypoint for ${level} should exist`);
    assert.ok(DEFAULT_WAYPOINTS[level].position instanceof THREE.Vector3);
    assert.ok(DEFAULT_WAYPOINTS[level].lookAt instanceof THREE.Vector3);
  }
  // Surface should be closest to origin, cosmos farthest.
  const distances = levels.map((l) => DEFAULT_WAYPOINTS[l]!.position.length());
  assert.ok(distances[0]! > distances[2]!, 'cosmos farther than planet');
  assert.ok(distances[2]! > distances[3]!, 'planet farther than surface');
});
