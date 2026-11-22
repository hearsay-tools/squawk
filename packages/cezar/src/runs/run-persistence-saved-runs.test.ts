import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RUNS_DB_FILE } from './run-database.ts';
import { RunStore } from './store.ts';

/**
 * Saved runs stay a one-way door across the persistence move (hearsay-tools/squawk#4043): the
 * fixture is a dump of `runs.db` and an event file written by the code before the move
 * (`.ai/qa/4043/make-saved-runs-fixture.ts` at that commit), with what that code read back and
 * wrote back. This code must read the same records and write the same rows, byte for byte.
 */
interface SavedRunsFixture {
  ids: { plain: string; archived: string; root: string; extras: string };
  before: { userVersion: number; schema: string[]; tables: Record<string, Array<Record<string, unknown>>> };
  events: string;
  decoded: Record<string, unknown>;
  after: { runs: Array<Record<string, unknown>> };
}
const fixture = JSON.parse(readFileSync(new URL('./__fixtures__/saved-runs-13c09e5a.json', import.meta.url), 'utf8')) as SavedRunsFixture;

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cez-saved-runs-'));
  const db = new DatabaseSync(join(dataDir, RUNS_DB_FILE));
  for (const sql of fixture.before.schema) db.exec(sql);
  db.exec(`PRAGMA user_version = ${fixture.before.userVersion}`);
  for (const [table, rows] of Object.entries(fixture.before.tables)) {
    for (const row of rows) {
      const columns = Object.keys(row);
      db.prepare(`INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
        .run(...columns.map((column) => row[column] as string | number | null));
    }
  }
  db.close();
  mkdirSync(join(dataDir, 'runs'), { recursive: true });
  writeFileSync(join(dataDir, 'runs', `${fixture.ids.plain}.ndjson`), fixture.events);
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const storedRuns = () => {
  const db = new DatabaseSync(join(dataDir, RUNS_DB_FILE), { readOnly: true });
  try { return db.prepare('SELECT * FROM runs ORDER BY seq').all(); } finally { db.close(); }
};

describe('runs saved before the persistence move', () => {
  it('read back as the same records, with the same events', () => {
    const store = RunStore.open(dataDir);
    try {
      for (const [key, id] of Object.entries(fixture.ids)) expect(JSON.parse(JSON.stringify(store.getRun(id))), key).toEqual(fixture.decoded[key]);
      expect(store.eventLog.readEvents(fixture.ids.plain)).toEqual(fixture.events.trim().split('\n').map((line) => JSON.parse(line)));
    } finally {
      store.close();
    }
    expect(storedRuns()).toEqual(fixture.before.tables.runs);
  });

  it('write back the same rows: a debounced save, a committed write, a newer writer\'s field and an untouched row', () => {
    const store = RunStore.open(dataDir);
    try {
      store.updateRun(fixture.ids.plain, { title: 'plain, renamed' });
      store.updateRun(fixture.ids.extras, { title: 'extras, renamed' });
      store.persistence.flush();
      store.updateRun(fixture.ids.root, { allowWorkers: true });
    } finally {
      store.close();
    }
    expect(storedRuns()).toEqual(fixture.after.runs);
  });
});
