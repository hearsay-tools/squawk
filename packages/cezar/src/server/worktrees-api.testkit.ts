import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { onTestFinished } from 'vitest';
import { autosaveCleanupBlocker } from '../autosave-cleanup.ts';
import { scopeFixtureProcesses } from '../delegation/process-scope.testkit.ts';
import { createWorktree } from '../git-worktree.ts';
import { Home } from '../home/home.ts';
import { useTestHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import type { RunStore } from '../runs/store.ts';
import { MaintenanceClaims } from '../workflows/run/maintenance-claims.ts';
import type { RunModuleContext } from '../workflows/run/types.ts';
import type { RunManager } from '../workflows/run.ts';
import { unused } from '../workflows/unused.testkit.ts';

export const run = promisify(execFile);
export const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** A committed Git repository with a `.ai/cezar` data directory, under a sandboxed empty home:
 *  `keep` falls back to the workspace default, so the suite never reads the developer's own home. */
export async function worktreesRepo(): Promise<{ repoRoot: string; cezHome: string }> {
  onTestFinished(scopeFixtureProcesses());
  const cezHome = mkdtempSync(join(tmpdir(), 'cez-wtapi-home-'));
  useTestHome(Home.sandbox(cezHome));
  const repoRoot = mkdtempSync(join(tmpdir(), 'cez-wtapi-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
  await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'base.txt'), 'base\n');
  await run('git', ['add', '-A'], { cwd: repoRoot });
  await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
  mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
  return { repoRoot, cezHome };
}

/** Restores the home `worktreesRepo` replaced and removes both directories. */
export function removeWorktreesRepo(paths: { repoRoot: string; cezHome: string }, savedHome: string | undefined): void {
  useTestHome(savedHome ? Home.sandbox(savedHome) : undefined);
  rmSync(paths.repoRoot, { recursive: true, force: true });
  rmSync(paths.cezHome, { recursive: true, force: true });
}

/** A run with a real worktree of its own, in `status`. */
export async function seedWorktreeRun(repoRoot: string, store: RunStore, id: string, status: 'done' | 'review' | 'running', finishedAt?: string): Promise<string> {
  const wt = await createWorktree(repoRoot, id, 'main');
  const rec = store.createRun({ title: `run ${id.slice(0, 4)}`, workflow: 'w', task: 't', steps: [] });
  setRunStatus(store, rec.id, status, { finishedAt, worktreePath: wt.path, branch: wt.branch });
  return rec.id;
}

/** The manager surface the worktree and checkout routes use, over the real maintenance claims.
 *  It runs nothing, so no run is active. Anything else throws. */
export function claimsManager(store: RunStore): RunManager {
  // createApp reads these while it builds the project contexts; no case here plans or schedules.
  const absent = { createRunner: undefined, setAutomationTools: undefined, setSkillCatalog: undefined } as unknown as Partial<RunManager>;
  const manager: RunManager = unused<RunManager>('manager', {
    ...absent,
    isActive: () => false,
    claimWorktreeReclaim: runId => claims.claimWorktreeReclaim(runId),
    claimForPublish: runId => claims.claimForPublish(runId),
    claimForBranchCleanup: runIds => claims.claimForBranchCleanup(runIds),
  });
  const claims: MaintenanceClaims = new MaintenanceClaims({ store, disposed: () => false } as unknown as RunModuleContext, {
    isActive: runId => manager.isActive(runId),
    autosaveCleanupBlocker: runId => autosaveCleanupBlocker(store.sourceDataDir(runId), runId),
    hasExecution: () => false,
    scheduleScratchCleanup: () => undefined,
    holdForMaintenance: runIds => claims.holdForMaintenance(runIds),
  });
  return manager;
}

/** A worker generation that started and completed, as the run line leaves a worker that ran. */
export function executedWorker(store: RunStore, workerId: string): void {
  store.commitWorkerExecutionComplete(workerId, store.commitWorkerExecutionStart(workerId));
}
