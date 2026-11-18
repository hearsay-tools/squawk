import { ownsDirectory } from '@open-mercato/cezar-contract/delegation';
import { atTaskHead } from './launch-read-resolver.ts';
import { createWorktree, resolveBaseRef } from '../../git-worktree.ts';
import { getRepoInfo } from '../../server/git.ts';
import type { RunRecord, RunStore } from '../../runs/store.ts';
import type { Execution, ExecutionLaunch, WorkerDelegationRecord } from './types.ts';
import { requireWorkerWorkspaces, type WorkerWorkspaceOpened, type WorkerWorkspacePort } from './worker-workspace-port.ts';

export const REPOSITORY_ROOT_LOCK_DISABLED_NOTE =
  'repository-root lock disabled by CEZ_DISABLE_REPO_LOCK=1 (shared checkout is unsafe)';

/** Whether the run owns the directory it works in. A worker in its host's directory does not: it
 *  gets no recorded worktree or branch, no autosave commit, no worktree setup, no agent-config
 *  seeding and no repository-root lease, whatever that directory is. */
export function runOwnsDirectory(run: RunRecord | undefined): boolean {
  return run?.delegation?.role !== 'worker' || ownsDirectory(run.delegation.workspace);
}

/** The directory a worker's parent works in: its worktree, else the repository root. */
function parentCwd(store: RunStore, repoRoot: string, delegation: WorkerDelegationRecord): string {
  return store.getRun(delegation.parentRunId)?.worktreePath ?? repoRoot;
}

/** Verify an owned worker's Continue workspace without recreating it. The caller settles refusal. */
export async function ownedContinuationWorkspace(
  store: RunStore,
  repoRoot: string,
  dataDir: string,
  record: RunRecord,
  delegation: WorkerDelegationRecord,
  workspaces: WorkerWorkspacePort | undefined,
): Promise<string> {
  if (delegation.destroy) throw new Error('Worker destruction has begun');
  return requireWorkerWorkspaces(workspaces).openForContinue({ repoRoot, dataDir, run: record, parentCwd: parentCwd(store, repoRoot, delegation) });
}

/** An explicit worker attachment takes precedence over the project's personal config copy. */
export function executionSeedFiles(ownedRun: RunRecord | undefined): Set<string> {
  return new Set(ownedRun?.delegation?.role === 'worker'
    ? (ownedRun.delegation.context?.inputs ?? []).flatMap(input => input.source.kind === 'parent-file' ? [input.source.path] : [])
    : []);
}

/**
 * Fork from the configured base branch (config.json `baseBranch`, e.g.
 * `develop`) — also the target of the eventual draft PR. Unresolvable
 * (typo, not fetched) → note + the currently checked-out branch.
 *
 * A task that already recorded a fork point keeps it: its worktree is
 * reused as-is, and re-resolving against a since-changed config would
 * silently re-anchor the `merge-base` every diff/shortstat is measured
 * from, shifting "what did this task change" under an existing task.
 */
export async function executionBaseRef(
  store: RunStore,
  repoRoot: string,
  execution: Execution,
  repo: Awaited<ReturnType<typeof getRepoInfo>>,
  launch: ExecutionLaunch,
): Promise<string> {
  const { runId, emit } = execution;
  const recorded = launch.owned?.baselineSha ?? store.getRun(runId)?.baseBranch;
  let base = recorded ?? repo?.branch ?? 'HEAD';
  const configured = recorded ? undefined : atTaskHead.baseBranch(launch.config);
  if (configured) {
    const resolved = await resolveBaseRef(repoRoot, configured);
    if (resolved) {
      base = resolved;
    } else {
      emit({
        type: 'note',
        message: `configured base branch "${configured}" not found (locally or on origin) — using "${base}"`,
      });
    }
  }
  return base;
}

/** The task's worktree: an owned worker's verified workspace, or a new worktree forked from `base`.
 *  A worker never gets an ordinary task worktree: without a registered port its launch throws. */
export async function openExecutionWorktree(
  store: RunStore,
  repoRoot: string,
  dataDir: string,
  execution: Execution,
  launch: ExecutionLaunch,
  base: string,
  workspaces: WorkerWorkspacePort | undefined,
): Promise<WorkerWorkspaceOpened> {
  const { runId, startAt } = execution;
  const delegation = launch.ownedRun?.delegation;
  if (!launch.ownedRun || delegation?.role !== 'worker') return createWorktree(repoRoot, runId, base);
  return requireWorkerWorkspaces(workspaces).openForLaunch({ repoRoot, dataDir, run: launch.ownedRun,
    parentCwd: parentCwd(store, repoRoot, delegation), firstLaunch: startAt === 0 });
}
