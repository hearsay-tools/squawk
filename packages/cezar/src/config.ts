import { projectPaths, readDataPath, readProjectPath } from './project-paths.ts';
import { assertProjectWritable, projectAdmissionRefusal } from './project-fence.ts';
import type { Home } from './home/home.ts';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { loadWorkspaceConfig, type WorkspaceConfig } from './workspace/config.ts';
import { knownRunnerIds, registeredRunners } from './core/runner-registry.ts';
import { DEFAULT_RUNNER_ID } from './core/runner-ids.ts';

/**
 * Optional advanced config at `.ai/cezar/config.json`. Zero-config rule:
 * a missing file behaves exactly like the default below, an unreadable or
 * invalid file degrades to the default too (never blocks startup); a bad value drops only its
 * own key.
 */
/** Last-resort retention when neither the repo nor the workspace says anything. */
export const DEFAULT_WORKTREE_RETENTION = 10;

/** Bounds for `worktreeRetention` — shared with the presence probe below, so the
 *  "does this repo set its own?" question is answered by the same rule the
 *  schema enforces (and mirrors the workspace default's bounds). */
const worktreeRetentionSchema = z.number().int().min(0).max(1000);

const configSchema = z.object({
  /** How many tasks may run at once (spec 006). Non-git dirs always run 1. */
  maxParallel: z.number().int().min(1).max(16).default(2),
  /**
   * Count-based worktree retention (#483): keep the last N *finished*
   * worktrees materialized on disk; reclaim older ones (directory only — the
   * `cez/<id8>` branch is kept, so the work stays recoverable). 0 = unlimited
   * (never auto-reclaim). Default 10. `.catch(10)` keeps it additive-safe: a
   * bad value degrades to the default instead of discarding the rest.
   */
  worktreeRetention: worktreeRetentionSchema.default(DEFAULT_WORKTREE_RETENTION).catch(DEFAULT_WORKTREE_RETENTION),
  /**
   * Per-task memory ceiling in MiB (whole process tree). When a running task's
   * RSS crosses this the engine pauses it with a warning and lets the queue
   * advance (#memory-guard). 0 / unset = no limit. `.catch(undefined)` keeps
   * the key additive-safe: a bad value degrades to "no limit".
   */
  memoryLimitMb: z.number().int().min(0).max(1_048_576).optional().catch(undefined),
  /**
   * Which agent backend a task uses unless overridden per task (GUI) or per
   * step (workflow). The GUI only offers runners actually installed; this is
   * the preselected default. Also the runner the chain planner uses.
   */
  defaultRunner: z.string().min(1).refine((id) => knownRunnerIds().includes(id)).default(DEFAULT_RUNNER_ID),
  /** Model for the chain planner (spec 008) — cheap but reliable at JSON. */
  plannerModel: z.string().min(1).default('sonnet'),
  /** Model for the task namer (spec 2026-07-17-task-auto-naming) — the cheapest
   *  alias that answers strict JSON; naming is fire-and-forget and never blocks. */
  namerModel: z.string().min(1).default('haiku'),
  /** Live title updates: refresh the display title through the namer on each
   *  turn end. Absent = the `CEZ_TITLE_UPDATES` env decides (default ON — owner
   *  decision on PR #479). */
  archiveOnMerge: z.boolean().optional().catch(undefined),
  liveTitleUpdates: z.boolean().optional(),
  /** Optional diff-first review gate (#489): when a successful run with changes
   *  should park at `review` for a human. Absent = the `CEZ_REVIEW_GATE` env
   *  decides (default OFF — the deliberate inverse of `liveTitleUpdates`).
   *  Autonomous runs always skip the gate regardless of this. */
  reviewGate: z.boolean().optional(),
  /**
   * Branch task worktrees fork from and draft PRs target (e.g. `develop`).
   * Unset = the branch currently checked out. Settable from the Repo tab.
   */
  baseBranch: z.string().trim().min(1).optional(),
  /**
   * Default extra system prompt applied to every run's agent steps (claude:
   * `--append-system-prompt`; codex/opencode: prepended to the opening user
   * message — the AgentRunSpec seam handles the per-backend delivery).
   * Settings is the single edit place; `POST /api/runs` can override it per
   * run (`systemPrompt`). `.catch(undefined)` keeps the key additive-safe: a
   * bad value degrades to unset without discarding the rest of the config.
   */
  systemPrompt: z.string().trim().min(1).max(20_000).optional().catch(undefined),
  /**
   * Per-runner default model preset (Settings → Agents, redesign R6 1.5): the
   * model id the composer preselects for that runner. Missing = auto (the
   * runner decides). A capability (`model`), never a vendor config format.
   * A record keyed by registered id, checked against the registry when config
   * loads: a key no registered runner took is dropped, as the closed
   * per-runner object (no passthrough) dropped it, and a bad value for a
   * registered runner refuses the whole key, as the object's `.catch(undefined)`
   * did. `.catch(undefined)` keeps it additive-safe like `systemPrompt`: a
   * bad value degrades to unset without discarding the rest of the config.
   */
  defaultModels: z
    .record(z.string(), z.unknown())
    .transform((entries) => Object.fromEntries(
      registeredRunners().filter(({ id }) => id in entries).map(({ id }) => [id, entries[id]]),
    ))
    .pipe(z.record(z.string(), z.string().trim().min(1).max(200).optional()))
    .optional()
    .catch(undefined),
  /**
   * Make each coding agent's native model setting authoritative. This is an
   * optional repo-level counterpart to `CEZ_AGENT_MODELS_LOCKED=1`; absent or
   * false preserves the ordinary per-runner model selector.
   */
  modelsLocked: z.boolean().optional().catch(undefined),
  /**
   * Commands that prepare a new task or worker worktree (#917). Deliberately `unknown` here:
   * `resolveWorktreeSetup` (`worktree-setup.ts`) judges it, so an invalid value is reported to the
   * run instead of resetting this whole file to defaults or being dropped without a word.
   */
  worktreeSetup: z.unknown().optional(),
  /**
   * Commands that stop what a worker's worktree started for itself before destroy looks for holders
   * (hearsay-tools/squawk#914). Same shape as `worktreeSetup`, judged by the same resolver.
   */
  worktreeTeardown: z.unknown().optional(),
});

