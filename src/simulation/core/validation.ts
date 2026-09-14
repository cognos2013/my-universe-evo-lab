export class ValidationError extends Error {
  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = 'ValidationError';
  }
}

export function fail(path: string, reason: string): never { throw new ValidationError(path, reason); }

export function object(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected object');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(path, 'expected plain object');
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) if (!keys.includes(key)) fail(`${path}.${key}`, 'unknown field');
  for (const key of keys) if (!Object.hasOwn(obj, key)) fail(`${path}.${key}`, 'required');
  return obj;
}

export function number(value: unknown, path: string, min = 0, max = Number.MAX_VALUE): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(path, `expected finite number in [${min}, ${max}]`);
  }
  return value;
}

export function integer(value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const n = number(value, path, min, max);
  if (!Number.isSafeInteger(n)) fail(path, 'expected safe integer');
  return n;
}

export function text(value: unknown, path: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(path, `expected nonempty string, max ${max} characters`);
  return value;
}

export function id(value: unknown, path: string): string {
  const s = text(value, path, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(s)) fail(path, 'invalid ID');
  return s;
}

export function choice<T extends string | number>(value: unknown, options: readonly T[], path: string): T {
  if (!options.includes(value as T)) fail(path, `expected ${options.join(' | ')}`);
  return value as T;
}

export function array(value: unknown, path: string, max = 10000): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(path, `expected array, max length ${max}`);
  // Sparse arrays are not valid interchange data.
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) fail(`${path}[${i}]`, 'missing item');
  return value;
}

export function unique(values: readonly (string | number)[], path: string): void {
  if (new Set(values).size !== values.length) fail(path, 'duplicate value');
}

export function ids(value: unknown, path: string, max = 10000): string[] {
  const result = array(value, path, max).map((v, i) => id(v, `${path}[${i}]`));
  unique(result, path);
  return result;
}

export function hash(value: unknown, path: string): string {
  const s = text(value, path, 64);
  if (!/^[0-9a-f]{64}$/.test(s)) fail(path, 'expected SHA-256 hex digest');
  return s;
}
