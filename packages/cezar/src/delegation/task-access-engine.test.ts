import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture } from './service-engine.testkit.ts';
import { QUICK_TASK_WORKFLOW } from '../workflows/types.ts';
import { workerCleanups } from './worker-cleanup.ts';

// Per-task access (hearsay-tools/cezarion#2784): the engine's acceptance defaults for a new run.
describe('task access', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { f = fixture(workerCleanups()); });
  afterEach(async () => {
    for (const run of f.store.listRuns()) if (f.manager.isActive(run.id)) f.manager.cancel(run.id);
    await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  });

  it('a new run stores an explicit choice: on when omitted, off when asked', async () => {
    const omitted = f.manager.startRun(QUICK_TASK_WORKFLOW, { task: 'omitted', worktree: false });
    const off = f.manager.startRun(QUICK_TASK_WORKFLOW, { task: 'off', worktree: false, allowWorkers: false, allowMessaging: false });
    expect(f.store.getRun(omitted.id)).toMatchObject({ allowWorkers: true, allowMessaging: true });
    expect(f.store.getRun(off.id)).toMatchObject({ allowWorkers: false, allowMessaging: false });
    for (const id of [omitted.id, off.id]) { f.manager.cancel(id); await f.manager.awaitRunTermination(id, 5_000); }
  });
});
