import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';

import { RUNS_DB_FILE, RunDatabase } from './run-database.ts';
import { encodeRunRow } from './run-row.ts';
import { crashStore, readPersistedRuns, seedRuns, setRunStatus } from './run-store.testkit.ts';
import type { RunLifecycleEvents, RunLifecycleEventType } from './lifecycle.ts';
import { RunStore, type RunRecord } from './store.ts';

/**
 * The lifecycle a `RunStore` publishes beside its emitter (.ai/specs/2026-11-21-run-lifecycle-and-
 * store-ports.md § Lifecycle delivery cases): one test per row of the table, and the `before` of
 * each write path.
 */

type Delivery = { [K in RunLifecycleEventType]: { type: K; payload: RunLifecycleEvents[K] } }[RunLifecycleEventType];

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cez-store-lifecycle-'));
  const stores: RunStore[] = [];
  const open = () => { const store = RunStore.open(dir, { keepLive: true }); stores.push(store); return store; };
  const store = open();
  cleanups.push(() => { for (const each of stores) each.close(); rmSync(dir, { recursive: true, force: true }); });
  const created = (steps: Parameters<RunStore['createRun']>[0]['steps'] = []) => store.createRun({ title: 'lifecycle', task: 'lifecycle', workflow: 'quick-task', steps }).id;
  const persisted = (id: string) => readPersistedRuns(dir).find((row) => row.id === id) as RunRecord | undefined;
  return { dir, store, open, created, persisted };
}

/** Every lifecycle event `store` publishes from now on, and `seen(type)` called inside each delivery. */
function record(store: RunStore, seen: (delivery: Delivery) => void = () => {}): Delivery[] {
  const deliveries: Delivery[] = [];
  const handler = <K extends RunLifecycleEventType>(type: K) => (payload: RunLifecycleEvents[K]) => {
    const delivery = { type, payload } as Delivery;
    deliveries.push(delivery);
    seen(delivery);
  };
  store.lifecycle.subscribe({
    'run.created': handler('run.created'), 'run.updated': handler('run.updated'), 'run.status-changed': handler('run.status-changed'),
    'run.deleted': handler('run.deleted'), 'run.event': handler('run.event'), 'store.closed': handler('store.closed'),
  });
  return deliveries;
}
const types = (deliveries: readonly Delivery[]) => deliveries.map((delivery) => delivery.type);
function only<K extends RunLifecycleEventType>(deliveries: readonly Delivery[], type: K): RunLifecycleEvents[K] {
  const matching = deliveries.filter((delivery) => delivery.type === type);
  expect(matching).toHaveLength(1);
  return matching[0]!.payload as RunLifecycleEvents[K];
}
const ROOT = { role: 'root' as const, permissions: [], receipts: [] };

