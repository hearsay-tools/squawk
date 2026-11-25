import type { Home } from '../home/home.ts';
import { HomeOutsideWriteError, HomeStore, readHomeFile } from '../home/store.ts';
import { realpathSync } from 'node:fs';
import { posix, resolve, win32 } from 'node:path';
import { z } from 'zod';
import { DEFAULT_AGENT_ACCOUNT_ID } from '@open-mercato/cezar-contract/agent-profiles';
import type { ProviderId } from '../core/provider-auth.ts';
import { supportsProfiles } from '../core/agent-profiles.ts';
import { isRegisteredRunner, knownRunnerIds, runnersSealed, savedRunnerRegistration } from '../core/runner-registry.ts';
import { storedRunnerIdSchema } from '../core/runner-id-schema.ts';
import { loadWorkspaceConfigSync, registeredRunnerRecord } from './config.ts';

/**
 * Optional agent-account store with root-keyed selections. Preserve unknown keys and salvage
 * entries; write atomically at 0600. Corruption degrades to empty with a warning. Keep account
 * removal and selection cleanup in one write.
 */

/** `id` slug rule — the project rule, for the same URL/segment-safety reason. */
export const AGENT_ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Reserved discovered-default id, never allocated or stored as an account. Re-export the
 * contract’s value so requests and storage share one spelling.
 */
export { DEFAULT_AGENT_ACCOUNT_ID };

/**
 * Is `configDir` absolute on `platform`? The account routes' only path rule, and the reason it is a
 * named function rather than a test written inline.
 *
 * A relative dir would resolve against whatever cwd the agent happens to be spawned in — for a task
 * that is a throwaway worktree — so it has to be refused. But the obvious spelling of that refusal,
 * a leading-`/` test, refuses every real Windows path too: `C:\Users\me\.claude-work` starts with
 * neither `/` nor `~`. That is not a corner case: `core/shell-env.ts` renders `set "VAR=v"` for
 * `cmd.exe` precisely so an account survives a Windows terminal handoff, and the Add-account dialog
 * delegates ALL path validation to the server, so a string test would leave the whole feature
 * unreachable on the one platform the rest of this work went out of its way to support.
 *
 * `platform` is a parameter so both answers stay testable from either OS.
 */
export function isAbsoluteConfigDir(
  configDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (platform === 'win32' ? win32 : posix).isAbsolute(configDir);
}

/** C0 controls + DEL. A path containing one is never legitimate and would be interpolated into a
 *  shell command by the CLI handoff, so it is refused at the schema, not just at the route. */
export const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/**
 * One extra config dir for a provider — a second login of the same CLI
 * (`CLAUDE_CONFIG_DIR=~/.claude-klaudiusz claude`), see `src/core/agent-profiles.ts`.
 *
 * `id`, `provider` and `configDir` are load-bearing and carry no `.catch`: a row missing any of
 * them names no account, so the per-entry salvage below drops it. Display fields degrade per key.
 *
 * `configDir` is stored AS WRITTEN — a literal `~` survives — and every consumer expands it
 * through `expandTilde`.
 */
const agentAccountSchema = z
  .object({
    id: z.string().regex(AGENT_ACCOUNT_ID_RE).refine((v) => v !== DEFAULT_AGENT_ACCOUNT_ID, {
      message: `"${DEFAULT_AGENT_ACCOUNT_ID}" is reserved for the discovered account`,
    }),
    // Refused at the SCHEMA, not just at the route, for the same reason the reserved `default` id
    // is: this file is designed to survive hand edits, foreign writers and the legacy import, and a
    // provider whose credentials do not follow its config dir resolves to a LIE — `profileEnv`
    // returns `{}` for it, so the step records the account, the UI names it, and the CLI runs on
    // the default login anyway. Dropped by the per-entry salvage instead, which is the one
    // degradation that cannot mislead.
    // A provider the registry does not hold is kept verbatim: its plugin may be absent.
    // `savedRunnerRegistration` is false for that id once the registry is sealed, and undefined
    // while it is unsealed — both keep the row. `isRegisteredRunner` and `supportsProfiles` throw
    // before the seal, and this decode runs at startup. A registered runner whose credentials
    // do not follow its config dir is still dropped (spec 2026-11-24, A3).
    provider: storedRunnerIdSchema.refine((provider) => savedRunnerRegistration(provider) !== true || supportsProfiles(provider), {
      message: 'this agent cannot carry more than one account (its credentials do not follow its config dir)',
    }),
    configDir: z
      .string()
      .min(1)
      .max(4096)
      .refine((v) => !CONTROL_CHARS_RE.test(v), 'configDir must not contain control characters'),
    label: z.string().max(200).catch(''),
    addedAt: z.string().max(64).catch(''),
  })
  .passthrough();

