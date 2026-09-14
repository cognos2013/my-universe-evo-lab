import type { Scenario, WorldState } from '../simulation/core/contracts.ts';
import { validateScenario } from '../simulation/core/schema.ts';
import { validateState } from '../simulation/core/state.ts';
import { validateModelCoverage } from '../knowledge/model-cards.ts';
import { canonicalJson, sha256 } from '../simulation/core/canonical.ts';
import * as v from '../simulation/core/validation.ts';

// Versioned state interchange; ongoing forcing and command receipts are included.
// Full replay histories and branch graphs are wrapped by Timeline / ExperimentBook.
function pack(value: unknown): unknown {
  if (value instanceof Float64Array || value instanceof Uint32Array) {
    return { $array: value instanceof Float64Array ? 'f64' : 'u32', data: Array.from(value) };
  }
  if (Array.isArray(value)) return value.map(pack);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, val]) => [k, pack(val)]));
  }
  return value;
}

function unpack(value: unknown, depth = 0): unknown {
  if (depth > 32) v.fail('file', 'nesting too deep');
  if (Array.isArray(value)) {
    v.array(value, 'file.array', 100000);
    return value.map(x => unpack(x, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (Object.hasOwn(obj, '$array')) {
      v.object(obj, ['$array', 'data'], 'file.typedArray');
      const kind = v.choice(obj.$array, ['f64', 'u32'], 'file.typedArray.$array');
      const data = v.array(obj.data, 'file.typedArray.data', 100000);
      // Validate BEFORE constructing Uint32Array: no silent truncation/wrapping.
      const values = data.map((x, i) => kind === 'u32'
        ? v.integer(x, `file.typedArray.data[${i}]`, 0, 0xffffffff)
        : v.number(x, `file.typedArray.data[${i}]`, -Number.MAX_VALUE));
      return kind === 'u32' ? new Uint32Array(values) : new Float64Array(values);
    }
    return Object.fromEntries(Object.entries(obj).map(([k, val]) => [k, unpack(val, depth + 1)]));
  }
  return value;
}

async function encode(kind: 'scenario' | 'state', input: unknown): Promise<string> {
  const payload = pack(input);
  const content = { format: 'my-universe-state', version: 2, kind, payload };
  return canonicalJson({ ...content, checksum: await sha256(content) });
}

async function decode(raw: string, kind: 'scenario' | 'state'): Promise<unknown> {
  const limit = kind === 'scenario' ? 1_000_000 : 50_000_000;
  v.text(raw, 'file', limit);
  if (new TextEncoder().encode(raw).byteLength > limit) v.fail('file', 'byte limit exceeded');
  const parsed: unknown = JSON.parse(raw);
  const e = v.object(parsed, ['format', 'version', 'kind', 'payload', 'checksum'], 'file');
  v.choice(e.format, ['my-universe-state'], 'file.format'); v.choice(e.version, [2], 'file.version');
  v.choice(e.kind, [kind], 'file.kind'); v.hash(e.checksum, 'file.checksum');
  // Decode with bounded depth first so canonical hashing cannot recurse unboundedly.
  const decoded = unpack(e.payload);
  const content = { format: e.format, version: e.version, kind: e.kind, payload: e.payload };
  if (await sha256(content) !== e.checksum) v.fail('file.checksum', 'content changed or corrupt');
  return decoded;
}

export async function serializeScenario(input: Scenario): Promise<string> {
  validateScenario(input); validateModelCoverage(input);
  return encode('scenario', input);
}
export async function deserializeScenario(raw: string): Promise<Scenario> {
  const value = await decode(raw, 'scenario');
  validateScenario(value); validateModelCoverage(value);
  return value;
}
export async function serializeState(input: WorldState): Promise<string> {
  validateState(input);
  if (await sha256(input.rules) !== input.manifest.rulesetHash) v.fail('manifest.rulesetHash', 'rules digest mismatch');
  return encode('state', input);
}
export async function deserializeState(raw: string): Promise<WorldState> {
  const value = await decode(raw, 'state');
  validateState(value);
  if (await sha256(value.rules) !== value.manifest.rulesetHash) v.fail('manifest.rulesetHash', 'rules digest mismatch');
  return value;
}
