import type { DatabaseSync } from 'node:sqlite';

/**
 * A table of rows derived from each run's record, so a lookup reads an index instead of every
 * record. `RunDatabase.transaction` replaces a run's rows with every write of that run and removes
 * them with its delete. A fallback database may predate the table, so its rows are derived from its
 * records on read (`select`), and adoption copies them (project-run-connection.ts).
 */
export interface RunIndexTable {
  readonly table: string;
  /** The columns, the run's id first. */
  readonly columns: readonly [string, ...string[]];
  /** SQL for the rows of the runs-shaped table `source` (alias `s`) that `where` selects, in
   *  `columns` order. A row whose record is not JSON gives none: the store skips that row. */
  select(source: string, where?: string): string;
}

/** One run's rows, without the run id: the rest of `columns`, in order. */
export type RunIndexRow = readonly (string | null)[];

const instances = new WeakMap<DatabaseSync, Map<string, RunIndexRows>>();
type Execute = <T>(work: () => T) => T;
export function runIndexRows(db: DatabaseSync, index: RunIndexTable, execute: Execute): RunIndexRows {
  let tables = instances.get(db);
  if (!tables) { tables = new Map(); instances.set(db, tables); }
  let rows = tables.get(index.table);
  if (!rows) { rows = new RunIndexRows(db, index, execute); tables.set(index.table, rows); }
  return rows;
}

/** Prepared once per connection. `replace` and `deleteRun` join the run write that calls them. */
export class RunIndexRows {
  private statements;
  constructor(db: DatabaseSync, index: RunIndexTable, private execute: Execute) {
    const [run, ...rest] = index.columns;
    this.statements = {
      rows: db.prepare(`SELECT ${rest.join(', ')} FROM ${index.table} WHERE ${run} = ? ORDER BY ${rest.join(', ')}`),
      delete: db.prepare(`DELETE FROM ${index.table} WHERE ${run} = ?`),
      insert: db.prepare(`INSERT OR IGNORE INTO ${index.table} (${index.columns.join(', ')}) VALUES (${index.columns.map(() => '?').join(', ')})`),
    };
  }

  /** A run's stored rows, for a write that keeps them: null for none. */
  rowsOf(runId: string): RunIndexRow[] | null {
    const rows = this.execute(() => this.statements.rows.all(runId)).map((row) => Object.values(row) as (string | null)[]);
    return rows.length > 0 ? rows : null;
  }

  replace(runId: string, rows: readonly RunIndexRow[] | null): void {
    this.statements.delete.run(runId);
    for (const row of rows ?? []) this.statements.insert.run(runId, ...row);
  }

  deleteRun(runId: string): void { this.statements.delete.run(runId); }
}

/** The temp view a project connection reads `index` through: the main table, then the rows of
 *  the fallback `source` table that main does not shadow, derived from their records. */
export function runIndexView(index: RunIndexTable, source: string): string {
  const columns = index.columns.join(', ');
  return `CREATE TEMP VIEW project_${index.table} AS SELECT ${columns} FROM main.${index.table} UNION ALL
    SELECT ${columns} FROM (${index.select(source)}) source WHERE NOT EXISTS (SELECT 1 FROM main.runs legacy WHERE legacy.id = source.${index.columns[0]})`;
}

/** Copy one adopted run's rows into the main table, from its record now in `main.runs`. */
export function runIndexAdoption(index: RunIndexTable): string {
  return `INSERT OR IGNORE INTO main.${index.table} (${index.columns.join(', ')}) ${index.select('main.runs', 's.id = :id')}`;
}
