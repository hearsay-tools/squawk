import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPersistedRuns, seedRuns } from './run-store.testkit.ts';
import { RunStore, type RunRecord } from './store.ts';

function finishedRecord(id: string, createdAt: string): RunRecord {
  return {
    id,
    title: `run ${id}`,
    workflow: 'quick-task',
    task: `task ${id}`,
    status: RUN_STATUS.done,
    createdAt,
    finishedAt: createdAt,
    tokensUsed: 0,
    archived: false,
    steps: [],
  };
}

describe('RunArchiveTopic.archiveFinished concurrency (hearsay-tools/squawk#4086)', () => {
  let dataDir: string;
  const stores: RunStore[] = [];

  const open = () => {
    const store = RunStore.open(dataDir, { keepLive: true });
    stores.push(store);
    return store;
  };
  const persisted = (id: string) => readPersistedRuns(dataDir).find((run: RunRecord) => run.id === id) as RunRecord | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-03-01T00:00:00.000Z') });
    dataDir = mkdtempSync(join(tmpdir(), 'cez-run-archive-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const store of stores.splice(0)) store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("archiveFinished('unpinned') skips a task pinned by another store between selection and claim", () => {
    seedRuns(dataDir, [
      finishedRecord('pinned-later', '2026-01-01T00:00:00.000Z'),
      finishedRecord('stays-unpinned', '2026-01-02T00:00:00.000Z'),
    ]);
    const store = open();
    const other = open();
    const originalClaim = store.claims.claimFamilies.bind(store.claims);
    vi.spyOn(store.claims, 'claimFamilies').mockImplementationOnce((families, opts) => {
      other.readFlags.setPinned('pinned-later', true);
      other.persistence.flush();
      return originalClaim(families, opts);
    });

    const result = store.archive.archiveFinished('unpinned');
    store.persistence.flush();

    expect(result).toEqual({ archived: 1, ids: ['stays-unpinned'], pinnedIds: [] });
    expect(persisted('pinned-later')).toMatchObject({ archived: false, pinned: true });
    expect(persisted('stays-unpinned')).toMatchObject({ archived: true });
  });

  it('archiveFinished() reports a task pinned between selection and claim in pinnedIds', () => {
    seedRuns(dataDir, [
      finishedRecord('pinned-later', '2026-01-01T00:00:00.000Z'),
      finishedRecord('stays-unpinned', '2026-01-02T00:00:00.000Z'),
    ]);
    const store = open();
    const other = open();
    const originalClaim = store.claims.claimFamilies.bind(store.claims);
    vi.spyOn(store.claims, 'claimFamilies').mockImplementationOnce((families, opts) => {
      other.readFlags.setPinned('pinned-later', true);
      other.persistence.flush();
      return originalClaim(families, opts);
    });

    const result = store.archive.archiveFinished();
    store.persistence.flush();

    expect(result).toEqual({
      archived: 2,
      ids: ['stays-unpinned', 'pinned-later'],
      pinnedIds: ['pinned-later'],
    });
    expect(persisted('pinned-later')?.archived).toBe(true);
    expect(persisted('pinned-later')?.pinned).toBeUndefined();
  });
});
