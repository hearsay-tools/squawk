/**
 * Look a wire string up in a plain-object table by own keys only. A plain index returns
 * `Object.prototype` members for keys such as `toString`, `constructor` or `__proto__`.
 */
export function ownLookup<V>(table: Readonly<Record<string, V>>, key: unknown): V | undefined {
  return typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined;
}
