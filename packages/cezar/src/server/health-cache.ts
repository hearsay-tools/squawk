/**
 * Server-side health cache (stale-while-revalidate). The snapshot reads Git and workspace state,
 * and each Git read spawns a child process on the server loop. Paying that on the browser's FIRST
 * `GET /api/health` is the few-seconds-blank the cockpit showed at load, so the live server computes
 * the snapshot at its own pace: the GET and the WS `health` topic serve the cached value at once and
 * revalidate behind the response, and the cache is pre-warmed at boot.
 */

/** How often a read starts a revalidation. */
export const HEALTH_TTL_MS = 5_000;
/**
 * The staleness CEILING, a different job from the TTL. The TTL decides how often a revalidation
 * starts; on its own it bounds nothing, because the revalidation is fire-and-forget. While a cockpit
 * holds the `health` topic the publisher's interval keeps the cache warm — but the normal state of a
 * background `hsq serve` is NO subscriber, and then nothing refreshes the cache at all: the next GET,
 * an hour later, would answer with the boot pre-warm's payload. `repo.branch` going stale there is
 * hearsay-tools/cezarion#369, so past this age the read waits for the compute.
 */
export const HEALTH_MAX_STALE_MS = 60_000;

export interface HealthCache<T> {
  /** Compute a new snapshot. Concurrent callers share ONE compute rather than racing two. */
  refresh(): Promise<T>;
  /**
   * The cached payload, revalidated behind the read when stale, awaited when too old or absent.
   * `serveCached` shapes only a payload served from the cache; a computed one is returned as is.
   */
  read(serveCached?: (payload: T) => T): Promise<T>;
  /**
   * Change the cached payload without a new snapshot, after any cold snapshot finishes. The cache
   * keeps its age, so the fields it did not change keep their TTL and staleness ceiling. With no
   * cached payload it computes one.
   */
  patch(update: (payload: T) => T): Promise<void>;
}

export function createHealthCache<T>(options: {
  snapshot: () => Promise<T>;
  /** Called only when the serialized payload changed. */
  publish: (payload: T) => void;
  now?: () => number;
}): HealthCache<T> {
  const now = options.now ?? Date.now;
  let cache: { at: number; payload: T; body: string } | undefined;
  let inFlight: Promise<T> | undefined;
  const store = (payload: T, at: number): void => {
    const body = JSON.stringify(payload);
    const changed = body !== cache?.body;
    cache = { at, payload, body };
    if (changed) options.publish(payload);
  };
  const refresh = (): Promise<T> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const payload = await options.snapshot();
        store(payload, now());
        return payload;
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };
  return {
    refresh,
    async read(serveCached = (payload) => payload) {
      if (!cache) return refresh();
      const age = now() - cache.at;
      if (age > HEALTH_MAX_STALE_MS) return refresh();
      if (age > HEALTH_TTL_MS) void refresh().catch(() => {});
      return serveCached(cache.payload);
    },
    async patch(update) {
      await inFlight?.catch(() => {});
      if (cache) store(update(cache.payload), cache.at);
      else await refresh();
    },
  };
}