export type CezConfig = z.infer<typeof configSchema>;

/**
 * Fold the machine-wide agent defaults under a repo's own config (spec 2026-07-29-agent-profiles).
 *
 * Applied to the RAW object, before parsing, for the reason `ownWorktreeRetention` documents just
 * below: `defaultRunner`'s `.default(DEFAULT_RUNNER_ID)` materializes the key, so after a parse there is no
 * telling "the user chose claude" from "the user said nothing". Merging first keeps the wire shape
 * exactly as it has always been — `defaultRunner` and the model presets stay always-present — while
 * making an absent key mean "ask the machine".
 *
 * A repo key always wins, and `models` merges per RUNNER rather than wholesale: pinning claude's
 * model in one repo must not silently discard the machine's codex preset.
 */
function withMachineDefaults(raw: unknown, machine: WorkspaceConfig['agentDefaults']): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  const own = raw as Record<string, unknown>;
  const ownModels = own.defaultModels && typeof own.defaultModels === 'object'
    ? own.defaultModels as Record<string, unknown>
    : undefined;
  const models = { ...machine.models, ...ownModels };
  return {
    ...own,
    ...(own.defaultRunner === undefined && machine.runner !== undefined
      ? { defaultRunner: machine.runner }
      : {}),
    ...(Object.keys(models).length > 0 ? { defaultModels: models } : {}),
  };
}

/**
 * Read `.ai/cezar/config.json` on demand — never cached, never throws.
 *
 * Also reads the machine-wide defaults, which is one more small JSON read and deliberately not
 * cached for the same reason this one is not: `~/.cezar/` is shared by every Squawk process on the
 * machine, so a snapshot is a staleness bug.
 */
export async function loadConfig(repoRoot: string, home: Home): Promise<CezConfig> {
  const machine = (await loadWorkspaceConfig(home.workspaceConfig)).agentDefaults;
  let raw: unknown = {};
  try {
    raw = JSON.parse(await readFile(readProjectPath(repoRoot, 'config.json'), 'utf8'));
  } catch {
    // A missing file or malformed JSON degrades to the default.
  }
  return parseLeniently(withMachineDefaults(raw, machine));
}

/** The last config each health read saw, by repo root. */
const healthConfigs = new Map<string, CezConfig>();

/**
 * The project config health shows: read as `loadConfig` reads it, except while a migration fence
 * holds the project. Then the last value read (the defaults before any) stands in and the project
 * is not read.
 */
export async function healthConfig(repoRoot: string, home: Home): Promise<CezConfig> {
  if (projectAdmissionRefusal(projectPaths(repoRoot).write)) {
    return healthConfigs.get(repoRoot) ?? parseLeniently(withMachineDefaults({}, (await loadWorkspaceConfig(home.workspaceConfig)).agentDefaults));
  }
  const config = await loadConfig(repoRoot, home);
  healthConfigs.set(repoRoot, config);
  return config;
}

/** Most bad values one file can hold before the parse gives up and answers the defaults. */
const MAX_REPAIRS = 64;

/**
 * Parse a config object, dropping only the key the schema refuses.
 */
