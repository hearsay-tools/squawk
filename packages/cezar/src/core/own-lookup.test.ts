import { describe, expect, it } from 'vitest';
import { ownLookup } from './own-lookup.ts';

describe('ownLookup', () => {
  const table: Readonly<Record<string, string>> = { done: 'completed', error: 'failed' };

  it('returns the value of an own key', () => {
    expect(ownLookup(table, 'done')).toBe('completed');
    expect(ownLookup(table, 'error')).toBe('failed');
  });

  it('returns undefined for an unknown key, an Object.prototype member or a non-string key', () => {
    for (const key of ['nope', 'toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf', '']) {
      expect(ownLookup(table, key)).toBeUndefined();
    }
    for (const key of [undefined, null, 1, {}, ['done']]) {
      expect(ownLookup(table, key)).toBeUndefined();
    }
  });
});
