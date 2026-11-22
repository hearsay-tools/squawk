import { legacyIndexRows, readableSavedRunner, upgradeLegacyRunRow, withKeptFields } from './legacy-run-rows.ts';
import { addRunSource, fallbackRunSource } from './project-run-sources.ts';
import { registeredWaitRecord, registeredReceiptRecord } from './wait-registration-write.ts';
import { stageCommit, stageDurableUpdate, stageDebouncedUpdate, stageConversation, stageStepUpdate, stepTotals, redactPatch, type RecordPatch } from './record-write-rules.ts';
import { publishRunWrite, RunLifecycle, snapshotRun, type RunLifecycleSource } from './lifecycle.ts';
import { listPeerTaskSummaries, parseStoredSummary, type PeerTaskPageOptions } from './run-summary-page.ts';
export { parseStoredSummary } from './run-summary-page.ts';
import type { WorkerExecutionRecords, WorkerExecutions } from './ports.ts';
import { workerExecutionsFactory } from './worker-executions-registry.ts';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  delegationStateSchema,
  workerDestroyRetrySchema,
} from '@open-mercato/cezar-contract/delegation';
import { agentInputSchema, inboxClaimSchema } from '@open-mercato/cezar-contract/agent-input';
import {
  stepStateSchema as contractStepStateSchema,
  toRunSummary,
  runRecordSchema as contractRunRecordSchema,
  runPullRequestSchema,
} from '@open-mercato/cezar-contract/runs';
import { queuedMessageSchema } from '@open-mercato/cezar-contract/queued-messages';
import { previewServerSchema } from '@open-mercato/cezar-contract/preview';
import { waitSchema, type WaitRegistrationReceipt } from '@open-mercato/cezar-contract/waits';
import { isUsageLimitHold } from '@open-mercato/cezar-contract/usage-limit-hold';
import { REFERENCED_RUN_RULE } from '@open-mercato/cezar-contract/run-predicates';
import type { ArchivedRunsResponse, ConversationState, AgentInput, InboxClaim, DelegationState, RunSummary, Wait, WorkerDestroyRetry } from '@open-mercato/cezar-contract';
import { matchesRunSearch, sqlPrefilterTokens, type AutomationNames } from '@open-mercato/cezar-contract/run-search';
import { storedDelegationStateSchema } from './delegation-state.ts';
import { LiveItemSnapshots } from './live-item-snapshots.ts';
import { RunTranscriptFacts } from './transcript-facts-topic.ts';
import { restoreHistory } from './history-file.ts';
// Type-only module (zod + nothing else), so this cannot cycle back into the store.
import { workflowDefSchema } from '../workflows/types.ts';
import { applyOutcomes, type OutcomeDependencies, type OutcomeReceipt, type RunOutcome } from './outcome-commit.ts';
import { ISSUE_URL_RE, namesForeignReference, rescopeRun, restoreOriginatingIssue, trackReferencedIssues, trackReferencedPrs } from './run-references.ts';
import { applyExit, doneCommits, exitDurability, RUN_EXITS, type ExitCall, type ExitDurability, type RunExitId, type RunExitSpec, type RunPatch } from './run-exits.ts';
import { assertConversationIdFree, type ConversationIdentity } from './conversation-identity.ts';
export { ConversationIdInUseError } from './conversation-identity.ts';

import { LEGACY_RUNNER_IDS } from '../core/runner-ids.ts';
import {
  ARCHIVED_ROOT, RUNS_DB_FILE, RUNS_IMPORT_COMPLETE_KEY, RunConflictError, RunDatabase, RunDatabaseBusyError,
  type RunConflictEvidence, type RunDatabaseChanges, type RunDatabaseCommit, type RunFenceClaim, type RunRow, type RunRowInput, type RunWriteFence,
} from './run-database.ts';
import { listBranchOwners, type BranchOwner } from './branch-owners.ts';
import { guardedJsonSql } from './guarded-json-sql.ts';
import { reconcileLoadedRun } from './loaded-run-exits.ts';
import { hasLegacyWaitFields, UNREADABLE_WAIT } from './legacy-waits.ts';
export { ciWaitEntry, holdsWorkerWait, upgradeLegacyWaits, workerWaitEntry } from './legacy-waits.ts';
import { ExitEvents } from './exit-events.ts';
import { encodeRunRow, familyRootOf, isLiveRecord, materializedWorktreePath, newestFirst, type ListOrder } from './run-row.ts';
import { RunRetentionTopic } from './run-retention.ts';
import { collectRawExtras, encodeRawRecord, type RawExtras } from './raw-record.ts';
import { ColdReadCache, storedRow, type StoredRow } from './cold-reads.ts';
import { LEGACY_INDEX_FILE, LegacyWriterError } from './legacy-index.ts';
import { RunStoreOpenError, toRunStoreOpenError } from './store-open-error.ts';
import { importLegacyIndex, OPEN_RETRY_DELAYS_MS, sleepSync } from './store-open.ts';
import { RunClaimsTopic, RunWriteRefusedError } from './run-claims-topic.ts';
import { RunPinsTopic, type RunPinHolder } from './run-pins.ts';
import { createStoreOwnedRun, type SpawnCapacityRefusal } from './owned-run-create.ts';
import { WorkerResultsTopic } from './worker-results.ts';
import { RunEventLogTopic } from './event-log.ts';
import { RunRedaction } from './run-redaction.ts';
import { RunArchiveTopic } from './run-archive.ts';
import { RunReadFlagsTopic } from './run-read-flags.ts';
import { closeClaimSession, familyKey, openClaimSession, rowFamily, type ClaimOwner } from './run-claims.ts';
import { assertProjectWritable, projectWriteRefused } from '../server/cockpit-ownership.ts';

/** Per-store persistence adapter; the second argument is the normal fenced transaction. */
export type RunStorePersistence = (changes: RunDatabaseChanges, transaction: RunDatabase['transaction']) => RunDatabaseCommit;

export type RunStatus = 'queued' | 'running' | 'waiting' | 'review' | 'done' | 'failed' | 'cancelled';
export type StepStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'review'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'skipped';

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

export { LEGACY_INDEX_BACKUP_FILE, LEGACY_INDEX_FILE } from './legacy-index.ts';

export type StepState = z.infer<typeof stepStateSchema>;
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;

/** One persisted event line; `type` mirrors AgentEvent plus engine lifecycle. */
export type RunEvent = import('@open-mercato/cezar-contract').RunEvent;

/** How many archived root runs the run lists carry per project (#864): `GET /run-summaries?archived=recent`
 *  and `GET /workspace/runs-index`. Unarchived runs are never cut; older archived runs page in
 *  through `GET /run-summaries/archived` and the workspace search. */
export const ARCHIVED_WINDOW = 200;

/** The repository a project IS, as `resolveRepoHandle` reports it. `null`/absent means "unknown",
 *  which is a real and common state (no `gh`, no remote, a non-git root) — never an error. */
export type RepoHandle = { owner: string; name: string };

export { branchOwnerOf, type BranchOwner } from './branch-owners.ts';

/** Make `target` hold exactly `source`'s fields, keeping the object every holder references. */
function replaceRecord(target: RunRecord, source: RunRecord): void {
  for (const key of Object.keys(target)) if (!(key in source)) delete (target as Record<string, unknown>)[key];
  Object.assign(target, source);
}

/** An archived root's place in the archived list, with its summary once it is known: a held run's,
 *  or a searched row's. A row ranked by key alone has none, and its page reads it. */
type ArchivedKey = ListOrder & { summary?: RunSummary };

/** Why a `run` event fired, when a delegation checkpoint caused it or nothing durable changed
 *  (`republish`) (in-process only). */
export type CommitSource = 'delegation-checkpoint' | 'delegation-destroy-progress' | 'live-release';

/**
 * A worker's destroy moving between two unfinished phases, and nothing else changing: nothing the
 * family reconcile reads changed, so it may skip that pass (#880). The first request and the
 * `complete` phase still reconcile: one changes delivery eligibility, the other settles requests.
 */
function isDestroyProgress(before: RunRecord['delegation'], after: DelegationState): boolean {
  if (before?.role !== 'worker' || after.role !== 'worker' || !before.destroy || !after.destroy) return false;
  if (before.destroy.phase === 'complete' || after.destroy.phase === 'complete') return false;
  return isDeepStrictEqual({ ...before, destroy: undefined }, { ...after, destroy: undefined });
}

/** An archived page's cursor: the last row's order, opaque to clients. A held run with no row yet
 *  lists after every row (`seq` is infinite), which JSON cannot carry, so it travels as null. */
function encodeArchivedCursor(key: ListOrder): string {
  return Buffer.from(JSON.stringify({ c: key.createdAt, s: Number.isFinite(key.seq) ? key.seq : null })).toString('base64url');
}

function decodeArchivedCursor(cursor: string): ListOrder | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { c, s } = parsed as { c?: unknown; s?: unknown };
    if (typeof c !== 'string' || !(s === null || (typeof s === 'number' && Number.isInteger(s)))) return undefined;
    return { createdAt: c, seq: s ?? Number.POSITIVE_INFINITY };
  } catch {
    return undefined;
  }
}

/** The items newest first, each by the order beside it. Stable: ties keep their input order. */
function sortNewestFirst<T>(entries: Iterable<readonly [T, ListOrder]>): T[] {
  return [...entries].sort(([, a], [, b]) => newestFirst(a, b)).map(([item]) => item);
}

/** Tests freeze the copies of cold runs, so an in-place write to one throws instead of vanishing. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Run rows in runs.db plus append-only NDJSON events and an in-process event bus. Hold live,
 * pinned, related and unsettled records only. Optimistic writes debounce; durable commits
 * publish after persistence. Family claims fence every write.
 */
