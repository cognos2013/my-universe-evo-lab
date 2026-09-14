/**
 * P10-2 — chemistry loader façade.
 *
 * Wraps `loadReactionNetwork` plus the two phase-1 synthetic
 * networks (GARD-like and Markov-state) behind a single
 * `loadChemistryBySource` entry point. The controller's
 * `chemistryLoad` handler accepts a `source` field that picks
 * which loader to use:
 *
 *   - `'raw'` (default): the existing `loadReactionNetwork` —
 *     the caller ships a hand-written `{species, reactions}`
 *     payload.
 *   - `'gard'`: return `syntheticGardNetwork()`.
 *   - `'markov'`: return `syntheticMarkovNetwork()`.
 *
 * Both synthetic networks are honest about being synthetic in
 * their `source` field; the UI must label them as demo data.
 */
import type { ReactionNetwork } from './network.ts';
import { loadReactionNetwork } from './network.ts';
import { syntheticGardNetwork } from './gard.ts';
import { syntheticMarkovNetwork } from './markov.ts';

export type ChemistrySource = 'raw' | 'gard' | 'markov';

/** Map `source` → network. For `'raw'`, pass through `input`
 *  via `loadReactionNetwork`. */
export function loadChemistryBySource(source: ChemistrySource, input: unknown): ReactionNetwork {
  switch (source) {
    case 'gard':
      return syntheticGardNetwork();
    case 'markov':
      return syntheticMarkovNetwork();
    case 'raw':
      return loadReactionNetwork(input);
  }
}
