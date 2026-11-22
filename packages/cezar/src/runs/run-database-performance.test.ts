import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MIGRATIONS } from './run-database-migrations.ts';
import { RUN_DATABASE_READABLE_FROM, RunDatabase } from './run-database.ts';
import { LOAD_REPAIR_SQL } from './store-open.ts';

let dir: string;
let path: string;
const connections: Array<{ close(): void }> = [];
const track = <T extends { close(): void }>(db: T): T => { connections.push(db); return db; };
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'run-db-perf-')); path = join(dir, 'runs.db'); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of connections.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true });
});

it('migrates the real v14 layout, preserving every named column, row, index and private table', () => {
  const old = new DatabaseSync(path);
  old.exec(MIGRATIONS.slice(0, 14).join('\n') + '\nPRAGMA user_version = 14;');
  old.exec(`INSERT INTO runs (seq, id, created_at, finished_at, status, archived, live, parent_run_id,
    client_request_id, group_id, worktree_path, branch, base_branch, revision, data, summary) VALUES
    (7, 'root', 'now', NULL, 'done', 0, 0, NULL, 'request', 'group', '/path', 'branch', 'main', 92, 'opaque', '{"id":"root"}'),
    (19, 'worker', 'now', 'later', 'waiting', 1, 1, 'root', NULL, NULL, NULL, NULL, NULL, 93, 'broken {', 'also broken');
    INSERT INTO meta VALUES ('commit-seq', '93');
    INSERT INTO run_claims VALUES ('root', 'session', 123, 'start', 17);
    INSERT INTO run_conflicts (run_id, detected_at, session, reason, local_deleted) VALUES ('root', 'now', 'session', 'changed', 0);
    INSERT INTO conversation_members VALUES ('root', 'peer');
    INSERT INTO automation_runs VALUES ('root', 'daily', 'receipt');`);
  const names = old.prepare('PRAGMA table_info(runs)').all().map(row => row.name as string);
  expect(names.indexOf('summary')).toBeGreaterThan(names.indexOf('data'));
  const columns = names.join(', ');
  const rows = old.prepare(`SELECT ${columns} FROM runs ORDER BY seq`).all();
  const indexes = old.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'runs' ORDER BY name").all();
  const privateRows = ['meta', 'run_claims', 'run_conflicts', 'conversation_members', 'automation_runs'].map(table =>
    old.prepare(`SELECT * FROM ${table}`).all());
  old.close();
  expect(RUN_DATABASE_READABLE_FROM).toBe(1);
  const before = RunDatabase.openReadOnly(path)!;
  expect(before.listSummaries().map(row => row.seq)).toEqual([7, 19]);
  before.close();
  const upgraded = RunDatabase.open(path);
  expect(upgraded.get('worker')).toMatchObject({ seq: 19, revision: 93, data: 'broken {', summary: 'also broken' });
  upgraded.close();
  const current = track(new DatabaseSync(path));
  const reordered = current.prepare('PRAGMA table_info(runs)').all().map(row => row.name as string);
  expect(reordered.indexOf('summary') + 1).toBe(reordered.indexOf('data'));
  expect(current.prepare('PRAGMA user_version').get()).toEqual({ user_version: 15 });
  expect(current.prepare('PRAGMA table_list').all().find(row => row.name === 'runs')?.strict).toBe(1);
  expect(current.prepare(`SELECT ${columns} FROM runs ORDER BY seq`).all()).toEqual(rows);
  expect(current.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'runs' ORDER BY name").all().map(row => ({ ...row, sql: String(row.sql).replace(/\s+/g, ' ') }))).toEqual(
    indexes.map(row => ({ ...row, sql: String(row.sql).replace(/\s+/g, ' ') })));
  expect(['meta', 'run_claims', 'run_conflicts', 'conversation_members', 'automation_runs'].map(table =>
    current.prepare(`SELECT * FROM ${table}`).all())).toEqual(privateRows);
  expect(track(RunDatabase.openReadOnly(path)!).listSummaries().map(row => row.seq)).toEqual([7, 19]);
});

it('prepares only schema inspection on read-only open, then prepares a used statement once', () => {
  RunDatabase.open(path).close();
  const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
  const db = track(RunDatabase.openReadOnly(path)!);
  expect(prepare.mock.calls.map(([sql]) => sql)).toEqual(['PRAGMA user_version']);
  expect(db.listIds()).toEqual([]);
  expect(db.listIds()).toEqual([]);
  expect(prepare.mock.calls.map(([sql]) => sql)).toEqual(['PRAGMA user_version', 'SELECT id FROM runs']);
  expect(db.getMeta('absent')).toBeUndefined();
  expect(prepare.mock.calls.map(([sql]) => sql)).toEqual([
    'PRAGMA user_version', 'SELECT id FROM runs', 'SELECT value FROM meta WHERE key = ?',
  ]);
});

it('uses indexes for window lists, root scans and selected-row load repair without selecting data', () => {
  const db = track(RunDatabase.open(path));
  const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
  db.listWindowSummaries(10);
  db.listWindowSummaries(10, { roots: true });
  db.visitRootSummaries(['term'], () => true);
  db.listKeysWhere(`id IN (SELECT value FROM json_each(?)) AND (${LOAD_REPAIR_SQL})`, ['[]']);
  const sql = prepare.mock.calls.map(([text]) => text);
  prepare.mockRestore();
  expect(sql).toHaveLength(4);
  const raw = track(new DatabaseSync(path, { readOnly: true }));
  const plans = sql.map(text => raw.prepare(`EXPLAIN QUERY PLAN ${text}`).all().map(row => String(row.detail)).join(' | '));
  expect(plans[0]).toContain('runs_unarchived');
  for (const plan of plans.slice(0, 2)) expect(plan).toContain('runs_archived_roots');
  expect(plans[2]).toContain('USING INDEX');
  expect(plans[3]).toContain('SEARCH runs USING INDEX sqlite_autoindex_runs_1');
  expect(sql.every(text => !/\bdata\b/.test(text))).toBe(true);
});
