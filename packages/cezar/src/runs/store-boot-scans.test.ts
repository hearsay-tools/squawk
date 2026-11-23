import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { RunDatabase, RUNS_DB_FILE } from './run-database.ts';
import { encodeRunRow } from './run-row.ts';
import { seedRuns, overwriteRunColumns } from './run-store.testkit.ts';
import { readRunIndexFromDisk } from './run-index.ts';
import { decodeRunRecord, RunStore, type RunRecord } from './store.ts';
import { AUTOMATION_ORIGIN_HEAL_COMPLETE_KEY, AUTOMATION_ORIGIN_HEAL_SQL, LEGACY_REFERENCE_HEAL_SQL } from './store-open.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'boot-scans-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
const record = (id: string, extra: Partial<RunRecord> = {}): RunRecord => decodeRunRecord(JSON.stringify({
  id, title: id, workflow: 'build', task: 'research', status: RUN_STATUS.done,
  createdAt: '2026-09-01T00:00:00Z', tokensUsed: 0, archived: false, steps: [], ...extra,
}))!;
function database<T>(read: (db: RunDatabase) => T): T {
  const db = RunDatabase.open(join(dir, RUNS_DB_FILE));
  try { return read(db); } finally { db.close(); }
}
const meta = (key: string) => database(db => db.getMeta(key));
const openClose = () => { const store = RunStore.open(dir); store.close(); };

it('heals automation summaries before recording completion, then skips the data scan', () => {
  const run = record('auto', { automationTrigger: {
    automationId: 'nightly', automationRevision: 1, receiptId: 'r', trigger: 'manual', occurrenceAt: '2026-10-05T00:00:00.000Z',
  } });
  seedRuns(dir, [run]);
  const summary = JSON.parse(encodeRunRow(run).summary);
  delete summary.automationId;
  overwriteRunColumns(dir, run.id, { summary: JSON.stringify(summary) });
  const scan = vi.spyOn(RunDatabase.prototype, 'listWhere');
  const store = RunStore.open(dir);
  expect(meta(AUTOMATION_ORIGIN_HEAL_COMPLETE_KEY)).toBeUndefined();
  store.close();
  expect(database(db => JSON.parse(db.get(run.id)!.summary).automationId)).toBe('nightly');
  openClose();
  expect(meta(AUTOMATION_ORIGIN_HEAL_COMPLETE_KEY)).toBe('1');
  scan.mockClear();
  openClose();
  expect(scan.mock.calls.some(([sql]) => sql === AUTOMATION_ORIGIN_HEAL_SQL)).toBe(false);
});

it('stamps unchanged PR checks by revision, retries after writes, and still restores lost references', () => {
  const unchanged = record('unchanged', { markerRefs: { pr: 9 } });
  const restored = record('restored', { markerRefs: { pr: 9 }, pullRequestUrl: 'https://github.com/o/r/pull/9',
    referencedPrCandidates: ['https://github.com/o/r/pull/4'] });
  seedRuns(dir, [unchanged, restored]);
  const revision = database(db => db.get(unchanged.id)!.revision);
  openClose();
  expect(meta('pr-reference-heal:unchanged')).toBe(String(revision));
  expect(database(db => JSON.parse(db.get(restored.id)!.data).referencedPullRequestUrl)).toBe('https://github.com/o/r/pull/4');
  const scan = vi.spyOn(RunDatabase.prototype, 'listWhere');
  openClose();
  expect(scan.mock.results.filter((_, i) => scan.mock.calls[i]![0] === LEGACY_REFERENCE_HEAL_SQL)
    .flatMap(result => result.value).map(row => row.id)).not.toContain('unchanged');
  database(db => db.transaction({ upserts: [encodeRunRow(unchanged)], deletes: [] }));
  scan.mockClear();
  openClose();
  expect(scan.mock.results.filter((_, i) => scan.mock.calls[i]![0] === LEGACY_REFERENCE_HEAL_SQL)
    .flatMap(result => result.value).map(row => row.id)).toContain('unchanged');
  expect(meta('pr-reference-heal:unchanged')).toBe(String(database(db => db.get(unchanged.id)!.revision)));
});

it('loads only foreign records, caches corroborated scope, and invalidates by handle and revision', () => {
  const handle = { owner: 'Local', name: 'Repo' };
  const foreign = record('foreign', { task: 'review foreign/repo', referencedPullRequestUrl: 'https://github.com/foreign/repo/pull/42' });
  const local = record('local', { referencedPullRequestUrl: 'https://github.com/local/repo/pull/43' });
  seedRuns(dir, [foreign, local]);
  const store = RunStore.open(dir);
  const scan = vi.spyOn(RunDatabase.prototype, 'listWhere');
  const keys = vi.spyOn(RunDatabase.prototype, 'listKeysWhere');
  const summaries = vi.spyOn(RunDatabase.prototype, 'getSummaries');
  const full = vi.spyOn(RunDatabase.prototype, 'getMany');
  store.repoScope.setRepoHandle(handle);
  expect(scan).not.toHaveBeenCalled();
  expect(keys).toHaveBeenCalled();
  expect(summaries).toHaveBeenCalled();
  expect(full.mock.calls.flatMap(([ids]) => ids)).toEqual(['foreign']);
  const revision = database(db => db.get(foreign.id)!.revision);
  expect(meta('repo-scope:foreign')).toBe(`local/repo@${revision}`);
  full.mockClear();
  store.repoScope.setRepoHandle({ owner: 'local', name: 'repo' });
  expect(full.mock.calls.flatMap(([ids]) => ids)).toEqual([]);
  store.close();
  full.mockClear();
  const reopened = RunStore.open(dir);
  reopened.repoScope.setRepoHandle(handle);
  expect(full.mock.calls.flatMap(([ids]) => ids)).toEqual([]);
  full.mockClear();
  expect(readRunIndexFromDisk(dir, { handle }).runs.find(run => run.id === 'foreign')?.referencedPullRequestUrl).toBe(foreign.referencedPullRequestUrl);
  expect(full.mock.calls.flatMap(([ids]) => ids)).toEqual([]);
  reopened.close();
  database(db => db.transaction({ upserts: [encodeRunRow(foreign)], deletes: [] }));
  const changed = RunStore.open(dir);
  full.mockClear();
  changed.repoScope.setRepoHandle(handle);
  expect(full.mock.calls.flatMap(([ids]) => ids)).toEqual(['foreign']);
  full.mockClear();
  changed.repoScope.setRepoHandle({ owner: 'another', name: 'repo' });
  expect(full.mock.calls.flatMap(([ids]) => ids)).toContain('foreign');
  changed.close();
});
