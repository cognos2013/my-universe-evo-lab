/**
 * P10-2 — synthetic Markov-state chemical network.
 *
 * A Markov-state chemistry is a graph of N states where the
 * transition matrix gives the rate of `i → j` per unit
 * concentration of `i`. The dynamics are linear in the state
 * vector. The reference textbook case is the *Oregonator*
 * (Field–Noyes 1974) — a 3-state oscillating chemistry. We ship
 * a synthetic 4-state "predator-prey" network that exhibits
 * damped oscillations when fed a small amount of energy.
 *
 * The network is encoded in the same `{ species, reactions }`
 * shape as `loadReactionNetwork` so the controller's chemistry
 * pipeline is identical for GARD / Markov / hand-written
 * networks.
 */
import type { ReactionNetwork } from './network.ts';
import { species } from './network.ts';

/**
 * Build a synthetic Markov-state "predator-prey" chemistry.
 *
 * Topology (4 species: `A`, `B`, `C`, `D`):
 *
 *   A → B                    (substrate activation, energy-neutral)
 *   B → A                    (spontaneous decay, neutral)
 *   B + A → 2B              (autocatalysis, exothermic)
 *   B → C                    (predator eats prey, energy cost)
 *   C → D                    (predator decay, neutral)
 *   D → A                    (waste recycling to substrate, neutral)
 *
 * The 4-state cycle gives rise to damped oscillations on the
 * `A-B-C` subspace when initial concentrations favour `A`.
 */
export function syntheticMarkovNetwork(): ReactionNetwork {
  return {
    species: (['A', 'B', 'C', 'D'] as const).map(species),
    reactions: [
      { id: 'activate',     reactants: [species('A')],         products: [species('B')],          rate: 0.40, energyJPerMole: 0 },
      { id: 'decay_B',      reactants: [species('B')],         products: [species('A')],          rate: 0.20, energyJPerMole: 0 },
      { id: 'autocatalyse', reactants: [species('B'), species('A')],     products: [species('B'), species('B')],     rate: 0.50, energyJPerMole: -10 },
      { id: 'predation',    reactants: [species('B')],         products: [species('C')],          rate: 0.05, energyJPerMole: 20 },
      { id: 'decay_C',      reactants: [species('C')],         products: [species('D')],          rate: 0.10, energyJPerMole: 0 },
      { id: 'recycle',      reactants: [species('D')],         products: [species('A')],          rate: 0.30, energyJPerMole: 0 },
    ],
    source: 'synthetic-Markov, phase-1 demo (P10-2)',
  };
}
