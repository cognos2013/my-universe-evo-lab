/**
 * V14 — backend router.
 *
 * The single entry point `generateWorld(spec, options)` picks
 * the right backend (default: inRepo) and returns the result.
 * The router is intentionally tiny: it just maps `backend`
 * strings to backend implementations, so adding a new
 * provider (e.g. real World Labs, internal tool, third-party)
 * is a one-line change.
 *
 * Each backend implements `V14BackendImpl`:
 *
 *   - `kind`: the discriminator string.
 *   - `sourceLabel`: human-readable provenance for the UI banner.
 *   - `generate(spec)`: returns a `V14WorldResult`.
 */
import type { V14Backend, V14BackendImpl, V14WorldResult, V14WorldSpec } from './types.ts';
import { validateV14Spec } from './types.ts';
import { inRepoBackend } from './inRepo.ts';
import { atlasBackend, sparkBackend, worldLabsBackend } from './worldLabs.ts';

const BACKENDS: Record<V14Backend, V14BackendImpl> = {
  inRepo: inRepoBackend,
  worldLabs: worldLabsBackend,
  atlas: atlasBackend,
  spark: sparkBackend,
};

export interface GenerateOptions {
  backend?: V14Backend;
}

/** Resolve the backend implementation for `backend`, falling
 *  back to `inRepo` for unknown values (defensive default). */
export function resolveBackend(backend: V14Backend | string | undefined): V14BackendImpl {
  if (backend && Object.prototype.hasOwnProperty.call(BACKENDS, backend)) {
    return BACKENDS[backend as V14Backend];
  }
  return inRepoBackend;
}

export async function generateWorld(
  spec: V14WorldSpec,
  options: GenerateOptions = {},
): Promise<V14WorldResult> {
  validateV14Spec(spec);
  const backend = resolveBackend(options.backend);
  return backend.generate(spec);
}
