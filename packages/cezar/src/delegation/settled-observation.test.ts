import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { fixture } from './service.testkit.ts';
import { workspaceKindOf } from './workspace-kinds.ts';

describe('worker settlement observations (hearsay-tools/squawk#3901)', () => {
  let f: ReturnType<typeof fixture>;
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); });

  async function worker() {
    f = fixture();
    const { workerId } = await f.service.spawn(f.caller, { task: 'work', baseline: 'HEAD', requestId: randomUUID() });
    f.manager.cancel(workerId);
    // bound: drain the scheduler entry before seeding a session's private completion state.
    expect(await f.manager.awaitRunTermination(workerId, 8_000)).toBe(true);
    return workerId;
  }

  it('collect sees termination completed during its evidence read at the same revision as inspect and list', async () => {
    const workerId = await worker();
    const generation = f.store.workerExecutions.commitWorkerExecutionStart(workerId);
    setRunStatus(f.store, workerId, RUN_STATUS.review);
    const run = f.store.getRun(workerId)!;
    vi.spyOn(workspaceKindOf(run), 'readHead').mockImplementationOnce(async () => {
      expect(f.store.workerExecutions.readWorkerExecution(workerId)?.phase).toBe('starting');
      f.store.workerExecutions.commitWorkerExecutionComplete(workerId, generation);
      return f.sha;
    });
    const collected = await f.service.collect(f.caller, { workerId });
    const inspected = await f.service.inspect(f.caller, { workerId });
    const listed = (await f.service.list(f.caller, {})).workers[0]!;
    expect(collected.revision).toBe(listed.revision);
    expect(listed.settled).toBe(true);
    expect(collected).toMatchObject({ settled: true, partial: false });
    expect(inspected).toMatchObject({ settled: true });
  });

  it('keeps every observation unsettled until private termination is proven', async () => {
    const workerId = await worker();
    const generation = f.store.workerExecutions.commitWorkerExecutionStart(workerId);
    setRunStatus(f.store, workerId, RUN_STATUS.cancelled);
    expect(await f.service.inspect(f.caller, { workerId })).toMatchObject({ settled: false });
    expect((await f.service.list(f.caller, {})).workers[0]).toMatchObject({ settled: false });
    expect(await f.service.collect(f.caller, { workerId })).toMatchObject({ settled: false, partial: true });
    f.store.workerExecutions.commitWorkerExecutionComplete(workerId, generation);
  });
});
