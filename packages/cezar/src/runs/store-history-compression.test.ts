import { spawnCapacityRefusal } from '../delegation/capacity.ts';
import { setRunStatus } from './run-store.testkit.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';

import { historyPaths, readHistoryText } from './history-file.ts';
import { RUNS_DB_FILE, RunDatabase } from './run-database.ts';
import { RunStore } from './store.ts';
import { sealTestRunSlots } from './removal-slots.testkit.ts';

// Runs are deleted or reclaimed here; no feature's slot is part of what these cases check.
sealTestRunSlots();

/** Hang guard for the waits below: each ends the moment its condition holds, so the bound only ends a hang. */
const HANG_GUARD_MS = 15_000;

const dirs: string[] = [];
const stores: RunStore[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (stores.length > 0) {
    const store = stores.pop()!;
    store.close();
    await store.archive.historyIdle();
  }
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function openStore(existing?: string): { dir: string; store: RunStore } {
  const dir = existing ?? mkdtempSync(join(tmpdir(), 'cez-store-history-'));
  if (!existing) dirs.push(dir);
  const store = RunStore.open(dir);
  stores.push(store);
  return { dir, store };
}

function finish(store: RunStore, id: string): void {
  setRunStatus(store, id, RUN_STATUS.done, { finishedAt: new Date().toISOString() });
}

function br(data: string | Buffer): Buffer {
  return brotliCompressSync(Buffer.from(data), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
  });
}

function listClaims(dir: string) {
  const db = RunDatabase.open(join(dir, RUNS_DB_FILE));
  try {
    return db.listClaims();
  } finally {
    db.close();
  }
}

