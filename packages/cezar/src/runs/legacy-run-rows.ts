import type { parseRunRecords } from './store.ts';
import type { RunRowInput } from './run-database.ts';
import { encodeRunRow } from './run-row.ts';
import { upgradeLegacyWaits } from './legacy-waits.ts';

/** The read-time upgrades of a stored record, in place, before the schema reads it. */
export function upgradeLegacyRunRow(row: Record<string, unknown>): void {
  upgradeLegacyWaits(row);
  upgradeLegacyWorkflowCursor(row);
  upgradeRemovedRunner(row);
}

/** Runners Squawk no longer ships (hearsay-tools/squawk#3715). A run saved on one still opens,
 *  lists and shows its transcript. */
const REMOVED_RUNNER_IDS: readonly string[] = ['cursor'];

function isRemovedRunner(value: unknown): value is string {
  return typeof value === 'string' && REMOVED_RUNNER_IDS.includes(value);
}

/**
 * A run saved on a removed runner, or with any step on one, is read as `removedRunner`; a removed
 * `runner` is cleared. Its steps on that runner keep no backend and no session, and a Continue on
 * a live runner always opens a new session: the latest work is the removed runner's, so an older
 * session of another runner is not where the task stands. The next write of the row stores the fold.
 */
export function upgradeRemovedRunner(row: Record<string, unknown>): void {
  let removed = isRemovedRunner(row.runner) ? row.runner : undefined;
  if (removed !== undefined) delete row.runner;
  for (const step of Array.isArray(row.steps) ? row.steps as unknown[] : []) {
    if (!step || typeof step !== 'object') continue;
    const fields = step as Record<string, unknown>;
    if (!isRemovedRunner(fields.backend)) continue;
    removed ??= fields.backend;
    delete fields.backend;
    delete fields.sessionId;
    delete fields.sessionTransport;
  }
  if (removed !== undefined && row.removedRunner === undefined) row.removedRunner = removed;
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