export type AgentAccount = z.infer<typeof agentAccountSchema>;

/** Shared salvage and first-wins policy; migration also needs the discarded duplicate rows. */
export function parseAgentAccountEntries(entries: unknown[]): { accounts: AgentAccount[]; duplicates: AgentAccount[]; selectedIndices: number[] } {
  const accounts: AgentAccount[] = [], duplicates: AgentAccount[] = [], selectedIndices: number[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const parsed = agentAccountSchema.safeParse(entry);
    if (!parsed.success) return;
    if (seen.has(parsed.data.id)) { duplicates.push(parsed.data); return; }
    seen.add(parsed.data.id);
    accounts.push(parsed.data);
    selectedIndices.push(index);
  });
  return { accounts, duplicates, selectedIndices };
}

/** One project's choice, per provider: a record keyed by registered id, checked against the
 *  registry when the store loads. A key no registered runner took is kept and ignored, as
 *  `.passthrough()` kept it; a registered runner's value is bounded and degrades per key. An
 *  absent key means the discovered default. */
const selectionSchema = registeredRunnerRecord(z.string().max(64).optional().catch(undefined));

export type AgentAccountSelection = z.infer<typeof selectionSchema>;

/** The raw rows the salvage reads: anything that is not an array names no account. */
const accountRowsSchema = z
  .array(z.unknown())
  .default(() => [])
  .catch(() => []);

export const storeSchema = z
  .object({
    /** Format cursor for THIS file, independent of `config.json`'s `schemaVersion`. Nothing reads
     *  it yet; it exists so a future shape change has somewhere to say so. */
    version: z.number().int().min(0).default(1).catch(1),
    accounts: accountRowsSchema.transform((entries) => parseAgentAccountEntries(entries).accounts),
    /** Repo root → per-provider choice. Per-entry salvage: a bad row is dropped, the rest stay. */
    selections: z
      .record(z.string(), z.unknown())
      .default(() => ({}))
      .catch(() => ({}))
      .transform((raw) => {
        const out: Record<string, AgentAccountSelection> = {};
        for (const [root, value] of Object.entries(raw)) {
          const parsed = selectionSchema.safeParse(value);
          if (parsed.success) out[root] = parsed.data;
        }
        return out;
      }),
  })
  .passthrough();

export type AgentAccountStore = z.infer<typeof storeSchema>;

/** The in-memory default — what a missing file behaves like, and the zero-config state. */
export function defaultAgentAccountStore(): AgentAccountStore {
  return storeSchema.parse({});
}

/**
 * Read the store on demand — never cached, never throws.
 *
 * Not cached because `~/.cezar/` is shared by every Squawk process on the machine, so a snapshot is
 * a staleness bug; one small JSON read is free next to spawning a CLI.
 *
 * A missing file is the zero-config default (silent). A corrupt one degrades to the default with a
 * one-line warning and is left on disk untouched, so the user can repair it by hand — the next
 * successful merge-write is what replaces it.
 */
function loadAgentAccountsSync(home: Home): AgentAccountStore {
  const stored = readStoredAccounts(home);
  // Absent — but accounts may predate this file (they lived in config.json on the branch that
  // introduced them), so give those one chance to come across.
  if (stored === 'absent') return importLegacyAccounts(home);
  if (stored !== 'corrupt') return Object.hasOwn(stored, 'defaults') ? upgradeSavedDefaults(home, stored) : stored;
  console.warn(`[hsq] agent accounts ${home.agentAccounts} is corrupt — ignoring it (every project falls back to its default account)`);
  return defaultAgentAccountStore();
}

/** The file as written, with no import and no upgrade. */
function readStoredAccounts(home: Home): AgentAccountStore | 'absent' | 'corrupt' {
  let raw: string;
  try {
    raw = readHomeFile(home.agentAccounts);
  } catch {
    return 'absent';
  }
  try {
    const parsed = storeSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // malformed JSON names no account
  }
  return 'corrupt';
}

/**
 * One-time upgrade of a saved machine-wide default, which this file no longer carries
 * (hearsay-tools/squawk#3865). Each registered project with no choice of its own for a provider
 * takes the saved one, so no project changes its login. A home that cannot be written keeps the
 * upgraded store in memory. While the registry lists no project (it may be unreadable), the saved
 * default stays in the file for a later load.
 */