function parseLeniently(input: unknown): CezConfig {
  let value: unknown = input && typeof input === 'object' && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};
  for (let repairs = 0; repairs < MAX_REPAIRS; repairs++) {
    const parsed = configSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    value = withoutRefused(value as Record<string, unknown>, parsed.error.issues[0]?.path ?? []);
  }
  return configSchema.parse({});
}

function withoutRefused(raw: Record<string, unknown>, path: readonly PropertyKey[]): Record<string, unknown> {
  const [key] = path;
  if (typeof key !== 'string') return {};
  const next = { ...raw };
  delete next[key];
  return next;
}

/** Why the project's config file cannot be read: the file that was read. */
function configIssue(path: string, error: unknown): string {
  const shown = basename(dirname(dirname(path))) === '.ai' ? `.ai/${basename(dirname(path))}/config.json` : path;
  return `${shown} cannot be read: ${error instanceof Error ? error.message : String(error)}. Fix the file, then reload.`;
}

/** A failed read keeps `raw` when the file is a JSON object that only the schema refuses. */
export type RawConfigRead = { ok: true; raw: Record<string, unknown> } | { ok: false; issue: string; raw?: Record<string, unknown> };

/**
 * The raw `.ai/cezar/config.json` object, or why it cannot be used. A missing file is `{}`.
 * Malformed JSON or a non-object is an issue: a writer that merged into it would replace the
 * user's file.
 */
export async function readRawConfig(dataDir: string): Promise<RawConfigRead> {
  let text: string;
  const path = readDataPath(dataDir, 'config.json');
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, raw: {} };
    return { ok: false, issue: configIssue(path, error) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, issue: configIssue(path, error) };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, issue: configIssue(path, 'it is not a JSON object') };
  return { ok: true, raw: raw as Record<string, unknown> };
}

const configWrites = new Map<string, Promise<unknown>>();

/**
 * Change `.ai/cezar/config.json` under one in-process lock per file, then write it atomically (a
 * temporary file, then a rename), so a synchronous reader never sees a partial file and two
 * cockpit writes never drop each other's keys. `change` gets the file as `readRawConfig` reads
 * it now and returns the next object, or a refusal that writes nothing.
 */
export function updateConfigFile<T>(
  dataDir: string,
  change: (current: RawConfigRead) => { write: Record<string, unknown>; result: T } | { refuse: T },
): Promise<T> {
  const path = join(dataDir, 'config.json');
  const previous = configWrites.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const outcome = change(await readRawConfig(dataDir));
    if ('refuse' in outcome) return outcome.refuse;
    assertProjectWritable(dataDir);
    await mkdir(dataDir, { recursive: true });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(outcome.write, null, 2)}\n`, 'utf8');
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return outcome.result;
  });
  configWrites.set(path, next);
  void next.finally(() => { if (configWrites.get(path) === next) configWrites.delete(path); }).catch(() => undefined);
  return next;
}

/**
 * The repo's OWN `worktreeRetention`, or `undefined` when it doesn't set one.
 *
 * `loadConfig` cannot answer this: the schema's `.default(10).catch(10)`
 * materializes the key, so a parsed config can't tell "the user chose 10" from
 * "the user said nothing". So we probe the raw file — a key that is absent (or
 * carries a value the schema would refuse) means the repo has no opinion, and
 * the workspace default gets to seed it.
 */
async function ownWorktreeRetention(repoRoot: string): Promise<number | undefined> {
  let raw: string;
  try {
    raw = await readFile(readProjectPath(repoRoot, 'config.json'), 'utf8');
  } catch {
    return undefined; // no file — nothing set
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const value = (parsed as Record<string, unknown>).worktreeRetention;
    if (value === undefined) return undefined;
    const field = worktreeRetentionSchema.safeParse(value);
    return field.success ? field.data : undefined;
  } catch {
    return undefined; // malformed JSON — same as unset
  }
}

/**
 * Effective worktree retention for a repo (#483 + spec
 * 2026-07-20-multi-project-workspace). Precedence, exactly what Settings →
 * Worktrees promises: the repo's own `worktreeRetention` wins whenever it sets
 * one; otherwise the workspace's `resources.worktreeRetentionDefault` seeds it;
 * an absent/unreadable workspace config keeps the historical 10. Every
 * enforcement site (boot sweeps, terminal transitions, the reclaim route) must
 * go through here so the setting can never be a lie.
 */
export async function resolveWorktreeRetention(repoRoot: string, home: Home): Promise<number> {
  const own = await ownWorktreeRetention(repoRoot);
  if (own !== undefined) return own;
  const workspace = await loadWorkspaceConfig(home.workspaceConfig).catch(() => null);
  return workspace?.resources.worktreeRetentionDefault ?? DEFAULT_WORKTREE_RETENTION;
}
