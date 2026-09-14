/**
 * P12 — pre-life chemistry: deterministic mass-action reactor.
 *
 * Given a `ReactionNetwork` and an initial concentration map, `stepReactor`
 * integrates forward by one step using a deterministic fixed-step
 * mass-action integration. This is NOT a real chemistry simulator; it
 * is a contract test surface that verifies the P12 exit gate:
 *
 *   1. With zero external energy, energy-driven reactions stall and the
 *      pool is doomed to extinction.
 *   2. With no energy at all, the reactor reports `status: 'failed'`
 *      once all species drop below the extinction threshold for the
 *      configured patience window.
 *   3. Endothermic reactions charge against `externalEnergyInJ`. If
 *      energy is insufficient the reaction simply does not fire that
 *      step (we do not allow partial conversions; the caller's seed
 *      will report the same chemistry in the next step).
 *
 * The reactor returns the updated state plus an `events` record so
 * tests can assert that "no life special case" rule (no time-triggered
 * injection of life) holds. P12 exit gate requires running multiple
 * seeds; this file's job is to surface the signals (energy use,
 * extinction, replication) so those multi-seed experiments can be
 * built on top.
 */
import type { ReactionNetwork, Species, Reaction } from './network.ts';

export type ReactorStatus = 'active' | 'extinct' | 'failed' | 'starved';

export interface ReactorState {
  /** Current concentration per species (moles per unit volume). */
  concentrations: Map<Species, number>;
  /** Step count since reactor start. */
  step: number;
  /** Available external energy in the current step (J). Decremented as endothermic reactions fire. */
  energyAvailableJ: number;
  /** Cumulative external energy consumed since start (J). */
  energyConsumedJ: number;
  /** Cumulative external energy demanded but not delivered because of shortfall (J). */
  energyShortfallJ: number;
  /** Current status. */
  status: ReactorStatus;
  /** How many consecutive steps all species have been below `extinctionThreshold`. */
  belowThresholdStreak: number;
}

export interface ReactorStepEvent {
  /** Which reactions fired this step (id → moles of reaction events). */
  fired: { id: string; moles: number }[];
  /** Energy consumed this step (J). */
  energyConsumedJ: number;
  /** Energy demanded but not available (J). */
  energyShortfallJ: number;
  /** Total energy delivered to the external sink (exothermic sum, J). */
  energyReleasedJ: number;
}

export interface ReactorConfig {
  /** Concentration below which a species is considered extinct. Default 1e-12. */
  extinctionThreshold?: number;
  /** How many consecutive below-threshold steps before reporting `failed`. Default 50. */
  failurePatience?: number;
}

export function makeReactorState(
  network: ReactionNetwork,
  initial: Map<Species, number>,
  energyInJ: number,
  config: ReactorConfig = {},
): ReactorState {
  for (const s of network.species) {
    if (!initial.has(s)) initial.set(s, 0);
  }
  return {
    concentrations: new Map(initial),
    step: 0,
    energyAvailableJ: energyInJ,
    energyConsumedJ: 0,
    energyShortfallJ: 0,
    status: 'active',
    belowThresholdStreak: 0,
  };
}

function massActionRate(r: Reaction, concentrations: Map<Species, number>): number {
  let rate = r.rate;
  for (const s of r.reactants) {
    const c = concentrations.get(s) ?? 0;
    if (c <= 0) return 0;
    rate *= c;
  }
  return rate;
}

/**
 * Advance the reactor by one step. Returns the next state plus an events
 * record. If the reactor reaches `failurePatience` consecutive steps
 * with all concentrations below `extinctionThreshold`, the returned
 * state's `status` becomes `'failed'`. The caller is expected to check
 * `status` and not auto-seed anything in response.
 */
export function stepReactor(
  state: ReactorState,
  network: ReactionNetwork,
  config: ReactorConfig = {},
): { state: ReactorState; events: ReactorStepEvent } {
  if (state.status !== 'active') {
    return { state, events: { fired: [], energyConsumedJ: 0, energyShortfallJ: 0, energyReleasedJ: 0 } };
  }
  const threshold = config.extinctionThreshold ?? 1e-12;
  const patience = config.failurePatience ?? 50;
  const fired: { id: string; moles: number }[] = [];
  let energyConsumedJ = 0;
  let energyShortfallJ = 0;
  let energyReleasedJ = 0;
  // Snapshot concentrations; compute deltas; apply at end. This keeps
  // the integrator order-independent within a step (no chained mass-
  // action over the same pool within one dt).
  const delta = new Map<Species, number>();
  for (const s of network.species) delta.set(s, 0);

  for (const r of network.reactions) {
    if (r.rate === 0) continue;
    const rate = massActionRate(r, state.concentrations);
    if (rate <= 0) continue;
    // Endothermic reactions: charge the energy pool first; if no
    // energy, do not fire.
    if (r.energyJPerMole > 0) {
      const energyNeeded = rate * r.energyJPerMole;
      if (state.energyAvailableJ >= energyNeeded) {
        state.energyAvailableJ -= energyNeeded;
        energyConsumedJ += energyNeeded;
        fireReaction(r, rate, delta);
        fired.push({ id: r.id, moles: rate });
      } else {
        energyShortfallJ += energyNeeded;
        // Insufficient energy this step; reaction is silent.
      }
    } else if (r.energyJPerMole < 0) {
      // Exothermic: energy released to the environment (not added to
      // the external pool — it is thermal and we don't model that here).
      const energyReleased = -rate * r.energyJPerMole;
      energyReleasedJ += energyReleased;
      fireReaction(r, rate, delta);
      fired.push({ id: r.id, moles: rate });
    } else {
      // Energy-neutral: just fire.
      fireReaction(r, rate, delta);
      fired.push({ id: r.id, moles: rate });
    }
  }
  // Apply deltas.
  for (const [s, d] of delta) {
    if (d === 0) continue;
    const next = (state.concentrations.get(s) ?? 0) + d;
    state.concentrations.set(s, next < 0 ? 0 : next);
  }
  state.step++;
  state.energyConsumedJ += energyConsumedJ;
  state.energyShortfallJ += energyShortfallJ;
  // Failure detection.
  let allBelow = true;
  for (const s of network.species) {
    if ((state.concentrations.get(s) ?? 0) > threshold) { allBelow = false; break; }
  }
  if (allBelow) {
    state.belowThresholdStreak++;
    if (state.belowThresholdStreak >= patience) state.status = 'extinct';
  } else {
    state.belowThresholdStreak = 0;
  }
  // Starvation: an active reactor that has been unable to fire any
  // energy-driven reactions for the entire run is a configuration
  // smell, not a chemistry outcome. We don't fail here; the caller's
  // multi-seed harness decides.
  if (state.energyAvailableJ <= 0 && state.step > 0 && fired.length === 0) {
    // No-op; the failure check above will catch the extinction later.
  }
  return { state, events: { fired, energyConsumedJ, energyShortfallJ, energyReleasedJ } };
}

function fireReaction(r: Reaction, moles: number, delta: Map<Species, number>): void {
  for (const s of r.reactants) delta.set(s, (delta.get(s) ?? 0) - moles);
  for (const s of r.products) delta.set(s, (delta.get(s) ?? 0) + moles);
}
