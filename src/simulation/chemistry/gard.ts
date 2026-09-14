/**
 * P10-2 — synthetic GARD-like chemical network.
 *
 * The real GARD model (Glass / Segré / Lancet) is a
 * compositionally-tunable lipid-world chemistry that exhibits
 * replication, selection, and homeostasis on a stochastic
 * simulation. Downloading the reference data is out of scope for
 * phase 1; this file ships a *synthetic* GARD-like network that
 * captures the key qualitative behaviour: a small molecule
 * (lipid L) catalyses its own production from a food source
 * (precursor P), with a replicator R and a waste sink W for
 * mass balance.
 *
 * The network has the same `{ species, reactions }` shape as
 * `loadReactionNetwork` expects, so it can be passed straight
 * into `makeReactorState` / `stepReactor` with no special-case
 * logic. The point of having it is that the `chemistryLoad`
 * handler can offer a "synthetic-GARD" source alongside
 * "synthetic-markov" and "raw" — i.e. the loader path exercises
 * the full `loadGardNetwork` contract without bundling MBs of
 * real data.
 *
 * The numbers are illustrative, not calibrated to any specific
 * GARD parameter set.
 */
import type { ReactionNetwork } from './network.ts';
import { species } from './network.ts';

/**
 * Build a synthetic GARD-like network. The lipid world
 * `L` self-replicates from precursor `P` (with `F` as a food
 * source), `R` is a templating replicator that copies itself
 * with `L`-catalysis, and `W` is a waste sink.
 *
 * Topology (rates chosen to give `R` a long but finite lifetime
 * at zero energy — mirrors the P12 acceptance gate "extinct if
 * no energy; stable with energy"):
 *
 *   P + F → L + P           (base production, energy-neutral)
 *   L + P → 2L              (self-catalysis, exothermic)
 *   L + P → L + R            (templating, slight energy cost)
 *   R + P → 2R + L            (templated replication, energy cost)
 *   2L → W                  (decay / aggregation, neutral)
 *   R → W                   (replicator decay, neutral)
 */
export function syntheticGardNetwork(): ReactionNetwork {
  return {
    species: (['P', 'F', 'L', 'R', 'W'] as const).map(species),
    reactions: [
      { id: 'produce',   reactants: [species('F')],      products: [species('L')],         rate: 0.05, energyJPerMole: 0 },
      { id: 'catalyse',  reactants: [species('L'), species('P')], products: [species('L'), species('L')], rate: 0.02, energyJPerMole: -10 },
      { id: 'template',  reactants: [species('L'), species('P')], products: [species('L'), species('R')], rate: 0.01, energyJPerMole: 5 },
      { id: 'replicate', reactants: [species('R'), species('P')], products: [species('R'), species('R')], rate: 0.05, energyJPerMole: 30 },
      { id: 'decay_L',   reactants: [species('L'), species('L')], products: [species('W')], rate: 0.01, energyJPerMole: 0 },
      { id: 'decay_R',   reactants: [species('R')],      products: [species('W')],         rate: 0.05, energyJPerMole: 0 },
    ],
    source: 'synthetic-GARD, phase-1 demo (P10-2)',
  };
}
