/**
 * P12 — pre-life chemistry: chemical-reaction network contract.
 *
 * Per docs/15 P12: "no alive-initial-value case; the declared reaction
 * network and external energy input must support replication, heritable
 * variation and persistence; failure is allowed when resources run out".
 *
 * This file defines only the *interface* and a deterministic mass-action
 * simulator. A real-world reaction network (e.g. GARD, Markov-state or
 * protocell models) would plug in via `loadReactionNetwork` and use
 * the same reactor. The reactor in `reactor.ts` follows three hard
 * rules from the P12 exit gate:
 *
 *   1. The reaction rules must not contain any "spawn the first life
 *      on day N" special case. We do not look at the time axis to
 *      inject life.
 *   2. External energy must be charged against the ledger. If
 *      `externalEnergyInJ` is zero, no energy-driven reactions proceed.
 *   3. If all species drop below `extinctionThreshold` for `failurePatience`
 *      consecutive steps, the reactor reports `status: 'failed'`. The
 *      caller must NOT auto-seed living cells; it must record the
 *      failure and run a different seed.
 */
import * as v from '../core/validation.ts';

/** A chemical species identifier (e.g. "A", "B", "RNAP", "lipid"). */
export type Species = string & { readonly __brand: 'Species' };

export function species(name: string): Species {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(name)) {
    throw new Error(`Invalid species name: ${name} (must match /^[A-Za-z][A-Za-z0-9_-]{0,31}$/)`);
  }
  return name as Species;
}

/**
 * A single chemical reaction.
 *
 * `rate` is a mass-action rate constant in (concentration · step)⁻¹ for
 * the per-reactant multiplicity sum. `energyJPerMole` is the free
 * energy per mole of reaction event; positive = endothermic (consumes
 * energy from the external source), negative = exothermic (releases
 * energy to the environment).
 */
export interface Reaction {
  id: string;
  /** One or more reactants consumed per event. */
  reactants: Species[];
  /** One or more products produced per event. */
  products: Species[];
  /** Mass-action rate constant; 0 disables the reaction. */
  rate: number;
  /** Free energy per mole of reaction (J/mol). Positive = endothermic. */
  energyJPerMole: number;
}

/** Topology: declarations of species and reactions. */
export interface ReactionNetwork {
  /** All species referenced in any reaction. */
  species: Species[];
  reactions: Reaction[];
  /** Human-readable provenance; not validated, just stored. */
  source?: string;
}

/** Validate arbitrary input as a `ReactionNetwork`. */
export function loadReactionNetwork(input: unknown): ReactionNetwork {
  const t = v.object(input, ['species', 'reactions'], 'reactionNetwork');
  const speciesList = v.array(t.species, 'reactionNetwork.species', 64);
  const validatedSpecies: Species[] = [];
  for (let i = 0; i < speciesList.length; i++) {
    if (typeof speciesList[i] !== 'string') {
      v.fail('reactionNetwork.species', `entry ${i} must be a string`);
    }
    validatedSpecies.push(species(speciesList[i] as string));
  }
  const speciesSet = new Set(validatedSpecies);
  const reactionsRaw = v.array(t.reactions, 'reactionNetwork.reactions', 256);
  const validatedReactions: Reaction[] = [];
  const reactionIds = new Set<string>();
  for (let i = 0; i < reactionsRaw.length; i++) {
    const r = v.object(reactionsRaw[i]!, ['id', 'reactants', 'products', 'rate', 'energyJPerMole'], 'reactionNetwork.reaction');
    if (reactionIds.has(r.id as string)) v.fail('reaction.id', `duplicate reaction id: ${r.id}`);
    reactionIds.add(r.id as string);
    const reactants = v.array(r.reactants, 'reaction.reactants', 8);
    const products = v.array(r.products, 'reaction.products', 8);
    // Both empty is a no-op. Reactants only (e.g. A → ∅) means
    // *decay* / removal. Products only (e.g. ∅ → A) means *synthesis*
    // driven by an external energy source. Both are valid chemistry;
    // both empty is not.
    if (reactants.length === 0 && products.length === 0) {
      v.fail('reaction.reactants', 'reaction with neither reactants nor products is a no-op');
    }
    const seenReactant = new Set<string>();
    const reactantsTyped: Species[] = reactants.map((s, j) => {
      if (typeof s !== 'string') v.fail(`reaction.reactants[${j}]`, 'must be a string');
      if (seenReactant.has(s)) v.fail(`reaction.reactants[${j}]`, `duplicate reactant ${s}`);
      seenReactant.add(s);
      if (!speciesSet.has(s as Species)) v.fail(`reaction.reactants[${j}]`, `unknown species ${s}`);
      return s as Species;
    });
    const productsTyped: Species[] = products.map((s, j) => {
      if (typeof s !== 'string') v.fail(`reaction.products[${j}]`, 'must be a string');
      if (!speciesSet.has(s as Species)) v.fail(`reaction.products[${j}]`, `unknown species ${s}`);
      return s as Species;
    });
    validatedReactions.push({
      id: r.id as string,
      reactants: reactantsTyped,
      products: productsTyped,
      rate: v.number(r.rate, 'reaction.rate', 0, 1e6),
      energyJPerMole: v.number(r.energyJPerMole, 'reaction.energyJPerMole', -1e12, 1e12),
    });
  }
  // Every species must be referenced by at least one reaction; orphan
  // species are a config smell (no source, no sink).
  const referenced = new Set<Species>();
  for (const r of validatedReactions) {
    for (const s of r.reactants) referenced.add(s);
    for (const s of r.products) referenced.add(s);
  }
  for (const s of validatedSpecies) {
    if (!referenced.has(s)) v.fail('reactionNetwork.species', `orphan species ${s} (no reaction references it)`);
  }
  const net: ReactionNetwork = { species: validatedSpecies, reactions: validatedReactions };
  if (typeof t.source === 'string') net.source = t.source;
  return net;
}