describe('lifecycle delivery cases', () => {
  it('createRun publishes run.created when touch runs, beside the emitter', () => {
    const { store } = setup();
    const order: string[] = [];
    store.on('run', () => order.push('emitter:run'));
    const deliveries = record(store, (delivery) => order.push(delivery.type));
    const id = store.createRun({ title: 'new', task: 'new', workflow: 'quick-task', steps: [] }).id;
    expect(types(deliveries)).toEqual(['run.created']);
    expect(only(deliveries, 'run.created').run).toBe(store.getRun(id));
    expect(order).toEqual(['run.created', 'emitter:run']);
  });

  it('a committed move that changes status: run.updated, run.status-changed, then run.event for the lifecycle event, after the commit', () => {
    const { store, created, persisted } = setup();
    const id = created();
    setRunStatus(store, id, RUN_STATUS.waiting, { delegation: ROOT });
    store.commitRootFinishIntent(id);
    const statusAtDelivery: Array<string | undefined> = [];
    const deliveries = record(store, (delivery) => { if (delivery.type !== 'run.event') statusAtDelivery.push(persisted(id)?.status); });
    expect(store.move(id, 'cancel-root')).toBeDefined();
    expect(types(deliveries)).toEqual(['run.updated', 'run.status-changed', 'run.event']);
    expect(only(deliveries, 'run.status-changed')).toMatchObject({ exit: 'cancel-root', from: RUN_STATUS.waiting, to: RUN_STATUS.cancelled });
    expect(only(deliveries, 'run.event')).toMatchObject({ runId: id, event: { type: 'lifecycle' } });
    expect(statusAtDelivery).toEqual([RUN_STATUS.cancelled, RUN_STATUS.cancelled]);
  });

  it('a debounced move publishes run.updated and run.status-changed when touch runs, before the SQLite write', () => {
    const { store, created, persisted } = setup();
    const id = created();
    store.flush();
    const statusAtDelivery: Array<string | undefined> = [];
    const deliveries = record(store, () => statusAtDelivery.push(persisted(id)?.status));
    store.move(id, 'start');
    expect(types(deliveries)).toEqual(['run.updated', 'run.status-changed']);
    expect(only(deliveries, 'run.status-changed')).toMatchObject({ exit: 'start', from: RUN_STATUS.queued, to: RUN_STATUS.running });
    expect(statusAtDelivery).toEqual([RUN_STATUS.queued, RUN_STATUS.queued]);
  });

  it('a debounced updateRun that keeps the status publishes run.updated only', () => {
    const { store, created } = setup();
    const id = created();
    const deliveries = record(store);
    store.updateRun(id, { title: 'renamed' });
    expect(types(deliveries)).toEqual(['run.updated']);
  });

  it.each([
    ['debounced', {}],
    ['committed', { autoMergePr: true }],
  ] as const)('updateRun with a status in the patch publishes run.status-changed with exit patch (%s)', (_path, extras) => {
    const { store, created } = setup();
    const id = created();
    const deliveries = record(store);
    setRunStatus(store, id, RUN_STATUS.done, extras);
    expect(types(deliveries)).toEqual(['run.updated', 'run.status-changed']);
    expect(only(deliveries, 'run.status-changed')).toMatchObject({ exit: 'patch', from: RUN_STATUS.queued, to: RUN_STATUS.done });
  });

  it('appendEvent that finds a PR reference publishes run.event, then run.updated', () => {
    const { store, created } = setup();
    const id = created();
    store.setRepoHandle({ owner: 'o', name: 'r' });
    const deliveries = record(store);
    store.appendEvent(id, { type: 'result', result: 'Created a PR: https://github.com/o/r/pull/812' });
    expect(types(deliveries)).toEqual(['run.event', 'run.updated']);
    const { run, before } = only(deliveries, 'run.updated');
    expect(before.pullRequests).toBeUndefined();
    expect(run.pullRequests?.map((pr) => pr.number)).toEqual([812]);
  });

  it('a conflict publishes run.updated with source conflict, and run.status-changed with exit conflict', () => {
    const { dir, store, created, persisted } = setup();
    const id = created();
    store.flush();
    const raw = RunDatabase.open(join(dir, RUNS_DB_FILE));
    try { raw.transaction({ upserts: [encodeRunRow({ ...persisted(id)!, title: 'elsewhere', status: RUN_STATUS.failed })], deletes: [] }); } finally { raw.close(); }
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    store.updateRun(id, { title: 'local' });
    const deliveries = record(store);
    store.flush();
    expect(types(deliveries)).toEqual(['run.updated', 'run.status-changed']);
    const updated = only(deliveries, 'run.updated');
    expect(updated).toMatchObject({ source: 'conflict', run: { title: 'elsewhere', status: RUN_STATUS.failed } });
    expect(updated.before).toMatchObject({ title: 'local', status: RUN_STATUS.queued });
    expect(only(deliveries, 'run.status-changed')).toMatchObject({ exit: 'conflict', from: RUN_STATUS.queued, to: RUN_STATUS.failed });
  });

  it('a conflict on a deleted row publishes run.deleted', () => {
    const { dir, store, created } = setup();
    const id = created();
    store.flush();
    const raw = RunDatabase.open(join(dir, RUNS_DB_FILE));
    try { raw.transaction({ upserts: [], deletes: [id] }); } finally { raw.close(); }
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    store.updateRun(id, { title: 'local' });
    const deliveries = record(store);
    store.flush();
    expect(deliveries).toEqual([{ type: 'run.deleted', payload: { runId: id } }]);
  });

  it('the delete of a plain run publishes run.deleted before the debounced write', () => {
    const { store, created, persisted } = setup();
    const id = created();
    store.flush();
    const rowAtDelivery: boolean[] = [];
    const deliveries = record(store, () => rowAtDelivery.push(persisted(id) !== undefined));
    expect(store.deleteRun(id)).toBe(true);
    expect(deliveries).toEqual([{ type: 'run.deleted', payload: { runId: id } }]);
    expect(rowAtDelivery).toEqual([true]);
  });

  it('the delete of a delegated run publishes run.deleted after the commit', () => {
    const { store, created, persisted } = setup();
    const id = created();
    setRunStatus(store, id, RUN_STATUS.done, { delegation: ROOT });
    store.flush();
    const rowAtDeletion: boolean[] = [];
    const deliveries = record(store, (delivery) => { if (delivery.type === 'run.deleted') rowAtDeletion.push(persisted(id) !== undefined); });
    expect(store.deleteRun(id)).toBe(true);
    expect(types(deliveries)).toEqual(['run.updated', 'run.deleted']);
    expect(rowAtDeletion).toEqual([false]);
  });

  it('a load or an adoption that applies an exit publishes nothing', () => {
    const { dir, store, open } = setup();
    // A settled row with an accepted Stop: reading it applies `cancel-late`.
    seedRuns(dir, [{ id: 'stopped', title: 't', workflow: 'w', task: 't', status: RUN_STATUS.done, stopping: true,
      createdAt: '2026-11-21T00:00:00.000Z', tokensUsed: 0, archived: false, steps: [] }]);
    const deliveries = record(store);
    expect(store.getRun('stopped')?.status).toBe(RUN_STATUS.cancelled);
    // A live row its dead owner left: adopting it settles it as interrupted.
    const gone = open();
    const orphan = gone.createRun({ title: 'left running', workflow: 'w', task: 't', steps: [] });
    setRunStatus(gone, orphan.id, RUN_STATUS.running);
    gone.flush();
    crashStore(gone);
    expect(store.adoptFamily(orphan.id)).toBe(orphan.id);
    expect(store.getRun(orphan.id)?.status).toBe(RUN_STATUS.failed);
    expect(deliveries).toEqual([]);
  });

  it('a listener that throws: the other listeners still get the event, and the write goes on', () => {
    const { store } = setup();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    store.lifecycle.subscribe({ 'run.created': () => { throw new Error('broken listener'); } });
    const deliveries = record(store);
    const id = store.createRun({ title: 'new', task: 'new', workflow: 'quick-task', steps: [] }).id;
    expect(types(deliveries)).toEqual(['run.created']);
    expect(store.getRun(id)).toBeDefined();
    expect(error.mock.calls.flat().join('\n')).toMatch(new RegExp(`run\\.created.*${id}.*broken listener`));
  });

  it('close() publishes store.closed before the database closes', () => {
    const { store } = setup();
    const openAtDelivery: boolean[] = [];
    const deliveries = record(store, () => openAtDelivery.push(store.reportSource().db !== null));
    store.close();
    expect(deliveries).toEqual([{ type: 'store.closed', payload: {} }]);
    expect(openAtDelivery).toEqual([true]);
  });

  it('emitEphemeral publishes run.event', () => {
    const { store, created } = setup();
    const id = created();
    const deliveries = record(store);
    store.emitEphemeral(id, { type: 'item.delta', text: 'x' });
    expect(deliveries).toEqual([{ type: 'run.event', payload: { runId: id, event: expect.objectContaining({ type: 'item.delta' }) } }]);
  });
});

