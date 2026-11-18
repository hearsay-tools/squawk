import type { RunRecord } from '../../runs/store.ts';

/** One worker run and where its files live. `parentCwd` is the directory its parent works in. */
export type WorkerWorkspaceRequest = { repoRoot: string; dataDir: string; run: RunRecord; parentCwd: string };

/** One ended execution of a worker run: `generation` is the id of that execution. */
export type WorkerSettlement = { repoRoot: string; dataDir: string; run: RunRecord; generation: string };

/** Where a launch runs. `branch` is the workspace's own branch; a workspace without one leaves it out. */
export type WorkerWorkspaceOpened = { path: string; branch?: string; baseBranch: string };

/** What the run engine asks of a worker's workspace. The workers feature registers the
 *  implementation with `RunManager.setWorkerWorkspaces` when a project registers (ADR 0065). */
export interface WorkerWorkspacePort {
  /** The verified workspace a launch runs in. A first launch also places the worker's context files. */
  openForLaunch(request: WorkerWorkspaceRequest & { firstLaunch: boolean }): Promise<WorkerWorkspaceOpened>;
  /** The verified directory a Continue runs in. Never creates or replaces it. */
  openForContinue(request: WorkerWorkspaceRequest): Promise<string>;
  /** The worker's execution `generation` ended. Never throws. */
  settle(request: WorkerSettlement): Promise<void>;
}

/** A worker run with no registered port has no workspace: the caller fails the run. */
export function requireWorkerWorkspaces(port: WorkerWorkspacePort | undefined): WorkerWorkspacePort {
  if (!port) throw new Error('Worker workspaces are unavailable: no worker workspace port is registered');
  return port;
}
