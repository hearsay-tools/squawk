/** The worker workspace kinds: one definition per `workspace.kind`. Delegation code and the run
 *  engine's port ask the definition; they never call a kind's own functions directly. */
import type { WorkerDestroy, WorkerDestroyResult, WorkerDiff, WorkerWorkspace } from '@open-mercato/cezar-contract';
import { runGit } from '../git-command.ts';
import type { RunRecord } from '../runs/store.ts';
import type { WorkerWorkspaceOpened, WorkerWorkspacePort, WorkerWorkspaceRequest } from '../workflows/run/worker-workspace-port.ts';
import { placeWorkerAttachments, prepareWorkerContext, verifyWorkerContext } from './context.ts';
import { ensureOwnedWorkspace, planOwnedWorkspace, readOwnedDiff, verifyOwnedWorkspace } from './workspace.ts';

export type WorkspaceResource = Exclude<WorkerDestroy['remaining'][number], 'process'>;

/** What a removal releases first, and the checks it repeats before each destructive step. */
export type WorkspaceRemoval = {
  previewHost?: { release(runId: string): Promise<void> } | undefined;
  assertCurrent?: (() => void) | undefined;
  assertUnheld?: (() => void) | undefined;
  /** How long the removal may wait for a lock it needs. Left out: it does not wait. */
  waitMs?: number;
};

export interface WorkspaceKind {
  /** What a destroy removes besides the worker's processes. */
  readonly destroyResources: readonly WorkspaceResource[];
  /** The workspace record of a new worker. No resource side effects. */
  plan(repoRoot: string, workerId: string, baselineSha: string): Promise<WorkerWorkspace>;
  /** Snapshot a spawn's context inputs and name where the worker reads each one. */
  prepareContext(options: Parameters<typeof prepareWorkerContext>[0]): ReturnType<typeof prepareWorkerContext>;
  /** The verified workspace a launch runs in. A first launch also places the worker's context files. */
  openForLaunch(request: WorkerWorkspaceRequest & { firstLaunch: boolean }): Promise<WorkerWorkspaceOpened>;
  /** The verified directory a Continue runs in. Never creates or replaces it. */
  openForContinue(request: WorkerWorkspaceRequest): Promise<string>;
  /** Throws, naming what is gone, when a fresh session could not restart from the workspace. */
  assertResumable(repoRoot: string, run: RunRecord): Promise<void>;
  /** The commit the verified workspace is at. */
  readHead(repoRoot: string, run: RunRecord): Promise<string>;
  readDiff(repoRoot: string, run: RunRecord): Promise<WorkerDiff>;
  /** Runs `config`, the project's `worktreeTeardown` value, before a destroy. Returns why it failed, if it did. */
  teardown(repoRoot: string, config: unknown, workspace: WorkerWorkspace): Promise<string | undefined>;
  /** Removes the workspace's resources and reports the ones that remain. */
  remove(repoRoot: string, workspace: WorkerWorkspace, removal: WorkspaceRemoval): Promise<WorkerDestroyResult>;
}

type WorkerDelegation = Extract<NonNullable<RunRecord['delegation']>, { role: 'worker' }>;

function workerDelegation(run: RunRecord): WorkerDelegation {
  if (run.delegation?.role !== 'worker') throw new Error('Missing worker ownership');
  return run.delegation;
}

/** A worker with its own worktree and branch, forked from the baseline commit. */
const isolated: WorkspaceKind = {
  destroyResources: ['worktree', 'branch'],
  plan: planOwnedWorkspace,
  prepareContext: prepareWorkerContext,
  async openForLaunch({ repoRoot, dataDir, run, parentCwd, firstLaunch }) {
    const workspace = await ensureOwnedWorkspace(repoRoot, run);
    const delegation = workerDelegation(run);
    await verifyWorkerContext({ dataDir, parentId: delegation.parentRunId, workspace: delegation.workspace, context: delegation.context, parentCwd });
    // First launch only (hearsay-tools/cezarion#1149): a worker re-queued past its first step and
    // runContinuation never re-place attachments the worker may have edited or deleted.
    if (firstLaunch) await placeWorkerAttachments({ dataDir, workspace: delegation.workspace, context: delegation.context });
    return { path: workspace.path, branch: workspace.branch, baseBranch: workspace.baselineSha };
  },
  async openForContinue({ repoRoot, dataDir, run, parentCwd }) {
    const { path } = await verifyOwnedWorkspace(repoRoot, run);
    const delegation = workerDelegation(run);
    await verifyWorkerContext({ dataDir, parentId: delegation.parentRunId, workspace: delegation.workspace, context: delegation.context, parentCwd });
    return path;
  },
  async assertResumable(repoRoot, run) {
    const workspace = await verifyOwnedWorkspace(repoRoot, run);
    // The branch is the work a fresh session reads from (its notice says `git log`): prove its ref too.
    await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${workspace.branch}^{commit}`], { cwd: repoRoot, timeout: 30_000 })
      .catch(() => { throw new Error(`branch ${workspace.branch} is missing`); });
  },
  async readHead(repoRoot, run) {
    const workspace = await verifyOwnedWorkspace(repoRoot, run);
    return (await runGit(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: workspace.path, timeout: 30_000, maxBuffer: 1024 })).stdout.trim();
  },
  readDiff: readOwnedDiff,
  // The teardown and removal modules load at the first destroy: a process that destroys no worker never loads them.
  async teardown(repoRoot, config, workspace) {
    return (await import('./worktree-teardown.ts')).runWorktreeTeardown(repoRoot, config, workspace);
  },
  async remove(repoRoot, workspace, { previewHost, assertCurrent, assertUnheld, waitMs }) {
    return (await import('./owned-workspace-release.ts')).releaseThenRemoveOwnedWorkspace({ previewHost }, repoRoot, workspace, assertCurrent, assertUnheld,
      waitMs === undefined ? {} : { waitMs });
  },
};

export const workspaceKinds: Readonly<Record<WorkerWorkspace['kind'], WorkspaceKind>> = { 'owned-isolated': isolated };

/** The kind a spawn plans. */
export const DEFAULT_WORKSPACE_KIND: WorkerWorkspace['kind'] = 'owned-isolated';

/** The definition a workspace record names. */
export function workspaceKind(workspace: Pick<WorkerWorkspace, 'kind'>): WorkspaceKind {
  if (!Object.hasOwn(workspaceKinds, workspace.kind)) throw new Error(`Unknown worker workspace kind: ${String(workspace.kind)}`);
  return workspaceKinds[workspace.kind];
}

/** The definition a worker run's workspace record names. Throws for a run that is no worker. */
export function workspaceKindOf(run: RunRecord): WorkspaceKind {
  return workspaceKind(workerDelegation(run).workspace);
}

/** The run engine's port: each call goes to the definition the worker's workspace record names. */
export const workerWorkspacePort: WorkerWorkspacePort = {
  openForLaunch: async request => workspaceKindOf(request.run).openForLaunch(request),
  openForContinue: async request => workspaceKindOf(request.run).openForContinue(request),
};