describe('RunStore history compression', () => {
  it('archiving a finished run compresses its transcript', async () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.eventLog.appendEvent(run.id, { type: 'note', message: 'one' });
    store.eventLog.appendEvent(run.id, { type: 'note', message: 'two' });
    const before = store.eventLog.readEvents(run.id);
    finish(store, run.id);
    store.archive.setArchived(run.id, true);
    await store.archive.historyIdle();
    const { plain, compressed } = historyPaths(dir, run.id);
    expect(existsSync(compressed)).toBe(true);
    expect(existsSync(plain)).toBe(false);
    expect(store.eventLog.readEvents(run.id).map((event) => ({ seq: event.seq, type: event.type, message: event.message }))).toEqual(
      before.map((event) => ({ seq: event.seq, type: event.type, message: event.message })),
    );
  });

  it('unarchiving restores the plain transcript synchronously', async () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.eventLog.appendEvent(run.id, { type: 'note', message: 'keep' });
    finish(store, run.id);
    store.archive.setArchived(run.id, true);
    await store.archive.historyIdle();
    store.archive.setArchived(run.id, false);
    const { plain, compressed } = historyPaths(dir, run.id);
    expect(existsSync(plain)).toBe(true);
    expect(existsSync(compressed)).toBe(false);
    expect(readHistoryText(dir, run.id)).toContain('"message":"keep"');
  });

  it('deleting an archived run removes the compressed transcript', async () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.eventLog.appendEvent(run.id, { type: 'note', message: 'gone' });
    finish(store, run.id);
    store.archive.setArchived(run.id, true);
    await store.archive.historyIdle();
    const { plain, compressed } = historyPaths(dir, run.id);
    expect(existsSync(compressed)).toBe(true);
    expect(store.retention.deleteRun(run.id)).toBe(true);
    store.persistence.flush();
    expect(existsSync(compressed)).toBe(false);
    expect(existsSync(plain)).toBe(false);
  });

  it('the startup sweep compresses archived runs left plain and resolves both-present leftovers', async () => {
    const { dir, store } = openStore();
    const leftPlain = store.createRun({ title: 'plain', workflow: 'w', task: 'task', steps: [] });
    store.eventLog.appendEvent(leftPlain.id, { type: 'note', message: 'plain-body' });
    finish(store, leftPlain.id);
    store.archive.setArchived(leftPlain.id, true);
    const both = store.createRun({ title: 'both', workflow: 'w', task: 'task', steps: [] });
    store.eventLog.appendEvent(both.id, { type: 'note', message: 'A' });
    finish(store, both.id);
    store.archive.setArchived(both.id, true);
    store.persistence.flush();
    await store.archive.historyIdle();
    store.close();
    stores.pop();

    const plainLeft = historyPaths(dir, leftPlain.id);
    const original = '{"seq":1,"type":"note","message":"plain-body"}\n';
    writeFileSync(plainLeft.plain, original);
    if (existsSync(plainLeft.compressed)) rmSync(plainLeft.compressed);

    const bothPaths = historyPaths(dir, both.id);
    mkdirSync(join(dir, 'runs'), { recursive: true });
    writeFileSync(bothPaths.plain, 'A');
    writeFileSync(
      bothPaths.compressed,
      brotliCompressSync(Buffer.from('B'), { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }),
    );

    const reopened = RunStore.open(dir);
    stores.push(reopened);
    reopened.archive.compressArchivedHistory();
    await reopened.archive.historyIdle();
    expect(existsSync(plainLeft.plain)).toBe(false);
    expect(existsSync(plainLeft.compressed)).toBe(true);
    expect(readHistoryText(dir, leftPlain.id)).toBe(original);
    expect(existsSync(bothPaths.plain)).toBe(false);
    expect(existsSync(bothPaths.compressed)).toBe(true);
    expect(readHistoryText(dir, both.id)).toBe('A');
    expect(existsSync(`${bothPaths.compressed}.orphaned`)).toBe(true);
    expect(brotliDecompressSync(readFileSync(`${bothPaths.compressed}.orphaned`)).toString()).toBe('B');
  });

  it('close stops the compressor', async () => {
    const started: string[] = [];
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const historyFile = await import('./history-file.ts');
    const spy = vi.spyOn(historyFile, 'compressHistory').mockImplementation(async (_dataDir, id) => {
      started.push(id);
      if (started.length === 1) await first;
      return 'skipped';
    });
    const { store } = openStore();
    const runs = Array.from({ length: 3 }, () => {
      const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
      store.eventLog.appendEvent(run.id, { type: 'note', message: 'x' });
      finish(store, run.id);
      store.archive.setArchived(run.id, true);
      return run.id;
    });
    await vi.waitFor(() => expect(started.length).toBeGreaterThanOrEqual(1), { timeout: HANG_GUARD_MS });
    store.close();
    release();
    await store.archive.historyIdle();
    expect(started.length).toBeLessThan(runs.length);
    spy.mockRestore();
  });

  it('does not compress or clean a transcript another live store holds', async () => {
    const { dir, store: owner } = openStore();
    const run = owner.createRun({ title: 'theirs', workflow: 'w', task: 'task', steps: [] });
    owner.eventLog.appendEvent(run.id, { type: 'note', message: 'owned' });
    finish(owner, run.id);
    expect(owner.runPins.pin(run.id, 'active')).toBeDefined();
    const historyFile = await import('./history-file.ts');
    const spy = vi.spyOn(historyFile, 'compressHistory').mockResolvedValue('skipped');
    owner.archive.setArchived(run.id, true);
    owner.persistence.flush();
    await owner.archive.historyIdle();
    spy.mockRestore();

    const { plain, compressed } = historyPaths(dir, run.id);
    expect(existsSync(plain)).toBe(true);
    writeFileSync(
      compressed,
      brotliCompressSync(Buffer.from('foreign-br'), { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }),
    );

    const other = openStore(dir).store;
    expect(other.claims.runOwnership(run.id)).toBe('foreign');
    other.archive.compressArchivedHistory();
    await other.archive.historyIdle();

    expect(existsSync(plain)).toBe(true);
    expect(readFileSync(plain, 'utf8')).toContain('owned');
    expect(existsSync(compressed)).toBe(true);
    expect(existsSync(`${compressed}.orphaned`)).toBe(false);
  });

  it('re-compresses after archive then append (variant-pick race)', async () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.eventLog.appendEvent(run.id, { type: 'note', message: 'before' });
    finish(store, run.id);
    store.archive.setArchived(run.id, true);
    store.eventLog.appendEvent(run.id, { type: 'lifecycle', message: 'variant picked' });
    await store.archive.historyIdle();
    const { plain, compressed } = historyPaths(dir, run.id);
    expect(existsSync(compressed)).toBe(true);
    expect(existsSync(plain)).toBe(false);
    const text = readHistoryText(dir, run.id);
    expect(text).toContain('before');
    expect(text).toContain('variant picked');
  });

  it('compresses when a run archived while live later finishes', async () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.eventLog.appendEvent(run.id, { type: 'note', message: 'live' });
    setRunStatus(store, run.id, RUN_STATUS.running);
    store.archive.setArchived(run.id, true);
    await store.archive.historyIdle();
    const { plain, compressed } = historyPaths(dir, run.id);
    expect(existsSync(plain)).toBe(true);
    expect(existsSync(compressed)).toBe(false);
    finish(store, run.id);
    await store.archive.historyIdle();
    expect(existsSync(compressed)).toBe(true);
    expect(existsSync(plain)).toBe(false);
  });

  it('re-compresses after appendEvent restores an archived transcript', async () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.eventLog.appendEvent(run.id, { type: 'note', message: 'old' });
    finish(store, run.id);
    store.archive.setArchived(run.id, true);
    await store.archive.historyIdle();
    const { plain, compressed } = historyPaths(dir, run.id);
    expect(existsSync(compressed)).toBe(true);
    store.eventLog.appendEvent(run.id, { type: 'note', message: 'after-restore' });
    expect(existsSync(plain)).toBe(true);
    await store.archive.historyIdle();
    expect(existsSync(compressed)).toBe(true);
    expect(existsSync(plain)).toBe(false);
    expect(readHistoryText(dir, run.id)).toContain('after-restore');
  });

  it('compressArchivedHistory swallows an fs error on one id and continues', async () => {
    const { dir, store } = openStore();
    const ok = store.createRun({ title: 'ok', workflow: 'w', task: 'task', steps: [] });
    store.eventLog.appendEvent(ok.id, { type: 'note', message: 'ok-body' });
    finish(store, ok.id);
    const boom = store.createRun({ title: 'boom', workflow: 'w', task: 'task', steps: [] });
    store.eventLog.appendEvent(boom.id, { type: 'note', message: 'boom-body' });
    finish(store, boom.id);
    store.archive.setArchived(ok.id, true);
    store.archive.setArchived(boom.id, true);
    store.persistence.flush();
    await store.archive.historyIdle();
    store.close();
    stores.pop();

    const okPaths = historyPaths(dir, ok.id);
    writeFileSync(okPaths.plain, readHistoryText(dir, ok.id) ?? 'ok');
    if (existsSync(okPaths.compressed)) rmSync(okPaths.compressed);
    const boomPaths = historyPaths(dir, boom.id);
    writeFileSync(boomPaths.plain, 'A');
    writeFileSync(
      boomPaths.compressed,
      brotliCompressSync(Buffer.from('B'), { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }),
    );

    const historyFile = await import('./history-file.ts');
    const original = historyFile.restoreHistory;
    const spy = vi.spyOn(historyFile, 'restoreHistory').mockImplementation((dataDir, id) => {
      if (id === boom.id) throw new Error('fs boom');
      return original(dataDir, id);
    });
    const reopened = openStore(dir).store;
    expect(() => reopened.archive.compressArchivedHistory()).not.toThrow();
    await reopened.archive.historyIdle();
    expect(existsSync(okPaths.compressed)).toBe(true);
    expect(existsSync(okPaths.plain)).toBe(false);
    spy.mockRestore();
  });

  it('leaves the record unchanged when restoreHistory throws on unarchive', async () => {
    const { store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.eventLog.appendEvent(run.id, { type: 'note', message: 'keep' });
    finish(store, run.id);
    store.archive.setArchived(run.id, true);
    await store.archive.historyIdle();
    const before = store.getRun(run.id)!;
    const historyFile = await import('./history-file.ts');
    const spy = vi.spyOn(historyFile, 'restoreHistory').mockImplementation(() => {
      throw new Error('restore failed');
    });
    try {
      expect(() => setRunStatus(store, run.id, RUN_STATUS.queued, { archived: false })).toThrow(/restore failed/);
      const after = store.getRun(run.id)!;
      expect(after.status).toBe(before.status);
      expect(after.archived).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('drops a prefix .br on the startup sweep and orphans a non-prefix leftover', async () => {
    const { dir, store } = openStore();
    const prefixRun = store.createRun({ title: 'prefix', workflow: 'w', task: 'task', steps: [] });
    store.eventLog.appendEvent(prefixRun.id, { type: 'note', message: 'same' });
    finish(store, prefixRun.id);
    const other = store.createRun({ title: 'other', workflow: 'w', task: 'task', steps: [] });
    store.eventLog.appendEvent(other.id, { type: 'note', message: 'A' });
    finish(store, other.id);
    store.archive.setArchived(prefixRun.id, true);
    store.archive.setArchived(other.id, true);
    store.persistence.flush();
    await store.archive.historyIdle();
    store.close();
    stores.pop();

    const prefixPaths = historyPaths(dir, prefixRun.id);
    const body = readHistoryText(dir, prefixRun.id)!;
    writeFileSync(prefixPaths.plain, body);
    writeFileSync(
      prefixPaths.compressed,
      brotliCompressSync(Buffer.from(body), { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }),
    );
    const otherPaths = historyPaths(dir, other.id);
    writeFileSync(otherPaths.plain, 'A');
    writeFileSync(
      otherPaths.compressed,
      brotliCompressSync(Buffer.from('B'), { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }),
    );

    const historyFile = await import('./history-file.ts');
    const restore = vi.spyOn(historyFile, 'restoreHistory');
    const reopened = openStore(dir).store;
    reopened.archive.compressArchivedHistory();
    await reopened.archive.historyIdle();
    expect(restore).not.toHaveBeenCalled();
    expect(existsSync(prefixPaths.plain)).toBe(false);
    expect(existsSync(prefixPaths.compressed)).toBe(true);
    expect(existsSync(`${prefixPaths.compressed}.orphaned`)).toBe(false);
    expect(brotliDecompressSync(readFileSync(prefixPaths.compressed)).toString()).toBe(body);
    expect(existsSync(otherPaths.plain)).toBe(false);
    expect(existsSync(otherPaths.compressed)).toBe(true);
    expect(existsSync(`${otherPaths.compressed}.orphaned`)).toBe(true);
    expect(brotliDecompressSync(readFileSync(`${otherPaths.compressed}.orphaned`)).toString()).toBe('B');
    expect(brotliDecompressSync(readFileSync(otherPaths.compressed)).toString()).toBe('A');
  });

  it('archiveFinished compresses finished runs', async () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.eventLog.appendEvent(run.id, { type: 'note', message: 'bulk' });
    finish(store, run.id);
    expect(store.archive.archiveFinished().ids).toEqual([run.id]);
    await store.archive.historyIdle();
    const { plain, compressed } = historyPaths(dir, run.id);
    expect(existsSync(compressed)).toBe(true);
    expect(existsSync(plain)).toBe(false);
  });

  it('updateRun({ archived }) compresses and restores through applyArchived', async () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.eventLog.appendEvent(run.id, { type: 'note', message: 'via-update' });
    finish(store, run.id);
    store.updateRun(run.id, { archived: true });
    await store.archive.historyIdle();
    const { plain, compressed } = historyPaths(dir, run.id);
    expect(existsSync(compressed)).toBe(true);
    expect(existsSync(plain)).toBe(false);
    store.updateRun(run.id, { archived: false });
    expect(existsSync(plain)).toBe(true);
    expect(existsSync(compressed)).toBe(false);
  });

  it('commitWorkerContinuation restores the plain file', async () => {
    const { dir, store } = openStore();
    const parent = store.createRun({ title: 'parent', workflow: 'w', task: 'parent', steps: [] });
    setRunStatus(store, parent.id, RUN_STATUS.waiting, { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    const workerId = randomUUID();
    const worker = store.createOwnedRun(
      {
        title: 'worker', task: 'worker', workflow: 'quick-task', runner: 'claude',
        steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }],
      },
      parent.id,
      randomUUID(),
      {
        role: 'worker',
        permissions: [],
        parentRunId: parent.id,
        workspace: {
          ownerRunId: workerId,
          resourceId: randomUUID(),
          kind: 'owned-isolated',
          path: `/managed/${workerId}`,
          branch: `cez/${workerId.slice(0, 8)}`,
          baselineSha: 'a'.repeat(40),
        },
      },
      'a'.repeat(64),
      spawnCapacityRefusal,
    );
    store.eventLog.appendEvent(worker.id, { type: 'note', message: 'old' });
    store.updateStep(worker.id, 'task', { status: STEP_STATUS.done, sessionId: 'old-session' });
    setRunStatus(store, worker.id, RUN_STATUS.done);
    store.archive.setArchived(worker.id, true);
    await store.archive.historyIdle();
    const { plain, compressed } = historyPaths(dir, worker.id);
    expect(existsSync(compressed)).toBe(true);
    store.commitWorkerContinuation(worker.id, 'continue-line', { archived: false });
    expect(existsSync(plain)).toBe(true);
    expect(existsSync(compressed)).toBe(false);
    expect(readHistoryText(dir, worker.id)).toContain('old');
  });

  it('orphans a non-prefix .br when re-archiving a run an older Squawk continued', async () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.eventLog.appendEvent(run.id, { type: 'note', message: 'placeholder' });
    finish(store, run.id);
    const { plain, compressed } = historyPaths(dir, run.id);
    writeFileSync(plain, 'new');
    writeFileSync(compressed, br('old'));
    expect(store.getRun(run.id)!.archived).toBe(false);
    store.archive.setArchived(run.id, true);
    await store.archive.historyIdle();
    expect(existsSync(plain)).toBe(false);
    expect(brotliDecompressSync(readFileSync(compressed)).toString()).toBe('new');
    expect(brotliDecompressSync(readFileSync(`${compressed}.orphaned`)).toString()).toBe('old');
  });

  it('uses a unique orphan when re-archiving beside an existing .orphaned', async () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.eventLog.appendEvent(run.id, { type: 'note', message: 'placeholder' });
    finish(store, run.id);
    const { plain, compressed } = historyPaths(dir, run.id);
    writeFileSync(plain, 'new');
    writeFileSync(compressed, br('old'));
    writeFileSync(`${compressed}.orphaned`, 'already');
    expect(store.getRun(run.id)!.archived).toBe(false);
    store.archive.setArchived(run.id, true);
    await store.archive.historyIdle();
    expect(existsSync(plain)).toBe(false);
    expect(brotliDecompressSync(readFileSync(compressed)).toString()).toBe('new');
    expect(readFileSync(`${compressed}.orphaned`, 'utf8')).toBe('already');
    expect(brotliDecompressSync(readFileSync(`${compressed}.orphaned.1`)).toString()).toBe('old');
  });

  it('startup sweep does not claim already-compressed archived runs', async () => {
    const { dir, store } = openStore();
    for (let i = 0; i < 8; i++) {
      const run = store.createRun({ title: `t${i}`, workflow: 'w', task: 'task', steps: [] });
      store.eventLog.appendEvent(run.id, { type: 'note', message: `m${i}` });
      finish(store, run.id);
      store.archive.setArchived(run.id, true);
    }
    await store.archive.historyIdle();
    store.persistence.flush();
    store.close();
    stores.pop();

    const reopened = openStore(dir).store;
    const claimsBefore = listClaims(dir);
    const take = vi.spyOn(RunDatabase.prototype, 'takeClaims');
    reopened.archive.compressArchivedHistory();
    await reopened.archive.historyIdle();
    expect(take).not.toHaveBeenCalled();
    expect(listClaims(dir)).toEqual(claimsBefore);
  });

  it('skips compression when another store claims the run before the job starts', async () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.eventLog.appendEvent(run.id, { type: 'note', message: 'keep' });
    finish(store, run.id);
    const { plain, compressed } = historyPaths(dir, run.id);
    const before = readFileSync(plain);
    store.archive.setArchived(run.id, true);
    store.persistence.flush();
    const other = openStore(dir).store;
    expect(other.runPins.pin(run.id, 'active')).toBeDefined();
    await store.archive.historyIdle();
    expect(existsSync(plain)).toBe(true);
    expect(readFileSync(plain).equals(before)).toBe(true);
    expect(existsSync(compressed)).toBe(false);
  });

  it('skips compression when another store claims the run before commit', async () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.eventLog.appendEvent(run.id, { type: 'note', message: 'keep' });
    finish(store, run.id);
    const { plain, compressed } = historyPaths(dir, run.id);
    const before = readFileSync(plain);
    const historyFile = await import('./history-file.ts');
    const original = historyFile.compressHistory;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(historyFile, 'compressHistory').mockImplementation(async (...args) => {
      await gate;
      return original(...args);
    });
    try {
      store.archive.setArchived(run.id, true);
      await vi.waitFor(() => expect(spy).toHaveBeenCalled(), { timeout: HANG_GUARD_MS });
      store.persistence.flush();
      const other = openStore(dir).store;
      expect(other.runPins.pin(run.id, 'active')).toBeDefined();
      release();
      await store.archive.historyIdle();
      expect(existsSync(plain)).toBe(true);
      expect(readFileSync(plain).equals(before)).toBe(true);
      expect(existsSync(compressed)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('setArchived(false) leaves the record unchanged when restoreHistory throws', async () => {
    const { store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.eventLog.appendEvent(run.id, { type: 'note', message: 'keep' });
    finish(store, run.id);
    store.archive.setArchived(run.id, true);
    await store.archive.historyIdle();
    const before = store.getRun(run.id)!;
    const historyFile = await import('./history-file.ts');
    const spy = vi.spyOn(historyFile, 'restoreHistory').mockImplementation(() => {
      throw new Error('restore failed');
    });
    try {
      expect(() => store.archive.setArchived(run.id, false)).toThrow(/restore failed/);
      const after = store.getRun(run.id)!;
      expect(after.archived).toBe(true);
      expect(after.status).toBe(before.status);
      expect(after.archivedAt).toBe(before.archivedAt);
    } finally {
      spy.mockRestore();
    }
  });

  it('retries compression when the plain file grows after the job starts', async () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.eventLog.appendEvent(run.id, { type: 'note', message: 'before' });
    finish(store, run.id);
    const extra = '{"type":"lifecycle","message":"variant picked"}\n';
    const historyFile = await import('./history-file.ts');
    const original = historyFile.compressHistory;
    let raced = false;
    const spy = vi.spyOn(historyFile, 'compressHistory').mockImplementation(async (dataDir, id, stillEligible) => {
      return original(dataDir, id, () => {
        if (!raced) {
          raced = true;
          appendFileSync(historyPaths(dataDir, id).plain, extra);
        }
        return stillEligible();
      });
    });
    try {
      store.archive.setArchived(run.id, true);
      await store.archive.historyIdle();
      const { plain, compressed } = historyPaths(dir, run.id);
      expect(existsSync(compressed)).toBe(true);
      expect(existsSync(plain)).toBe(false);
      const text = readHistoryText(dir, run.id);
      expect(text).toContain('before');
      expect(text).toContain('variant picked');
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }
  });
});
