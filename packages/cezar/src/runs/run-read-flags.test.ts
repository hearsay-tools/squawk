import { isUnread } from '@open-mercato/cezar-contract/run-predicates';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedRuns, setRunStatus } from './run-store.testkit.ts';
import { RunStore } from './store.ts';

describe('RunReadFlagsTopic.markAllRead timestamps (hearsay-tools/squawk#4087)', () => {
  let dataDir: string;
  const stores: RunStore[] = [];

  const open = () => {
    const store = RunStore.open(dataDir, { keepLive: true });
    stores.push(store);
    return store;
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-run-read-flags-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const store of stores.splice(0)) store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('marks a task finished between the initial timestamp and the query as read', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T10:00:00.000Z'));

    const writer = open();
    const run = writer.createRun({ title: 'finishes mid-sweep', workflow: 'quick-task', task: 't', steps: [] });
    setRunStatus(writer, run.id, RUN_STATUS.running);
    writer.persistence.flush();

    const reader = open();
    const db = reader.persistence.reportSource().db!;
    const originalListWhere = db.listWhere.bind(db);
    vi.spyOn(db, 'listWhere').mockImplementationOnce((where, params, options) => {
      vi.advanceTimersByTime(10);
      setRunStatus(writer, run.id, RUN_STATUS.done, { finishedAt: new Date().toISOString() });
      writer.persistence.flush();
      return originalListWhere(where, params, options);
    });

    expect(reader.readFlags.markAllRead()).toBe(1);
    const stamped = reader.getRun(run.id)!;
    expect(stamped.seenAt).toBeDefined();
    expect(stamped.seenAt! >= stamped.finishedAt!).toBe(true);
    expect(isUnread(stamped)).toBe(false);
    expect(reader.readFlags.markAllRead()).toBe(0);
  });

  it('bounds seenAt below by finishedAt when another process clock runs ahead', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T10:00:00.000Z'));

    const futureFinishedAt = '2026-01-01T10:00:05.000Z';
    seedRuns(dataDir, [{
      id: 'clock-ahead',
      title: 'ahead',
      workflow: 'quick-task',
      task: 't',
      status: RUN_STATUS.done,
      createdAt: '2026-01-01T09:59:00.000Z',
      finishedAt: futureFinishedAt,
      tokensUsed: 0,
      archived: false,
      steps: [],
    }]);

    const store = open();
    expect(store.readFlags.markAllRead()).toBe(1);
    const stamped = store.getRun('clock-ahead')!;
    expect(stamped.seenAt).toBe(futureFinishedAt);
    expect(isUnread(stamped)).toBe(false);
    expect(store.readFlags.markAllRead()).toBe(0);
  });
});
