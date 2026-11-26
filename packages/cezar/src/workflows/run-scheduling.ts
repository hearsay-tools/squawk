import { isUsageLimitHold } from '@open-mercato/cezar-contract/usage-limit-hold';

import type { RunRecord } from '../runs/store.ts';
import type { AccountHolds } from '../workspace/semaphore.ts';
import type { StartRunInput } from './run/types.ts';
import { stepKind, type WorkflowDef } from './types.ts';
import { resolveRunnerId, runnerQuotaPool } from '../core/runner-registry.ts';

type HoldRun = Pick<RunRecord, 'runner' | 'agentProfile' | 'model' | 'workflowDef' | 'delegation'>;

/**
 * A deadline hold blocks all work in its pool. An in-flight resume holds fresh work only; other
 * resumes must remain eligible. modelsLocked is read only when the account holds a pool hold: with
 * the models lock on, every turn runs the runner's own default model, whose pool is unknown.
 */
export function accountHeldFor(
  run: HoldRun & Pick<RunRecord, 'status' | 'autoResumeAttempts' | 'autoResumeReason'>,
  holds: AccountHolds,
  fallbackRunner: string,
  modelsLocked: () => boolean,
): boolean {
  const account = runAccountKey(run, fallbackRunner);
  let pool: { value: string | undefined } | undefined;
  const ownPool = () => (pool ??= { value: modelsLocked() ? undefined : queuedQuotaPool(run, fallbackRunner) }).value;
  if (heldIn(holds.deadline, account, ownPool)) return true;
  return heldIn(holds.inFlight, account, ownPool) && !resumeInFlight(run);
}

/**
 * Key usage-limit holds by resolved runner and account. fallbackRunner applies before a run
 * records its runner.
 */
export function runAccountKey(
  run: Pick<RunRecord, 'runner' | 'agentProfile'>,
  fallbackRunner: string,
): string {
  return `${run.runner ?? fallbackRunner}:${run.agentProfile ?? 'default'}`;
}

/** Separates the pool from the account in a hold key. An account key never holds it. */
const POOL_SEPARATOR = '\u001f';

/**
 * The key a usage-limit hold closes (hearsay-tools/squawk#4343): the account and the quota pool of
 * the model its latest turn ran on, or the account alone when that pool is unknown. The launch
 * resolver records that model as `modelIdentity` when a step or Continue opens, after the models
 * lock and worker settings apply; the runner's own default model records none.
 */
export function runHoldKey(run: Pick<RunRecord, 'runner' | 'agentProfile' | 'modelIdentity'>, fallbackRunner: string): string {
  const account = runAccountKey(run, fallbackRunner);
  const pool = runnerQuotaPool(run.runner ?? fallbackRunner, run.modelIdentity);
  return pool === undefined ? account : `${account}${POOL_SEPARATOR}${pool}`;
}

/**
 * The pool every turn a queued run can take draws on (hearsay-tools/squawk#4343): each agent step
 * runs its authored model, else the run-level pin, which an accepted Continue also sets. A worker's
 * bound workflow holds each step's resolved model, and a step without one runs the runner's default
 * (`boundSpawnWorkflow`; a resume override rewrites it). Steps on two pools, or a step on the
 * runner's default model, read as unknown, which every pool hold on the account blocks.
 */
function queuedQuotaPool(run: HoldRun, fallbackRunner: string): string | undefined {
  const runner = run.runner ?? fallbackRunner;
  const [first, ...rest] = turnModels(run).map(model => runnerQuotaPool(runner, model));
  return first !== undefined && rest.every(pool => pool === first) ? first : undefined;
}

function turnModels(run: HoldRun): (string | undefined)[] {
  const agentSteps = run.workflowDef?.steps.filter(step => stepKind(step) === 'agent') ?? [];
  if (!agentSteps.length) return [run.model];
  return run.delegation?.role === 'worker' ? agentSteps.map(step => step.model) : agentSteps.map(step => step.model ?? run.model);
}

/** An account-wide hold blocks every pool. A pool hold blocks its pool, and a run whose pool is
 *  unknown, since that run may draw on it. */
