import type { EffortLevel } from '@open-mercato/cezar-contract';
import { runnerDefinition } from './runner-registry.ts';

export interface ModelOption {
  id: string;
  label: string;
  description: string;
  effortLevels?: EffortLevel[];
}

export interface ModelDiscoveryContext { accountHome?: string | undefined }

export type ModelCatalogSource = 'live' | 'cache' | 'unavailable';

export interface RunnerModelCatalogResult {
  /** The runner id as the wire sends it: a string. */
  runner: string;
  models: ModelOption[];
  source: ModelCatalogSource;
  stale: boolean;
  reason?: string;
}

export interface RunnerModelCatalogAdapter {
  discover(options?: ModelDiscoveryContext): Promise<ModelOption[]>;
  /** Native auth/build identity, checked before consulting the TTL. */
  cacheKey?(options: ModelDiscoveryContext): Promise<string>;
}

export interface RunnerModelCatalogOptions {
  adapters: Partial<Record<string, RunnerModelCatalogAdapter>>;
  now?: () => number;
  ttlMs?: number;
}

interface CachedCatalog {
  models: ModelOption[];
  expiresAt: number;
  failureReason?: string;
}

const DEFAULT_TTL_MS = 5 * 60 * 1_000;

/** Host-level, in-memory model discovery cache shared by every workspace. */
export class RunnerModelCatalog {
  readonly #adapters: Partial<Record<string, RunnerModelCatalogAdapter>>;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #cache = new Map<string, CachedCatalog>();
  readonly #inFlight = new Map<string, Promise<RunnerModelCatalogResult>>();
  readonly #generation = new Map<string, number>();
  readonly #identities = new Map<string, string>();
  readonly #runnerGeneration = new Map<string, number>();

  constructor(options: RunnerModelCatalogOptions) {
    this.#adapters = options.adapters;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  invalidate(runner: string): void {
    this.#runnerGeneration.set(runner, (this.#runnerGeneration.get(runner) ?? 0) + 1);
    for (const key of new Set([...this.#cache.keys(), ...this.#inFlight.keys()])) {
      if (key !== runner && !key.startsWith(`${runner}\u0000`)) continue;
      const cached = this.#cache.get(key);
      if (cached) cached.expiresAt = 0;
      this.#inFlight.delete(key);
      this.#generation.set(key, (this.#generation.get(key) ?? 0) + 1);
    }
  }

  get(runner: string, options: ModelDiscoveryContext = {}): Promise<RunnerModelCatalogResult> {
    const adapter = this.#adapters[runner];
    const key = options.accountHome ? `${runner}\u0000${options.accountHome}` : runner;
    if (!adapter?.cacheKey) return this.#get(runner, key, options);
    const generation = this.#runnerGeneration.get(runner) ?? 0;
    return adapter.cacheKey(options).then(value => {
      // An auth refresh during the asynchronous identity probe invalidates its answer too.
      if ((this.#runnerGeneration.get(runner) ?? 0) !== generation) return this.get(runner, options);
      if (this.#identities.get(key) !== value) {
        this.#identities.set(key, value);
        this.#cache.delete(key);
        this.#inFlight.delete(key);
        this.#generation.set(key, (this.#generation.get(key) ?? 0) + 1);
      }
      return this.#get(runner, key, options);
    }, () => ({ runner, models: [], source: 'unavailable' as const, stale: false, reason: unavailableReason(runner) }));
  }

  #get(runner: string, key: string, options: ModelDiscoveryContext): Promise<RunnerModelCatalogResult> {
    const cached = this.#cache.get(key);
    if (cached && this.#now() < cached.expiresAt) {
      if (cached.failureReason) {
        return Promise.resolve({
          runner,
          models: cached.models,
          source: cached.models.length > 0 ? 'cache' : 'unavailable',
          stale: cached.models.length > 0,
          reason: cached.failureReason,
        });
      }
      return Promise.resolve({ runner, models: cached.models, source: 'cache', stale: false });
    }

    const pending = this.#inFlight.get(key);
    if (pending) return pending;

    const generation = this.#generation.get(key) ?? 0;
    const refresh = this.#refresh(runner, key, options, cached, generation).finally(() => {
      if ((this.#generation.get(key) ?? 0) === generation) this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, refresh);
    return refresh;
  }

  async #refresh(
    runner: string,
    key: string,
    options: ModelDiscoveryContext,
    cached: CachedCatalog | undefined,
    generation: number,
  ): Promise<RunnerModelCatalogResult> {
    const current = () => (this.#generation.get(key) ?? 0) === generation;
    try {
      const adapter = this.#adapters[runner];
      if (!adapter) throw new Error('adapter unavailable');
      const models = await (options.accountHome ? adapter.discover(options) : adapter.discover());
      const value = { models: [...models], expiresAt: this.#now() + this.#ttlMs };
      if (current()) this.#cache.set(key, value);
      return { runner, models: value.models, source: 'live', stale: false };
    } catch {
      const reason = unavailableReason(runner);
      if (cached) {
        if (current()) {
          this.#cache.set(key, { models: cached.models, expiresAt: this.#now() + this.#ttlMs, failureReason: reason });
        }
        return { runner, models: cached.models, source: 'cache', stale: true, reason };
      }
      if (current()) {
        this.#cache.set(key, { models: [], expiresAt: this.#now() + this.#ttlMs, failureReason: reason });
      }
      return { runner, models: [], source: 'unavailable', stale: false, reason };
    }
  }
}

function unavailableReason(runner: string): string {
  return `${runnerDefinition(runner).display.modelListName} model discovery is temporarily unavailable`;
}
