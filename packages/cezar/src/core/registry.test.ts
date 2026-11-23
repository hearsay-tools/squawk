import { describe, expect, it } from 'vitest';
import { createKeyedRegistry, createListRegistry, createSingleRegistry } from './registry.ts';

const options = { name: 'test registry', bootHint: 'call bootTestRegistry()' };
const unreadable = /test registry.*bootTestRegistry\(\)/;

describe('keyed registry lifecycle', () => {
  it('fails closed on normal reads and permits passive inspection before sealing', () => {
    const registry = createKeyedRegistry<string, object>(options);
    for (const read of [() => registry.get('a'), () => registry.has('a'), registry.values, registry.keys, registry.entries]) {
      expect(read).toThrow(unreadable);
    }
    expect(registry.isSealed()).toBe(false);
    expect(registry.peekKeys()).toEqual([]);
    expect(registry.peekHas('a')).toBe(false);
    const value = {};
    registry.register('a', value);
    expect(registry.peekKeys()).toEqual(['a']);
    expect(registry.peekHas('a')).toBe(true);
    expect(() => registry.get('a')).toThrow(unreadable);
  });

  it('keeps registration order, seals idempotently, and returns detached snapshots', () => {
    const registry = createKeyedRegistry<string, object>(options);
    const a = {}, b = {};
    registry.register('b', b);
    registry.register('a', a);
    registry.register('b', b);
    registry.seal();
    registry.seal();
    expect(registry.isSealed()).toBe(true);
    registry.register('b', b);
    expect(registry.keys()).toEqual(['b', 'a']);
    expect(registry.values()).toEqual([b, a]);
    expect(registry.entries()).toEqual([['b', b], ['a', a]]);
    expect(registry.get('a')).toBe(a);
    expect(registry.has('missing')).toBe(false);
    expect(registry.get('missing')).toBeUndefined();
    registry.keys().pop();
    registry.values().pop();
    registry.entries().pop();
    registry.peekKeys().pop();
    expect(registry.keys()).toEqual(['b', 'a']);
    expect(() => registry.register('new', {})).toThrow(/sealed/);
  });

  it.each([false, true])('rejects conflicts and reserved keys (sealed=%s)', sealed => {
    const registry = createKeyedRegistry<string, object>({ ...options, reservedKeys: new Set(['legacy']) });
    const value = {};
    registry.register('a', value);
    if (sealed) registry.seal();
    expect(() => registry.register('a', value)).not.toThrow();
    expect(() => registry.register('a', {})).toThrow(/conflicting.*a/);
    expect(() => registry.register('legacy', value)).toThrow(/legacy.*legacy/);
  });
});

describe('list registry lifecycle', () => {
  it('requires sealing, keeps reference order, and refuses new entries after sealing', () => {
    const registry = createListRegistry<object>(options);
    const a = {}, b = {};
    expect(registry.isSealed()).toBe(false);
    expect(registry.values).toThrow(unreadable);
    registry.register(a);
    registry.register(a);
    registry.register(b);
    expect(registry.values).toThrow(unreadable);
    registry.seal();
    registry.seal();
    registry.register(a);
    expect(registry.isSealed()).toBe(true);
    expect(registry.values()).toEqual([a, b]);
    registry.values().pop();
    expect(registry.values()).toEqual([a, b]);
    expect(() => registry.register({})).toThrow(/sealed/);
  });
});

describe('single registry lifecycle', () => {
  it('fails closed before seal and when sealed empty', () => {
    const registry = createSingleRegistry<object>(options);
    expect(registry.isSealed()).toBe(false);
    expect(registry.get).toThrow(unreadable);
    expect(registry.has).toThrow(unreadable);
    registry.seal();
    registry.seal();
    expect(registry.isSealed()).toBe(true);
    expect(registry.has()).toBe(false);
    expect(registry.get).toThrow(unreadable);
    expect(() => registry.register({})).toThrow(/sealed/);
  });

  it.each([false, true])('accepts only the same reference twice (sealed=%s)', sealed => {
    const registry = createSingleRegistry<() => void>(options);
    const factory = () => {};
    registry.register(factory);
    if (sealed) registry.seal();
    registry.register(factory);
    expect(() => registry.register(() => {})).toThrow(/different value/);
    if (!sealed) expect(registry.get).toThrow(unreadable);
    registry.seal();
    expect(registry.has()).toBe(true);
    expect(registry.get()).toBe(factory);
  });
});
