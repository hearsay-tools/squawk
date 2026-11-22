import { reportsIndex } from '../artifacts/reports-index.ts';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs/promises';
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }));
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReportsFrame } from '@open-mercato/cezar-contract/reports';
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { CountedLifecycle } from '../activity/activity.testkit.ts';
import { artifactDirectory, publishArtifact } from '../artifacts/store.ts';
import { publishRunWrite, snapshotRun } from '../runs/lifecycle.ts';
import { RunDatabase } from '../runs/run-database.ts';
import { encodeRunRow } from '../runs/run-row.ts';
import type { RunRecord } from '../runs/store.ts';
import { reportsPublisher } from './reports-topic.ts';

/**
 * The store the index reads, over a real runs database and with no `RunStore`: each write commits
 * the run's row, then publishes it to the lifecycle as the store does.
 */
function fakeRuns(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const db = RunDatabase.open(join(dataDir, 'runs.db'));
  const lifecycle = new CountedLifecycle();
  const runs = new Map<string, RunRecord>();
  let closed = false;
  const write = (run: RunRecord, before?: Readonly<RunRecord>): RunRecord => {
    db.transaction({ upserts: [encodeRunRow(run)], deletes: [] });
    runs.set(run.id, run);
    publishRunWrite(lifecycle, run, before);
    return run;
  };
  return {
    lifecycle,
    getRun: (id: string) => runs.get(id),
    reportSource: () => ({ db, dataDir, openFailure: undefined }),
    claims: { sourceDataDir: () => dataDir },
    flush: () => undefined,
    create: () => write(makeRunRecord({ id: randomUUID(), title: 'Source', workflow: 'quick-task', task: 'Report', status: RUN_STATUS.queued, steps: [] })),
    /** One write of a run; a `status` in the patch also publishes `run.status-changed`. */
    update: (id: string, patch: Partial<Omit<RunRecord, 'id'>>) => {
      const current = runs.get(id)!;
      return write({ ...current, ...patch }, snapshotRun(current));
    },
    delete: (id: string) => {
      db.transaction({ upserts: [], deletes: [id] });
      runs.delete(id);
      lifecycle.publish('run.deleted', { runId: id });
    },
    close: () => {
      if (closed) return;
      closed = true;
      lifecycle.publish('store.closed', {});
      db.close();
    },
  };
}

