import type { parseRunRecords } from './store.ts';
import type { RunRowInput } from './run-database.ts';
import { encodeRunRow } from './run-row.ts';
import { upgradeLegacyWaits } from './legacy-waits.ts';
import { savedRunnerRegistration } from '../core/runner-registry.ts';
import { LEGACY_RUNNER_IDS } from '../core/runner-ids.ts';

/** The read-time upgrades of a stored record, in place, before the schema reads it. */
export function upgradeLegacyRunRow(row: Record<string, unknown>): void {
  upgradeLegacyWaits(row);
  upgradeLegacyWorkflowCursor(row);
  upgradeLegacyDoneAccepted(row);
  upgradeRemovedRunner(row);
}

/** Runners Squawk no longer ships (hearsay-tools/squawk#3715). A run saved on one still opens,
 *  lists and shows its transcript. */
export const REMOVED_RUNNER_IDS: readonly string[] = ['cursor'];

/**
 * How a saved runner id reads in this process. `retired`: a runner Squawk no longer ships; its fold
 * is stored. `unregistered`: an id that no runner of this process registered (a runner of a newer
 * build or one that did not load); its fold is undone by the next write and by a later process that
 * registers it. Undefined: a readable id. Before the registry seals, no id is `unregistered`.
 */
type Removal = 'retired' | 'unregistered';

function removalOf(value: unknown): Removal | undefined {
  if (typeof value !== 'string') return undefined;
  if (REMOVED_RUNNER_IDS.includes(value)) return 'retired';
  return LEGACY_RUNNER_IDS.has(value) || savedRunnerRegistration(value) !== false ? undefined : 'unregistered';
}

/** Whether a run's `removedRunner` names a runner that this process did not register, not a retired
 *  one: such a run waits, untouched, for a process that registers its runner. */
export function waitsForUnregisteredRunner(run: { removedRunner?: string | undefined }): boolean {
  return run.removedRunner !== undefined && !REMOVED_RUNNER_IDS.includes(run.removedRunner);
}

/** Whether a saved runner id parses: a legacy id, or an id a runner registered. An unsealed process
 *  has no opinion: every non-empty id parses, the row reads as written, and
 *  the unregistered-runner fold is skipped (planner decision 2026-11-20, option a). Production
 *  entries register the built-ins before they open a store, so this is the saved-run rule only. */
export function readableSavedRunner(id: string): boolean {
  if (LEGACY_RUNNER_IDS.has(id)) return true;
  return savedRunnerRegistration(id) !== false;
}

/** A removed field of an unregistered runner and where it was. */
interface KeptField { path: (string | number)[]; value: unknown }

/** The fields each fold of an unregistered runner removed, keyed by the row it read. */
const keptFields = new WeakMap<object, KeptField[]>();

/** Whether a removed runner id that a row stored names a runner this process registered. */
function registeredAgain(value: unknown): value is string {
  return typeof value === 'string' && !REMOVED_RUNNER_IDS.includes(value) && savedRunnerRegistration(value) === true;
}

/** A `removedRunner` or `removedBackend` that names a runner registered again reads as before. */
function clearRegisteredAgain(row: Record<string, unknown>): void {
  if (registeredAgain(row.removedRunner)) delete row.removedRunner;
  for (const step of records(row.steps)) if (registeredAgain(step.removedBackend)) delete step.removedBackend;
}

/**
 * A run saved on a removed runner, or with any step or workflow-definition step on one, is read as
 * `removedRunner`; a removed `runner` is cleared. Its steps on that runner keep no backend and no
 * session, only `removedBackend`, so a Continue knows that step holds the latest work and opens a
 * new session for it. A definition step on that runner keeps its prompt, skill and checks, and
 * loses the runner and the model, effort and account that belonged to it. For a retired runner the
 * next write of the row stores the fold; for an unregistered one it puts the removed fields back
 * (`withKeptFields`), where the write has not set them.
 */
export function upgradeRemovedRunner(row: Record<string, unknown>): void {
  clearRegisteredAgain(row);
  const kept: KeptField[] = [];
  const drop = (target: Record<string, unknown>, keys: readonly string[], path: (string | number)[], removal: Removal) => {
    for (const key of keys) {
      if (target[key] === undefined) continue;
      if (removal === 'unregistered') kept.push({ path: [...path, key], value: target[key] });
      delete target[key];
    }
  };
  // Runners whose fold a write already stored on a step: see the step loop below.
  const stored = new Set(records(row.steps).map(step => step.removedBackend));
  const rowRemoval = removalOf(row.runner);
  let removed = rowRemoval ? row.runner as string : undefined;
  if (rowRemoval) drop(row, ['runner'], [], rowRemoval);
  records(row.steps).forEach((step, index) => {
    const removal = removalOf(step.backend);
    if (!removal) return;
    // A step that a write already stored as folded marks no run: a Continue on another runner
    // cleared the run's mark, as it clears it for a retired runner, whose fold leaves no backend.
    if (removal === 'retired' || !stored.has(step.backend)) removed ??= step.backend as string;
    step.removedBackend = step.backend;
    drop(step, ['backend', 'sessionId', 'sessionTransport'], ['steps', index], removal);
  });
  const definition = row.workflowDef;
  records(definition && typeof definition === 'object' ? (definition as Record<string, unknown>).steps : undefined).forEach((step, index) => {
    const removal = removalOf(step.runner);
    if (!removal) return;
    if (removal === 'retired' || !stored.has(step.runner)) removed ??= step.runner as string;
    drop(step, ['runner', 'model', 'effort', 'agentProfile'], ['workflowDef', 'steps', index], removal);
  });
  if (removed !== undefined && row.removedRunner === undefined) row.removedRunner = removed;
  if (kept.length > 0) keptFields.set(row, kept);
}