describe('before holds the record as it was at the entry of each write path', () => {
  it('a committed write (commitIndex)', () => {
    const { store, created } = setup();
    const id = created();
    const deliveries = record(store);
    store.updateRun(id, { title: 'committed', autoMergePr: true });
    const { run, before } = only(deliveries, 'run.updated');
    expect(before).toMatchObject({ title: 'lifecycle' });
    expect(before.autoMergePr).toBeUndefined();
    expect(run).toMatchObject({ title: 'committed', autoMergePr: true });
    expect(Object.isFrozen(before)).toBe(true);
  });

  it('a committed update whose rules change the held record before the commit', () => {
    const { store, created } = setup();
    const id = created();
    store.setRepoHandle({ owner: 'o', name: 'r' });
    const deliveries = record(store);
    store.updateRun(id, { pullRequestUrl: 'https://github.com/o/r/pull/7', autoMergePr: true });
    const { run, before } = only(deliveries, 'run.updated');
    expect(before.pullRequests).toBeUndefined();
    expect(run.pullRequests?.map((pr) => pr.number)).toEqual([7]);
  });

  it('a commitOutcome that applies an exit names it', () => {
    const { store, created } = setup();
    const id = created();
    setRunStatus(store, id, RUN_STATUS.waiting);
    const deliveries = record(store);
    store.commitOutcome(id, [], { exit: 'resume' });
    expect(only(deliveries, 'run.updated').before.status).toBe(RUN_STATUS.waiting);
    expect(only(deliveries, 'run.status-changed')).toMatchObject({ exit: 'resume', from: RUN_STATUS.waiting, to: RUN_STATUS.running });
  });

  it('an archive that withdraws a usage-limit hold names withdraw-hold', () => {
    const { store, created } = setup();
    const id = created();
    setRunStatus(store, id, RUN_STATUS.waiting, { autoResumeAt: '2026-11-21T12:00:00.000Z' });
    const deliveries = record(store);
    store.setArchived(id, true);
    expect(only(deliveries, 'run.updated').before).toMatchObject({ status: RUN_STATUS.waiting, autoResumeAt: '2026-11-21T12:00:00.000Z' });
    expect(only(deliveries, 'run.status-changed')).toMatchObject({ exit: 'withdraw-hold', from: RUN_STATUS.waiting, to: RUN_STATUS.failed });
  });

  it('a debounced write through touch', () => {
    const { store, created } = setup();
    const id = created();
    const deliveries = record(store);
    store.setRead(id);
    const { run, before } = only(deliveries, 'run.updated');
    expect(before.seenAt).toBeUndefined();
    expect(run.seenAt).toEqual(expect.any(String));
  });

  it('a debounced move and a debounced updateRun', () => {
    const { store, created } = setup();
    const id = created();
    const deliveries = record(store);
    store.move(id, 'start', { runner: 'claude' });
    store.updateRun(id, { title: 'renamed' });
    const [moved, updated] = deliveries.filter((delivery) => delivery.type === 'run.updated').map((delivery) => delivery.payload as RunLifecycleEvents['run.updated']);
    expect(moved!.before).toMatchObject({ status: RUN_STATUS.queued, title: 'lifecycle' });
    expect(moved!.before.runner).toBeUndefined();
    expect(updated!.before).toMatchObject({ status: RUN_STATUS.running, title: 'lifecycle', runner: 'claude' });
  });

  it('a step update and an added step keep the steps as they were', () => {
    const { store, created } = setup();
    const id = created([{ id: 'a', name: 'a', kind: STEP_KIND.agent }]);
    const deliveries = record(store);
    store.updateStep(id, 'a', { status: STEP_STATUS.running, tokensUsed: 5 });
    store.addStep(id, { id: 'b', name: 'b', kind: STEP_KIND.agent });
    const [stepped, added] = deliveries.map((delivery) => delivery.payload as RunLifecycleEvents['run.updated']);
    expect(stepped!.before.steps.map((step) => step.status)).toEqual([STEP_STATUS.pending]);
    expect(stepped!.before.tokensUsed).toBe(0);
    // `run` is the held record, which the added step has changed since.
    expect(stepped!.run).toMatchObject({ tokensUsed: 5, steps: [{ id: 'a', status: STEP_STATUS.running }, { id: 'b' }] });
    expect(added!.before.steps.map((step) => step.id)).toEqual(['a']);
    expect(added!.run.steps.map((step) => step.id)).toEqual(['a', 'b']);
  });

  it('republish', () => {
    const { store, created } = setup();
    const id = created();
    const deliveries = record(store);
    store.republish(id);
    expect(deliveries).toEqual([{ type: 'run.updated', payload: { run: store.getRun(id), before: { ...store.getRun(id) }, source: 'live-release' } }]);
  });
});
