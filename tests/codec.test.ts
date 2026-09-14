import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getScenario, scenarioIds } from '../src/scenarios/catalog.ts';
import { serializeScenario, deserializeScenario, serializeState, deserializeState } from '../src/persistence/codec.ts';
import { sha256 } from '../src/simulation/core/canonical.ts';
import { RandomStream } from '../src/simulation/core/random.ts';
import { stateFixture } from './fixtures.ts';

async function resign(envelope: any): Promise<string> {
  const { checksum: _, ...content } = envelope;
  return JSON.stringify({ ...content, checksum: await sha256(content) });
}

test('all scenarios roundtrip exactly and canonically', async () => {
  for (const id of scenarioIds) {
    const s = getScenario(id);
    const raw = await serializeScenario(s);
    const restored = await deserializeScenario(raw);
    assert.deepEqual(restored, s);
    assert.equal(await serializeScenario(restored), raw);
  }
});

test('state roundtrip preserves typed arrays, rules and RNG continuation', async () => {
  const original = await stateFixture();
  const raw = await serializeState(original);
  const restored = await deserializeState(raw);
  assert.deepEqual(restored, original);
  assert.equal(await serializeState(restored), raw);
  assert.ok(restored.cells.nutrientMu instanceof Float64Array);
  assert.ok(restored.cells.neighborIndices instanceof Uint32Array);
  const a = new RandomStream(original.rng), b = new RandomStream(restored.rng);
  assert.equal(a.nextUint32(), b.nextUint32());
  restored.cells.nutrientMu[0] = 0;
  assert.equal(original.cells.nutrientMu[0], 90);
});

test('tampering, malformed JSON, unsupported formats and kinds are rejected', async () => {
  const raw = await serializeScenario(getScenario('two-lineages'));
  const tampered = JSON.parse(raw); tampered.payload.seed = 'changed';
  await assert.rejects(deserializeScenario(JSON.stringify(tampered)), /checksum/);
  await assert.rejects(deserializeScenario('{broken'));
  const version = JSON.parse(raw); version.version = 99;
  await assert.rejects(deserializeScenario(await resign(version)), /version/);
  await assert.rejects(deserializeState(raw), /kind/);
  const invalid = JSON.parse(raw); invalid.payload.planet.nutrientMuPerCell = -1;
  await assert.rejects(deserializeScenario(await resign(invalid)), /nutrientMu/);
});

test('uint values checked before conversion, forged rule hashes rejected', async () => {
  const original = await stateFixture();
  const raw = await serializeState(original);
  for (const illegal of [-1, 1.5, 2 ** 32]) {
    const e = JSON.parse(raw); e.payload.cells.neighborIndices.data[0] = illegal;
    await assert.rejects(deserializeState(await resign(e)), /typedArray/);
  }
  const e = JSON.parse(raw); e.payload.rules.life.mutationProbability = 0.2;
  await assert.rejects(deserializeState(await resign(e)), /rules digest mismatch/);
  original.manifest.rulesetHash = '0'.repeat(64);
  await assert.rejects(serializeState(original), /rules digest mismatch/);
});

test('deep payloads are rejected before recursive hashing', async () => {
  const raw = await serializeScenario(getScenario('empty-planet'));
  const e = JSON.parse(raw);
  let nested: unknown = 0;
  for (let i = 0; i < 40; i++) nested = { child: nested };
  e.payload = nested;
  await assert.rejects(deserializeScenario(JSON.stringify(e)), /nesting too deep/);
});
