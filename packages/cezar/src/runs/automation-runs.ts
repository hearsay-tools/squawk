import type { DatabaseSync } from 'node:sqlite';
import { guardedJsonSql } from './guarded-json-sql.ts';
import type { RunIndexTable } from './run-index-rows.ts';

/**
 * `automation_runs` rows for the runs of the runs-shaped table `source` (alias `s`) that `where`
 * selects, read from each record: one per automation that launched the run (`automation`) or
 * triggered it (`automationTrigger`), with that provenance's receipt (`automationRunsOf`,
 * run-row.ts). Only a record that names an automation is parsed, and once.
 */
export function automationRunsSelect(source: string, where = '1'): string {
  return `WITH automation_sources AS MATERIALIZED (
      SELECT s.id AS run_id, ${provenance('automation')} AS launched, ${provenance('automationTrigger')} AS triggered FROM ${source} s
      WHERE ${where} AND instr(s.data, '"automation') > 0 AND ${guardedJsonSql('1', 0, ['s.data'])})
    SELECT run_id, json_extract(launched, '$.automationId') AS automation_id, json_extract(launched, '$.receiptId') AS receipt_id
      FROM automation_sources WHERE json_type(launched, '$.automationId') = 'text'
    UNION SELECT run_id, json_extract(triggered, '$.automationId'), json_extract(triggered, '$.receiptId')
      FROM automation_sources WHERE json_type(triggered, '$.automationId') = 'text'`;
}

/** One provenance object of a record the guarded selection kept, or NULL when it is not an object. */
function provenance(field: 'automation' | 'automationTrigger'): string {
  return `CASE WHEN json_type(s.data, '$.${field}') = 'object' THEN json_extract(s.data, '$.${field}') END`;
}

/** The index's rows: `[automation_id, receipt_id]` per run, the run id implied. */
export const AUTOMATION_RUNS_INDEX: RunIndexTable = { table: 'automation_runs', columns: ['run_id', 'automation_id', 'receipt_id'], select: automationRunsSelect };

/** Index which automation launched or triggered each run, so its count and receipts read a few rows. */
export const AUTOMATION_RUNS_MIGRATION = `
  -- Schema 14 adds automation_runs: the automation that launched (automation) or triggered
  -- (automationTrigger) each run, with its receipt. RunDatabase.transaction keeps it in step with
  -- every row it writes or deletes. It replaces scans of every record (json_extract over data),
  -- about 280 ms each on 4,372 runs: the automations list counted each automation's runs that way.
  CREATE TABLE IF NOT EXISTS automation_runs (
    run_id TEXT NOT NULL,
    automation_id TEXT NOT NULL,
    receipt_id TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS automation_runs_automation ON automation_runs (automation_id, run_id);
  CREATE INDEX IF NOT EXISTS automation_runs_receipt ON automation_runs (receipt_id) WHERE receipt_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS automation_runs_run ON automation_runs (run_id);
  DELETE FROM automation_runs;
  INSERT INTO automation_runs (run_id, automation_id, receipt_id) ${automationRunsSelect('runs')};
  `;

const instances = new WeakMap<DatabaseSync, AutomationRuns>();
type Execute = <T>(work: () => T) => T;
export function automationRuns(db: DatabaseSync, execute: Execute): AutomationRuns {
  let runs = instances.get(db);
  if (!runs) { runs = new AutomationRuns(db, execute); instances.set(db, runs); }
  return runs;
}

/** The index's lookups, prepared once per connection. */
export class AutomationRuns {
  private statements;
  constructor(db: DatabaseSync, private execute: Execute) {
    this.statements = {
      byAutomation: db.prepare('SELECT DISTINCT run_id AS id FROM automation_runs WHERE automation_id = ?'),
      byReceipt: db.prepare(`SELECT DISTINCT r.id AS id, r.created_at, r.seq FROM automation_runs a JOIN runs r ON r.id = a.run_id
        WHERE a.receipt_id IN (SELECT value FROM json_each(?)) ORDER BY r.created_at DESC, r.seq`),
    };
  }

  /** The runs that `automationId` launched or triggered, in no particular order. */
  runsOf(automationId: string): string[] {
    return this.execute(() => this.statements.byAutomation.all(automationId)).map((row) => row.id as string);
  }

  /** The runs whose launch or trigger carries one of `receiptIds`, newest first. */
  runsByReceipt(receiptIds: readonly string[]): string[] {
    return this.execute(() => this.statements.byReceipt.all(JSON.stringify(receiptIds))).map((row) => row.id as string);
  }
}
