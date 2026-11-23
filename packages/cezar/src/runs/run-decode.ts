import { z } from 'zod';
import { runPullRequestSchema, runRecordSchema as contractRunRecordSchema, stepStateSchema as contractStepStateSchema } from '@open-mercato/cezar-contract/runs';
import { previewServerSchema } from '@open-mercato/cezar-contract/preview';
import { waitSchema } from '@open-mercato/cezar-contract/waits';
import { LEGACY_RUNNER_IDS } from '../core/runner-ids.ts';
// Type-only module (zod + nothing else), so this cannot cycle back into the store.
import { workflowDefSchema } from '../workflows/types.ts';
import { storedDelegationStateSchema } from './delegation-state.ts';
import { readableSavedRunner, upgradeLegacyRunRow, withKeptFields } from './legacy-run-rows.ts';
import { hasLegacyWaitFields, UNREADABLE_WAIT } from './legacy-waits.ts';
import { collectRawExtras, type RawExtras } from './raw-record.ts';

/**
 * A runner id as it may appear in a PERSISTED record (#547), spec 2026-11-18-runner-definitions.
 *
 * `claude-cli` is the legacy spelling of `claude`: it is accepted and folded to `claude`
 * (`LEGACY_RUNNER_IDS`), and its step keeps its session. The loader `safeParse`s the WHOLE array
 * of a legacy `runs.json`, so one record the schema refused would drop every run in the file.
 *
 * An id is readable when `readableSavedRunner` says so: a registered id, or, in a process that
 * registered no runner, a built-in id. Before the parse, `upgradeRemovedRunner`
 * (legacy-run-rows.ts) reads a retired or unregistered id as a removed-runner run, so this
 * schema never sees one. An unknown id in a process with no registered runner makes the row
 * unreadable, as before runner ids were open.
 *
 * The legacy fold is one-way and permanent: the next write stores `claude`. Use ONLY for
 * read-back of stored state. Request bodies, settings and workflow step defs take the ids that
 * the server's runner registry holds, because nothing should be able to ASK for the legacy
 * spelling. The output is an open string: a runner that this process registered keeps its own
 * id.
 */
const storedRunnerSchema = z.string().refine(readableSavedRunner)
  .transform(id => LEGACY_RUNNER_IDS.get(id) ?? id);

const stepStateSchema = contractStepStateSchema.extend({ backend: storedRunnerSchema.optional() });

/** Exported for `./run-index.ts`, the read-only reader of the same records. Nothing else should
 *  parse a stored run — see `reconcileLoadedRun` for why a second parser is a correctness risk. */
export const runRecordSchema = contractRunRecordSchema.extend({
  delegation: storedDelegationStateSchema,
  lastWaitsError: contractRunRecordSchema.shape.lastWaitsError.catch(undefined),
  automaticWakes: contractRunRecordSchema.shape.automaticWakes.catch(undefined),
  waitDeliveryFailures: contractRunRecordSchema.shape.waitDeliveryFailures.catch(undefined),
  runner: storedRunnerSchema.optional(),
  notify: z.boolean().optional().catch(undefined),
  webhook: contractRunRecordSchema.shape.webhook.catch(undefined),
  destroyRetry: contractRunRecordSchema.shape.destroyRetry.catch(undefined),
  stopping: contractRunRecordSchema.shape.stopping.catch(undefined),
  autoResumeAt: z.string().datetime().optional().catch(undefined),
  autoResumeAttempts: z.number().int().min(0).optional().catch(undefined), autoResumeReason: contractRunRecordSchema.shape.autoResumeReason.catch(undefined),
  parkReason: contractRunRecordSchema.shape.parkReason.catch(undefined), hasPendingPermission: contractRunRecordSchema.shape.hasPendingPermission.catch(undefined),
  pullRequests: z.preprocess((value) => Array.isArray(value)
    ? value.flatMap((entry) => {
        const parsed = runPullRequestSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      })
    : undefined, z.array(runPullRequestSchema).optional()),
  worktreeSetup: contractRunRecordSchema.shape.worktreeSetup.catch(undefined), workflowCursor: contractRunRecordSchema.shape.workflowCursor.catch(undefined),
  doneAccepted: contractRunRecordSchema.shape.doneAccepted.catch(undefined), archived: z.boolean().default(false),
  workflowDef: workflowDefSchema.optional().catch(undefined),
  steps: z.array(stepStateSchema),
  automation: contractRunRecordSchema.shape.automation.unwrap().extend({
    automationRevision: z.number().int().positive(),
    githubUrl: z.string().url(),
  }).optional(),
  automationTrigger: contractRunRecordSchema.shape.automationTrigger.unwrap().extend({
    automationRevision: z.number().int().positive(),
  }).optional(),
  /** The handoff file's autosave records (hearsay-tools/cezarion#1809); unreadable drops the field. */
  handoffRecords: contractRunRecordSchema.shape.handoffRecords.catch(undefined),
});

