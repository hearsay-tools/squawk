import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { WorkerOperation } from '@open-mercato/cezar-contract';
import { isAuthenticatedCaller } from '../delegation/credentials.ts';
import { runnersUnderTest, useRunners } from '../core/runners-under-test.testkit.ts';
import { delegatingParent, parent, STARTUP_STALL_MS, store, useWorkerWaitFixture } from './worker-wait-claude.testkit.ts';

sealTestRunners();

describe('service-ready worker-wait fixture (hearsay-tools/cezarion#1752)', () => {
  useWorkerWaitFixture();

  it.each<{ permissions: WorkerOperation[] }>([{ permissions: [] }, { permissions: ['wait'] }, { permissions: ['spawn', 'wait', 'steer', 'inspect'] }])('opts in with exact permissions $permissions', async ({ permissions }) => {
    const f = await delegatingParent({ permissions });
    expect(store.getRun(f.p.id)?.delegation).toMatchObject({ role: 'root', permissions });
    const caller = f.callerFor(f.p.id);
    expect(isAuthenticatedCaller(caller)).toBe(true);
    expect(f.callerFor(f.p.id)).toBe(caller);
    expect(caller).toMatchObject({ projectId: 'project', runId: f.p.id });
    if (permissions.includes('inspect')) expect(await f.service.list(caller)).toMatchObject({ workers: [] });
    else await expect(f.service.list(caller)).rejects.toMatchObject({ code: 'denied_scope' });
    f.close(); f.close();
    expect(isAuthenticatedCaller(caller)).toBe(false);
    expect(() => f.callerFor(f.p.id)).toThrow('closed');
    await expect(f.service.list(caller)).rejects.toMatchObject({ code: 'denied_scope' });
  });

  it('builds the low-level parent with spawn and wait only', async () => {
    const p = await parent();
    expect(store.getRun(p.id)?.delegation).toMatchObject({ role: 'root', permissions: ['spawn', 'wait'] });
  });

  /** Hold every run's start where it loads its runner (`createRunner`) until `release`. `fail`
   *  releases it with a runner whose session cannot start, so the step fails before any session. */
  function gateRunnerLoad() {
    const real = runnersUnderTest();
    let reachedLoad!: () => void; let open!: (failure: Error | undefined) => void;
    const reached = new Promise<void>(resolve => { reachedLoad = resolve; });
    const gate = new Promise<Error | undefined>(resolve => { open = resolve; });
    useRunners(async backend => {
      reachedLoad();
      const failure = await gate; const runner = await real(backend);
      if (failure) vi.spyOn(runner, 'startSession').mockImplementation(() => { throw failure; });
      return runner;
    });
    onTestFinished(() => { vi.useRealTimers(); open(new Error('runner load gate closed')); useRunners(real); });
    return { reached, release: () => open(undefined), fail: (error: Error) => open(error) };
  }
  /** The run the fixture started, while `parent()` still waits on it. */
  const startingRun = () => store.queries.listRunIds()[0]!;

  // hearsay-tools/squawk#3042: the parent start waits on its session's start, not on a fixed bound.
  it('lets a start that keeps making progress take longer than the stall guard', async () => {
    const load = gateRunnerLoad();
    const started = parent();
    await load.reached;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      for (let elapsed = 0; elapsed < 3 * STARTUP_STALL_MS; elapsed += STARTUP_STALL_MS / 2) {
        store.eventLog.appendEvent(startingRun(), { type: 'note', message: `still loading after ${elapsed} ms` });
        await vi.advanceTimersByTimeAsync(STARTUP_STALL_MS / 2);
      }
    } finally { vi.useRealTimers(); load.release(); }
    const p = await started;
    expect(store.eventLog.readEvents(p.id).some(event => event.type === 'session')).toBe(true);
  });

  it('fails a start that stalls, naming its step and its events', async () => {
    const load = gateRunnerLoad();
    const started = parent();
    const failure = expect(started).rejects.toThrow(/made no progress for 15000 ms before its session started, at step task:\nevents of run/);
    await load.reached;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // The guard counts from the run's latest write or event.
      store.eventLog.appendEvent(startingRun(), { type: 'note', message: 'last progress' });
      await vi.advanceTimersByTimeAsync(STARTUP_STALL_MS);
      await failure;
    } finally { vi.useRealTimers(); load.fail(new Error('released after the stall')); }
  });

  it('fails at once, with the run\'s error, when the run fails before its session starts', async () => {
    const load = gateRunnerLoad();
    const started = parent();
    await load.reached;
    load.fail(new Error('runner load failed'));
    await expect(started).rejects.toThrow(/ failed before its session started: .*runner load failed/);
  });
});
