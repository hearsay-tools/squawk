/** A bounded process queue shared by cache misses. */
export function readQueue(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(read: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try { return await read(); }
    finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/** Entries include pending reads; invalidation detaches them without cancelling their callers. */
export function boundedReadCache<T>(ttl: number, max: number) {
  const entries = new Map<string, { until: number; value: Promise<T> }>();
  return {
    read(key: string, load: () => Promise<T>): Promise<T> {
      const hit = entries.get(key);
      if (hit && hit.until > Date.now()) return hit.value;
      const entry = { until: Infinity, value: Promise.resolve().then(load) };
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > max) entries.delete(entries.keys().next().value!);
      void entry.value.then(() => { entry.until = Date.now() + ttl; }, () => {
        if (entries.get(key) === entry) entries.delete(key);
      });
      return entry.value;
    },
    forget(key: string) { entries.delete(key); },
    clear() { entries.clear(); },
  };
}

/** Request-local memoization includes undefined results. */
export function memoizeRead<T>(read: (id: string) => T): (id: string) => T {
  const values = new Map<string, T>();
  return (id) => {
    if (!values.has(id)) values.set(id, read(id));
    return values.get(id)!;
  };
}
