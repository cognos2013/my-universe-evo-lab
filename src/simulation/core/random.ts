import { RNG_ALGORITHM } from './contracts.ts';
import type { RngSnapshot } from './contracts.ts';
import { sha256 } from './canonical.ts';
import * as v from './validation.ts';

export function validateRng(input: unknown): asserts input is RngSnapshot {
  const r = v.object(input, ['algorithm', 'state'], 'rng');
  v.choice(r.algorithm, [RNG_ALGORITHM], 'rng.algorithm');
  const state = v.array(r.state, 'rng.state', 4);
  if (state.length !== 4) v.fail('rng.state', 'requires four uint32 words');
  state.forEach((x, i) => v.integer(x, `rng.state[${i}]`, 0, 0xffffffff));
  if (state.every(x => x === 0)) v.fail('rng.state', 'all-zero state is forbidden');
}

function rotl(x: number, k: number): number { return ((x << k) | (x >>> (32 - k))) >>> 0; }

/** xoshiro128**; simulation only, not cryptographic randomness. */
export class RandomStream {
  #state: [number, number, number, number];
  constructor(snapshot: RngSnapshot) {
    validateRng(snapshot);
    this.#state = [...snapshot.state];
  }
  nextUint32(): number {
    let [a, b, c, d] = this.#state;
    const result = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0;
    const t = b << 9;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = rotl(d, 11);
    this.#state = [a >>> 0, b >>> 0, c >>> 0, d >>> 0];
    return result;
  }
  next(): number { return this.nextUint32() / 0x100000000; }
  snapshot(): RngSnapshot { return { algorithm: RNG_ALGORITHM, state: [...this.#state] }; }
}

/** Coordinates are length-safe canonical JSON, independent of branch/view IDs. */
export async function createRandomStream(seed: string, channel: string, entityId: string, tick: number): Promise<RandomStream> {
  v.text(seed, 'seed', 256); v.id(channel, 'channel'); v.id(entityId, 'entityId'); v.integer(tick, 'tick');
  const digest = await sha256({ algorithm: RNG_ALGORITHM, seed, channel, entityId, tick });
  const state = [0, 8, 16, 24].map(offset => Number.parseInt(digest.slice(offset, offset + 8), 16)) as RngSnapshot['state'];
  if (state.every(x => x === 0)) state[0] = 1;
  return new RandomStream({ algorithm: RNG_ALGORITHM, state });
}