export class RunStore {
  /** The held set: every record this store keeps in memory, by id. */
  private readonly held = new Map<string, RunRecord>();
  /** Who holds a run beyond its record, by holder, so one holder's unpin never releases another. */
  private readonly pins = new Map<string, Set<RunPinHolder>>();
  /** Staged ids while a durable commit installs and announces them: never evicted mid-commit. */
  private readonly committing = new Set<string>();
  private saveTimer: NodeJS.Timeout | null = null;
  /** `null` once the store is closed, and in a `RunStore.unavailable` store (nothing is written,
   *  nothing is evicted). */
  private db: RunDatabase | null = null;
  /** Persistence source for consumers that build the reports index. No index is created here. */
  reportSource() { return { db: this.db, dataDir: this.dataDir, openFailure: this.openFailure }; }
  /** Why `open` failed, in a `RunStore.unavailable` store. */
  private openFailure: RunStoreOpenError | undefined;
  private persistence: RunStorePersistence | undefined;
  /** Runs whose held record is ahead of its row; the next save or commit writes them. */
  private readonly dirty = new Set<string>();
  /** The typed lifecycle events the store publishes after each write (lifecycle.ts). */
  private readonly published = new RunLifecycle();
  readonly lifecycle: RunLifecycleSource = this.published;
  /** The lifecycle events run exits write (B12). */
  private readonly exitEvents = new ExitEvents((id, event) => this.eventLog.appendEvent(id, event));
  /** Runs gone from memory whose rows the next save or commit deletes. */
  private readonly deleted = new Set<string>();
  /** Deleted runs whose history files (events, handoff, images, artifacts) go once the delete of
   *  their row commits: until then a conflict can undo the delete and bring the row back. */
  private readonly historyOwed = new Set<string>();
  /** The repository this project IS (#945), armed after `open()` by `setRepoHandle`. Undefined
   *  until it arrives and `null` when it cannot be known — both mean "unscoped", which is
   *  exactly the pre-#945 behavior. */
  private repoHandle: RepoHandle | null | undefined;
  /** `open()`'s `keepLive`, which a run read later from `runs.db` is reconciled with too. */
  private keepLive = false;
  /** This store's identity in `run_claims`; undefined without a database. */
  private owner: ClaimOwner | undefined;
  /** The families this store claims, with the generation each acquisition got. */
  private readonly claimed = new Map<string, number>();
  /** Families judged free whose claim a busy database kept this store from taking: the next write
   *  of their rows takes it in its own transaction, if it is still as judged (null: absent). */
  private readonly pendingClaims = new Map<string, { session: string; generation: number } | null>();
  /** The revision and `data` of each held row (and pending deletion) as this store last read or
   *  wrote it: what a write is fenced against, and a conflict's "original". No entry: this store
   *  created the row and has not written it yet. `extras` is what that `data` holds beyond the
   *  schema, which the next write of the row puts back (raw-record.ts). */
  private readonly base = new Map<string, StoredRow>();
  /** Rows read cold in the current synchronous turn, so a commit staged from one is fenced against
   *  the version it was computed from. `owned`: its family was already this store's when read.
   *  Cleared at the next microtask: no commit spans a turn. */
  private readonly coldBase = new Map<string, StoredRow & { owned: boolean }>();
  private readonly coldReads = new ColdReadCache();
  /** The family of each pending deletion, whose claim the deleting write is fenced against. */
  private readonly deletedFamilies = new Map<string, string>();
  /** Rows a conflicting write excluded: this store refuses to write them until it is reopened. */
  private readonly quarantined = new Set<string>();
  /** Rows whose `data` this store tried to decode and could not: left in the database untouched,
   *  and left out of the list rows from then on, as the cold reader leaves them out (run-index.ts). */
  private readonly unreadable = new Set<string>();
  /** The archive flag, archive on merge, completion actions and the transcript compressor (hearsay-tools/squawk#4041). */
  readonly archive: RunArchiveTopic;
  /** The pinned and read flags (hearsay-tools/squawk#4041). */
  readonly readFlags: RunReadFlagsTopic;
  /** What the transcript says about a run (hearsay-tools/squawk#4036). */
  readonly transcriptFacts: RunTranscriptFacts;
  /** Whether a run may go, and its deletion; the count-based archive (hearsay-tools/squawk#4037). */
  readonly retention: RunRetentionTopic;
  /** The saved snapshot of a worker's collected result (hearsay-tools/squawk#4038). */
  readonly workerResults: WorkerResultsTopic;
  /** The event log and reference markers (hearsay-tools/squawk#4040). */
  readonly eventLog: RunEventLogTopic;
  /** The scrub of events and free text (hearsay-tools/squawk#4040). */
  readonly redaction: RunRedaction;
  /** Claims, ownership, sources and fallback (hearsay-tools/squawk#4042). */
  readonly claims: RunClaimsTopic;
  /** The holds that keep a run loaded (hearsay-tools/squawk#4042). */
  readonly runPins: RunPinsTopic;
  private executions: (WorkerExecutions & WorkerExecutionRecords) | undefined;
  /** A worker's execution, process, identity and scope records (hearsay-tools/squawk#4039), built on
   *  first use by the factory this process registered; throws when none is registered. */
  get workerExecutions(): WorkerExecutions & WorkerExecutionRecords {
    return this.executions ??= workerExecutionsFactory()(this.dataDir, {
      peek: (id) => this.peek(id), getRun: (id) => this.getRun(id), writeDir: (id) => this.claims.writeDir(id),
      sourceDataDir: (id) => this.claims.sourceDataDir(id), commitIndex: (input) => this.commitIndex(input),
      published: this.published, workerResults: this.workerResults,
    });
  }
  private readonly liveItems = new LiveItemSnapshots();

  /** Capture both sources on the same synchronous sequence boundary before history IO. */
  liveReadSnapshot(runId: string) {
    return { events: this.liveItems.read(runId), throughSeq: this.seqs.get(runId) ?? Infinity };
  }