function upgradeSavedDefaults(home: Home, store: AgentAccountStore): AgentAccountStore {
  // Before boot seals the runner registry, `knownRunnerIds()` is empty; folding now would strip
  // `defaults` without copying any runner's choice into `selections`. Keep it for a booted load.
  if (!runnersSealed()) return store;
  const roots = loadWorkspaceConfigSync(home.workspaceConfig).projects.map((project) => project.root);
  if (roots.length === 0 && savedDefaults(store).length > 0) return store;
  try {
    const homeStore = new HomeStore(home);
    return homeStore.transaction(() => {
      const current = readStoredAccounts(home);
      const next = foldSavedDefaults(typeof current === 'string' ? store : current, roots);
      homeStore.writeJson(home.agentAccounts, next);
      return next;
    }, [home.agentAccounts]);
  } catch {
    return foldSavedDefaults(store, roots);
  }
}

/** The saved machine-wide default as [provider, account id] pairs, over the registered runners
 *  in registration order (was `PROVIDER_IDS` order — the same five). */
function savedDefaults(store: AgentAccountStore) {
  const saved = selectionSchema.safeParse((store as { defaults?: unknown }).defaults);
  return saved.success ? knownRunnerIds().flatMap((id) => saved.data[id] === undefined ? [] : [[id, saved.data[id]] as const]) : [];
}

function foldSavedDefaults(store: AgentAccountStore, roots: readonly string[]): AgentAccountStore {
  const { defaults: _defaults, ...rest } = store as AgentAccountStore & { defaults?: unknown };
  const selections = { ...rest.selections };
  const chosen = savedDefaults(store);
  for (const root of chosen.length > 0 ? roots : []) {
    const selection = { ...selections[root] };
    // A salvaged key holds undefined, which is no choice: it must not hide the saved default.
    for (const [provider, id] of chosen) selection[provider] ??= id;
    selections[root] = selection;
  }
  return { ...rest, selections };
}

/** Retain the async caller contract while transactions remain synchronous. */
export async function loadAgentAccounts(home: Home): Promise<AgentAccountStore> {
  return loadAgentAccountsSync(home);
}

/**
 * Read-modify-write merge: re-read, apply `mutator`, atomic-rename write.
 *
 * Every writer holds the root write.lock across the re-read and replacement, so concurrent
 * processes cannot drop each other's account changes. Throws on write failure (a
 * read-only home); degrading is the caller's policy.
 */
export async function mergeWriteAgentAccounts(
  mutator: (store: AgentAccountStore) => AgentAccountStore | void,
  home: Home,
): Promise<AgentAccountStore> {
  const store = new HomeStore(home);
  return store.transaction(() => {
    const current = loadAgentAccountsSync(home);
    const next = mutator(current) ?? current;
    store.writeJson(home.agentAccounts, next);
    return next;
  }, [home.agentAccounts]);
}

/**
 * `DELETE /workspace/agent-profiles/:id`'s mutation: remove account `id` and scrub every selection
 * that names it. Returns the removed row's provider, or undefined when nothing was removed.
 */
export function removeAgentAccount(store: AgentAccountStore, id: string): ProviderId | undefined {
  const removedProvider = store.accounts.find((a) => a.id === id)?.provider;
  // A row whose runner is not registered is kept on disk until its plugin returns, and
  // answers 404 here as it does on status and PATCH (hearsay-tools/squawk#4200).
  if (removedProvider === undefined || !isRegisteredRunner(removedProvider)) return undefined;
  store.accounts = store.accounts.filter((a) => a.id !== id);
  // Scrub every reference IN THE SAME MUTATOR — the reason selections share this file.
  // A two-call delete-then-scrub can be observed mid-way by another Squawk process on
  // this machine, which would then resolve a dangling id; harmless today (it degrades
  // to the default) but only by luck.
  for (const [root, selection] of Object.entries(store.selections)) {
    for (const key of Object.keys(selection) as Array<keyof typeof selection>) {
      if (selection[key] === id) delete selection[key];
    }
    if (Object.keys(selection).length === 0) delete store.selections[root];
  }
  return removedProvider;
}

/**
 * One-time, non-destructive import of accounts that were written into `config.json` by the branch
 * that first introduced them (before they got their own file).
 *
 * Reads the RAW object rather than going through the workspace schema, because that schema no
 * longer names these keys — they only survive there as passthrough. Nothing is deleted from
 * `config.json`: an older Squawk sharing this home keeps reading what it has always read, and this
 * import is idempotent because it only runs while `agent-accounts.json` is absent.
 */
