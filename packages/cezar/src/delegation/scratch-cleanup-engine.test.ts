import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentTmpDir, agentTmpEnv } from '../runs/agent-tmpdir.ts';
import { manager, store, root, worker, reopenRuntime, useWorkerWaitFixture } from '../workflows/worker-wait-claude.testkit.ts';
import { setHostScope } from '../worker-scope/worker-scopes.ts';
import { setRunStatus, readPersistedRuns, seedRuns } from '../runs/run-store.testkit.ts';

/** Scratch cleanup cases that need the run engine's own recovery and terminal-run reap. */
describe('durable scratch cleanup evidence', () => {
  useWorkerWaitFixture();
  beforeEach(() => { setHostScope({ backend: 'groups', reason: 'test' }); });
  afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); setHostScope(undefined); });

  async function completed(location = 'local') {
    const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
    setRunStatus(store, parent.id, RUN_STATUS.waiting, { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    const run = await worker(parent.id);
    const generation = store.commitWorkerExecutionStart(run.id);
    setRunStatus(store, run.id, RUN_STATUS.cancelled); store.commitWorkerExecutionComplete(run.id, generation);
    manager.pauseWorkerCleanup();
    const dataDir = join(root, '.ai/cezar'), scratch = location === 'local' ? agentTmpDir(dataDir, run.id) : agentTmpEnv(dataDir, run.id, {}).TMPDIR!;
    if (location === 'fallback') {
      expect(scratch).not.toBe(agentTmpDir(dataDir, run.id));
      expect(existsSync(join(scratch, '.cez-owner'))).toBe(true);
    }
    mkdirSync(scratch, { recursive: true }); writeFileSync(join(scratch, 'keep'), 'durable');
    return { run, generation, dataDir, scratch };
  }

  it('cannot treat a worker with stripped role metadata as an ordinary terminal run or deletable history', async () => {
    const { run, dataDir, scratch } = await completed();
    manager.dispose(); store.close();
    const rows = readPersistedRuns(dataDir);
    delete rows.find((row: { id: string }) => row.id === run.id)!.delegation;
    seedRuns(dataDir, rows); reopenRuntime();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await manager.recover(); setRunStatus(store, run.id, RUN_STATUS.cancelled);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(store.retention.deleteRun(run.id)).toBe(false);
      expect(existsSync(join(scratch, 'keep'))).toBe(true);
      // Restoration of valid ownership permits the existing recovery path to retry it.
      store.updateRun(run.id, { delegation: run.delegation }); manager.recoverWorkerCleanup();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(existsSync(scratch)).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});
