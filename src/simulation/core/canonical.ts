/** Canonical JSON for hashes. Reject values JSON.stringify would silently discard. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function encode(x: unknown): string {
    if (x === null || typeof x === 'boolean' || typeof x === 'string') return JSON.stringify(x);
    if (typeof x === 'number') {
      if (!Number.isFinite(x)) throw new Error('Cannot encode non-finite number');
      return JSON.stringify(x); // -0 is intentionally normalized to 0.
    }
    if (typeof x !== 'object') throw new Error('Not a JSON value');
    if (seen.has(x)) throw new Error('Cannot encode cyclic value');
    seen.add(x);
    let result: string;
    if (Array.isArray(x)) {
      const items: string[] = [];
      for (let i = 0; i < x.length; i++) {
        if (!Object.hasOwn(x, i)) throw new Error('Cannot encode sparse array');
        items.push(encode(x[i]));
      }
      result = `[${items.join(',')}]`;
    } else {
      const proto = Object.getPrototypeOf(x);
      if (proto !== Object.prototype && proto !== null) throw new Error('Expected plain JSON object');
      if (Object.getOwnPropertySymbols(x).length) throw new Error('Symbol keys unsupported');
      const obj = x as Record<string, unknown>;
      result = `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${encode(obj[k])}`).join(',')}}`;
    }
    seen.delete(x);
    return result;
  }
  return encode(value);
}

export async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('');
}
