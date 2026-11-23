import '../core-registries.testkit.ts';
/**
 * The run tier of the harness parity matrix: fixtures that drive each backend's offline mock
 * through a real `RunManager`.
 *
 * `harness-parity.testkit.ts` holds the adapter tier — scenarios, adapters and `driveSeam` —
 * and stays free of the workflow engine, so a runner-adapter test does not load it
 * (hearsay-tools/cezarion#2938). Worker/delegation parity fixtures (`withOwnedInputRun`,
 * `withSkillParentRun`, `answerAsParent`) live in `worker-parity-core.testkit.ts` so non-worker
 * parity tests do not load `delegation/service.ts` (hearsay-tools/squawk#4176).
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { RunStore, type RunRecord } from '../runs/store.ts';
import { createFixtureManager, drainFixtureManagers, fixtureWork } from '../workflows/fixture-manager.testkit.ts';
import { RunManager } from '../workflows/run.ts';
import { type WorkflowDef } from '../workflows/types.ts';
import type { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { HARNESS_ADAPTERS, promptFor, waitFor, type ScenarioName } from './harness-parity-core.testkit.ts';
import { observationClock } from './observation-clock.testkit.ts';

const execFileAsync = promisify(execFile);
const GIT_IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** The zero-config single-agent-step workflow, which is what a quick task runs. */
const SINGLE_STEP: WorkflowDef = {
  name: 'quick-task',
  source: 'built-in',
  steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
};

export interface RunObservation {
  /** Every status the run passed through, in order. A row can then assert a
   *  state was never ENTERED, not merely that it is not the final one — which
   *  is what #53/#54 need, since the bug was a transient park. */
  readonly statuses: readonly string[];
  readonly record: RunRecord | undefined;
  /** The run's persisted NDJSON, parsed — v1 and v2 events in one file, the
   *  same bytes SSE replays to the cockpit. */
  readonly events: readonly Record<string, unknown>[];
}

/** Omit an absent dependency under exact optional property types. */
function optionalSemaphore(semaphore: WorkspaceSemaphore | undefined): { semaphore?: WorkspaceSemaphore } {
  return semaphore ? { semaphore } : {};
}

/**
 * Drive one backend through a real `RunManager` run against its offline mock.
 *
 * The run tier exists because three of the failure-mode groups are only uniform
 * ABOVE the seam: `workflows/run/` emits `ask.requested` for every runner's `cezar_ask`
 * card, while codex and opencode also emit it from the runner for a native ask, and
 * whether a provider failure fails the run or parks it is decided in the orchestrator.
 *
 * Modelled on the #565 suite in `workflows/run.test.ts`: a temp git repo, a
 * store, a manager, and the built-in single-step workflow with `worktree: false`.
 */
function scenarioEnvironment(adapter: (typeof HARNESS_ADAPTERS)[string], scenario: ScenarioName | { prompt: string }): Record<string, string> {
  return typeof scenario === 'string' ? { ...adapter?.scenarioEnv?.[scenario] } : {};
}

