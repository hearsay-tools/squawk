/** Process-wide registries register first, seal at boot, then allow normal reads. */
interface RegistryOptions {
  name: string;
  bootHint: string;
}

function lifecycle({ name, bootHint }: RegistryOptions) {
  let sealed = false;
  return {
    seal() { sealed = true; },
    isSealed: () => sealed,
    assertReadable() {
      if (!sealed) throw new Error(`${name} is unsealed: ${bootHint}`);
    },
    assertWritable() {
      if (sealed) throw new Error(`${name} is sealed: register every entry before sealing. ${bootHint}`);
    },
  };
}

/** A keyed registry with passive inspection for cold callers. Returned arrays are snapshots. */
export function createKeyedRegistry<K extends string, V>(options: RegistryOptions & { reservedKeys?: ReadonlySet<string> | readonly string[] }) {
  const state = lifecycle(options);
  const entries = new Map<K, V>();
  const reserved = new Set(options.reservedKeys);
  return {
    seal: state.seal,
    isSealed: state.isSealed,
    register(key: K, value: V) {
      if (reserved.has(key)) throw new Error(`${options.name}: reserved legacy key '${key}'.`);
      if (entries.has(key)) {
        if (entries.get(key) === value) return;
        throw new Error(`${options.name}: conflicting registration for '${key}'.`);
      }
      state.assertWritable();
      entries.set(key, value);
    },
    get(key: K) { state.assertReadable(); return entries.get(key); },
    has(key: K) { state.assertReadable(); return entries.has(key); },
    values() { state.assertReadable(); return [...entries.values()]; },
    keys() { state.assertReadable(); return [...entries.keys()]; },
    entries() { state.assertReadable(); return [...entries.entries()]; },
    peekKeys: () => [...entries.keys()],
    peekHas: (key: K) => entries.has(key),
  };
}

/** An ordered list that ignores repeated registration of the same reference. */
export function createListRegistry<V>(options: RegistryOptions) {
  const state = lifecycle(options);
  const items: V[] = [];
  return {
    seal: state.seal,
    isSealed: state.isSealed,
    register(item: V) {
      if (items.some(value => value === item)) return;
      state.assertWritable();
      items.push(item);
    },
    values() { state.assertReadable(); return [...items]; },
  };
}

/** A single registration. Even a sealed slot fails closed when it is empty. */
export function createSingleRegistry<V>(options: RegistryOptions) {
  const state = lifecycle(options);
  let entry: { value: V } | undefined;
  return {
    seal: state.seal,
    isSealed: state.isSealed,
    register(value: V) {
      if (entry) {
        if (entry.value === value) return;
        throw new Error(`${options.name}: a different value is already registered.`);
      }
      state.assertWritable();
      entry = { value };
    },
    has() { state.assertReadable(); return entry !== undefined; },
    get(): V {
      state.assertReadable();
      if (!entry) throw new Error(`${options.name}: missing registration. ${options.bootHint}`);
      return entry.value;
    },
  };
}
