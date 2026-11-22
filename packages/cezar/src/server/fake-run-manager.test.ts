import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { QUICK_TASK_WORKFLOW } from '../workflows/types.ts';
import { fixture as fakeFixture } from '../delegation/service.testkit.ts';
import { fixture as engineFixture } from '../delegation/service-engine.testkit.ts';

// The fake must write what the engine writes for a run no session holds (hearsay-tools/squawk#3937).
// Each case runs on both, over the same delegation fixture, and compares the store's records.
type Fixture = ReturnType<typeof fakeFixture> | ReturnType<typeof engineFixture>;
const managers = [
  { name: 'FakeRunManager', build: (): Fixture => fakeFixture() },
  { name: 'RunManager', build: (): Fixture => engineFixture() },
];

describe.each(managers)('$name, before any session starts', ({ build }) => {
  let f: Fixture | undefined;
  afterEach(async () => { await f?.close(); f = undefined; });
  const open = () => (f = build());

  it('accepts a run as a queued record with the task\'s references', () => {
    const { manager, store } = open();
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'Fix GitHub issue #12', runner: 'claude', worktree: false });
    expect(store.getRun(run.id)).toMatchObject({ status: RUN_STATUS.queued, workflow: 'quick-task', task: 'Fix GitHub issue #12', issueNumber: 12, runner: 'claude' });
    expect(manager.isActive(run.id)).toBe(true);
  });

  it('replays an idempotent start with the same hash and refuses another hash', () => {
    const { manager } = open();
    const request = { id: randomUUID(), hash: 'one' };
    const first = manager.startRunIdempotent(QUICK_TASK_WORKFLOW, { task: 'once', runner: 'claude', worktree: false }, request);
    expect(first).toMatchObject({ created: true });
    const runId = 'run' in first ? first.run.id : '';
    expect(manager.startRunIdempotent(QUICK_TASK_WORKFLOW, { task: 'once', runner: 'claude', worktree: false }, request)).toMatchObject({ created: false, run: { id: runId } });
    expect(manager.startRunIdempotent(QUICK_TASK_WORKFLOW, { task: 'once', runner: 'claude', worktree: false }, { ...request, hash: 'two' })).toEqual({ conflict: true });
  });

  it('stacks a message on a queued run, and Stop takes the run out of the line', () => {
    const { manager, store } = open();
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'later', runner: 'claude', worktree: false });
    expect(manager.enqueueMessage(run.id, [{ type: 'text', text: 'also this' }])).toMatchObject({ text: 'also this' });
    expect(store.getRun(run.id)?.queuedMessages?.map(message => message.text)).toEqual(['also this']);
    expect(manager.cancel(run.id)).toBe(true);
    expect(store.getRun(run.id)?.status).toBe(RUN_STATUS.cancelled);
    expect(manager.isActive(run.id)).toBe(false);
    expect(manager.enqueueMessage(run.id, [{ type: 'text', text: 'too late' }])).toBeNull();
    expect(manager.cancel(run.id)).toBe(false);
  });

  it('keeps an accepted run queued when a later acceptance write fails', () => {
    const { manager, store } = open();
    const created = vi.spyOn(store, 'createRun');
    vi.spyOn(store, 'updateRun').mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => manager.startRun(QUICK_TASK_WORKFLOW, { task: 'half written', runner: 'claude', worktree: false })).toThrow('disk full');
    const runId = created.mock.results[0]!.value.id as string;
    expect(store.getRun(runId)?.status).toBe(RUN_STATUS.queued);
    expect(manager.isActive(runId)).toBe(true);
  });

  it('refuses to continue a run that does not exist', () => {
    const { manager } = open();
    expect(manager.continueRun(randomUUID())).toEqual({ ok: false, error: 'not found' });
  });

  it('accepts Finish on a review run with no session', () => {
    const { manager, store, parent } = open();
    setRunStatus(store, parent.id, RUN_STATUS.review);
    expect(manager.finish(parent.id)).toBe(true);
    expect(store.getRun(parent.id)?.status).toBe(RUN_STATUS.done);
  });

  it('queues a spawned worker, queues its steering input and stops it as terminated', async () => {
    const { manager, store, service, caller } = open();
    const { workerId } = await service.spawn(caller, { task: 'work', baseline: 'HEAD', requestId: randomUUID() });
    expect(store.getRun(workerId)?.status).toBe(RUN_STATUS.queued);
    expect(manager.isActive(workerId)).toBe(true);
    expect(await service.steer(caller, { workerId }, { text: 'hello' })).toEqual({ workerId, state: 'queued' });
    expect(store.getRun(workerId)?.agentInputs?.map(input => input.text)).toEqual(['hello']);
    expect(manager.requestWorkerStop(workerId)).toEqual({ workerId, state: 'terminated' });
    expect(store.getRun(workerId)?.status).toBe(RUN_STATUS.cancelled);
    expect(store.workerExecutions.readWorkerExecution(workerId)?.phase).toBe('complete');
    expect(manager.isActive(workerId)).toBe(false);
    // bound: a queued worker that never launched has nothing left to stop.
    expect(await manager.awaitRunTermination(workerId, 8_000)).toBe(true);
  });

  it('refuses a worker wait from a parent with no live session', () => {
    const { manager, parent } = open();
    expect(() => manager.registerWorkerWait(parent.id, { workerIds: [randomUUID()], mode: 'all', timeoutSeconds: 60 }))
      .toThrow(expect.objectContaining({ code: 'incompatible_state' }));
  });
});