export async function driveRun(
  backend: string,
  scenario: ScenarioName | { prompt: string },
  settled: (record: RunRecord | undefined) => boolean,
  timeoutMs = 30_000,
  afterSettled?: (context: { store: RunStore; manager: RunManager; runId: string }) => Promise<void>,
  options: {
    autonomous?: boolean;
    skillPaths?: Record<string, string>;
    semaphore?: WorkspaceSemaphore;
    workflowDef?: WorkflowDef;
    /** Called with the fresh store and manager before the run starts (to observe either), and
     *  the repo root, so a row can write the project's `.ai/cezar/config.json` (#917). */
    beforeStart?: (context: { store: RunStore; manager: RunManager; repoRoot: string }) => void;
    /** Restore a test-controlled clock before teardown measures its real cleanup bounds. */
    beforeCleanup?: () => void;
    /** Run in an isolated task worktree instead of in place (#917: worktree setup only runs
     *  there). Default false, which every earlier row relies on. */
    worktree?: boolean;
    /** Runs after startRun, in parallel with the settle loop — inject a mid-turn follow-up (#486). */
    during?: (context: { store: RunStore; manager: RunManager; runId: string }) => Promise<void>;
    /** Environment overrides restored after the run settles. */
    env?: Record<string, string>;
    /** Override the adapter mock binary (Codex coalesced-steer wrapper, #486). */
    mockBin?: string;
  } = {},
): Promise<RunObservation> {
  const { beforeStart, beforeCleanup, during, env: extraEnv, mockBin, worktree, semaphore, ...runOptions } = options;
  const adapter = HARNESS_ADAPTERS[backend]!;
  const savedBin = process.env[adapter.binEnv]!;
  const savedDry = process.env.CEZ_DRY_RUN;
  const savedAutoName = process.env.CEZ_AUTONAME;
  // The mock answers Squawk's no-wait nudge in plain text (hearsay-tools/cezarion#1234), so a row
  // that ends a turn with no wait reaches Squawk's own wait rather than a question the mock made
  // up. `options.env` may opt back in to the card.
  const env = { CEZ_MOCK_NUDGE_REPLY: 'plain', ...scenarioEnvironment(adapter, scenario), ...extraEnv };
  const savedEnv = Object.keys(env).map(name => [name, process.env[name]] as const);
  const restoreEnvironment = () => {
    if (savedBin === undefined) delete process.env[adapter.binEnv];
    else process.env[adapter.binEnv]! = savedBin;
    if (savedDry !== undefined) process.env.CEZ_DRY_RUN = savedDry;
    if (savedAutoName === undefined) delete process.env.CEZ_AUTONAME;
    else process.env.CEZ_AUTONAME = savedAutoName;
    for (const [name, saved] of savedEnv) {
      if (saved === undefined) delete process.env[name]; else process.env[name] = saved;
    }
  };
  Object.assign(process.env, env);
  process.env.CEZ_AUTONAME = '0';
  process.env[adapter.binEnv]! = mockBin ?? adapter.mockBin;
  delete process.env.CEZ_DRY_RUN;
  const repoRoot = mkdtempSync(join(tmpdir(), `cez-parity-run-${backend}-`));
  let store: RunStore | undefined;
  let manager: RunManager | undefined;
  try {
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
    await execFileAsync('git', [...GIT_IDENTITY, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot, optionalSemaphore(semaphore));
    beforeStart?.({ store, manager, repoRoot });
    const started = manager.startRun(runOptions.workflowDef ?? SINGLE_STEP, {
      ...runOptions,
      task: typeof scenario === 'string' ? promptFor(backend, scenario) : scenario.prompt,
      runner: backend,
      worktree: worktree === true,
    });
    let duringError: unknown;
    const duringWork = during
      ? during({ store, manager, runId: started.id }).catch((err: unknown) => { duringError = err; })
      : undefined;
    const statuses: string[] = [];
    const record = () => store!.getRun(started.id);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (duringError) break;
      const current = record();
      const status = current?.status;
      if (status !== undefined && statuses.at(-1) !== status) statuses.push(status);
      if (settled(current)) break;
      if (Date.now() > deadline) {
        throw new Error(
          `driveRun(${backend}, ${scenario}) never settled; statuses seen: ${statuses.join(' -> ')}`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (duringWork) await duringWork;
    if (duringError) throw duringError;
    if (afterSettled) await afterSettled({ store, manager, runId: started.id });
    store.persistence.flush();
    // Cleanup mutates the live record; return the observed state before cancellation.
    return { statuses, record: structuredClone(record()), events: readRunEvents(repoRoot, started.id) };
  } finally {
    beforeCleanup?.();
    await drainFixtureManagers(repoRoot);
    store?.close();
    restoreEnvironment();
    rmSync(repoRoot, { force: true, recursive: true });
  }
}

/** Parse a run's append-only NDJSON, skipping bad lines the way readers must. */
function readRunEvents(repoRoot: string, runId: string): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = readFileSync(join(repoRoot, '.ai/cezar/runs', `${runId}.ndjson`), 'utf8');
  } catch {
    return [];
  }
  const events: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object') {
        events.push(parsed as Record<string, unknown>);
      }
    } catch {
      // A reader skips a bad line; so does this.
    }
  }
  return events;
}

/** Observe, do not replace, the manager's fire-and-forget Git bookkeeping so
 * test-owned directories outlive every real write. */
export function trackTurnBookkeeping(manager: RunManager): () => Promise<void> {
  const work = fixtureWork(manager);
  return async () => {
    for (;;) {
      const pending = [...work.pending].filter(([, label]) => label === 'recordTurnEnd');
      if (!pending.length) return;
      await Promise.all(pending.map(([promise]) => promise));
    }
  };
}

/** R17 keeps the shipped retry budget, but observes it after the latest native retry. */
export async function driveUnavailableProvider(backend: string, scenario: ScenarioName | { prompt: string },
  settled: (record: RunRecord | undefined) => boolean, timeoutMs?: number): ReturnType<typeof driveRun> {
  if (backend !== 'codex') return driveRun(backend, scenario, settled, timeoutMs);
  let clock: ReturnType<typeof observationClock> | undefined;
  try {
    return await driveRun(backend, scenario, settled, timeoutMs, undefined, {
      beforeStart: () => {
        clock = observationClock(delay => delay === 60_000 &&
          /\bhandleStreamError\b/.test(new Error().stack ?? ''));
      },
      during: async ({ store, runId }) => {
        // bound: the real native mock must deliver both retry frames before the
        // product's no-progress timer can report its stored latest reason.
        await waitFor(() => store.eventLog.readEvents(runId).some(event => event.type === 'session.error' &&
          String(event.message).includes('Connection failed: error sending request')));
        if (clock!.captured !== 1) throw new Error(`Expected one stream retry timer, got ${clock!.captured}`);
        await clock!.advance(60_000);
      },
      beforeCleanup: () => { clock?.restore(); clock = undefined; },
    });
  } finally { clock?.restore(); }
}