  private constructor(private readonly dataDir: string) {
    this.redaction = new RunRedaction();
    this.claims = new RunClaimsTopic(dataDir, {
      db: () => this.db, owner: () => this.owner, keepLive: () => this.keepLive, held: this.held, base: this.base, dirty: this.dirty,
      deleted: this.deleted, quarantined: this.quarantined, unreadable: this.unreadable, claimed: this.claimed, pendingClaims: this.pendingClaims,
      exitEvents: this.exitEvents, coldReads: this.coldReads, decodeRunRow, anchoredFamilies: () => this.anchoredFamilies(), scheduleSave: () => this.scheduleSave(),
    });
    this.runPins = new RunPinsTopic({ pins: this.pins, published: this.published, record: (id) => this.record(id), peek: (id) => this.peek(id), sweepIfSettled: (ids) => this.sweepIfSettled(ids) });
    this.transcriptFacts = new RunTranscriptFacts(dataDir, {
      isFallbackRun: (id) => this.claims.isFallbackRun(id),
      sourceDataDir: (id) => this.claims.sourceDataDir(id),
      isOpen: () => this.db !== null,
      held: this.held,
      listFamilyRunIds: (rootId) => this.listFamilyRunIds(rootId),
      listConversationRootIds: () => this.listConversationRootIds(),
      listRunIds: () => this.listRunIds(),
    });
    this.workerResults = new WorkerResultsTopic(dataDir, {
      peek: (id) => this.peek(id), hasRun: (id) => this.hasRun(id), hasFallbackRun: (id) => this.claims.hasFallbackRun(id),
      writeDir: (id) => this.claims.writeDir(id), sourceDataDir: (id) => this.claims.sourceDataDir(id),
      redactResult: (result) => this.redaction.redact({ type: 'worker-result', seq: 0, ts: result.observedAt, result }).result,
      redactText: (text) => this.redaction.redactText(text), commitDelegation: (patches) => this.commitDelegation(patches),
    });
    this.eventLog = new RunEventLogTopic(dataDir, {
      seqs: this.seqs, published: this.published, liveItems: this.liveItems, transcriptFacts: this.transcriptFacts, redaction: this.redaction,
      record: (id) => this.record(id), missingRunError: (runId) => this.claims.missingRunError(runId), sourceDataDir: (id) => this.claims.sourceDataDir(id),
      touch: (run, before) => this.touch(run, before), change: (id, apply) => this.change(id, apply), repoHandle: () => this.repoHandle,
      maybeEnqueueHistoryCompress: (run) => this.archive.maybeEnqueueHistoryCompress(run),
    });
    this.retention = new RunRetentionTopic(dataDir, {
      db: () => this.db, held: this.held, deleted: this.deleted, quarantined: this.quarantined,
      historyOwed: this.historyOwed, seqs: this.seqs, published: this.published, transcriptFacts: this.transcriptFacts,
      peek: (id) => this.peek(id), hasRun: (id) => this.hasRun(id), record: (id) => this.record(id),
      listWorkersOf: (parentId) => this.listWorkersOf(parentId), isFallbackRun: (id) => this.claims.isFallbackRun(id),
      hasFallbackRun: (id) => this.claims.hasFallbackRun(id), listOrder: (run) => this.listOrder(run),
      claimFamilies: (families) => this.claims.claimFamilies(families), markDeleted: (id, family) => this.markDeleted(id, family),
      scheduleSave: () => this.scheduleSave(), commitIndex: (input) => this.commitIndex(input),
      commitDelegation: (patches) => this.commitDelegation(patches), applyArchived: (run, archived) => this.archive.applyArchived(run, archived),
      workerDeletionEvidence: (id) => this.workerExecutions.workerDeletionEvidence(id),
      workerResults: this.workerResults,
      readWorkerExecution: (id) => this.workerExecutions.readWorkerExecution(id), identityPath: (id) => this.workerExecutions.identityPath(id),
      processesPath: (id) => this.workerExecutions.processesPath(id), scopePath: (id) => this.workerExecutions.scopePath(id),
      executionPath: (id) => this.workerExecutions.executionPath(id), handoffPath: (runId) => this.handoffPath(runId),
      imagesDir: (runId) => this.imagesDir(runId),
    });
    this.archive = new RunArchiveTopic(dataDir, {
      db: () => this.db, held: this.held, deleted: this.deleted, quarantined: this.quarantined, pins: this.pins,
      claimed: this.claimed, base: this.base, owner: () => this.owner, transcriptFacts: this.transcriptFacts,
      decodeRunRow, sortNewestFirst, peek: (id) => this.peek(id), record: (id) => this.record(id),
      listWorkersOf: (parentId) => this.listWorkersOf(parentId), familyOf: (id) => this.familyOf(id),
      claimFamilies: (families, opts) => this.claims.claimFamilies(families, opts), writeRefusal: (id) => this.claims.writeRefusal(id),
      assertWritable: (staged) => this.assertWritable(staged), decodeCold: (row) => this.decodeCold(row),
      listOrder: (run) => this.listOrder(run), commitIndex: (input, source, write) => this.commitIndex(input, source, write),
      touch: (run, before, exit) => this.touch(run, before, exit),
      readWorkerExecution: (id) => this.workerExecutions.readWorkerExecution(id),
    });
    this.readFlags = new RunReadFlagsTopic({
      db: () => this.db, held: this.held, deleted: this.deleted, record: (id) => this.record(id),
      claimFamilies: (families) => this.claims.claimFamilies(families), touch: (run, before) => this.touch(run, before),
      change: (id, apply) => this.change(id, apply),
    });
  }
  /**
   * Open the project's run store. See `reconcileLoadedRun` for what `keepLive` (#367) decides
   * about live-looking rows.
   *
   * Reads `runs.db` once its import is complete. Before that, `runs.json` is imported into it in
   * one transaction (`importLegacyIndex`) and left exactly as it was, for older cezars to read.
   * Either way only the held set is decoded: the live rows (by the indexed `live` column), the
   * few finished rows a normalization still repairs, and the delegation families of the live
   * ones.
   *
   * A store that cannot be opened is never an empty one (#779, plan step 4): `open` throws a
   * `RunStoreOpenError` naming the cause, and nothing is reset, restored or deleted. `retryBusy`
   * waits out a busy database (and a cockpit that may still be importing) with growing pauses,
   * about 3.5 s in all, before it gives up. Open is synchronous, so the wait blocks this thread:
   * only a boot passes it, while nothing else runs yet. Without it a busy database fails after
   * one busy timeout.
   */
  static open(dataDir: string, opts?: { keepLive?: boolean | undefined; retryBusy?: boolean; maintenance?: boolean; persist?: RunStorePersistence }): RunStore {
    const path = join(dataDir, RUNS_DB_FILE);
    const delays = opts?.retryBusy ? OPEN_RETRY_DELAYS_MS : [];
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      try {
        return RunStore.openOnce(dataDir, path, opts?.keepLive === true, opts?.maintenance === true, opts?.persist);
      } catch (error) {
        const transient = error instanceof RunDatabaseBusyError || (error instanceof LegacyWriterError && error.reason === 'cockpit');
        if (!transient || attempt >= delays.length) {
          throw toRunStoreOpenError(error, path, attempt > 0 ? { waitedMs: Date.now() - started } : {});
        }
        sleepSync(delays[attempt]!);
      }
    }
  }
  private static openOnce(dataDir: string, path: string, keepLive: boolean, maintenance: boolean, persist?: RunStorePersistence): RunStore {
    const source = fallbackRunSource(dataDir, bytes => legacyIndexRows(bytes, parseRunRecords)?.rows);
    const deferred = source && !existsSync(path) && !existsSync(join(dataDir, LEGACY_INDEX_FILE));
    if (!deferred) mkdirSync(join(dataDir, 'runs'), { recursive: true });
    const store = new RunStore(dataDir);
    store.keepLive = keepLive;
    store.persistence = persist;
    let db = RunDatabase.open(deferred ? ':memory:' : path);
    try {
      if (deferred) db.transaction({ upserts: [], deletes: [], meta: { [RUNS_IMPORT_COMPLETE_KEY]: 'none' } });
      else if (db.getMeta(RUNS_IMPORT_COMPLETE_KEY) === undefined) importLegacyIndex(db, dataDir, parseRunRecords);
      if (source) db = addRunSource(db, dataDir, source);
      store.db = db;
      store.owner = openClaimSession();
      if (!maintenance) {
        store.claims.loadHeldRows();
        store.transcriptFacts.warmTranscriptFacts();
        store.exitEvents.writeLoaded();
      }
    } catch (error) {
      if (store.owner) {
        try { db.releaseClaims(store.owner.session); } catch { /* the session closes below: its claims are provably dead */ }
        closeClaimSession(store.owner.session);
      }
      store.owner = undefined;
      store.db = null;
      store.held.clear();
      store.dirty.clear();
      store.claimed.clear();
      store.base.clear();
      db.close();
      throw error;
    }
    return store;
  }

  /**
   * The store `serve` keeps for its boot project when `open` failed: no database, nothing held,
   * and every attempt to create or save a run refused with `failure`. The cockpit answers every
   * route of that project with `failure`'s message, and boot skips everything that would read
   * its empty run list as "no runs" (orphan pruning, retention, recovery, scratch sweeps). The
   * way out is a restart once the cause is gone.
   */
  static unavailable(dataDir: string, failure: RunStoreOpenError): RunStore {
    const store = new RunStore(dataDir);
    store.openFailure = failure;
    return store;
  }

  /** Why this store has no database, when it is `RunStore.unavailable`'s: its runs are unknown,
   *  not absent. */
  get unavailable(): RunStoreOpenError | undefined { return this.openFailure; }

  /**
   * Whether a held run anchors itself (and its family) in memory. Anything else held is a family
   * member or a settled write, and leaves at the next sweep (`evictSettled`).
   *
   * The held set is: every run that is live (`isLiveRecord`), pinned by a RunManager (`pin`),
   * dirty, or inside a durable commit; plus the whole delegation family (root and direct
   * workers) of any such run. Families are held because the RunManager reads a live run's family
   * on every run event — `GET /runs/:id/relationships`, the global `reconcileWorkerWaits` pass
   * (about twenty call sites), completion blockers and conversations — and decoding a cold
   * record costs about 200 µs (JSON.parse plus the schema). Measured on a copy of a real
   * cockpit's `runs.json` (958 runs, 957 of them delegated): a running root with 26 workers
   * paid about 5 ms per family read, and the live families together about 10 ms per global
   * pass, all on the event loop. Holding them costs memory in proportion to active work, not to
   * history.
   */
  private isAnchor(id: string, run: RunRecord): boolean {
    return isLiveRecord(run) || this.pins.has(id) || this.dirty.has(id) || this.committing.has(id);
  }

  /** The family roots with an anchoring member in memory. */
  private anchoredFamilies(): Set<string> {
    const roots = new Set<string>();
    for (const [id, run] of this.held) {
      const root = familyRootOf(run);
      if (root !== undefined && this.isAnchor(id, run)) roots.add(root);
    }
    return roots;
  }

  /** Drop every held run that is neither an anchor nor in an anchored family. A store without a
   *  database keeps everything: memory is the only copy it has. */
  private evictSettled(): void {
    if (!this.db) return;
    const families = this.anchoredFamilies();
    for (const [id, run] of this.held) {
      if (this.isAnchor(id, run)) continue;
      const root = familyRootOf(run);
      if (root !== undefined && families.has(root)) continue;
      this.held.delete(id);
      this.base.delete(id);
      this.coldReads.forget(id);
    }
    this.claims.releaseUnheldClaims();
  }

  /** A run read from `runs.db`, normalized like a loaded one (`reconcileLoadedRun`, then the
   *  repository scope) but held by nobody. Undefined when absent, deleted or unreadable. */
  private loadCold(id: string): RunRecord | undefined {
    if (!this.db || this.deleted.has(id)) return undefined;
    const row = this.db.get(id);
    return row ? this.decodeCold(row) : undefined;
  }

  /** `loaded` sees the record once the load has normalized it, before it is scoped: a heal's `before`. */
  private decodeCold(row: RunRow, loaded?: (run: RunRecord) => void): RunRecord | undefined {
    this.coldReads.at(row.id, row.revision); // the fence below moves to this revision
    const decoded = decodeRunRow(row.data);
    if (!decoded) {
      this.unreadable.add(row.id);
      return undefined;
    }
    this.unreadable.delete(row.id);
    const { run, extras } = decoded;
    if (this.coldBase.size === 0) queueMicrotask(() => this.coldBase.clear());
    const family = rowFamily(row);
    this.coldBase.set(row.id, { revision: row.revision, seq: row.seq, data: row.data, extras, owned: this.claimed.has(family) || this.pendingClaims.has(family) });
    reconcileLoadedRun(run, { keepLive: this.keepLive });
    loaded?.(run);
    rescopeRun(run, this.repoHandle);
    return run;
  }

  /** Hold a writable row. A fallback family's reads stay detached (the cold-read contract). */
  private holdDecoded(run: RunRecord): RunRecord {
    if (this.db?.familyHasFallback(familyKey(run))) return process.env.VITEST ? deepFreeze(run) : run;
    const read = this.coldBase.get(run.id);
    this.held.set(run.id, run);
    if (read) this.base.set(run.id, storedRow(read));
    return run;
  }

  /**
   * Hold a claimed run for a write; leave after settlement unless anchored.
   * Take the family claim before reading its row. Return undefined for a live foreign owner
   * or a fallback family: neither claim is granted.
   */
  private hold(id: string): RunRecord | undefined {
    const held = this.held.get(id);
    if (held) return held;
    const family = this.db && !this.deleted.has(id) ? this.db.familyOf(id) : undefined;
    if (family === undefined || !this.claims.claimFamilies([family]).has(family)) return undefined;
    const run = this.coldReads.claimed(id, this.coldBase.get(id), () => this.db?.revisionOf(id)) ?? this.loadCold(id);
    if (!run) return undefined;
    this.holdDecoded(run);
    this.scheduleSave();
    return run;
  }

  /** The record a store write changes in place: held, or loaded to be. Undefined for a run this
   *  store may not write (another process's, or quarantined), so the write changes nothing. */
  private record(id: string): RunRecord | undefined {
    if (this.quarantined.has(id)) return undefined;
    return this.held.get(id) ?? this.hold(id);
  }

  /** Read held legacy family members, or a detached cold record. */
  private peek(id: string): RunRecord | undefined {
    const held = this.held.get(id);
    if (held) return held;
    const run = this.loadCold(id);
    return run && this.answerCold(run, false);
  }

  /**
   * A run just read off its row, as reads answer it: held when its family is in memory (a live
   * family's members are read on every run event), else a copy nobody holds — frozen under
   * vitest when it leaves the store (`freeze`).
   */
  private answerCold(run: RunRecord, freeze: boolean): RunRecord {
    const root = familyRootOf(run);
    if (root !== undefined && this.anchoredFamilies().has(root)) return this.holdDecoded(run);
    return freeze && process.env.VITEST ? deepFreeze(run) : run;
  }

  /** `getRun` for a row a query already read: the held object, else decoded from `row`. */
  private fromRow(row: RunRow): RunRecord | undefined {
    const held = this.held.get(row.id);
    if (held) return held;
    if (this.deleted.has(row.id)) return undefined;
    const cached = this.coldReads.at(row.id, row.revision);
    if (cached) return cached;
    const run = this.decodeCold(row);
    return run && this.coldReads.keep(this.answerCold(run, true), this.coldBase.get(row.id), this.held.has(row.id));
  }

  /** Run `fn` reading each run that is not held at most once (`ColdReadCache`, hearsay-tools/cezarion#2378). */
  withReadCache<T>(fn: () => T): T { return this.coldReads.scope(fn); }

  /** Whether the run exists, held or not, without decoding it. */
  private hasRun(id: string): boolean {
    return this.held.has(id) || (!!this.db && !this.deleted.has(id) && this.db.has(id));
  }

  /**
   * Set discovered repository identity without blocking boot. Recompute conclusions from retained
   * evidence, including cold records; null retains unknown-handle behavior.
   */
  setRepoHandle(handle: RepoHandle | null): void {
    this.repoHandle = handle;
    if (!handle) return; // nothing to prove foreign against
    // `touch` per healed run: the cockpit is already live when the handle lands, so a corrected
    // chip has to reach the open page over SSE, not just the next `runs.json` write.
    let healed = false;
    const stored = this.db?.listWhere(guardedJsonSql(`${REFERENCED_RUN_RULE.sql} OR json_extract(summary, '$.pullRequests') IS NOT NULL`, 0)).filter((row) => {
      if (this.held.has(row.id) || this.deleted.has(row.id)) return false;
      const summary = parseStoredSummary(row.summary);
      return !summary || namesForeignReference(summary, handle);
    }) ?? [];
    for (const run of [...this.held.values()]) {
      const before = snapshotRun(run);
      if (rescopeRun(run, this.repoHandle)) {
        this.touch(run, before);
        healed = true;
      }
    }
    // Only rows this store may write: another process's runs heal when their owner arms its handle.
    const writable = this.claims.claimFamilies(stored.map(rowFamily));
    for (const row of stored) {
      if (!writable.has(rowFamily(row))) continue;
      let before: Readonly<RunRecord> | undefined;
      const run = this.decodeCold(row, (loaded) => { before = snapshotRun(loaded); });
      // `decodeCold` already scoped it with the handle just armed; write it when that changed it.
      if (!run || !this.storedScopeDiffers(row, run)) continue;
      this.holdDecoded(run);
      this.touch(run, before ?? snapshotRun(run));
      healed = true;
    }
    // Discovery may finish after headless shutdown's final flush. Persist repairs now: the
    // debounced save is unref'd, so it cannot keep the CLI alive once the lookup completes.
    if (healed) this.flush();
  }

  /** Whether the stored summary still names a reference the scoped record no longer has. */
  private storedScopeDiffers(row: RunRow, run: RunRecord): boolean {
    const summary = parseStoredSummary(row.summary);
    return summary?.referencedPullRequestUrl !== run.referencedPullRequestUrl ||
      summary?.referencedIssueUrl !== run.referencedIssueUrl || summary?.issueNumber !== run.issueNumber || !isDeepStrictEqual(summary?.pullRequests, run.pullRequests);
  }

  /**
   * The live set, newest first: runs whose record is live (`isLiveRecord`) or that a RunManager
   * pins. Finished runs are not here — read one by id (`getRun`), by an indexed query
   * (`listWorkersOf`, `findRunByClientRequestId`, `listRunsWithWorktree`,
   * `listBranchOwners`), or as list rows (`listRunSummaries`).
   */
  listRuns(): RunRecord[] {
    return sortNewestFirst([...this.held].filter(([id, run]) => isLiveRecord(run) || this.pins.has(id)).map(([, run]) => [run, this.listOrder(run)]));
  }

  /** Where a held run lists: its row's insertion order, or after every row while this store has
   *  not written it yet. The held set keeps such runs in creation order, and so does every list
   *  that sorts them in held-set order (`sortNewestFirst` is stable). */
  private listOrder(run: RunRecord): ListOrder {
    return { createdAt: run.createdAt, seq: this.base.get(run.id)?.seq ?? Number.POSITIVE_INFINITY };
  }

  /**
   * EVERY run as a full record, newest first — decoded row by row. Only the legacy `GET /runs`
   * (older clients; the cockpit reads `GET /run-summaries`) may call this: it is exactly the
   * whole-history parse #779 exists to remove from everything else.
   */
  listAllRunsForLegacyRoute(): RunRecord[] {
    const runs = new Map<string, readonly [RunRecord, ListOrder]>();
    for (const row of this.db?.listAll() ?? []) {
      if (this.deleted.has(row.id) || this.held.has(row.id)) continue;
      const run = this.decodeCold(row);
      if (run) runs.set(row.id, [run, row]);
    }
    for (const [id, run] of this.held) runs.set(id, [run, this.listOrder(run)]);
    return sortNewestFirst(runs.values());
  }

  /** A bounded page of discoverable peer roots, including the current held overlay. */
  listPeerTaskSummaries(options: PeerTaskPageOptions) {
    return listPeerTaskSummaries({ db: this.db, held: this.held, skipped: this.deleted,
      order: run => this.listOrder(run), cold: id => this.coldSummary(id) }, options);
  }

  /**
   * Every run as its list row, newest first: the stored `summary` column, with each held run's
   * own projection laid over it — a debounced save keeps memory up to 300 ms ahead of the row,
   * and a run created since the last save has no row yet. `usage` is the caller's to attach.
   *
   * With `archivedWindow` (#864), the window the cockpit's lists read: every unarchived run, plus
   * the newest `archivedWindow` archived ROOT runs, and whether older archived roots were left
   * out. Archived workers are never in it (see `RunDatabase.listWindowSummaries`); with `roots`,
   * no worker is — the runs index, whose readers list no workers. A held run
   * lists by its record, so one archived or unarchived since the last save is ranked as it is now.
   *
   * A row this store found unreadable is left out, as the cold reader leaves out a row it had to
   * decode and could not. A finished row nobody has decoded is served from its summary by both,
   * which decodes nothing; reading it is what finds out (`isUnreadable`).
   */
  listRunSummaries(options: { archivedWindow?: number | undefined; roots?: boolean } = {}): { runs: RunSummary[]; truncated: boolean } {
    const { archivedWindow, roots = false } = options;
    // Every skipped row may be an archived root, so ask for that many more: one past the window
    // after skipping is how "older ones were left out" is known without counting them.
    const rows = (archivedWindow === undefined
      ? this.db?.listSummaries()
      : this.db?.listWindowSummaries(archivedWindow + 1 + this.deleted.size + this.unreadable.size + this.held.size, { roots })) ?? [];
    const summaries = new Map<string, readonly [RunSummary, ListOrder]>();
    for (const row of rows) {
      if (this.deleted.has(row.id) || this.held.has(row.id) || this.unreadable.has(row.id)) continue;
      const summary = parseStoredSummary(row.summary) ?? this.coldSummary(row.id);
      if (summary) summaries.set(row.id, [summary, row]);
    }
    for (const [id, run] of this.held) {
      if (archivedWindow !== undefined && (run.archived || roots) && run.delegation?.role === 'worker') continue;
      summaries.set(id, [toRunSummary(run), this.listOrder(run)]);
    }
    const runs = sortNewestFirst(summaries.values());
    if (archivedWindow === undefined) return { runs, truncated: false };
    let archived = 0;
    const kept = runs.filter((run) => !run.archived || ++archived <= archivedWindow);
    return { runs: kept, truncated: archived > archivedWindow };
  }

  /**
   * One page of archived ROOT runs, newest first (#864): `GET /run-summaries/archived`, the
   * archived runs past the window. Held runs list by their record, as in `listRunSummaries`.
   * `before` is the previous page's `nextCursor`; with `q`, only runs `matchesRunSearch` keeps, and
   * `total` counts those. `automationNames` lets `q` match a task by its automation's name, as the
   * list's origin line shows it (hearsay-tools/cezarion#1616). A cursor this store did not write
   * answers `{ error }`.
   *
   * Ranking reads every archived root's key (id, created_at, seq: no record, no summary), so the
   * page and `total` agree with the held overlay; only the page's own rows are read in full.
   */
  listArchivedRuns(options: { before?: string; limit: number; q?: string; automationNames?: AutomationNames }): ArchivedRunsResponse | { error: string } {
    let after: ListOrder | undefined;
    if (options.before !== undefined) {
      after = decodeArchivedCursor(options.before);
      if (!after) return { error: 'before is not a cursor this server wrote' };
    }
    const q = options.q?.trim() ?? '';
    const ranked = this.rankArchivedRows(q, options.automationNames);
    this.overlayHeldArchived(ranked, q, options.automationNames);
    const ordered = [...ranked.entries()].sort(([, a], [, b]) => newestFirst(a, b));
    return this.archivedPage(ordered, after, options.limit);
  }

  /** The archived roots in `runs.db`, each by its key: every one without `q` (no record, no
   *  summary read), and with `q` the searched rows `matchesRunSearch` keeps, which carry the summary
   *  the search read. A deleted, held or unreadable run's row is left out; a held run joins in
   *  `overlayHeldArchived`. */
  private rankArchivedRows(q: string, automationNames: AutomationNames | undefined): Map<string, ArchivedKey> {
    const skipped = (id: string) => this.deleted.has(id) || this.held.has(id) || this.unreadable.has(id);
    const ranked = new Map<string, ArchivedKey>();
    if (q === '') {
      for (const key of this.db?.listKeysWhere(ARCHIVED_ROOT) ?? []) if (!skipped(key.id)) ranked.set(key.id, key);
    } else {
      for (const row of this.db?.searchRootSummaries(sqlPrefilterTokens(q, { automationNames })) ?? []) {
        if (skipped(row.id)) continue;
        const summary = parseStoredSummary(row.summary) ?? this.coldSummary(row.id);
        if (summary?.archived && matchesRunSearch(summary, q, { automationNames })) ranked.set(row.id, { ...row, summary });
      }
    }
    return ranked;
  }

  /** Lay the held archived roots over `ranked`, each by its record: it replaces its stored row
   *  (already left out of `ranked`), and with `q` it must match. A held worker never lists. */
  private overlayHeldArchived(ranked: Map<string, ArchivedKey>, q: string, automationNames: AutomationNames | undefined): void {
    for (const [id, run] of this.held) {
      if (!run.archived || run.delegation?.role === 'worker') continue;
      const summary = toRunSummary(run);
      if (q === '' || matchesRunSearch(summary, q, { automationNames })) ranked.set(id, { ...this.listOrder(run), summary });
    }
  }

  /** The page of `ordered` after the cursor `after`: its summaries, the cursor of the next page,
   *  and `total`, the count of all of `ordered`. */
  private archivedPage(ordered: Array<[string, ArchivedKey]>, after: ListOrder | undefined, limit: number): ArchivedRunsResponse {
    const rest = after ? ordered.filter(([, key]) => newestFirst(key, after) > 0) : ordered;
    const page = rest.slice(0, limit);
    const runs = this.hydrateArchivedPage(page);
    const last = page.at(-1)?.[1];
    return {
      runs,
      nextCursor: last && rest.length > page.length ? encodeArchivedCursor(last) : null,
      total: ordered.length,
    };
  }

  /** The page's summaries: a ranked key's own, else its stored one, read for the rows that have
   *  none in a single query. A row whose stored summary does not fit the contract is projected from
   *  its record; a row that cannot be read at all is left out. */
  private hydrateArchivedPage(page: Array<[string, ArchivedKey]>): RunSummary[] {
    const cold = new Map((this.db?.getSummaries(page.filter(([, key]) => !key.summary).map(([id]) => id)) ?? [])
      .map((row) => [row.id, parseStoredSummary(row.summary) ?? this.coldSummary(row.id)]));
    return page.flatMap(([id, key]) => {
      const summary = key.summary ?? cold.get(id);
      return summary ? [summary] : [];
    });
  }

  /**
   * The ROOT runs, archived or not, that match `query` (`matchesRunSearch`), newest first: at most
   * `limit`, and whether more matched. The owned half of the workspace search (#864); held runs
   * match by their record.
   */
  searchRunSummaries(query: string, limit: number): { runs: RunSummary[]; truncated: boolean } {
    const matched = new Map<string, readonly [RunSummary, ListOrder]>();
    // Rows come newest first, so the newest `limit + 1` row matches are all a page can use; held
    // runs, which may be newer than any row, are ranked in below.
    this.db?.visitRootSummaries(sqlPrefilterTokens(query), (row) => {
      if (this.deleted.has(row.id) || this.held.has(row.id) || this.unreadable.has(row.id)) return true;
      const summary = parseStoredSummary(row.summary) ?? this.coldSummary(row.id);
      if (summary && matchesRunSearch(summary, query)) matched.set(row.id, [summary, row]);
      return matched.size <= limit;
    });
    for (const [id, run] of this.held) {
      if (run.delegation?.role === 'worker') continue;
      const summary = toRunSummary(run);
      if (matchesRunSearch(summary, query)) matched.set(id, [summary, this.listOrder(run)]);
    }
    const runs = sortNewestFirst(matched.values());
    return { runs: runs.slice(0, limit), truncated: runs.length > limit };
  }

  /** A row whose stored summary does not fit the contract any more, projected from its record. */
  private coldSummary(id: string): RunSummary | undefined {
    const run = this.loadCold(id);
    return run ? toRunSummary(run) : undefined;
  }

  /**
   * The run, or undefined. A held run is the held object (writes install into it). Any other run
   * is a fresh copy of its row each call, normalized like a loaded record — frozen under vitest —
   * so changing it means a store method, never an assignment.
   */
  getRun(id: string): RunRecord | undefined {
    const held = this.held.get(id);
    if (held) return held;
    const cached = this.deleted.has(id) || !this.db ? undefined : this.coldReads.at(id, this.db.revisionOf(id));
    if (cached) return cached;
    const run = this.loadCold(id);
    return run && this.coldReads.keep(this.answerCold(run, true), this.coldBase.get(id), this.held.has(id));
  }

  /** Whether the run's row is in `runs.db` but its record could not be read here: what tells a
   *  run that cannot open from one that does not exist. Known once something tried to read it. */
  isUnreadable(id: string): boolean {
    return this.unreadable.has(id) && !this.held.has(id) && !this.deleted.has(id);
  }

  /** The ids in memory right now: the held set, for diagnostics and the benchmark's heap pass. */
  heldIds(): string[] {
    return [...this.held.keys()];
  }

  /**
   * The workers a root run owns, newest first, read off its own `receipts` (#659). Every
   * `createOwnedRun` writes the receipt and the worker record in one transaction, and the
   * receipt list is capped at 1,024 creations (#816), so this is a bounded lookup rather than a walk of the whole
   * project index. An ordinary or worker run owns nothing and costs one map read; a receipt
   * whose record has been deleted is skipped, never invented. A parent quarantined to
   * `invalid` has no readable receipts and reports none, which is also what the cockpit
   * assumes for that role.
   */
  listOwnedWorkers(parentId: string): RunRecord[] {
    const parent = this.getRun(parentId);
    if (parent?.delegation?.role !== 'root') return [];
    const workers: RunRecord[] = [];
    for (const receipt of parent.delegation.receipts) {
      const worker = this.getRun(receipt.workerId);
      if (worker?.delegation?.role === 'worker' && worker.delegation.parentRunId === parentId) workers.push(worker);
    }
    return workers.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Every worker filed under `parentId` (the `parent_run_id` index plus memory), newest first:
   *  receipts or not, which is what the reconcile and deletion checks ask. */
  listWorkersOf(parentId: string): RunRecord[] {
    const workers = new Map<string, readonly [RunRecord, ListOrder]>();
    for (const run of this.held.values()) {
      if (run.delegation?.role === 'worker' && run.delegation.parentRunId === parentId) workers.set(run.id, [run, this.listOrder(run)]);
    }
    // Ids first: a live family's workers are usually all held, and then no record is read at all.
    const cold = (this.db?.listIdsByParent(parentId) ?? []).filter((id) => !this.held.has(id) && !this.deleted.has(id));
    for (const row of cold.length > 0 ? this.db!.getMany(cold) : []) {
      const run = this.fromRow(row);
      if (run?.delegation?.role === 'worker' && run.delegation.parentRunId === parentId) workers.set(row.id, [run, row]);
    }
    return sortNewestFirst(workers.values());
  }

  /** The id of every worker, held or stored, without decoding any (recovery's worker passes). */
  listWorkerIds(): string[] {
    const ids = new Set(this.db?.listWorkerIds() ?? []);
    for (const id of this.deleted) ids.delete(id);
    for (const run of this.held.values()) if (run.delegation?.role === 'worker') ids.add(run.id);
    return [...ids];
  }

  /** The id of every run whose delegation is quarantined (`invalid`), held or stored: its stored
   *  summary says so, so nothing is decoded (scratch cleanup). */
  listQuarantinedRunIds(): string[] {
    const ids = new Set((this.db?.listKeysWhere(guardedJsonSql("json_extract(summary, '$.delegation.role') = 'invalid'", 0)) ?? []).map((key) => key.id));
    for (const id of this.deleted) ids.delete(id);
    for (const [id, run] of this.held) {
      if (run.delegation?.role === 'invalid') ids.add(id);
      else ids.delete(id);
    }
    return [...ids];
  }

  /** All retained tasks this automation started, including variants, finished and archived runs.
   * Logs and receipts may compact independently. Read only matching keys in SQLite and overlay
   * held records so a debounced provenance update or deletion is reflected immediately. */
  countAutomationRuns(automationId: string): number {
    const ids = new Set(this.db?.listAutomationRuns(automationId) ?? []);
    for (const id of this.deleted) ids.delete(id);
    for (const [id, run] of this.held) {
      if (run.automation?.automationId === automationId || run.automationTrigger?.automationId === automationId) ids.add(id);
      else ids.delete(id);
    }
    return ids.size;
  }

  /** First non-archived task referencing a project issue, including secondary references. */
  findNonArchivedRunByIssue(repo: string, number: number): string | undefined {
    const url = `https://github.com/${repo}/issues/${number}`.toLowerCase();
    const matches = (run: RunRecord) => {
      if (run.archived) return false;
      const urls = [run.referencedIssueUrl, ...(run.referencedIssueCandidates ?? []),
        ...(run.automation?.event.startsWith('issue.') ? [run.automation.githubUrl] : []),
        ...[...run.task.matchAll(new RegExp(ISSUE_URL_RE.source, 'gi'))].map((match) => match[0])]
        .filter((value): value is string => value !== undefined)
        .map((value) => value.replace(/\/+$/, '').toLowerCase())
        .filter((value) => value.endsWith(`/issues/${number}`));
      // The legacy issueNumber is display-only and cannot establish repository identity.
      // Explicit task markers remain project-scoped unless a qualified URL contradicts them.
      return urls.includes(url) || (urls.length === 0 && run.markerRefs?.issue === number);
    };
    for (const run of this.held.values()) if (matches(run)) return run.id;
    // Secondary references are record-only: query them in SQLite rather than hydrating every
    // finished transcript or relying on the slim summary's primary issue number.
    const where = `archived = 0 AND ${guardedJsonSql(`
      json_extract(data, '$.issueNumber') = ? OR json_extract(data, '$.markerRefs.issue') = ?
      OR lower(rtrim(json_extract(data, '$.referencedIssueUrl'), '/')) = ?
      OR EXISTS (SELECT 1 FROM json_each(data, '$.referencedIssueCandidates') WHERE lower(rtrim(value, '/')) = ?)
      OR (json_extract(data, '$.automation.event') LIKE 'issue.%' AND lower(rtrim(json_extract(data, '$.automation.githubUrl'), '/')) = ?)
      OR instr(lower(json_extract(data, '$.task')), ?) > 0
    `, 0, ['data'])}`;
    for (const key of this.db?.listKeysWhere(where, [number, number, url, url, url, url]) ?? []) {
      if (this.held.has(key.id) || this.deleted.has(key.id) || this.unreadable.has(key.id)) continue;
      const run = this.getRun(key.id);
      if (run && matches(run)) return key.id;
    }
    return undefined;
  }

  /**
   * The runs automation receipts launched, by receipt id (`automation.receiptId` or
   * `automationTrigger.receiptId`). Memory answers first; a receipt it does not know costs one
   * pass over `runs.db` that reads the records' JSON in SQLite — only a crash leftover (a
   * receipt still `reserved` at startup) ever asks.
   */
  findRunIdsByAutomationReceipt(receiptIds: readonly string[]): Map<string, string> {
    const wanted = new Set(receiptIds);
    const found = new Map<string, string>();
    const receiptOf = (run: RunRecord) => run.automation?.receiptId ?? run.automationTrigger?.receiptId;
    for (const run of this.held.values()) {
      const receipt = receiptOf(run);
      if (receipt !== undefined && wanted.has(receipt)) found.set(receipt, run.id);
    }
    const missing = [...wanted].filter((receipt) => !found.has(receipt));
    if (missing.length === 0 || !this.db) return found;
    for (const id of this.db.listRunsByAutomationReceipt(missing)) {
      if (this.held.has(id) || this.deleted.has(id)) continue;
      const run = this.getRun(id);
      const receipt = run && receiptOf(run);
      if (receipt !== undefined && wanted.has(receipt) && !found.has(receipt)) found.set(receipt, id);
    }
    return found;
  }

  /** The id of every root whose delegation carries a conversation, held or stored: recovery's full
   *  reconcile pass (#661). `naming` keeps the ledgers whose messages name that run id as sender or
   *  recipient. Stored roots come from the `conversation_members` index, so no record is read. */
  listConversationRootIds(naming?: string): string[] {
    const ids = new Set(this.db?.listConversationRoots(naming) ?? []);
    for (const id of this.deleted) ids.delete(id);
    for (const [id, run] of this.held) {
      if (run.delegation?.role === 'root' && run.delegation.conversation && (!naming || run.delegation.conversation.messages.some(message => [message.senderRunId, message.recipientRunId].includes(naming)))) ids.add(id);
      else ids.delete(id);
    }
    return [...ids];
  }

  /** The id of every run, held or stored, without decoding any (orphan-worktree sweeps). */
  listRunIds(): string[] {
    const ids = new Set(this.db?.listIds() ?? []);
    for (const id of this.deleted) ids.delete(id);
    for (const id of this.held.keys()) ids.add(id);
    return [...ids];
  }

  /** Runs with a materialized worktree directory (`worktreePath`, not reclaimed), most recently
   *  finished first, then newest first: worktree retention and the worktrees panel. */
  listRunsWithWorktree(): RunRecord[] {
    const runs = this.queryRuns(this.db?.listWithWorktree() ?? [], (run) => materializedWorktreePath(run) !== undefined);
    const recency = ([run]: readonly [RunRecord, ListOrder]) => run.finishedAt ?? run.createdAt;
    return runs.sort((a, b) => (recency(a) < recency(b) ? 1 : recency(a) > recency(b) ? -1 : newestFirst(a[1], b[1]))).map(([run]) => run);
  }

  /**
   * Every run that owns a branch or names the PR it created, as the few fields branch cleanup and
   * git-log attribution read (issue 08 §B3, §B5; a squash commit is attributed by its PR number):
   * the stored summary plus the `branch` and `base_branch` columns, so a Git-tab request decodes
   * no record. Held runs answer from memory.
   */
  listBranchOwners(): BranchOwner[] {
    const rows = (this.db?.listBranchOwners(`branch IS NOT NULL OR ${guardedJsonSql("json_extract(summary, '$.pullRequestUrl') IS NOT NULL", 0)}`) ?? [])
      .filter((row) => !this.deleted.has(row.id) && !this.held.has(row.id));
    return listBranchOwners(rows, [...this.held.values()], (id) => this.getRun(id));
  }

  /** The rows a column query returned, as records, with memory laid over them: a held run
   *  answers from memory (matching `matches` there, not on its maybe-older row). */
  private queryRuns(rows: readonly RunRow[], matches: (run: RunRecord) => boolean): Array<readonly [RunRecord, ListOrder]> {
    const runs = new Map<string, readonly [RunRecord, ListOrder]>();
    for (const run of this.held.values()) if (matches(run)) runs.set(run.id, [run, this.listOrder(run)]);
    for (const row of rows) {
      if (runs.has(row.id) || this.held.has(row.id) || this.deleted.has(row.id)) continue;
      const run = this.fromRow(row);
      if (run && matches(run)) runs.set(row.id, [run, row]);
    }
    return [...runs.values()];
  }

  /** The run an idempotent start already created (#504), archived or not. A deleted run is gone
   *  with its record, so a retry after deletion honestly creates a fresh one. */
  findRunByClientRequestId(clientRequestId: string): RunRecord | undefined {
    for (const run of this.held.values()) if (run.clientRequestId === clientRequestId) return run;
    const row = this.db?.findByClientRequestId(clientRequestId);
    if (!row || this.held.has(row.id)) return undefined;
    const run = this.getRun(row.id);
    return run?.clientRequestId === clientRequestId ? run : undefined;
  }

  createRun(input: Pick<RunRecord, 'allowWorkers' | 'allowMessaging'> & {
    title: string;
    systemPrompt?: string | undefined;
    workflowDef?: z.infer<typeof workflowDefSchema>;
    workflow: string;
    task: string;
    model?: string | undefined;
    /** Reasoning-effort pin (#45). Absent = harness default. */
    effort?: string | undefined;
    runner?: string | undefined;
    /** Composer's per-task agent account (spec 2026-07-29-agent-profiles). */
    agentProfile?: string | undefined;
    autonomous?: boolean | undefined;
    archiveWhenDone?: boolean | undefined;
    autoMergePr?: boolean | undefined;
    /** Task webhook opt-in (#589), set at creation so the first transition is already covered. */
    notify?: boolean | undefined;
    worktree?: false | undefined;
    groupId?: string;
    variant?: string;
    clientRequestId?: string | undefined;
    clientRequestHash?: string | undefined;
    /** Automation provenance, committed with the row that creates the run (hearsay-tools/cezarion#1465):
     *  a crash before a later write must still let reconciliation find the receipt's task. */
    automation?: RunRecord['automation'];
    automationTrigger?: RunRecord['automationTrigger'];
    steps: Array<Pick<StepState, 'id' | 'name' | 'kind' | 'skillPath'>>;
  }): RunRecord {
    if (this.openFailure) throw this.openFailure;
    const run = this.buildRun(input, randomUUID());
    // A new family, so nobody else can hold it; claimed before anything (an NDJSON event) is written.
    if (this.db && !this.claims.claimFamilies([run.id]).has(run.id)) throw new RunWriteRefusedError(run.id, 'foreign');
    this.held.set(run.id, run);
    this.retention.pruneOldRuns();
    this.touch(run, undefined);
    return run;
  }

  /** Build without publishing: owned creation must commit its receipt and run together. */
  private buildRun(input: Parameters<RunStore['createRun']>[0], id: string): RunRecord {
    const run: RunRecord = {
      id,
      // Scrubbed on the way in, exactly as `updateRun` scrubs it on the way
      // through (#456 review) — a token pasted into the prompt otherwise sat
      // verbatim in `runs.json` from creation. `task` is deliberately NOT
      // scrubbed: it is the user's own prompt and is replayed into `{{task}}`
      // when a queued run is revived after a restart (#367), so redacting it
      // would corrupt the revived run.
      title: this.redaction.redactText(input.title),
      workflow: input.workflow,
      task: input.task,
      model: input.model,
      systemPrompt: input.systemPrompt,
      workflowDef: input.workflowDef === undefined ? undefined : workflowDefSchema.parse(input.workflowDef),
      effort: input.effort,
      runner: input.runner,
      agentProfile: input.agentProfile,
      autonomous: input.autonomous,
      archiveWhenDone: input.archiveWhenDone,
      autoMergePr: input.autoMergePr, allowWorkers: input.allowWorkers, allowMessaging: input.allowMessaging,
      ...(input.notify ? { notify: true } : {}),
      worktree: input.worktree,
      groupId: input.groupId,
      variant: input.variant,
      ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId, clientRequestHash: input.clientRequestHash }),
      ...(input.automation ? { automation: input.automation } : {}),
      ...(input.automationTrigger ? { automationTrigger: input.automationTrigger } : {}),
      status: 'queued',
      createdAt: new Date().toISOString(),
      tokensUsed: 0,
      archived: false,
      steps: input.steps.map((s) => ({
        ...s,
        status: 'pending',
        iterations: 0,
        tokensUsed: 0,
      })),
    };
    // A prompt that pastes a PR or issue URL is already about that item — seed
    // both referenced tiers so queued runs can expose the reference before the
    // first agent event (#407, #554).
    trackReferencedPrs(run, input.task, this.repoHandle);
    trackReferencedIssues(run, input.task, this.repoHandle);
    return run;
  }

  /** Accept the family ledger and its recipient queue in a single durable index replacement. A new
   *  message (`message`, or the delivered input) whose ID is in use writes nothing; `recipientDelegation`
   *  makes a peer recipient with no delegation record a root task in the same write. */
  commitConversation(rootId: string, conversation: ConversationState, delivery?: { recipientRunId: string; input: AgentInput; recipientDelegation?: DelegationState },
    message?: ConversationIdentity): void {
    const root = this.peek(rootId);
    if (root?.delegation?.role !== 'root') throw new Error('missing conversation root');
    assertConversationIdFree(root, message ?? delivery?.input, id => this.peek(id), (runId, id) => this.eventLog.hasProjection(runId, id));
    const staged = new Map<string, RunRecord>();
    stageConversation(staged, root, conversation, delivery, id => this.peek(id), text => this.redaction.redactText(text));
    this.commitIndex(staged);
  }

  /** Crash recovery (#505): input a harness accepted but was never seen reading goes
   * back to the queue. Returns the requeued IDs. */
  requeueAwaitingReadInputs(id: string): string[] {
    const ids = (this.peek(id)?.agentInputs ?? []).filter(input => input.awaitingRead && input.deliveredAt && !input.consumedAt).map(input => input.id);
    if (ids.length) this.commitOutcome(id, { kind: 'requeued', inputIds: ids });
    return ids;
  }

  /** Delivered, but the harness never confirmed reading it (#505): stop awaiting a read. */
  commitAgentInputsUnconfirmed(id: string, ids: readonly string[]): void {
    const run = this.peek(id);
    if (!run?.agentInputs || !ids.length) return;
    this.commitAgentInputs(id, run.agentInputs.map(input => {
      if (!ids.includes(input.id) || !input.awaitingRead) return input;
      const { awaitingRead: _awaiting, ...unconfirmed } = input;
      return unconfirmed;
    }));
  }

  /** Observable atomic input checkpoint for the queue itself: enqueue, retire, reorder. Delivery
   *  and reads are outcomes (`commitOutcome`). */
  commitAgentInputs(id: string, inputs: readonly AgentInput[]): void {
    const run = this.peek(id);
    if (!run) throw new Error('missing agent input target');
    const agentInputs = inputs.map(input => agentInputSchema.parse(input));
    // Receipts are outcomes (hearsay-tools/cezarion#1805): only `commitOutcome` writes them.
    const stored = new Map((run.agentInputs ?? []).map(input => [input.id, input]));
    if (agentInputs.some(input => input.deliveredAt !== stored.get(input.id)?.deliveredAt || input.consumedAt !== stored.get(input.id)?.consumedAt)) {
      throw new Error('agent input receipts change only through commitOutcome');
    }
    const now = new Date().toISOString();
    for (const input of run.agentInputs ?? []) {
      const claim = input.inboxClaim;
      if (!claim || claim.acknowledgedAt || claim.expiresAt <= now) continue;
      const matching = agentInputs.filter(next => next.id === input.id);
      if (matching.length !== 1 || !isDeepStrictEqual(matching[0]!.inboxClaim, claim)) {
        throw new Error('live inbox receipt changed');
      }
    }
    this.commitIndex(new Map([[id, { ...run, agentInputs }]]));
  }

  /** Reserve only unread conversation inputs in one durable index replacement. */
  claimInboxInputs(runId: string, ids: readonly string[], claim: InboxClaim): void {
    const run = this.peek(runId);
    if (!run) throw new Error('missing inbox recipient');
    const selected = z.array(z.uuid()).min(1).max(32).refine(values => new Set(values).size === values.length).parse(ids);
    const receipt = inboxClaimSchema.parse({ ...claim, memberIds: selected });
    if (receipt.acknowledgedAt || receipt.expiresAt <= new Date().toISOString()) throw new Error('inbox claim is not live');
    const inputs = run.agentInputs ?? [];
    if (inputs.some(input => input.inboxClaim?.receiptId === receipt.receiptId)) throw new Error('inbox receipt already exists');
    for (const id of selected) {
      const matching = inputs.filter(input => input.id === id);
      if (matching.length !== 1 || matching[0]?.source !== 'agent' || !matching[0].conversation ||
        matching[0].deliveredAt || (matching[0].inboxClaim && matching[0].inboxClaim.expiresAt > new Date().toISOString())) {
        throw new Error('inbox input is not available');
      }
    }
    const selectedIds = new Set(selected);
    this.commitIndex(new Map([[runId, { ...run, agentInputs: inputs.map(input => selectedIds.has(input.id)
      ? agentInputSchema.parse({ ...input, inboxClaim: receipt }) : input) }]]));
  }

  /** A receipt owns every matching input or none; exact ACK retries preserve the first timestamp. */
  ackInboxInputs(runId: string, receiptId: string, generation: string, at: string): 'acknowledged' | 'already-acknowledged' {
    const run = this.peek(runId);
    if (!run) throw new Error('missing inbox recipient');
    inboxClaimSchema.shape.receiptId.parse(receiptId);
    inboxClaimSchema.shape.generation.parse(generation);
    inboxClaimSchema.shape.expiresAt.parse(at);
    const matching = (run.agentInputs ?? []).filter(input => input.inboxClaim?.receiptId === receiptId);
    const receipt = matching[0]?.inboxClaim;
    const memberIds = receipt?.memberIds;
    if (!memberIds || matching.length !== memberIds.length ||
      !memberIds.every(id => matching.some(input => input.id === id)) ||
      matching.some(input => !isDeepStrictEqual(input.inboxClaim, receipt)) ||
      matching.some(input => input.inboxClaim?.generation !== generation ||
      input.source !== 'agent' || !input.conversation)) throw new Error('inbox receipt changed');
    if (matching.every(input => input.inboxClaim?.acknowledgedAt && input.deliveredAt === input.inboxClaim.acknowledgedAt)) {
      return 'already-acknowledged';
    }
    if (matching.some(input => input.deliveredAt || input.inboxClaim?.acknowledgedAt || input.inboxClaim!.expiresAt <= at)) {
      throw new Error('inbox receipt expired or displaced');
    }
    this.commitOutcome(runId, { kind: 'inbox-acknowledged', receiptId, at });
    return 'acknowledged';
  }

  releaseInboxInputs(runId: string, receiptId: string, generation: string): 'released' {
    const run = this.peek(runId);
    if (!run) throw new Error('missing inbox recipient');
    inboxClaimSchema.shape.receiptId.parse(receiptId);
    inboxClaimSchema.shape.generation.parse(generation);
    const matching = (run.agentInputs ?? []).filter(input => input.inboxClaim?.receiptId === receiptId);
    if (!matching.length || matching.some(input => input.inboxClaim?.generation !== generation ||
      input.inboxClaim?.acknowledgedAt || input.deliveredAt)) throw new Error('inbox receipt changed');
    this.commitIndex(new Map([[runId, { ...run, agentInputs: run.agentInputs!.map(input => {
      if (input.inboxClaim?.receiptId !== receiptId) return input;
      const { inboxClaim: _claim, ...unclaimed } = input;
      return agentInputSchema.parse(unclaimed);
    }) }]]));
    return 'released';
  }

  clearExpiredInboxClaims(runId: string, now: string): void {
    const run = this.peek(runId);
    if (!run) throw new Error('missing inbox recipient');
    inboxClaimSchema.shape.expiresAt.parse(now);
    if (!run.agentInputs?.some(input => input.inboxClaim && !input.inboxClaim.acknowledgedAt && input.inboxClaim.expiresAt <= now)) return;
    this.commitIndex(new Map([[runId, { ...run, agentInputs: run.agentInputs.map(input => {
      if (!input.inboxClaim || input.inboxClaim.acknowledgedAt || input.inboxClaim.expiresAt > now) return input;
      const { inboxClaim: _claim, ...unclaimed } = input;
      return agentInputSchema.parse(unclaimed);
    }) }]]));
  }

  /**
   * A wait and its wake input share one atomic index replacement (spec 2026-10-17-unified-waits).
   * Upserts `wait` by id into `waits` and clears `lastWaitsError`; `input` is appended once (an
   * input whose id is already queued stays as it is). Only an open or resolved wait is committed
   * here: settling is an outcome (`commitOutcome`). A new open wait
   * past `WAIT_LIMIT` open ones is refused, so the list stays bounded whatever the caller checked.
   */
  commitWait(id: string, wait: Wait, input?: AgentInput, registration?: WaitRegistrationReceipt): void {
    const run = this.peek(id);
    if (!run) throw new Error('missing wait target');
    this.commitIndex(new Map([[id, registeredWaitRecord(run, wait, input, registration)]]));
  }

  /** Record a deduplicated registration without mutating its wait. */
  commitWaitRegistration(id: string, receipt: WaitRegistrationReceipt): void {
    const run = this.peek(id);
    if (!run) throw new Error('missing wait target');
    this.commitIndex(new Map([[id, registeredReceiptRecord(run, receipt)]]));
  }

  /** A usage-limit appointment withdrawn, committed at once instead of on the debounced save
   *  (hearsay-tools/cezarion#1236): a crash right after the withdrawal must not find it on disk,
   *  or recovery re-arms work the user cancelled. A run held for its resume settles `failed` by
   *  the `withdraw-hold` exit; any other run only loses its resume fields. */
  commitAutoResumeWithdrawal(id: string): void {
    const run = this.peek(id);
    if (!run || (run.autoResumeAt === undefined && run.autoResumeAttempts === undefined)) return;
    if (isUsageLimitHold(run)) this.move(id, 'withdraw-hold');
    else this.commitIndex(new Map([[id, { ...run, autoResumeAt: undefined, autoResumeAttempts: undefined, autoResumeReason: undefined }]]));
  }

  /** A human message beside a run's waits (hearsay-tools/cezarion#1235): accepted durably, and
   *  every wait stays. A lifecycle opening becomes
   *  the human's and keeps its wake text, so the message opens the continuation (and answers a
   *  pending question) and the owed results still reach the agent. */
  commitHumanMessageBesideWaits(id: string, acceptedHumanMessage: QueuedMessage): void {
    const run = this.peek(id);
    if (!run) throw new Error('missing queued message target');
    this.commitIndex(new Map([[id, { ...run, queuedMessages: [...(run.queuedMessages ?? []), queuedMessageSchema.parse(acceptedHumanMessage)],
      ...(run.continuationMessage ? { continuationMessage: { ...run.continuationMessage, origin: 'human' as const } } : {}),
    }]]));
  }

  /**
   * The one write of a run outcome (hearsay-tools/cezarion#1805): an input or wait delivered, a wake
   * charged, a wait settled, a question answered, staged by `applyOutcomes` with what it depends on
   * (`deps`) and committed in one transaction, with every pending row. A crash keeps all of it or
   * none. Nothing changes: nothing is written. Needs no live session: it reads the stored record.
   *
   * A refused write throws with nothing changed. `bestEffort` is for a cleanup path, which must
   * never stop on it: it warns and applies the change in memory for the debounced save to retry.
   * A conversation request outcome is the other sanctioned write: `commitConversation`.
   */
  commitOutcome(id: string, outcomes: RunOutcome | readonly RunOutcome[], deps: OutcomeDependencies = {}, opts: { bestEffort?: boolean } = {}): OutcomeReceipt {
    const run = this.peek(id);
    if (!run) return { committed: false, answered: [], settled: [] };
    const staged = applyOutcomes(run, Array.isArray(outcomes) ? outcomes : [outcomes as RunOutcome], deps);
    if (!staged.changed) return { committed: false, answered: [], settled: [] };
    try { this.commitIndex(new Map([[id, staged.next]]), undefined, { exits: new Map([[id, staged.exit]]) }); }
    catch (error) {
      if (!opts.bestEffort) throw error;
      console.warn(`[hsq] outcome checkpoint failed: ${error instanceof Error ? error.message : String(error)}`);
      const live = this.record(id);
      if (!live) return { committed: false, answered: staged.answered, settled: staged.settled };
      const before = snapshotRun(live);
      replaceRecord(live, staged.next);
      this.touch(live, before, staged.exit);
      return { committed: false, answered: staged.answered, settled: staged.settled };
    }
    return { committed: true, answered: staged.answered, settled: staged.settled };
  }

  /** An acknowledged inactive-root Finish must survive the async diff and restart. */
  commitRootFinishIntent(id: string): void {
    const run = this.peek(id);
    if (run?.status !== 'waiting' || run.delegation?.role !== 'root') throw new Error('root is not waiting');
    if (run.delegation.finishRequestedAt) return;
    this.commitDelegation([{ id, delegation: { ...run.delegation, finishRequestedAt: new Date().toISOString() } }]);
  }

  /** Persist all authority patches before exposing any of them to the engine or subscribers. */
  commitDelegation(patches: ReadonlyArray<{ id: string; delegation: DelegationState }>): void {
    if (patches.length === 0) return;
    const staged = new Map<string, RunRecord>();
    let destroyProgress = true;
    for (const patch of patches) {
      const run = this.peek(patch.id);
      if (!run || staged.has(patch.id)) throw new Error('missing or duplicate delegation patch target');
      const delegation = delegationStateSchema.parse(patch.delegation);
      if (!isDestroyProgress(run.delegation, delegation)) destroyProgress = false;
      staged.set(patch.id, { ...run, delegation });
    }
    // In-process cause only: consumers can skip metadata replay when delegation
    // is disabled without dropping real status or termination-proof notifications.
    this.commitIndex(staged, destroyProgress ? 'delegation-destroy-progress' : 'delegation-checkpoint');
  }

  /** A pending destroy's automatic retry state, or its removal (hearsay-tools/cezarion#879). Kept on
   * the record beside the strict delegation, so an older Squawk strips it rather than quarantining the
   * worker. Destroy progress: nothing the family reconcile reads changes. */
  commitDestroyRetry(id: string, retry: WorkerDestroyRetry | undefined): void {
    const run = this.peek(id);
    if (run?.delegation?.role !== 'worker' || !run.delegation.destroy) throw new Error('missing pending destroy');
    if (!retry && !run.destroyRetry) return;
    // An explicit `undefined`, not an omitted key: commitIndex assigns onto the live record.
    this.commitIndex(new Map([[id, { ...run, destroyRetry: retry ? workerDestroyRetrySchema.parse(retry) : undefined }]]), 'delegation-destroy-progress');
  }

  /** Accepted execution revision is public lifecycle identity, separate from process generations. */
  commitWorkerContinuation(id: string, exit: RunExitId, patch: Omit<RunPatch, 'delegation'> = {}, step?: Pick<StepState, 'id' | 'name' | 'kind' | 'synthetic' | 'continuesStepId'>,
    conversation?: { rootId: string; state: ConversationState; input: AgentInput }): void {
    const run = this.peek(id);
    if (run?.delegation?.role !== 'worker') throw new Error('missing worker continuation target');
    const delegation = delegationStateSchema.parse({ ...run.delegation,
      executionRevision: (run.delegation.executionRevision ?? 0) + 1,
      executionStartSeq: this.transcriptFacts.transcriptFacts(id).lastSeq,
    });
    const staged = new Map<string, RunRecord>();
    this.exitEvents.started(id);
    const next: RunRecord = { ...run, ...applyExit(run, exit, this.redactPatch(patch) as RunPatch), delegation,
      ...(step ? { steps: [...run.steps, { ...step, status: 'pending' as const, iterations: 0, tokensUsed: 0 }] } : {}),
    };
    staged.set(id, next);
    if (Object.prototype.hasOwnProperty.call(patch, 'archived')) this.archive.syncTranscriptForm(id, next.archived);
    if (conversation) {
      const root = this.peek(conversation.rootId);
      if (root?.delegation?.role !== 'root' || run.delegation.parentRunId !== root.id) throw new Error('missing conversation ownership');
      stageConversation(staged, root, conversation.state, { recipientRunId: id, input: conversation.input },
        runId => this.peek(runId), text => this.redaction.redactText(text));
    }
    this.commitIndex(staged, undefined, { exits: new Map([[id, exit]]) });
  }

  /** Create an owned worker run and its parent receipt; `createStoreOwnedRun` holds the checks. */
  createOwnedRun(
    input: Parameters<RunStore['createRun']>[0],
    parentId: string,
    requestId: string,
    worker: DelegationState,
    requestHash: string,
    spawnCapacityRefusal: SpawnCapacityRefusal,
    executionIdentity: unknown = { kind: 'internal' },
  ): RunRecord {
    return createStoreOwnedRun({
      peek: (id) => this.peek(id),
      hasRun: (id) => this.hasRun(id),
      held: this.held, deleted: this.deleted, db: this.db,
      buildRun: (ownedInput, id) => this.buildRun(ownedInput, id),
      writeWorkerIdentity: (id, identity) => this.workerExecutions.writeWorkerIdentity(id, identity),
      writeWorkerExecution: (id, proof, fresh) => this.workerExecutions.writeWorkerExecution(id, proof, fresh),
      commitIndex: (owned) => this.commitIndex(owned),
    }, input, parentId, requestId, worker, requestHash, spawnCapacityRefusal, executionIdentity);
  }

  /**
   * Durably replace or delete staged rows together with pending dirty rows. Persist before
   * changing held objects or notifying subscribers. On failure retain all pending state; flush()
   * remains best-effort.
   */
  private commitIndex(input: ReadonlyMap<string, RunRecord | null>, source?: CommitSource,
    write: { before?: ReadonlyMap<string, Readonly<RunRecord>>; exits?: ReadonlyMap<string, RunExitId | undefined> } = {}): void {
    const exits = new Map(write.exits);
    const staged = stageCommit(input, {
      peek: id => this.peek(id),
      completionArchiveBlocker: run => this.archive.completionArchiveBlocker(run),
      stageArchive: (staged, run, archived) => this.archive.stageArchive(staged, run, archived, exits),
    });
    const before = new Map([...staged].map(([id, next]) => [id, next ? write.before?.get(id) ?? snapshotRun(this.peek(id)) : undefined])), committed = new Map([...staged].map(([id, next]) => [id, snapshotRun(next ?? undefined)]));
    if (!this.db) throw this.openFailure ?? new Error('runs database unavailable: nothing can be saved');
    this.assertWritable(staged);
    this.persist(staged);
    // Preserve existing record references, but expose the entire transaction before its first event, which
    // carries the record this commit wrote (`committed`). A finished run is held until the next sweep.
    for (const [id, next] of staged) {
      this.coldReads.forget(id);
      if (!next) { this.held.delete(id); continue; }
      this.committing.add(id);
      const current = this.held.get(id);
      if (current) replaceRecord(current, next);
      else this.held.set(id, next);
    }
    try {
      for (const id of staged.keys()) {
        const run = this.held.get(id);
        if (run) publishRunWrite(this.published, committed.get(id) ?? run, before.get(id), source, exits.get(id));
        else this.published.publish('run.deleted', { runId: id });
      }
    } finally {
      for (const id of staged.keys()) this.committing.delete(id);
      this.sweepIfSettled(staged.keys());
    }
    for (const [id, next] of staged) if (next?.archived) this.archive.compressor.enqueue(id);
  }

  /**
   * Refuse (throwing, with nothing changed) a commit that stages a quarantined run, or a run whose
   * family this store does not claim and cannot take: another process owns it, or a dead process
   * left it live and it has not been adopted.
   */
  private assertWritable(staged: ReadonlyMap<string, RunRecord | null>): void {
    const families = new Map<string, string>();
    const held = new Set<string>();
    for (const [id, next] of staged) {
      if (this.quarantined.has(id)) throw new RunWriteRefusedError(id, 'quarantined');
      const family = next ? familyKey(next) : this.familyOf(id);
      families.set(id, family);
      if (this.held.has(id)) held.add(family);
    }
    // A run this store holds may move to a new family; any other row is claimed as a plain write.
    const owned = new Set([...this.claims.claimFamilies(held, { allowLive: true }),
      ...this.claims.claimFamilies([...families.values()].filter((family) => !held.has(family)))]);
    for (const [id, family] of families) {
      if (!owned.has(family)) throw this.claims.runOwnership(id) === 'fallback' ? this.claims.fallbackRefusal(id) : new RunWriteRefusedError(id, this.claims.runOwnership(id) === 'orphaned' ? 'orphaned' : 'foreign');
    }
  }

  /** The family of a run this store knows: held, else its row; a run nowhere is its own. */
  private familyOf(id: string): string {
    const held = this.held.get(id);
    return held ? familyKey(held) : this.deletedFamilies.get(id) ?? this.db?.familyOf(id) ?? id;
  }

  /** Schedule the sweep that lets any of `ids` leave memory, when one of them now can. */
  private sweepIfSettled(ids: Iterable<string>): void {
    for (const id of ids) {
      const run = this.held.get(id);
      if (run && !this.isAnchor(id, run)) { this.scheduleSave(); return; }
    }
  }

  /** Move run `id` by `exit` (ADR 0056): its status and `extras` in one write, checked against the
   *  record that write changes. A run this store cannot write is neither checked nor written. The
   *  exit decides how the write persists (`exitDurability`), never the extras. A guarded exit (one
   *  with a `guard` or a `settle`) commits at once, and writes nothing when its guard fails: undefined, or its
   *  `refused` error. `call` names the step the exit settles apart from the others, and the text
   *  of the lifecycle event it writes after the write (`exitEvent`). */
  move(id: string, exit: RunExitId, extras: RunPatch = {}, call: ExitCall = {}): RunRecord | undefined {
    const spec: RunExitSpec = RUN_EXITS[exit];
    const guarded = Boolean(spec.guard || spec.settle);
    const run = guarded ? this.peek(id) : this.record(id);
    if (!run || spec.guard?.(run) === false) {
      if (spec.refused) throw new Error(spec.refused);
      return undefined;
    }
    const event = this.exitEvents.owed(id, exit, run.status, call);
    // Redacted first: a step the exit settles takes the run's error.
    const redacted = this.redactPatch(extras) as RunPatch;
    let moved: RunRecord | undefined;
    if (!guarded) moved = this.writeRun(id, run, applyExit(run, exit, redacted, call), exitDurability(exit, run), exit);
    else {
      const input = { ...run, ...redacted };
      this.commitIndex(new Map([[id, { ...(spec.settle?.(input, { ...call, now: new Date().toISOString() }) ?? input), ...applyExit(run, exit, {}, call) }]]), undefined, { exits: new Map([[id, exit]]) });
      moved = this.peek(id);
    }
    if (event) this.exitEvents.write(id, event);
    return moved;
  }

  /** A write that is not a run exit. It commits at once when it changes handoff records, a
   *  completion option or task access, else the next save writes it. A status in the patch, which only test
   *  fixtures still write, takes the exit's record rule (`doneCommits`). */
  updateRun(id: string, patch: RunPatch): RunRecord | undefined {
    const run = this.record(id);
    if (!run) return undefined;
    const committed = (patch.status === 'done' && doneCommits(run)) || patch.handoffRecords !== undefined ||
      [patch.archiveWhenDone, patch.autoMergePr, patch.allowWorkers, patch.allowMessaging].some(value => value !== undefined);
    return this.writeRun(id, run, patch, committed ? 'committed' : 'debounced');
  }

  /** One update of the held record `run`: committed at once, or written to the record for the next
   *  save. A debounced write is best-effort, so a locked database cannot stop cleanup. */
  private writeRun(id: string, run: RunRecord, patch: RecordPatch, durability: ExitDurability, exit?: RunExitId): RunRecord | undefined {
    const before = snapshotRun(run);
    const hooks = {
      redact: (text: string) => this.redaction.redactText(text),
      repoHandle: this.repoHandle,
      restore: () => restoreHistory(this.dataDir, id),
      archive: (record: RunRecord, archived: boolean) => this.archive.applyArchived(record, archived, before, exit),
      touch: (record: RunRecord) => this.touch(record, before, exit),
    };
    if (durability === 'committed') {
      const staged = stageDurableUpdate(run, patch, hooks, exit);
      this.commitIndex(new Map([[id, staged.run]]), undefined, { before: new Map([[id, before]]), exits: new Map([[id, staged.exit]]) });
      return this.record(id);
    }
    stageDebouncedUpdate(run, patch, hooks);
    return run;
  }
  private redactPatch(patch: Partial<Omit<RunRecord, 'id' | 'steps'>>): Partial<Omit<RunRecord, 'id' | 'steps'>> {
    return redactPatch(patch, text => this.redaction.redactText(text));
  }

  /** Append a step to an existing run (used by "Continue" — spec 003). */
  addStep(runId: string, step: Pick<StepState, 'id' | 'name' | 'kind' | 'synthetic' | 'continuesStepId'>): void {
    const run = this.record(runId);
    if (!run || run.steps.some((s) => s.id === step.id)) return;
    const before = snapshotRun(run);
    run.steps = [...run.steps, { ...step, status: 'pending', iterations: 0, tokensUsed: 0 }];
    this.touch(run, before);
  }
  updateStep(runId: string, stepId: string, patch: Partial<Omit<StepState, 'id'>>): void {
    const run = this.record(runId);
    const step = run?.steps.find((s) => s.id === stepId);
    if (!run || !step) return;
    const before = snapshotRun(run), next = { ...step, ...stageStepUpdate(patch, text => this.redaction.redactText(text)) };
    // Replaced, never changed in place, so `before` keeps the steps as they were.
    run.steps = run.steps.map((candidate) => candidate === step ? next : candidate);
    Object.assign(run, stepTotals(run.steps));
    this.touch(run, before);
  }

  /** A debounced write of the held record `id`: `apply` changes it in place, then `touch` saves it. */
  private change(id: string, apply: (run: RunRecord) => void): RunRecord | undefined {
    const run = this.record(id), before = snapshotRun(run);
    if (!run) return undefined;
    apply(run);
    this.touch(run, before);
    return run;
  }

  /** Indexed family enumeration, including members not yet flushed to SQLite. */
  listFamilyRunIds(rootId: string): string[] {
    const ids = new Set([rootId, ...(this.db?.listIdsByParent(rootId) ?? [])]);
    for (const [id, run] of this.held) {
      if (familyRootOf(run) === rootId) ids.add(id);
      else if (id !== rootId) ids.delete(id);
    }
    for (const id of this.deleted) ids.delete(id);
    return [...ids];
  }

  /** Write the pending rows out now (used on shutdown). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveNow();
  }

  // ---- internals -----------------------------------------------------------

  private seqs = new Map<string, number>();

  /** Same location `handoffPath()` in handoff.ts produces — inlined to keep
   *  the store free of upward imports. */
  private handoffPath(runId: string): string {
    return join(this.claims.sourceDataDir(runId), 'runs', `${runId}.handoff.md`);
  }

  /** Agent screenshots persisted by the run manager (see persistImage). */
  private imagesDir(runId: string): string {
    return join(this.claims.sourceDataDir(runId), 'runs', `${runId}-images`);
  }

  /** Save `run` debounced and publish it; `before` is the record at the write's entry (none: created). */
  private touch(run: RunRecord, before: Readonly<RunRecord> | undefined, exit?: RunExitId): void {
    this.dirty.add(run.id);
    this.scheduleSave();
    publishRunWrite(this.published, run, before, undefined, exit);
    this.archive.maybeEnqueueHistoryCompress(run);
  }

  /** The held record is gone; the next save or commit deletes its row, fenced by `family`'s claim
   *  and by the revision this store last saw (kept in `base` until the delete is written). */
  private markDeleted(id: string, family: string): void {
    this.liveItems.forget(id);
    this.coldReads.forget(id);
    const read = this.coldBase.get(id);
    if (!this.base.has(id) && read) this.base.set(id, storedRow(read));
    this.dirty.delete(id);
    this.deleted.add(id);
    this.deletedFamilies.set(id, family);
    this.historyOwed.add(id);
  }

  /** Debounced so token-usage updates don't rewrite a row per event. Nothing to schedule without
   *  a database: a `RunStore.unavailable` store, or a closed one, writes nothing. */
  private scheduleSave(): void {
    if (this.saveTimer || !this.db) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 300);
    this.saveTimer.unref?.();
  }

  /** The single database write, so a test can fail it the way a full disk would. */
  private writeIndex(changes: RunDatabaseChanges): RunDatabaseCommit {
    const transaction = (changes: RunDatabaseChanges) => { assertProjectWritable(this.dataDir); return this.db!.transaction(changes); };
    return this.persistence ? this.persistence(changes, transaction) : transaction(changes);
  }

  /**
   * Write `staged` plus everything still pending — dirty rows from memory, deletions — in one
   * transaction, then clear the pending marks. Throws with nothing cleared when it fails.
   * Never copies or sorts the whole store: the cost is the rows that changed.
   *
   * Fenced (#779, plan step 3): the transaction commits only if every family it writes still
   * carries this store's claim and every row is at the revision this store last saw. Otherwise
   * nothing is written and `handleConflicts` deals with the rows that changed under it.
   */
  private persist(staged: ReadonlyMap<string, RunRecord | null>): void {
    const upserts: RunRowInput[] = [];
    const deletes: string[] = [];
    const families = new Map<string, string>();
    const extras = new Map<string, RawExtras | undefined>();
    const encode = (run: RunRecord) => {
      const encoded = encodeRawRecord(run, (this.base.get(run.id) ?? this.coldBase.get(run.id))?.extras);
      extras.set(run.id, encoded.extras);
      const projected = { ...run };
      restoreOriginatingIssue(projected);
      upserts.push({ ...encodeRunRow(run, encoded.data),
        issueAttributionCurrent: isDeepStrictEqual(projected, run) });
    };
    for (const [id, next] of staged) {
      if (next) encode(next);
      else deletes.push(id);
      families.set(id, next ? familyKey(next) : this.familyOf(id));
    }
    for (const id of this.dirty) {
      const run = this.held.get(id);
      if (!run || staged.has(id)) continue;
      encode(run);
      families.set(id, familyKey(run));
    }
    for (const id of this.deleted) {
      if (staged.has(id)) continue;
      deletes.push(id);
      families.set(id, this.familyOf(id));
    }
    // A row's insertion order (`seq`) is the order this write inserts it in, and it is where the
    // run lists among runs created in the same millisecond. Insert new runs in creation order (the
    // held set's, then staged runs not held yet), whether staged or dirty brought them here.
    if (upserts.filter((row) => !this.base.has(row.id)).length > 1) {
      const created = new Map<string, number>();
      for (const id of [...this.held.keys(), ...staged.keys()]) if (!created.has(id)) created.set(id, created.size);
      upserts.sort((a, b) => created.get(a.id)! - created.get(b.id)!);
    }
    // A held run whose write moved it into a new family (a worker quarantined to `invalid`) takes
    // that family's claim first; one it cannot take fails the fence below as claim-lost.
    const moved = [...new Set(families.values())].filter((family) => !this.claimed.has(family) && !this.pendingClaims.has(family));
    if (moved.length > 0) this.claims.claimFamilies(moved, { allowLive: true });
    let commit: RunDatabaseCommit;
    try {
      commit = this.writeIndex({ upserts, deletes, ...(this.owner ? { fence: this.fence(families) } : {}) });
    } catch (error) {
      if (error instanceof RunConflictError) this.handleConflicts(error, staged);
      throw error;
    }
    for (const [family, generation] of commit.claims) {
      this.claimed.set(family, generation);
      this.pendingClaims.delete(family);
    }
    for (const row of upserts) {
      this.base.set(row.id, { revision: commit.revisions.get(row.id)!, seq: commit.seqs.get(row.id)!, data: row.data, extras: extras.get(row.id) });
    }
    for (const id of deletes) {
      this.liveItems.forget(id);
      this.base.delete(id);
      this.deletedFamilies.delete(id);
      this.retention.removeOwedHistory(id);
    }
    this.dirty.clear();
    this.deleted.clear();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  /** What a write of these rows (id → family) must still find: this store's claims, at the
   *  generations it took them, and each row at the revision it last saw (none for a new row). */
  private fence(families: ReadonlyMap<string, string>): RunWriteFence {
    const claims = new Map<string, RunFenceClaim>();
    const rows = new Map<string, { revision: number | null; family: string }>();
    for (const [id, family] of families) {
      const pending = this.pendingClaims.get(family);
      // Generations start at 1, so an unclaimed family's 0 fails the fence as claim-lost.
      claims.set(family, pending !== undefined ? { take: pending } : { generation: this.claimed.get(family) ?? 0 });
      rows.set(id, { revision: (this.base.get(id) ?? this.coldBase.get(id))?.revision ?? null, family });
    }
    return { owner: this.owner!, claims, rows };
  }

  /**
   * Handle a fenced-write conflict. Save unexpected conflict evidence before clearing pending
   * state or quarantining the row. If evidence persistence fails, retain pending writes. Other
   * rows remain writable; stale unclaimed reads only fail their write.
   */
  private handleConflicts(error: RunConflictError, staged: ReadonlyMap<string, RunRecord | null>): void {
    const unexpected = error.conflicts.filter((conflict) =>
      this.held.has(conflict.id) || this.deleted.has(conflict.id) || this.coldBase.get(conflict.id)?.owned === true);
    if (unexpected.length === 0 || !this.db || !this.owner) return;
    const evidence: RunConflictEvidence[] = unexpected.map((conflict) => {
      const seen = this.base.get(conflict.id) ?? this.coldBase.get(conflict.id);
      const local = staged.has(conflict.id) ? staged.get(conflict.id)! : this.deleted.has(conflict.id) ? null : this.held.get(conflict.id) ?? null;
      return {
        runId: conflict.id, reason: conflict.reason,
        baseRevision: seen?.revision ?? null, baseData: seen?.data ?? null,
        localData: local === null ? null : JSON.stringify(local), localDeleted: local === null,
        currentRevision: conflict.current?.revision ?? null, currentData: conflict.current?.data ?? null,
      };
    });
    let seqs: number[];
    try {
      seqs = this.db.recordConflicts(this.owner.session, evidence);
    } catch (evidenceError) {
      const message = evidenceError instanceof Error ? evidenceError.message : String(evidenceError);
      console.error(`[hsq] ${RUNS_DB_FILE}: could not record the conflicting write on ${unexpected.map((c) => c.id).join(', ')}; it stays pending: ${message}`);
      return;
    }
    unexpected.forEach((conflict, index) => {
      const family = this.familyOf(conflict.id);
      this.liveItems.forget(conflict.id);
      this.quarantined.add(conflict.id);
      this.coldReads.forget(conflict.id);
      this.dirty.delete(conflict.id);
      this.deleted.delete(conflict.id);
      this.deletedFamilies.delete(conflict.id);
      // The delete did not happen, so the history stays with the row.
      this.historyOwed.delete(conflict.id);
      if (conflict.reason === 'claim-lost') {
        this.claimed.delete(family);
        this.pendingClaims.delete(family);
      }
      const decoded = conflict.current ? decodeRunRow(conflict.current.data) : undefined;
      const current = decoded?.run;
      if (this.claims.isFallbackRun(conflict.id)) this.held.delete(conflict.id);
      const held = this.held.get(conflict.id);
      const before = snapshotRun(held ?? staged.get(conflict.id) ?? undefined);
      if (current && conflict.current) {
        // The other writer's record as it stands, normalized only as a live owner's run would be.
        reconcileLoadedRun(current, { keepLive: true });
        rescopeRun(current, this.repoHandle);
        if (held) replaceRecord(held, current);
        this.base.set(conflict.id, { revision: conflict.current.revision, seq: conflict.current.seq, data: conflict.current.data, extras: decoded!.extras });
        publishRunWrite(this.published, held ?? current, before ?? snapshotRun(current), 'conflict');
      } else {
        this.held.delete(conflict.id);
        this.base.delete(conflict.id);
        this.published.publish('run.deleted', { runId: conflict.id });
      }
      console.error(`[hsq] run ${conflict.id} was changed by another writer (${conflict.reason}); this process will not write it again until Squawk restarts. Evidence: ${join(this.dataDir, RUNS_DB_FILE)}, table run_conflicts, seq ${seqs[index]}.`);
    });
    this.scheduleSave();
  }

  /** Write what is pending, then (unless closing) let every run whose write settled leave memory. */
  private saveNow(evict = true): void {
    if (!this.db || projectWriteRefused(this.dataDir)) return;
    // A second attempt only after a conflict excluded its rows: the unrelated rest goes out at once.
    for (let attempt = 0; attempt < 2 && (this.dirty.size > 0 || this.deleted.size > 0); attempt++) {
      const quarantined = this.quarantined.size;
      try {
        this.persist(new Map());
      } catch (err) {
        if (err instanceof RunConflictError && this.quarantined.size > quarantined) continue;
        // A pending save may outlive its directory; never recreate it or hide live-directory
        // failures. The rows stay pending (and held), so the next save or commit retries them.
        if (existsSync(this.dataDir)) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[hsq] failed to save ${RUNS_DB_FILE}: ${message}`);
        }
        break;
      }
    }
    if (evict) this.evictSettled();
  }

  /**
   * Write what is pending and release the database (store disposal, process shutdown).
   * Idempotent. A closed store keeps answering reads for what it holds — the final save evicts
   * nothing — but cannot read `runs.db` any more, so a run that had already left memory reads as
   * absent. It saves nothing more, and a durable commit on it throws.
   */
  close(): void {
    this.liveItems.clear();
    // Demand-bound feeds stop before storage disappears during project removal/shutdown.
    this.published.publish('store.closed', {});
    this.archive.compressor.stop();
    this.transcriptFacts.stop();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveNow(false);
    if (this.db && this.owner) {
      // Every claim goes with the store. Should the release fail, the claims stay until this
      // process exits; from then on they are provably dead and the next opener takes them.
      try { this.db.releaseClaims(this.owner.session); } catch { /* see above */ }
    }
    this.claimed.clear();
    this.pendingClaims.clear();
    if (this.owner) closeClaimSession(this.owner.session);
    this.db?.close();
    this.db = null;
  }
}

