import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSendRequest } from '@open-mercato/cezar-contract/conversations';
import { RUN_STATUS, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunRecord } from '../runs/store.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { WORKERS_OFF } from './policy.ts';
import { fixture } from './service-engine.testkit.ts';
import { QUICK_TASK_WORKFLOW } from '../workflows/types.ts';
import { workerCleanups } from './worker-cleanup.ts';

// Per-task access (hearsay-tools/cezarion#2784): the engine's acceptance defaults for a new run, and a
// resume the engine accepts once workers are on again.
describe('task access', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { f = fixture(workerCleanups()); });
  afterEach(async () => {
    for (const run of f.store.listRuns()) if (f.manager.isActive(run.id)) f.manager.cancel(run.id);
    await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  });

  const spawnInput = () => ({ task: 'work', baseline: 'parent-head', requestId: randomUUID() });
  const access = (id: string, patch: Pick<RunRecord, 'allowWorkers' | 'allowMessaging'>) => f.store.updateRun(id, patch);
  const message = (recipientRunId: string, kind: ConversationSendRequest['kind'] = 'request', extra: Partial<ConversationSendRequest> = {}): ConversationSendRequest =>
    ({ id: randomUUID(), recipientRunId, kind, text: `${kind} text`, timeoutSeconds: 600, ...extra });
  async function completedWorker() {
    const { workerId } = await f.service.spawn(f.caller, spawnInput());
    f.manager.cancel(workerId);
    await f.manager.awaitRunTermination(workerId, 5_000);
    f.store.updateStep(workerId, 'task', { status: STEP_STATUS.done, sessionId: 'previous-session', backend: 'claude' });
    const generation = f.store.workerExecutions.commitWorkerExecutionStart(workerId);
    setRunStatus(f.store, workerId, RUN_STATUS.done);
    f.store.workerExecutions.commitWorkerExecutionComplete(workerId, generation);
    return workerId;
  }

  it('a new run stores an explicit choice: on when omitted, off when asked', async () => {
    const omitted = f.manager.startRun(QUICK_TASK_WORKFLOW, { task: 'omitted', worktree: false });
    const off = f.manager.startRun(QUICK_TASK_WORKFLOW, { task: 'off', worktree: false, allowWorkers: false, allowMessaging: false });
    expect(f.store.getRun(omitted.id)).toMatchObject({ allowWorkers: true, allowMessaging: true });
    expect(f.store.getRun(off.id)).toMatchObject({ allowWorkers: false, allowMessaging: false });
    for (const id of [omitted.id, off.id]) { f.manager.cancel(id); await f.manager.awaitRunTermination(id, 5_000); }
  });

  // A resume needs the engine to accept the Continue once workers are on again.
  it('refuses --resume of a settled worker once workers are off and accepts nothing', async () => {
    const workerId = await completedWorker();
    access(f.parent.id, { allowWorkers: false });
    const request = { ...message(workerId), resume: true };
    await expect(f.service.send(f.caller, request)).rejects.toMatchObject({ code: 'incompatible_state', message: WORKERS_OFF });
    expect(f.store.getRun(workerId)).toMatchObject({ status: RUN_STATUS.done });
    expect(f.store.getRun(f.parent.id)?.delegation).not.toHaveProperty('conversation.messages.0');
    access(f.parent.id, { allowWorkers: true });
    await expect(f.service.send(f.caller, request)).resolves.toMatchObject({ message: { resumed: true } });
  });
});
