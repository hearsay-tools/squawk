/** The worker workspace kinds: one definition per `workspace.kind`. Delegation code and the run
 *  engine's port ask the definition; they never call a kind's own functions directly. */
import type { WorkerChangeReport, WorkerDestroy, WorkerDestroyResult, WorkerDiff, WorkerWorkspace } from '@open-mercato/cezar-contract';
import { ownedWorkspace, type WORKSPACE_CHOICES } from '@open-mercato/cezar-contract/delegation';
import { runGit } from '../git-command.ts';
import type { RunRecord } from '../runs/store.ts';
import type { WorkerSettlement, WorkerWorkspaceOpened, WorkerWorkspacePort, WorkerWorkspaceRequest } from '../workflows/run/worker-workspace-port.ts';
import { placeWorkerAttachments, prepareWorkerContext, verifyWorkerContext } from './context.ts';
import { DelegationPolicyError } from './policy.ts';
import { SHARED_NO_DIFF, planSharedWorkspace, readSharedHead, sharedContextSources, verifySharedContext, verifySharedWorkspace } from './shared-workspace.ts';
import { ensureOwnedWorkspace, planOwnedWorkspace, readOwnedDiff, verifyOwnedWorkspace } from './workspace.ts';
import { clearWorkspaceEnds, recordWorkspaceEnd, recordWorkspaceStart, workspaceChangeReport, type WorkspaceReportTarget } from './workspace-state.ts';

export type WorkspaceResource = Exclude<WorkerDestroy['remaining'][number], 'process'>;

/** What a removal releases first, and the checks it repeats before each destructive step. */
export type WorkspaceRemoval = {
  previewHost?: { release(runId: string): Promise<void> } | undefined;
  assertCurrent?: (() => void) | undefined;
  assertUnheld?: (() => void) | undefined;
  /** How long the removal may wait for a lock it needs. Left out: the kind's default wait. */
  waitMs?: number;
};

/** A new worker's id and baseline, and the run that spawns it with the directory that run works in. */
export type WorkspacePlanRequest = { repoRoot: string; workerId: string; baselineSha: string; hostRunId: string; hostDirectory: string };

export interface WorkspaceKind {
  /** What a destroy removes besides the worker's processes. */
  readonly destroyResources: readonly WorkspaceResource[];
  /** A sentence the worker's own prompt gains; left out when the kind needs none. */
  readonly workerNotice?: string;
  /** Why the kind has no diff of its own; left out when it has one. */
  readonly noDiff?: string;
  /** The workspace record of a new worker. No resource side effects. */
  plan(request: WorkspacePlanRequest): Promise<WorkerWorkspace>;
  /** Snapshot a spawn's context inputs and name where the worker reads each one. */
  prepareContext(options: Parameters<typeof prepareWorkerContext>[0]): ReturnType<typeof prepareWorkerContext>;
  /** The verified workspace a launch runs in. A first launch also places the worker's context files. */
  openForLaunch(request: WorkerWorkspaceRequest & { firstLaunch: boolean }): Promise<WorkerWorkspaceOpened>;
  /** The verified directory a Continue runs in. Never creates or replaces it. */
  openForContinue(request: WorkerWorkspaceRequest): Promise<string>;
  /** The worker's execution `generation` ended. */
  settle(request: WorkerSettlement): Promise<void>;
  /** Throws, naming what is gone, when a fresh session could not restart from the workspace. */
  assertResumable(repoRoot: string, run: RunRecord): Promise<void>;
  /** The commit the verified workspace is at. */
  readHead(repoRoot: string, run: RunRecord): Promise<string>;
  readDiff(repoRoot: string, run: RunRecord): Promise<WorkerDiff>;
  /** Whether the workspace's directory changed during the worker's run; `target` names its current
   *  execution and says whether that ended. Undefined for a kind whose worker has the directory to itself: its diff says
   *  what it changed. */
  changeReport(dataDir: string, run: RunRecord, target: WorkspaceReportTarget): Promise<WorkerChangeReport | undefined>;
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
  plan: ({ repoRoot, workerId, baselineSha }) => planOwnedWorkspace(repoRoot, workerId, baselineSha),
  prepareContext: prepareWorkerContext,
  async openForLaunch({ repoRoot, dataDir, run, parentCwd, firstLaunch }) {
    const workspace = await ensureOwnedWorkspace(repoRoot, run);
    const delegation = workerDelegation(run);
    await verifyWorkerContext({ dataDir, parentId: delegation.supervisorRunId ?? delegation.parentRunId, workspace: delegation.workspace, context: delegation.context, parentCwd });
    // First launch only (hearsay-tools/cezarion#1149): a worker re-queued past its first step and
    // runContinuation never re-place attachments the worker may have edited or deleted.
    if (firstLaunch) await placeWorkerAttachments({ dataDir, workspace: delegation.workspace, context: delegation.context });
    return { path: workspace.path, branch: workspace.branch, baseBranch: workspace.baselineSha };
  },
  async openForContinue({ repoRoot, dataDir, run, parentCwd }) {
    const { path } = await verifyOwnedWorkspace(repoRoot, run);
    const delegation = workerDelegation(run);
    await verifyWorkerContext({ dataDir, parentId: delegation.supervisorRunId ?? delegation.parentRunId, workspace: delegation.workspace, context: delegation.context, parentCwd });
    return path;
  },
  async settle() {},
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
  async changeReport() { return undefined; },
  // The teardown and removal modules load at the first destroy: a process that destroys no worker never loads them.
  async teardown(repoRoot, config, workspace) {
    return (await import('./worktree-teardown.ts')).runWorktreeTeardown(repoRoot, config, ownedWorkspace(workspace));
  },
  async remove(repoRoot, workspace, { previewHost, assertCurrent, assertUnheld, waitMs }) {
    return (await import('./owned-workspace-release.ts')).releaseThenRemoveOwnedWorkspace({ previewHost }, repoRoot, ownedWorkspace(workspace), assertCurrent, assertUnheld,
      waitMs === undefined ? {} : { waitMs });
  },
};

