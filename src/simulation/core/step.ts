import { forcingField } from './execution.ts';
import { advanceLife } from '../life/advance.ts';
import type { WorldState } from './contracts.ts';
import { validateState } from './state.ts';
import { advanceEnvironment } from '../environment/advance.ts';

export function stepEnvironment(input: WorldState): WorldState {
  validateState(input);
  if (input.tick === Number.MAX_SAFE_INTEGER) throw new Error('Tick overflow');
  const next = structuredClone(input);
  advanceEnvironment(next,next.rules.tickSeconds);
  next.tick++;
  validateState(next);
  return next;
}

export async function stepWorld(input: WorldState) {
  validateState(input);
  if (input.tick === Number.MAX_SAFE_INTEGER) throw new Error('Tick overflow');
  const next = structuredClone(input);
  const forcing=forcingField(next);
  const first = advanceEnvironment(next,next.rules.tickSeconds/2,forcing);
  const life = advanceLife(next,next.rules.tickSeconds);
  const second = advanceEnvironment(next,next.rules.tickSeconds/2,forcing);
  next.tick++;
  next.execution.forcings=next.execution.forcings.filter(f=>f.endTick>next.tick);
  validateState(next);
  return { state: next, life, environment: { incomingJ:first.incomingJ+second.incomingJ, outgoingJ:first.outgoingJ+second.outgoingJ, recycledMu:first.recycledMu+second.recycledMu } };
}
