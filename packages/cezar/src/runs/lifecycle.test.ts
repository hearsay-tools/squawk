import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunEvent } from '@open-mercato/cezar-contract';
import { publishRunWrite, RunLifecycle, snapshotRun, type RunLifecycleHandlers } from './lifecycle.ts';

/**
 * The run lifecycle with no run store (.ai/specs/2026-11-21-run-lifecycle-and-store-ports.md § The
 * lifecycle): a test builds a `RunLifecycle`, subscribes and publishes the events of one run.
 */

afterEach(() => vi.restoreAllMocks());

/** Every handler of `handlers` that records `<label>:<type>` in `log`. */
function recording(log: string[], label = 'a'): RunLifecycleHandlers {
  return {
    'run.created': ({ run }) => { log.push(`${label}:run.created:${run.status}`); },
    'run.updated': ({ run, before, source }) => { log.push(`${label}:run.updated:${before.status}->${run.status}${source ? `:${source}` : ''}`); },
    'run.status-changed': ({ exit, from, to }) => { log.push(`${label}:run.status-changed:${exit}:${from}->${to}`); },
    'run.deleted': ({ runId }) => { log.push(`${label}:run.deleted:${runId}`); },
    'run.event': ({ event }) => { log.push(`${label}:run.event:${event.type}`); },
    'store.closed': () => { log.push(`${label}:store.closed`); },
  };
}

const lifecycleEvent = (seq: number): RunEvent => ({ type: 'lifecycle', message: 'run cancelled', seq, ts: '2026-11-21T10:00:00.000Z' } as RunEvent);

describe('RunLifecycle', () => {
  it('delivers the events of one run in order', () => {
    const lifecycle = new RunLifecycle();
    const log: string[] = [];
    lifecycle.subscribe(recording(log));
    const queued = makeRunRecord({ status: RUN_STATUS.queued });
    publishRunWrite(lifecycle, queued, undefined);
    const running = { ...queued, status: RUN_STATUS.running };
    publishRunWrite(lifecycle, running, snapshotRun(queued), undefined, 'start');
    const cancelled = { ...running, status: RUN_STATUS.cancelled };
    publishRunWrite(lifecycle, cancelled, snapshotRun(running), undefined, 'cancel');
    lifecycle.publish('run.event', { runId: queued.id, event: lifecycleEvent(1) });
    lifecycle.publish('run.deleted', { runId: queued.id });
    lifecycle.publish('store.closed', {});
    expect(log).toEqual([
      'a:run.created:queued',
      'a:run.updated:queued->running',
      'a:run.status-changed:start:queued->running',
      'a:run.updated:running->cancelled',
      'a:run.status-changed:cancel:running->cancelled',
      'a:run.event:lifecycle',
      `a:run.deleted:${queued.id}`,
      'a:store.closed',
    ]);
  });

  it('publishes no status change when the status stayed, and a patch or a conflict without an exit', () => {
    const lifecycle = new RunLifecycle();
    const log: string[] = [];
    lifecycle.subscribe(recording(log));
    const run = makeRunRecord({ status: RUN_STATUS.running });
    publishRunWrite(lifecycle, { ...run, title: 'renamed' }, snapshotRun(run), 'live-release');
    publishRunWrite(lifecycle, { ...run, status: RUN_STATUS.done }, snapshotRun(run));
    publishRunWrite(lifecycle, { ...run, status: RUN_STATUS.failed }, snapshotRun(run), 'conflict', 'fail');
    expect(log).toEqual([
      'a:run.updated:running->running:live-release',
      'a:run.updated:running->done',
      'a:run.status-changed:patch:running->done',
      'a:run.updated:running->failed:conflict',
      'a:run.status-changed:conflict:running->failed',
    ]);
  });

  it('calls listeners in subscription order, and logs a throwing listener with its event type and run id', () => {
    const lifecycle = new RunLifecycle();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log: string[] = [];
    lifecycle.subscribe(recording(log, 'first'));
    lifecycle.subscribe({ 'run.deleted': () => { throw new Error('listener broke'); } });
    lifecycle.subscribe(recording(log, 'third'));
    lifecycle.publish('run.deleted', { runId: 'run-1' });
    expect(log).toEqual(['first:run.deleted:run-1', 'third:run.deleted:run-1']);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toContain('run.deleted');
    expect(error.mock.calls[0]![0]).toContain('run-1');
    expect(error.mock.calls[0]![0]).toContain('listener broke');
  });

  it('does not await a listener\'s promise, and logs its rejection', async () => {
    const lifecycle = new RunLifecycle();
    const logged = new Promise<string>((resolve) => {
      vi.spyOn(console, 'error').mockImplementation((message: string) => resolve(message));
    });
    const log: string[] = [];
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    lifecycle.subscribe({ 'run.event': async ({ runId }) => { await pending; throw new Error(`late failure ${runId}`); } });
    lifecycle.subscribe(recording(log));
    lifecycle.publish('run.event', { runId: 'run-2', event: lifecycleEvent(1) });
    // The second listener ran while the first one's promise is still pending.
    expect(log).toEqual(['a:run.event:lifecycle']);
    settle();
    const message = await logged;
    expect(message).toContain('run.event');
    expect(message).toContain('run-2');
    expect(message).toContain('late failure run-2');
  });

  it('delivers a nested publish at once, before the outer delivery continues', () => {
    const lifecycle = new RunLifecycle();
    const log: string[] = [];
    lifecycle.subscribe({
      'run.deleted': ({ runId }) => {
        log.push(`outer-first:${runId}`);
        if (runId === 'outer') lifecycle.publish('run.deleted', { runId: 'nested' });
      },
    });
    lifecycle.subscribe({ 'run.deleted': ({ runId }) => { log.push(`outer-second:${runId}`); } });
    lifecycle.publish('run.deleted', { runId: 'outer' });
    expect(log).toEqual(['outer-first:outer', 'outer-first:nested', 'outer-second:nested', 'outer-second:outer']);
  });

  it('stops delivering to an unsubscribed listener, also one removed during a delivery', () => {
    const lifecycle = new RunLifecycle();
    const log: string[] = [];
    let unsubscribeSecond = () => {};
    const unsubscribeFirst = lifecycle.subscribe({ 'run.deleted': ({ runId }) => { log.push(`first:${runId}`); unsubscribeSecond(); } });
    unsubscribeSecond = lifecycle.subscribe({ 'run.deleted': ({ runId }) => { log.push(`second:${runId}`); } });
    lifecycle.publish('run.deleted', { runId: 'one' });
    unsubscribeFirst();
    unsubscribeFirst();
    lifecycle.publish('run.deleted', { runId: 'two' });
    expect(log).toEqual(['first:one']);
  });

  it('gives a subscriber no replay of earlier events', () => {
    const lifecycle = new RunLifecycle();
    lifecycle.publish('run.deleted', { runId: 'earlier' });
    const log: string[] = [];
    lifecycle.subscribe(recording(log));
    expect(log).toEqual([]);
  });
});

describe('snapshotRun', () => {
  it('is a shallow frozen copy', () => {
    const run = makeRunRecord({ status: RUN_STATUS.running });
    const before = snapshotRun(run);
    run.status = RUN_STATUS.done;
    expect(before.status).toBe(RUN_STATUS.running);
    expect(Object.isFrozen(before)).toBe(true);
    expect(before.steps).toBe(run.steps);
    expect(snapshotRun(undefined)).toBeUndefined();
  });
});
