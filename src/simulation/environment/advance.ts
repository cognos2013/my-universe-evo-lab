import { cellAlbedos } from './albedo.ts';
import type { WorldState } from '../core/contracts.ts';
export const STEFAN_BOLTZMANN = 5.670374419e-8;

export interface EnvironmentFlux {
  incomingJ: number;
  outgoingJ: number;
  recycledMu: number;
  substeps: number;
}

/** Mutates only an owned working state; public step() provides atomicity. */
export function advanceEnvironment(state: WorldState, seconds: number, forcingWPerM2?: Float64Array): EnvironmentFlux {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Invalid duration');
  const c = state.cells, p = state.rules.environment, n = c.areaM2.length;
  if (forcingWPerM2 && (forcingWPerM2.length !== n || forcingWPerM2.some(x => !Number.isFinite(x)))) throw new Error('Invalid forcing');
  const albedos = cellAlbedos(state);
  const heat = p.heatCapacityJPerM2K, radiationSlope = 4*p.emissivity*STEFAN_BOLTZMANN*400**3;
  let exchangeSlope = 0;
  for (let i = 0; i < n; i++) exchangeSlope = Math.max(exchangeSlope, (c.neighborOffsets[i+1]!-c.neighborOffsets[i]!)*p.heatExchangeWPerM2K);
  const stableDt = 0.1*heat/Math.max(1e-12,radiationSlope+exchangeSlope);
  const steps = Math.max(1,Math.ceil(seconds/Math.min(stableDt,3600)));
  if (steps > 4096) throw new Error('Environment stiffness exceeds substep budget; reduce tick or adjust parameters');
  const dt = seconds/steps, delta = new Float64Array(n);
  const flux: EnvironmentFlux = { incomingJ: 0, outgoingJ: 0, recycledMu: 0, substeps: steps };
  for (let step = 0; step < steps; step++) {
    delta.fill(0);
    for (let i = 0; i < n; i++) {
      const input = p.irradianceWPerM2*(1-albedos[i]!)+(forcingWPerM2?.[i] ?? 0);
      const output = p.emissivity*STEFAN_BOLTZMANN*c.temperatureK[i]!**4;
      const incoming = Math.max(input,0)*c.areaM2[i]!*dt;
      const outgoing = (output+Math.max(-input,0))*c.areaM2[i]!*dt;
      delta[i]! += incoming-outgoing;
      flux.incomingJ += incoming; flux.outgoingJ += outgoing;
      for (let edge = c.neighborOffsets[i]!; edge < c.neighborOffsets[i+1]!; edge++) {
        const j = c.neighborIndices[edge]!;
        if (j <= i) continue;
        const exchange = p.heatExchangeWPerM2K*Math.min(c.areaM2[i]!,c.areaM2[j]!)*(c.temperatureK[j]!-c.temperatureK[i]!)*dt;
        delta[i]! += exchange; delta[j]! -= exchange;
      }
    }
    for (let i = 0; i < n; i++) {
      c.temperatureK[i]! += delta[i]!/(heat*c.areaM2[i]!);
      if (!Number.isFinite(c.temperatureK[i]) || c.temperatureK[i]! < 150 || c.temperatureK[i]! > 400) throw new Error(`Temperature outside model range at cell ${i}`);
    }
  }
  const fraction = -Math.expm1(-p.recyclingPerSecond*seconds);
  for (let i = 0; i < n; i++) {
    const recycled = c.detritusMu[i]!*fraction;
    c.detritusMu[i]! -= recycled; c.nutrientMu[i]! += recycled; flux.recycledMu += recycled;
  }
  state.ledger.externalEnergyInJ += flux.incomingJ;
  state.ledger.externalEnergyOutJ += flux.outgoingJ;
  return flux;
}
