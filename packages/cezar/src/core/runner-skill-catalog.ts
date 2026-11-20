import type { RunnerSkillList } from '@open-mercato/cezar-contract/runner-skills';

export type SkillCatalog = Pick<RunnerSkillList, 'skills' | 'problems'>;
export interface SkillCatalogQuery { runner: string; cwd: string; accountHome?: string | undefined }
export interface RunnerSkillCatalogAdapter {
  discover(query: SkillCatalogQuery, signal: AbortSignal): Promise<SkillCatalog>;
}
interface Entry { value?: SkillCatalog | undefined; expiresAt: number; reason?: string }

/** Folder and account sensitive, with concurrent callers joined and last good lists retained. */
export class RunnerSkillCatalog {
  readonly #cache = new Map<string, Entry>();
  readonly #pending = new Map<string, Promise<RunnerSkillList>>();
  readonly #generation = new Map<string, number>();
  readonly #now: () => number;
  readonly #ttl: number;
  readonly #timeout: number;
  constructor(readonly options: {
    adapters: Partial<Record<string, RunnerSkillCatalogAdapter>>;
    now?: () => number;
    ttlMs?: number;
    timeoutMs?: number;
  }) {
    this.#now = options.now ?? Date.now;
    this.#ttl = options.ttlMs ?? 300_000;
    this.#timeout = options.timeoutMs ?? 15_000;
  }

  invalidate(query: SkillCatalogQuery): void {
    const key = catalogKey(query);
    const entry = this.#cache.get(key);
    if (entry) entry.expiresAt = 0;
    this.#pending.delete(key);
    this.#generation.set(key, (this.#generation.get(key) ?? 0) + 1);
  }

  get(query: SkillCatalogQuery): Promise<RunnerSkillList> {
    const key = catalogKey(query);
    const entry = this.#cache.get(key);
    if (entry && entry.expiresAt > this.#now()) return Promise.resolve(answer(query.runner, entry));
    const pending = this.#pending.get(key);
    if (pending) return pending;
    const generation = this.#generation.get(key) ?? 0;
    const current = () => (this.#generation.get(key) ?? 0) === generation;
    const refresh = this.#refresh(query, entry).then(result => {
      if (current()) this.#cache.set(key, result);
      return answer(query.runner, result, true);
    }).finally(() => { if (current()) this.#pending.delete(key); });
    this.#pending.set(key, refresh);
    return refresh;
  }

  async #refresh(query: SkillCatalogQuery, old?: Entry): Promise<Entry> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let discovery: Promise<SkillCatalog> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, this.#timeout);
    });
    try {
      const adapter = this.options.adapters[query.runner];
      if (!adapter) throw new Error('adapter missing');
      discovery = adapter.discover(query, controller.signal);
      const value = await Promise.race([discovery, deadline]);
      return { value: structuredClone(value), expiresAt: this.#now() + this.#ttl };
    } catch {
      return { value: old?.value, expiresAt: this.#now() + this.#ttl,
        reason: `${query.runner} skill discovery is temporarily unavailable` };
    } finally {
      clearTimeout(timer);
      if (controller.signal.aborted && discovery) await settleCancelledProbe(discovery);
    }
  }
}
function catalogKey(query: SkillCatalogQuery): string {
  return JSON.stringify([query.runner, query.accountHome ?? null, query.cwd]);
}
function answer(runner: string, entry: Entry, fresh = false): RunnerSkillList {
  return structuredClone({ runner, skills: entry.value?.skills ?? [], problems: entry.value?.problems ?? [],
    source: entry.value ? (fresh && !entry.reason ? 'live' : 'cache') : 'unavailable',
    ...(entry.reason ? { reason: entry.reason } : {}) });
}

/** Cancellation sends the kill immediately; observe adapter cleanup before answering. A broken
 * adapter cannot extend a request by more than this one-second cleanup bound. */
async function settleCancelledProbe(discovery: Promise<SkillCatalog>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      discovery.catch(() => undefined),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); }),
    ]);
  } finally { clearTimeout(timer); }
}