/** Read legacy wait fields into the wait list and salvage per entry, identically for live stores
 *  and the read-only workspace index. */
export function parseRunRecords(raw: unknown) {
  if (Array.isArray(raw)) for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    upgradeLegacyRunRow(row);
    // One unreadable wait must not evict the run, nor its readable siblings.
    for (const key of ['waits', 'lastWaits'] as const) {
      if (row[key] === undefined) continue;
      const entries: unknown[] = Array.isArray(row[key]) ? row[key] : [];
      const readable = entries.filter((entry) => waitSchema.safeParse(entry).success);
      if (!Array.isArray(row[key]) || readable.length !== entries.length) row.lastWaitsError = UNREADABLE_WAIT;
      if (readable.length) row[key] = readable;
      else delete row[key];
    }
    // One unreadable registration must not evict the run, nor its readable siblings (#781).
    if (row.previewServers !== undefined) {
      if (Array.isArray(row.previewServers)) row.previewServers = row.previewServers.filter((entry: unknown) => previewServerSchema.safeParse(entry).success);
      else delete row.previewServers;
    }
  }
  return z.array(runRecordSchema).safeParse(raw);
}

/** One stored record and what its JSON holds beyond the runtime schema (raw-record.ts), which
 *  the next write of its row puts back. */
export interface DecodedRun {
  run: RunRecord;
  extras: RawExtras | undefined;
  /** The stored JSON still had schema-3 wait fields (`upgradeLegacyWaits`): open rewrites it. */
  upgraded?: true;
}

/** One stored record (a row's `data`) through `parseRunRecords`' salvage and schema, with what the
 *  schema dropped. Read after the salvage ran: what it removes (an unreadable CI wait, a preview
 *  server entry) the runtime has decided to drop, and keeps dropping on the next write, as it always
 *  has; only what the schema does not know is put back. */
function decodeStoredRecord(raw: unknown): DecodedRun | undefined {
  const upgraded = hasLegacyWaitFields(raw);
  const parsed = parseRunRecords([raw]);
  if (!parsed.success) return undefined;
  const run = parsed.data[0]!;
  return { run, extras: collectRawExtras(withKeptFields(raw), run), ...(upgraded ? { upgraded: true as const } : {}) };
}

/** One database row's `data` back into a record and its extras. Undefined when it does not parse:
 *  one unreadable row costs that row only. */
export function decodeRunRow(data: string): DecodedRun | undefined {
  try {
    return decodeStoredRecord(JSON.parse(data));
  } catch {
    return undefined;
  }
}

/** One database row's `data` back into a record, for a reader that never writes it back. */
export function decodeRunRecord(data: string): RunRecord | undefined {
  try {
    const parsed = parseRunRecords([JSON.parse(data)]);
    return parsed.success ? parsed.data[0] : undefined;
  } catch {
    return undefined;
  }
}

export type StepState = z.infer<typeof stepStateSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