/**
 * `onto` (by default `raw` itself) with the fields that the fold of `raw`, an unregistered runner's
 * row, removed put back: for the raw extras of its row (raw-record.ts), so the next write keeps
 * them unless it sets them itself, and for the stored JSON of an imported `runs.json` entry. `onto`
 * itself when no such fold ran.
 */
export function withKeptFields(raw: unknown, onto: unknown = raw): unknown {
  const kept = raw && typeof raw === 'object' ? keptFields.get(raw) : undefined;
  if (!kept) return onto;
  const copy = structuredClone(onto) as Record<string, unknown>;
  for (const { path, value } of kept) {
    let target: unknown = copy;
    for (const key of path.slice(0, -1)) target = target && typeof target === 'object' ? (target as Record<string | number, unknown>)[key] : undefined;
    if (target && typeof target === 'object') (target as Record<string | number, unknown>)[path.at(-1)!] = value;
  }
  return copy;
}

/** A settled row's stored summary skips the record parse; it folds the same way, and a runner that
 *  is registered again reads as before. */
export function upgradeRemovedRunnerSummary(row: Record<string, unknown>): void {
  if (row.runner === undefined && registeredAgain(row.removedRunner)) {
    row.runner = row.removedRunner;
    delete row.removedRunner;
  }
  if (removalOf(row.currentStepBackend)) delete row.currentStepBackend;
  if (!removalOf(row.runner)) return;
  if (row.removedRunner === undefined) row.removedRunner = row.runner;
  delete row.runner;
}

/** A saved worker-result snapshot names the runner the worker ran on; a retired one is dropped. */
export function upgradeRemovedRunnerResult(file: unknown): unknown {
  const result = file && typeof file === 'object' ? (file as Record<string, unknown>).result : undefined;
  if (result && typeof result === 'object' && removalOf((result as Record<string, unknown>).backend) === 'retired') {
    delete (result as Record<string, unknown>).backend;
  }
  return file;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object') : [];
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

type RowEntry = { id?: unknown; phase?: unknown; registeredAt?: unknown; resolvedAt?: unknown; deliveredAt?: unknown; cancelledAt?: unknown; createdAt?: unknown };

/** A time a row entry recorded at or before `at`. */
function recordedBy(value: unknown, at: string): boolean {
  return typeof value === 'string' && value <= at;
}

/**
 * A `doneAccepted` saved before its identity facts (hearsay-tools/squawk#3708 saved `session`,
 * `at`, `seq` and `summary`) gets them from the row's own times, as that build ordered them: the
 * waits registered by `at`, of those the ones settled by `at`, and the last agent input created by
 * `at`. The next write of the row stores them.
 */
export function upgradeLegacyDoneAccepted(row: Record<string, unknown>): void {
  const done = row.doneAccepted as Record<string, unknown> | undefined;
  if (!done || typeof done !== 'object' || Array.isArray(done.openWaits) || typeof done.at !== 'string') return;
  const at = done.at;
  const entries = (value: unknown): RowEntry[] => Array.isArray(value) ? value.filter((entry): entry is RowEntry => !!entry && typeof entry === 'object') : [];
  const waits = [...entries(row.waits), ...entries(row.lastWaits)].filter(wait => typeof wait.id === 'string' && recordedBy(wait.registeredAt, at));
  const settled = (wait: RowEntry) => [wait.resolvedAt, wait.deliveredAt, wait.cancelledAt].some(time => recordedBy(time, at));
  const last = entries(row.agentInputs).filter(input => typeof input.id === 'string' && recordedBy(input.createdAt, at)).at(-1)?.id;
  row.doneAccepted = { ...done,
    openWaits: waits.filter(wait => !settled(wait)).map(wait => wait.id as string).slice(-32),
    settledWaits: waits.filter(settled).map(wait => wait.id as string).slice(-32),
    ...(typeof last === 'string' ? { lastInput: last } : {}) };
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
    // The shallow copy shares nested steps with the parsed entry: put back what the fold removed.
    rows.set(run.id, encodeRunRow(run, JSON.stringify(withKeptFields(entry, stored))));
  }
  return { rows: [...rows.values()], skipped, total: raw.length };
}
