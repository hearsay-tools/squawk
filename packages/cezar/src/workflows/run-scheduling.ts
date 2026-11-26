import { isUsageLimitHold } from '@open-mercato/cezar-contract/usage-limit-hold';

import type { RunRecord } from '../runs/store.ts';
import type { AccountHolds } from '../workspace/semaphore.ts';
import type { StartRunInput } from './run/types.ts';
import type { WorkflowDef } from './types.ts';
import { resolveRunnerId, runnerQuotaPool } from '../core/runner-registry.ts';
import { executionModel } from './execution-account.ts';

type HoldRun = Pick<RunRecord, 'runner' | 'agentProfile' | 'model' | 'steps' | 'workflowDef' | 'workflowCursor'>;

/**
 * A deadline hold blocks all work in its pool. An in-flight resume holds fresh work only; other
 * resumes must remain eligible.
 */
export function accountHeldFor(
  run: HoldRun & Pick<RunRecord, 'status' | 'autoResumeAttempts' | 'autoResumeReason'>,
  holds: AccountHolds,
  fallbackRunner: string,
): boolean {
  const account = runAccountKey(run, fallbackRunner);
  const pool = runQuotaPool(run, fallbackRunner);
  if (heldIn(holds.deadline, account, pool)) return true;
  return heldIn(holds.inFlight, account, pool) && !resumeInFlight(run);
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
 * The key a usage-limit hold closes (hearsay-tools/squawk#4343): the account and the quota pool its
 * model draws on, or the account alone when its runner cannot name the pool.
 */
export function runHoldKey(run: HoldRun, fallbackRunner: string): string {
  const account = runAccountKey(run, fallbackRunner);
  const pool = runQuotaPool(run, fallbackRunner);
  return pool === undefined ? account : `${account}${POOL_SEPARATOR}${pool}`;
}

function runQuotaPool(run: HoldRun, fallbackRunner: string): string | undefined {
  return runnerQuotaPool(run.runner ?? fallbackRunner, executionModel(run));
}

/** An account-wide hold blocks every pool. A pool hold blocks its pool, and a run whose pool is
 *  unknown, since that run may draw on it. */
function heldIn(keys: ReadonlySet<string>, account: string, pool: string | undefined): boolean {
  if (keys.has(account)) return true;
  if (pool !== undefined) return keys.has(`${account}${POOL_SEPARATOR}${pool}`);
  const prefix = `${account}${POOL_SEPARATOR}`;
  for (const key of keys) if (key.startsWith(prefix)) return true;
  return false;
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