/** A worker in its host run's directory, at the host's HEAD. It has no worktree and no branch, so
 *  a destroy removes nothing and takes no worktree mutation lock. */
const shared: WorkspaceKind = {
  destroyResources: [],
  noDiff: SHARED_NO_DIFF,
  workerNotice: 'You share your parent\'s worktree: do not write there unless your task says so.',
  plan: planSharedWorkspace,
  prepareContext: options => prepareWorkerContext(options, sharedContextSources),
  async openForLaunch({ repoRoot, dataDir, run, firstLaunch }) {
    if (workerDelegation(run).destroy) throw new Error('Worker destruction has begun');
    const workspace = await verifySharedWorkspace(repoRoot, run);
    const delegation = workerDelegation(run);
    await verifySharedContext({ repoRoot, dataDir, parentId: delegation.supervisorRunId ?? delegation.parentRunId, workspace, context: delegation.context });
    // A failed read leaves no start state: the change report then says it is unavailable.
    if (firstLaunch) await recordWorkspaceStart(dataDir, run.id, workspace.path).catch(() => undefined);
    await clearWorkspaceEnds(dataDir, run.id);
    return { path: workspace.path, baseBranch: workspace.baselineSha };
  },
  async openForContinue({ repoRoot, dataDir, run }) {
    const workspace = await verifySharedWorkspace(repoRoot, run);
    const delegation = workerDelegation(run);
    await verifySharedContext({ repoRoot, dataDir, parentId: delegation.supervisorRunId ?? delegation.parentRunId, workspace, context: delegation.context });
    await clearWorkspaceEnds(dataDir, run.id);
    return workspace.path;
  },
  async settle({ dataDir, run, generation }) {
    await recordWorkspaceEnd(dataDir, run.id, workerDelegation(run).workspace.path, generation).catch(() => undefined);
  },
  async assertResumable(repoRoot, run) { await verifySharedWorkspace(repoRoot, run); },
  readHead: readSharedHead,
  async readDiff() { throw new DelegationPolicyError('unavailable_diff', SHARED_NO_DIFF); },
  async changeReport(dataDir, run, target) { return workspaceChangeReport(dataDir, run.id, workerDelegation(run).workspace.path, target); },
  async teardown() { return undefined; },
  async remove(_repoRoot, workspace) { return { workerId: workspace.ownerRunId, state: 'complete', deleted: [], remaining: [] }; },
};

export const workspaceKinds: Readonly<Record<WorkerWorkspace['kind'], WorkspaceKind>> = { 'owned-isolated': isolated, shared };

/** Whether a destroy that left `remaining` removed the workspace's directory. A kind that removes
 *  no directory never did. */
export function workspaceDirectoryRemoved(workspace: Pick<WorkerWorkspace, 'kind'>, remaining: readonly WorkerDestroy['remaining'][number][]): boolean {
  return workspaceKind(workspace).destroyResources.includes('worktree') && !remaining.includes('worktree');
}

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
  settle: async request => { try { await workspaceKindOf(request.run).settle(request); } catch { /* the port's settle never throws */ } },
};
