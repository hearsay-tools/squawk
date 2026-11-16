import type { parseRunRecords } from './store.ts';
import type { RunRowInput } from './run-database.ts';
import { encodeRunRow } from './run-row.ts';
import { upgradeLegacyWaits } from './legacy-waits.ts';

/** The read-time upgrades of a stored record, in place, before the schema reads it. */
export function upgradeLegacyRunRow(row: Record<string, unknown>): void {
  upgradeLegacyWaits(row);
  upgradeLegacyWorkflowCursor(row);
}

/**
 * A row saved before the `workflowCursor` fact (ADR 0064) names its CI or provider-retry step as
 * `workflowResumeStepId`. It is read as a cursor that resumes that step, and the next write of the
 * row stores the cursor instead.
 */
export function upgradeLegacyWorkflowCursor(row: Record<string, unknown>): void {
  if (!('workflowResumeStepId' in row)) return;
  const stepId = row.workflowResumeStepId;
  delete row.workflowResumeStepId;
  if (typeof stepId === 'string' && row.workflowCursor === undefined) row.workflowCursor = { stepId, mode: 'resume' };
}

/** `runs.json`'s records as rows, and how many of its entries were left out. Each row's `data` is
 *  the record's own JSON as `runs.json` held it, so nothing this Squawk's schema does not know is lost
 *  (raw-record.ts); its summary and columns come from the parsed record, which is what decoding that
 *  JSON gives back. An entry that does not parse is skipped and costs that entry only, as an
 *  unreadable row does once it is in the database. Undefined when the file is not a JSON array. */
export function legacyIndexRows(bytes: Buffer, parse: typeof parseRunRecords): { rows: RunRowInput[]; skipped: number; total: number } | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!Array.isArray(raw)) return undefined;
  // A hand-edited index may repeat an id; the last one won when it loaded into a map, so it still does.
  const rows = new Map<string, RunRowInput>();
  let skipped = 0;
  for (const entry of raw as unknown[]) {
    // `parseRunRecords`' salvage rewrites top-level keys: the stored JSON is taken from a copy.
    const stored = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? { ...entry } : entry;
    const parsed = parse([entry]);
    if (!parsed.success) {
      skipped += 1;
      continue;
    }
    const run = parsed.data[0]!;
    rows.set(run.id, encodeRunRow(run, JSON.stringify(stored)));
  }
  return { rows: [...rows.values()], skipped, total: raw.length };
}
