/**
 * V14 — World Labs (Marble / Atlas / World API / Spark) stub.
 *
 * Per docs/04 §"World Labs 自有许可（待复核）" and the
 * docs/01-02 V-route pause note, the real World Labs
 * integration is **out of scope for phase 1** until the
 * commercial agreement and the API-key distribution are
 * settled. This file is the placeholder: it documents the
 * contract that the eventual integration will satisfy, and
 * throws a clear, honest error if the user actually requests
 * `worldLabs` / `atlas` / `spark`.
 *
 * To enable the real backend in a future phase:
 *   1. Provision an API key (env var `VITE_WORLD_LABS_API_KEY`).
 *   2. Replace the `throw` in `generate` with a `fetch` to the
 *      Marble / Atlas / World API endpoint.
 *   3. Map the response to `V14WorldResult` (the contract is
 *      already finalised in `./types.ts`).
 *
 * The interface is intentionally identical to the in-repo
 * backend so the router doesn't need to know which one is in
 * use.
 */
import type { V14BackendImpl, V14WorldResult, V14WorldSpec } from './types.ts';

export const worldLabsBackend: V14BackendImpl = {
  kind: 'worldLabs',
  sourceLabel: 'World Labs Marble (NOT YET WIRED — needs API key + commercial agreement per docs/04)',
  async generate(_spec: V14WorldSpec): Promise<V14WorldResult> {
    throw new Error(
      'V14 worldLabs backend is not yet wired. ' +
      'Per docs/04, World Labs integration requires an API key ' +
      '(env VITE_WORLD_LABS_API_KEY) and a commercial agreement. ' +
      'Use the in-repo backend for phase 1.',
    );
  },
};

export const atlasBackend: V14BackendImpl = {
  ...worldLabsBackend,
  kind: 'atlas',
  sourceLabel: 'World Labs Atlas (NOT YET WIRED — see worldLabs backend)',
};

export const sparkBackend: V14BackendImpl = {
  ...worldLabsBackend,
  kind: 'spark',
  sourceLabel: 'World Labs Spark (NOT YET WIRED — see worldLabs backend)',
};