let root: string, dataDir: string, store: ReturnType<typeof fakeRuns>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reports-watch-')); dataDir = join(root, '.ai/cezar'); store = fakeRuns(dataDir);
});
afterEach(() => { store.close(); vi.useRealTimers(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
const task = () => store.create();
async function publish(id: string, name = 'report.html') {
  const source = join(root, name); writeFileSync(source, '<p>Report</p>');
  return publishArtifact(artifactDirectory(dataDir, id), id, source);
}
const barrier = () => reportsIndex(store).backfill();

it('emits only relevant metadata and never scans settled clean history', async () => {
  const run = task(); await publish(run.id); store.update(run.id, { status: RUN_STATUS.done });
  await reportsIndex(store).list({});
  const frames: ReportsFrame[] = []; reportsIndex(store).onChange(frame => frames.push(frame));
  vi.useFakeTimers(); const release = reportsIndex(store).watch();
  const scans = vi.spyOn(fs, 'opendir');
  store.update(run.id, { title: 'Renamed' });
  expect(frames).toEqual([expect.objectContaining({ type: 'metadata', metadataGeneration: 1, runs: [expect.objectContaining({ taskTitle: 'Renamed' })] })]);
  store.update(run.id, { pinned: true });
  expect(frames).toHaveLength(1);
  store.update(run.id, { titleSummary: 'Search summary', branch: 'new-branch' });
  expect(frames).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(5_000); await barrier();
  expect(scans).not.toHaveBeenCalled();
  release();
});
it('scans live event bursts at most once per second and publishes changed sets and deletion', async () => {
  const run = task(); vi.useFakeTimers(); await reportsIndex(store).list({});
  const frames: ReportsFrame[] = []; reportsIndex(store).onChange(frame => frames.push(frame));
  const release = reportsIndex(store).watch();
  const artifact = await publish(run.id);
  store.update(run.id, { title: 'First' });
  await vi.advanceTimersByTimeAsync(1_000); await barrier();
  expect(frames.some(frame => frame.type === 'content')).toBe(true);
  const scans = vi.spyOn(fs, 'opendir');
  for (let n = 0; n < 10; n++) { store.update(run.id, { title: `Title ${n}` }); }
  await vi.advanceTimersByTimeAsync(999); await barrier();
  expect(scans).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await barrier();
  expect(scans).toHaveBeenCalledTimes(1);
  const generation = reportsIndex(store).state().generation;
  rmSync(join(artifactDirectory(dataDir, run.id), artifact.id), { recursive: true });
  await vi.advanceTimersByTimeAsync(10_000); await barrier();
  expect(reportsIndex(store).state().generation).toBe(generation + 1);
  await publish(run.id, 'another.html'); await reportsIndex(store).reconcile();
  const beforeDelete = reportsIndex(store).state().generation;
  store.delete(run.id);
  expect(reportsIndex(store).state().generation).toBe(beforeDelete + 1);
  release();
});
it('finds quiet publications on the watched tick and stops when the last watcher leaves', async () => {
  const run = task(); await reportsIndex(store).list({});
  vi.useFakeTimers(); const release = reportsIndex(store).watch();
  await publish(run.id); const initial = reportsIndex(store).state().generation;
  await vi.advanceTimersByTimeAsync(5_000); await barrier();
  expect(reportsIndex(store).state().generation).toBe(initial + 1);
  release(); const scans = vi.spyOn(fs, 'opendir');
  await vi.advanceTimersByTimeAsync(10_000); await barrier();
  expect(scans).not.toHaveBeenCalled();
});
it('retains unreadable cached rows and retries on the watched tick after repair', async () => {
  const run = task(); const artifact = await publish(run.id); await reportsIndex(store).list({});
  vi.useFakeTimers(); const release = reportsIndex(store).watch();
  const blocked = vi.spyOn(fs, 'opendir').mockRejectedValue(Object.assign(new Error('permission'), { code: 'EACCES' }));
  const before = reportsIndex(store).state().generation;
  await vi.advanceTimersByTimeAsync(5_000); await barrier();
  expect(reportsIndex(store).state().generation).toBe(before);
  const raw = new DatabaseSync(join(dataDir, 'runs.db'), { readOnly: true });
  try {
    expect(raw.prepare('SELECT id FROM artifacts WHERE id = ?').get(artifact.id)).toBeTruthy();
    expect(raw.prepare('SELECT value FROM meta WHERE key = ?').get(`reports-dirty:${run.id}`)).toBeTruthy();
  } finally { raw.close(); }
  blocked.mockRestore();
  rmSync(join(artifactDirectory(dataDir, run.id), artifact.id), { recursive: true });
  await vi.advanceTimersByTimeAsync(5_000); await barrier();
  expect(reportsIndex(store).state().generation).toBe(before + 1);
  release();
});
it('coalesces topic frames and releases watch demand', async () => {
  const run = task(); await publish(run.id); await reportsIndex(store).list({});
  vi.useFakeTimers();
  const publisher = reportsPublisher(reportsIndex(store)), send = vi.fn();
  const off = publisher.start(send);
  expect(await publisher.snapshot()).toMatchObject({ type: 'snapshot', ...reportsIndex(store).state() });
  store.update(run.id, { title: 'First' });
  store.update(run.id, { title: 'Second' });
  await vi.advanceTimersByTimeAsync(500);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0]).toMatchObject({ type: 'metadata', runs: [{ taskTitle: 'Second' }] });
  off();
  store.update(run.id, { title: 'Third' });
  await vi.advanceTimersByTimeAsync(5_000); await barrier();
  expect(send).toHaveBeenCalledTimes(1);
});
it('keeps terminal reconciliation when a shelf closes before its trailing scan', async () => {
  const run = task(); reportsIndex(store).start(); await reportsIndex(store).list({});
  vi.useFakeTimers(); const release = reportsIndex(store).watch();
  await publish(run.id);
  store.update(run.id, { status: RUN_STATUS.done });
  const before = reportsIndex(store).state().generation;
  release(); await barrier();
  expect(reportsIndex(store).state().generation).toBe(before + 1);
});
it('emits a content change when a selected settled page drops missing content', async () => {
  const run = task(); const artifact = await publish(run.id); store.update(run.id, { status: RUN_STATUS.done });
  await reportsIndex(store).list({});
  const before = reportsIndex(store).state().generation;
  rmSync(join(artifactDirectory(dataDir, run.id), artifact.id, 'content'));
  const page = await reportsIndex(store).list({});
  expect(page).toMatchObject({ reports: [] });
  expect(reportsIndex(store).state().generation).toBe(before + 1);
});
it('sends an update with no status change to the report watch: a live run scans, a settled one updates metadata', async () => {
  const live = task(), settled = task(); await publish(settled.id); store.update(settled.id, { status: RUN_STATUS.done });
  await reportsIndex(store).list({});
  const frames: ReportsFrame[] = []; reportsIndex(store).onChange(frame => frames.push(frame));
  vi.useFakeTimers(); const release = reportsIndex(store).watch();
  await publish(live.id); const generation = reportsIndex(store).state().generation;
  store.update(live.id, { title: 'Live renamed' });
  store.update(settled.id, { title: 'Settled renamed' });
  expect(frames).toEqual([expect.objectContaining({ type: 'metadata', runs: [expect.objectContaining({ runId: settled.id, taskTitle: 'Settled renamed' })] })]);
  await vi.advanceTimersByTimeAsync(1_000); await barrier();
  expect(reportsIndex(store).state().generation).toBe(generation + 1);
  release();
});
it('reads a settlement from run.status-changed, live to not live only, and scans the settled run at once', async () => {
  const run = task(); reportsIndex(store).start(); await reportsIndex(store).list({});
  await publish(run.id); const generation = reportsIndex(store).state().generation;
  const done = { ...run, status: RUN_STATUS.done };
  store.lifecycle.publish('run.status-changed', { run: done, exit: 'patch', from: RUN_STATUS.review, to: RUN_STATUS.done });
  await barrier();
  expect(reportsIndex(store).state().generation).toBe(generation);
  store.lifecycle.publish('run.status-changed', { run: done, exit: 'patch', from: RUN_STATUS.running, to: RUN_STATUS.done });
  await barrier();
  expect(reportsIndex(store).state().generation).toBe(generation + 1);
});
it('unsubscribes from the lifecycle when the store closes', () => {
  reportsIndex(store);
  expect(store.lifecycle.subscriptions).toBe(1);
  store.close();
  expect(store.lifecycle.subscriptions).toBe(0);
});
it('sends the run as it stands now when an older snapshot of it arrives last', async () => {
  const run = task(); await publish(run.id); store.update(run.id, { status: RUN_STATUS.done });
  await reportsIndex(store).list({});
  const frames: ReportsFrame[] = []; reportsIndex(store).onChange(frame => frames.push(frame));
  const older = snapshotRun(store.getRun(run.id)!);
  store.update(run.id, { title: 'Newer' });
  // An outer write's snapshot, delivered after the nested write that renamed the run.
  store.lifecycle.publish('run.updated', { run: older as RunRecord, before: older });
  expect(frames.map(frame => frame.type === 'metadata' && frame.runs[0]!.taskTitle)).toEqual(['Newer']);
  // A conflict's payload is the other writer's record, and it counts.
  store.lifecycle.publish('run.updated', { run: { ...older, title: 'Theirs' }, before: older, source: 'conflict' });
  expect(frames.map(frame => frame.type === 'metadata' && frame.runs[0]!.taskTitle)).toEqual(['Newer', 'Theirs']);
});