function importLegacyAccounts(home: Home): AgentAccountStore {
  // A load may have observed absence just before another process created the store.
  // Keep that recheck, import and publication inside one transaction as well.
  try {
    return new HomeStore(home).transaction(() => {
      try { readHomeFile(home.agentAccounts); return loadAgentAccountsSync(home); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return readLegacyAccounts(home, true);
    }, [home.agentAccounts]);
  } catch (error) {
    if (error instanceof HomeOutsideWriteError) console.warn(`[hsq] ${error.message}; imported accounts are available in memory only`);
    // A missing marker or read-only home still permits the historical in-memory import.
    return readLegacyAccounts(home, false);
  }
}

/** The raw `config.json` keys the one-time import reads; undefined when there is nothing to read. */
function legacyAccountInput(home: Home, read: (path: string) => string): { accounts: unknown; selections: Record<string, unknown> } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(read(home.workspaceConfig));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const legacy = parsed as { agentProfiles?: unknown; projects?: unknown };
  const selections: Record<string, unknown> = {};
  if (Array.isArray(legacy.projects)) {
    for (const entry of legacy.projects) {
      if (!entry || typeof entry !== 'object') continue;
      const { root, agentProfile } = entry as { root?: unknown; agentProfile?: unknown };
      if (typeof root === 'string' && agentProfile && typeof agentProfile === 'object') {
        selections[root] = agentProfile;
      }
    }
  }
  return { accounts: legacy.agentProfiles, selections };
}

/**
 * What a load reads, without the import's write: the raw account rows its salvage selects from,
 * and the store value a rewrite starts from (the file as written, or the store an import would
 * persist). `value` is undefined for a corrupt file, which a load ignores and never overwrites.
 * The legacy-home migration inventories and relocates accounts through this.
 */
export function readAgentAccountSource(home: Home, read: (path: string) => string = readHomeFile): { rows: unknown[]; value: Record<string, unknown> | undefined } {
  let raw: string;
  try {
    raw = read(home.agentAccounts);
  } catch {
    const input = legacyAccountInput(home, read);
    const imported = input ? storeSchema.safeParse(input) : undefined;
    return input && imported?.success ? { rows: accountRowsSchema.parse(input.accounts), value: imported.data } : { rows: [], value: undefined };
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (storeSchema.safeParse(value).success) return { rows: accountRowsSchema.parse((value as { accounts?: unknown }).accounts), value: value as Record<string, unknown> };
  } catch {
    // malformed JSON names no account, as in the loader
  }
  return { rows: [], value: undefined };
}

function readLegacyAccounts(home: Home, persist: boolean): AgentAccountStore {
  const input = legacyAccountInput(home, readHomeFile);
  if (!input) return defaultAgentAccountStore();
  const imported = storeSchema.safeParse(input);
  if (!imported.success) return defaultAgentAccountStore();
  // Only worth persisting when there was something to carry over; an empty import must not create
  // a file, or the zero-config promise ("delete any of them and Squawk rebuilds") gains a file that
  // exists for no reason.
  if (!persist || imported.data.accounts.length === 0) return imported.data;
  try {
    const path = home.agentAccounts;
    new HomeStore(home).writeJson(path, imported.data);
  } catch (error) {
    if (error instanceof HomeOutsideWriteError) console.warn(`[hsq] ${error.message}; imported accounts are available in memory only`);
    // read-only home: the import stays in memory for this process, which is still correct
  }
  return imported.data;
}

/** The account `provider` uses for `repoRoot`, or undefined when the repo has not chosen one. */
export function selectionFor(
  store: Pick<AgentAccountStore, 'selections'>,
  repoRoot: string | undefined,
  provider: ProviderId,
): string | undefined {
  return repoRoot === undefined ? undefined : selectionForRoot(store, repoRoot)?.[provider];
}

/**
 * The selection stored for `repoRoot`, matched on the literal spelling first and the realpath'd
 * one second.
 *
 * The keys come from the REGISTRY, which realpath-normalizes every root it stores
 * (`workspace/projects.ts` `normalizeRoot`); the readers hold whatever spelling their caller had —
 * `RunManager` is constructed with `repoInfo?.root ?? cwd` for the boot project, not with the
 * registry entry. `workspace/semaphore.ts` already normalizes at lookup for the per-project
 * concurrency map for exactly this reason. Doing it here too matters more, not less: a missed
 * concurrency override runs the task with the wrong ceiling, a missed account selection runs it on
 * the wrong subscription and says nothing.
 *
 * The literal probe comes first because it is free and answers the overwhelmingly common case; the
 * normalized one only pays a `realpathSync` when the literal key is absent.
 */
function selectionForRoot(
  store: Pick<AgentAccountStore, 'selections'>,
  repoRoot: string,
): AgentAccountSelection | undefined {
  const literal = store.selections[repoRoot];
  if (literal !== undefined) return literal;
  const normalized = normalizeRootSync(repoRoot);
  return normalized === repoRoot ? undefined : store.selections[normalized];
}

/** Realpath-normalize a root the way the registry does, but synchronously — this answers a run's
 *  per-step lookup and must not `await`. A path that cannot be realpath'd (gone, unreadable)
 *  degrades to `resolve()`, matching the registry's own fallback and `semaphore.ts`'s. */
function normalizeRootSync(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}
