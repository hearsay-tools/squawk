import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, onTestFinished } from 'vitest';
import { STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { RunStore } from '../runs/store.ts';
import { RunStoreOpenError } from '../runs/store-open-error.ts';
import { scopeFixtureProcesses } from './process-scope.testkit.ts';
import { planOwnedWorkspace } from './workspace.ts';

/** The project root of the current test: a Git repository with one empty commit. */
export let root: string;
/** The run store of the current test, under `root`. */
export let store: RunStore;

function openStore(): RunStore {
  // As `serve` boots: a store that cannot open is kept as `RunStore.unavailable` (hearsay-tools/cezarion#779).
  try {
    return RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
  } catch (error) {
    if (!(error instanceof RunStoreOpenError)) throw error;
    return RunStore.unavailable(join(root, '.ai/cezar'), error);
  }
}

/** A restart of the store alone: the old store closes first, then the database opens again. */
export function reopenStore(): void {
  store.close();
  store = openStore();
}

/** A real store over a fresh Git repository per test, with process enumeration scoped to the
 * test's own process tree. No run manager: scratch cleanup reads the store directly. */
export function useScratchCleanupFixture(): void {
  beforeEach(() => {
    onTestFinished(scopeFixtureProcesses());
    root = mkdtempSync(join(tmpdir(), 'cez-scratch-cleanup-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
    store = openStore();
  });
  afterEach(() => {
    try { store.close(); } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

/** A worker of `parentId` with an owned isolated workspace planned under `root`. */
export async function worker(parentId: string) {
  const id = randomUUID();
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const workspace = await planOwnedWorkspace(root, id, sha);
  return store.createOwnedRun({ title: 'worker', task: 'mock:hold', workflow: 'quick-task', runner: 'claude', steps: [{ id: 'task', kind: STEP_KIND.agent, name: 'Task' }] }, parentId, randomUUID(), {
    role: 'worker', permissions: [], parentRunId: parentId, workspace,
  }, 'a'.repeat(64));
}