function heldIn(keys: ReadonlySet<string>, account: string, ownPool: () => string | undefined): boolean {
  if (keys.has(account)) return true;
  const prefix = `${account}${POOL_SEPARATOR}`;
  const poolKeys = [...keys].filter(key => key.startsWith(prefix));
  if (!poolKeys.length) return false;
  const pool = ownPool();
  return pool === undefined || poolKeys.includes(`${prefix}${pool}`);
}

/**
 * Whether an automatic resume has not completed its first turn. Such resumes bypass in-flight
 * holds, but not a future deadline hold. A provider-error retry is not one: it holds no account
 * (hearsay-tools/squawk#3337).
 */
export function resumeInFlight(run: Pick<RunRecord, 'status' | 'autoResumeAttempts' | 'autoResumeReason'>): boolean {
  return (
    run.autoResumeAttempts !== undefined && run.autoResumeReason !== 'provider-error' && (run.status === 'queued' || run.status === 'running')
  );
}

export { sessionlessWakePrompt } from './run/wait-kinds.ts';

/** The index of the step the run's `start` cursor names (ADR 0064), else -1. */
export function workflowStartIndex(run: Pick<RunRecord, 'workflowCursor'>, workflow: WorkflowDef): number {
  const cursor = run.workflowCursor;
  return cursor?.mode === 'start' ? workflow.steps.findIndex(definition => definition.id === cursor.stepId) : -1;
}

/** Resume from the run's `start` cursor, else the persisted pending tail, instead of replaying
 *  completed agents. */
export function queuedStartAt(run: RunRecord, workflow: WorkflowDef): number {
  const cursor = workflowStartIndex(run, workflow);
  if (cursor >= 0) return cursor;
  return Math.max(0, workflow.steps.findIndex(definition =>
    run.steps.find(step => step.id === definition.id)?.status === 'pending'));
}

/** Input before hydration, preserving autonomy and an explicit worktree opt-out on restart. */
export function queuedRecoveryInput(run: RunRecord): StartRunInput {
  return {
    task: run.task,
    agentProfile: run.agentProfile,
    systemPrompt: run.systemPrompt,
    model: run.model,
    effort: run.effort,
    runner: run.runner === undefined ? undefined : resolveRunnerId(run.runner),
    autonomous: run.autonomous,
    worktree: run.worktree,
  };
}

/**
 * The wake instant as a human reads it — local, to the SECOND, with the zone named. The
 * transcript line is what someone scanning a stalled task actually reads, and "18:41" is not
 * enough to tell a wait that is nearly over from one that just started; the machine-readable ISO
 * copy lives on `RunRecord.autoResumeAt`. Server-side formatting is honest here because Squawk is
 * local-first: the process and the browser reading it are the same machine.
 */
export function formatWakeInstant(at: Date): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' }).format(at);
}

/**
 * Derive this project’s future-deadline and in-flight holds from records for the shared semaphore,
 * each keyed by `runHoldKey`. Past deadlines do not block the queue.
 */
export function deriveAccountHolds(
  records: RunRecord[],
  withExecutionAccount: <T extends RunRecord>(run: T) => T,
  now = Date.now(),
): AccountHolds {
  const deadline = new Set<string>();
  const inFlight = new Set<string>();
  for (const run of records) {
    // A run saved on a removed runner holds no live account: its limit was that runner's
    // (hearsay-tools/squawk#3715).
    if (run.removedRunner !== undefined) continue;
    // A holding run always carries the runner it actually ran on, so the fallback is unused
    // here — it is spelled out rather than `!` so a future record shape degrades, not throws.
    const key = () => runHoldKey(withExecutionAccount(run), resolveRunnerId(run.runner));
    // A provider-error hold blocks no account (hearsay-tools/squawk#3337): its error may be one
    // model's, and a run that meets the same limit holds by itself.
    if (isUsageLimitHold(run) && run.autoResumeReason !== 'provider-error') {
      const at = Date.parse(run.autoResumeAt);
      if (Number.isFinite(at) && at > now) deadline.add(key());
    } else if (resumeInFlight(run)) {
      inFlight.add(key());
    }
  }
  return { deadline, inFlight };
}
