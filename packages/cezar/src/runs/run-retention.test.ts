import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sealTestRunSlots } from './removal-slots.testkit.ts';
import { readPersistedRuns, seedRuns } from './run-store.testkit.ts';
import { RunStore, type RunRecord } from './store.ts';

sealTestRunSlots();

function settledFamily(rootId: string, workerId: string): RunRecord[] {
  return [
    {
      id: rootId,
      title: 'settled root',
      workflow: 'quick-task',
      task: 'root task',
      status: RUN_STATUS.done,
      createdAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:05:00.000Z',
      tokensUsed: 0,
      archived: false,
      steps: [],
      delegation: { role: 'root', permissions: ['spawn'], receipts: [] },
    },
    {
      id: workerId,
      title: 'settled worker',
      workflow: 'quick-task',
      task: 'worker task',
      status: RUN_STATUS.done,
      createdAt: '2026-01-02T00:00:00.000Z',
      finishedAt: '2026-01-02T00:05:00.000Z',
      tokensUsed: 0,
      archived: false,
      steps: [],
      delegation: {
        role: 'worker',
        parentRunId: rootId,
        permissions: [],
        workspace: {
          ownerRunId: workerId,
          resourceId: randomUUID(),
          kind: 'owned-isolated',
          path: '/tmp/worker',
          branch: 'worker',
          baselineSha: 'a'.repeat(40),
        },
      },
    },
  ];
}

function fillerRuns(count: number): RunRecord[] {
  return Array.from({ length: count }, () => ({
    id: randomUUID(),
    title: 'recent',
    workflow: 'quick-task',
    task: 'recent task',
    status: RUN_STATUS.done,
    createdAt: '2026-02-01T00:00:00.000Z',
    finishedAt: '2026-02-01T00:05:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
  }));
}

describe('RunRetentionTopic.archiveSettledFamily publish re-entrancy (hearsay-tools/squawk#4078)', () => {
  let dataDir: string;
  const stores: RunStore[] = [];

  const open = () => {
    const store = RunStore.open(dataDir);
    stores.push(store);
    return store;
  };
  const persisted = (id: string) => readPersistedRuns(dataDir).find((run: RunRecord) => run.id === id) as RunRecord | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-03-01T00:00:00.000Z') });
    dataDir = mkdtempSync(join(tmpdir(), 'cez-run-retention-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const store of stores.splice(0)) store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('archives workers even when a lifecycle subscriber flushes during the root archive publish', () => {
    const rootId = randomUUID();
    const workerId = randomUUID();
    seedRuns(dataDir, [...settledFamily(rootId, workerId), ...fillerRuns(300)]);
    const store = open();
    store.lifecycle.subscribe({
      'run.updated': ({ run }) => {
        if (run.id === rootId && run.archived) store.persistence.flush();
      },
    });

    store.createRun({ title: 'trigger retention', workflow: 'quick-task', task: 'task', steps: [] });
    store.persistence.flush();

    expect(store.getRun(rootId)?.archived).toBe(true);
    expect(store.getRun(workerId)?.archived).toBe(true);
    expect(persisted(rootId)?.archived).toBe(true);
    expect(persisted(workerId)?.archived).toBe(true);
  });

  it('archives each worker from its current record after a flush during root publish', () => {
    const rootId = randomUUID();
    const workerId = randomUUID();
    seedRuns(dataDir, [...settledFamily(rootId, workerId), ...fillerRuns(300)]);
    const store = open();
    const other = open();
    store.lifecycle.subscribe({
      'run.updated': ({ run }) => {
        if (run.id === rootId && run.archived) {
          store.persistence.flush();
          other.updateRun(workerId, { title: 'updated after root publish' });
          other.persistence.flush();
        }
      },
    });

    store.createRun({ title: 'trigger retention', workflow: 'quick-task', task: 'task', steps: [] });
    store.persistence.flush();

    expect(persisted(rootId)?.archived).toBe(true);
    expect(persisted(workerId)).toMatchObject({ archived: true, title: 'updated after root publish' });
  });

  it('skips archiving a worker pinned by another store after a flush during root publish', () => {
    const rootId = randomUUID();
    const workerId = randomUUID();
    seedRuns(dataDir, [...settledFamily(rootId, workerId), ...fillerRuns(300)]);
    const store = open();
    const other = open();
    store.lifecycle.subscribe({
      'run.updated': ({ run }) => {
        if (run.id === rootId && run.archived) {
          store.persistence.flush();
          other.readFlags.setPinned(workerId, true);
          other.persistence.flush();
        }
      },
    });

    store.createRun({ title: 'trigger retention', workflow: 'quick-task', task: 'task', steps: [] });
    store.persistence.flush();

    expect(persisted(rootId)?.archived).toBe(true);
    expect(persisted(workerId)).toMatchObject({ archived: false, pinned: true });
  });
});
