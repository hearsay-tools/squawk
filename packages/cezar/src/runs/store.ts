import { legacyIndexRows, readableSavedRunner, upgradeLegacyRunRow, withKeptFields } from './legacy-run-rows.ts';
import { addRunSource, fallbackRunSource } from './project-run-sources.ts';
import { registeredWaitRecord, registeredReceiptRecord } from './wait-registration-write.ts';
import { stageDurableUpdate, stageDebouncedUpdate, stageConversation, stageStepUpdate, stepTotals, redactPatch, type RecordPatch } from './record-write-rules.ts';
import { RunLifecycle, snapshotRun, type RunLifecycleSource } from './lifecycle.ts';
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
  runRecordSchema as contractRunRecordSchema,
  runPullRequestSchema,
} from '@open-mercato/cezar-contract/runs';
import { queuedMessageSchema } from '@open-mercato/cezar-contract/queued-messages';
import { previewServerSchema } from '@open-mercato/cezar-contract/preview';
import { waitSchema, type WaitRegistrationReceipt } from '@open-mercato/cezar-contract/waits';
import { isUsageLimitHold } from '@open-mercato/cezar-contract/usage-limit-hold';
import type { ConversationState, AgentInput, InboxClaim, DelegationState, Wait, WorkerDestroyRetry } from '@open-mercato/cezar-contract';
import { storedDelegationStateSchema } from './delegation-state.ts';
import { LiveItemSnapshots } from './live-item-snapshots.ts';
import { RunTranscriptFacts } from './transcript-facts-topic.ts';
import { restoreHistory } from './history-file.ts';
// Type-only module (zod + nothing else), so this cannot cycle back into the store.
import { workflowDefSchema } from '../workflows/types.ts';
import { applyOutcomes, type OutcomeDependencies, type OutcomeReceipt, type RunOutcome } from './outcome-commit.ts';
import { trackReferencedIssues, trackReferencedPrs } from './run-references.ts';
import { applyExit, doneCommits, exitDurability, RUN_EXITS, type ExitCall, type ExitDurability, type RunExitId, type RunExitSpec, type RunPatch } from './run-exits.ts';
import { assertConversationIdFree, type ConversationIdentity } from './conversation-identity.ts';
export { ConversationIdInUseError } from './conversation-identity.ts';

import { LEGACY_RUNNER_IDS } from '../core/runner-ids.ts';
import {
  RUNS_DB_FILE, RUNS_IMPORT_COMPLETE_KEY, RunDatabase, RunDatabaseBusyError,
} from './run-database.ts';
import { hasLegacyWaitFields, UNREADABLE_WAIT } from './legacy-waits.ts';
export { ciWaitEntry, holdsWorkerWait, upgradeLegacyWaits, workerWaitEntry } from './legacy-waits.ts';
import { ExitEvents } from './exit-events.ts';
import { RunRetentionTopic } from './run-retention.ts';
import { collectRawExtras, type RawExtras } from './raw-record.ts';
import type { StoredRow } from './cold-reads.ts';
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
import { replaceRecord, RunPersistenceTopic, type RunStorePersistence } from './run-persistence.ts';
import { closeClaimSession, openClaimSession, type ClaimOwner } from './run-claims.ts';
import { RunColdReadsTopic } from './run-cold-reads.ts';
import { RunQueriesTopic, sortNewestFirst } from './run-queries.ts';
import { RunRepoScopeTopic } from './run-repo-scope.ts';

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
  /** `null` once the store is closed, and in a `RunStore.unavailable` store (nothing is written,
   *  nothing is evicted). */
  private db: RunDatabase | null = null;
  /** Why `open` failed, in a `RunStore.unavailable` store. */
  private openFailure: RunStoreOpenError | undefined;
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
  /** Rows a conflicting write excluded: this store refuses to write them until it is reopened. */
  private readonly quarantined = new Set<string>();
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
  /** Flush, persist, the fence, conflicts and the save debounce (hearsay-tools/squawk#4043). */
  readonly persistence: RunPersistenceTopic;
  /** The held set's cold reads, holds and eviction (hearsay-tools/squawk#4044). */
  private readonly rows: RunColdReadsTopic;
  /** The list and find queries (hearsay-tools/squawk#4044). */
  readonly queries: RunQueriesTopic;
  /** The repository this project is, and the repair of the runs it rescopes (hearsay-tools/squawk#4044). */
  readonly repoScope: RunRepoScopeTopic;
  private executions: (WorkerExecutions & WorkerExecutionRecords) | undefined;
  /** A worker's execution, process, identity and scope records (hearsay-tools/squawk#4039), built on
   *  first use by the factory this process registered; throws when none is registered. */
  get workerExecutions(): WorkerExecutions & WorkerExecutionRecords {
    return this.executions ??= workerExecutionsFactory()(this.dataDir, {
      peek: (id) => this.rows.peek(id), getRun: (id) => this.getRun(id), writeDir: (id) => this.claims.writeDir(id),
      sourceDataDir: (id) => this.claims.sourceDataDir(id), commitIndex: (input) => this.persistence.commitIndex(input),
      published: this.published, workerResults: this.workerResults,
    });
  }
  private readonly liveItems = new LiveItemSnapshots();

  /** Capture both sources on the same synchronous sequence boundary before history IO. */
  liveReadSnapshot(runId: string) {
    return { events: this.liveItems.read(runId), throughSeq: this.seqs.get(runId) ?? Infinity };
  }

  private constructor(private readonly dataDir: string, persist?: RunStorePersistence) {
    this.rows = new RunColdReadsTopic({
      db: () => this.db, keepLive: () => this.keepLive, repoHandle: () => this.repoScope.repoHandle, held: this.held, pins: this.pins,
      committing: this.committing, dirty: this.dirty, deleted: this.deleted, quarantined: this.quarantined, claimed: this.claimed,
      pendingClaims: this.pendingClaims, base: this.base, claims: () => this.claims, persistence: () => this.persistence, decodeRunRow,
    });
    this.redaction = new RunRedaction();
    this.claims = new RunClaimsTopic(dataDir, {
      db: () => this.db, owner: () => this.owner, keepLive: () => this.keepLive, held: this.held, base: this.base, dirty: this.dirty,
      deleted: this.deleted, quarantined: this.quarantined, unreadable: this.rows.unreadable, claimed: this.claimed, pendingClaims: this.pendingClaims,
      exitEvents: this.exitEvents, coldReads: this.rows.coldReads, decodeRunRow, anchoredFamilies: () => this.rows.anchoredFamilies(), scheduleSave: () => this.persistence.scheduleSave(),
    });
    this.runPins = new RunPinsTopic({ pins: this.pins, published: this.published, record: (id) => this.rows.record(id), peek: (id) => this.rows.peek(id), sweepIfSettled: (ids) => this.persistence.sweepIfSettled(ids) });
    this.transcriptFacts = new RunTranscriptFacts(dataDir, {
      isFallbackRun: (id) => this.claims.isFallbackRun(id),
      sourceDataDir: (id) => this.claims.sourceDataDir(id),
      isOpen: () => this.db !== null,
      held: this.held,
      listFamilyRunIds: (rootId) => this.queries.listFamilyRunIds(rootId),
      listConversationRootIds: () => this.queries.listConversationRootIds(),
      listRunIds: () => this.queries.listRunIds(),
    });
    this.workerResults = new WorkerResultsTopic(dataDir, {
      peek: (id) => this.rows.peek(id), hasRun: (id) => this.rows.hasRun(id), hasFallbackRun: (id) => this.claims.hasFallbackRun(id),
      writeDir: (id) => this.claims.writeDir(id), sourceDataDir: (id) => this.claims.sourceDataDir(id),
      redactResult: (result) => this.redaction.redact({ type: 'worker-result', seq: 0, ts: result.observedAt, result }).result,
      redactText: (text) => this.redaction.redactText(text), commitDelegation: (patches) => this.commitDelegation(patches),
    });
    this.eventLog = new RunEventLogTopic(dataDir, {
      seqs: this.seqs, published: this.published, liveItems: this.liveItems, transcriptFacts: this.transcriptFacts, redaction: this.redaction,
      record: (id) => this.rows.record(id), missingRunError: (runId) => this.claims.missingRunError(runId), sourceDataDir: (id) => this.claims.sourceDataDir(id),
      touch: (run, before) => this.persistence.touch(run, before), change: (id, apply) => this.change(id, apply), repoHandle: () => this.repoScope.repoHandle,
      maybeEnqueueHistoryCompress: (run) => this.archive.maybeEnqueueHistoryCompress(run),
    });
    this.retention = new RunRetentionTopic(dataDir, {
      db: () => this.db, held: this.held, deleted: this.deleted, quarantined: this.quarantined,
      historyOwed: this.historyOwed, seqs: this.seqs, published: this.published, transcriptFacts: this.transcriptFacts,
      peek: (id) => this.rows.peek(id), hasRun: (id) => this.rows.hasRun(id), record: (id) => this.rows.record(id),
      listWorkersOf: (parentId) => this.queries.listWorkersOf(parentId), isFallbackRun: (id) => this.claims.isFallbackRun(id),
      hasFallbackRun: (id) => this.claims.hasFallbackRun(id), listOrder: (run) => this.queries.listOrder(run),
      claimFamilies: (families) => this.claims.claimFamilies(families), markDeleted: (id, family) => this.persistence.markDeleted(id, family),
      scheduleSave: () => this.persistence.scheduleSave(), commitIndex: (input) => this.persistence.commitIndex(input),
      commitDelegation: (patches) => this.commitDelegation(patches), applyArchived: (run, archived) => this.archive.applyArchived(run, archived),
      workerDeletionEvidence: (id) => this.workerExecutions.workerDeletionEvidence(id),
      workerResults: this.workerResults,
      readWorkerExecution: (id) => this.workerExecutions.readWorkerExecution(id), identityPath: (id) => this.workerExecutions.identityPath(id),
      processesPath: (id) => this.workerExecutions.processesPath(id), scopePath: (id) => this.workerExecutions.scopePath(id),
      executionPath: (id) => this.workerExecutions.executionPath(id), sourceDataDir: (id) => this.claims.sourceDataDir(id),
    });
    this.archive = new RunArchiveTopic(dataDir, {
      db: () => this.db, held: this.held, deleted: this.deleted, quarantined: this.quarantined, pins: this.pins,
      claimed: this.claimed, base: this.base, owner: () => this.owner, transcriptFacts: this.transcriptFacts,
      decodeRunRow, sortNewestFirst, peek: (id) => this.rows.peek(id), record: (id) => this.rows.record(id),
      listWorkersOf: (parentId) => this.queries.listWorkersOf(parentId), familyOf: (id) => this.persistence.familyOf(id),
      claimFamilies: (families, opts) => this.claims.claimFamilies(families, opts), writeRefusal: (id) => this.claims.writeRefusal(id),
      assertWritable: (staged) => this.persistence.assertWritable(staged), decodeCold: (row) => this.rows.decodeCold(row),
      listOrder: (run) => this.queries.listOrder(run), commitIndex: (input, source, write) => this.persistence.commitIndex(input, source, write),
      touch: (run, before, exit) => this.persistence.touch(run, before, exit),
      readWorkerExecution: (id) => this.workerExecutions.readWorkerExecution(id),
    });
    this.readFlags = new RunReadFlagsTopic({
      db: () => this.db, held: this.held, deleted: this.deleted, record: (id) => this.rows.record(id),
      claimFamilies: (families) => this.claims.claimFamilies(families), touch: (run, before) => this.persistence.touch(run, before),
      change: (id, apply) => this.change(id, apply),
    });
    this.persistence = new RunPersistenceTopic(dataDir, persist, {
      db: () => this.db, owner: () => this.owner, openFailure: () => this.openFailure, repoHandle: () => this.repoScope.repoHandle,
      held: this.held, committing: this.committing, dirty: this.dirty, deleted: this.deleted, historyOwed: this.historyOwed,
      quarantined: this.quarantined, claimed: this.claimed, pendingClaims: this.pendingClaims, base: this.base, coldBase: this.rows.coldBase,
      coldReads: this.rows.coldReads, liveItems: this.liveItems, published: this.published, archive: this.archive, claims: this.claims,
      retention: this.retention, decodeRunRow, peek: (id) => this.rows.peek(id), isAnchor: (id, run) => this.rows.isAnchor(id, run),
      evictSettled: () => this.rows.evictSettled(),
    });
    this.queries = new RunQueriesTopic({ db: () => this.db, held: this.held, pins: this.pins, deleted: this.deleted, unreadable: this.rows.unreadable,
      base: this.base, coldReads: this.rows.coldReads, rows: this.rows, getRun: (id) => this.getRun(id) });
    this.repoScope = new RunRepoScopeTopic({ db: () => this.db, held: this.held, deleted: this.deleted, claims: this.claims, persistence: this.persistence, rows: this.rows });
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
    const store = new RunStore(dataDir, persist);
    store.keepLive = keepLive;
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
   * The run, or undefined. A held run is the held object (writes install into it). Any other run
   * is a fresh copy of its row each call, normalized like a loaded record — frozen under vitest —
   * so changing it means a store method, never an assignment.
   */
  getRun(id: string): RunRecord | undefined {
    const held = this.held.get(id);
    if (held) return held;
    const cached = this.deleted.has(id) || !this.db ? undefined : this.rows.coldReads.at(id, this.db.revisionOf(id));
    if (cached) return cached;
    const run = this.rows.loadCold(id);
    return run && this.rows.coldReads.keep(this.rows.answerCold(run, true), this.rows.coldBase.get(id), this.held.has(id));
  }

  /** Whether the run's row is in `runs.db` but its record could not be read here: what tells a
   *  run that cannot open from one that does not exist. Known once something tried to read it. */
  isUnreadable(id: string): boolean {
    return this.rows.unreadable.has(id) && !this.held.has(id) && !this.deleted.has(id);
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
    this.persistence.touch(run, undefined);
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
    trackReferencedPrs(run, input.task, this.repoScope.repoHandle);
    trackReferencedIssues(run, input.task, this.repoScope.repoHandle);
    return run;
  }

  /** Accept the family ledger and its recipient queue in a single durable index replacement. A new
   *  message (`message`, or the delivered input) whose ID is in use writes nothing; `recipientDelegation`
   *  makes a peer recipient with no delegation record a root task in the same write. */
  commitConversation(rootId: string, conversation: ConversationState, delivery?: { recipientRunId: string; input: AgentInput; recipientDelegation?: DelegationState },
    message?: ConversationIdentity): void {
    const root = this.rows.peek(rootId);
    if (root?.delegation?.role !== 'root') throw new Error('missing conversation root');
    assertConversationIdFree(root, message ?? delivery?.input, id => this.rows.peek(id), (runId, id) => this.eventLog.hasProjection(runId, id));
    const staged = new Map<string, RunRecord>();
    stageConversation(staged, root, conversation, delivery, id => this.rows.peek(id), text => this.redaction.redactText(text));
    this.persistence.commitIndex(staged);
  }

  /** Crash recovery (#505): input a harness accepted but was never seen reading goes
   * back to the queue. Returns the requeued IDs. */
  requeueAwaitingReadInputs(id: string): string[] {
    const ids = (this.rows.peek(id)?.agentInputs ?? []).filter(input => input.awaitingRead && input.deliveredAt && !input.consumedAt).map(input => input.id);
    if (ids.length) this.commitOutcome(id, { kind: 'requeued', inputIds: ids });
    return ids;
  }

  /** Delivered, but the harness never confirmed reading it (#505): stop awaiting a read. */
  commitAgentInputsUnconfirmed(id: string, ids: readonly string[]): void {
    const run = this.rows.peek(id);
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
    const run = this.rows.peek(id);
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
    this.persistence.commitIndex(new Map([[id, { ...run, agentInputs }]]));
  }

  /** Reserve only unread conversation inputs in one durable index replacement. */
  claimInboxInputs(runId: string, ids: readonly string[], claim: InboxClaim): void {
    const run = this.rows.peek(runId);
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
    this.persistence.commitIndex(new Map([[runId, { ...run, agentInputs: inputs.map(input => selectedIds.has(input.id)
      ? agentInputSchema.parse({ ...input, inboxClaim: receipt }) : input) }]]));
  }

  /** A receipt owns every matching input or none; exact ACK retries preserve the first timestamp. */
  ackInboxInputs(runId: string, receiptId: string, generation: string, at: string): 'acknowledged' | 'already-acknowledged' {
    const run = this.rows.peek(runId);
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
    const run = this.rows.peek(runId);
    if (!run) throw new Error('missing inbox recipient');
    inboxClaimSchema.shape.receiptId.parse(receiptId);
    inboxClaimSchema.shape.generation.parse(generation);
    const matching = (run.agentInputs ?? []).filter(input => input.inboxClaim?.receiptId === receiptId);
    if (!matching.length || matching.some(input => input.inboxClaim?.generation !== generation ||
      input.inboxClaim?.acknowledgedAt || input.deliveredAt)) throw new Error('inbox receipt changed');
    this.persistence.commitIndex(new Map([[runId, { ...run, agentInputs: run.agentInputs!.map(input => {
      if (input.inboxClaim?.receiptId !== receiptId) return input;
      const { inboxClaim: _claim, ...unclaimed } = input;
      return agentInputSchema.parse(unclaimed);
    }) }]]));
    return 'released';
  }

  clearExpiredInboxClaims(runId: string, now: string): void {
    const run = this.rows.peek(runId);
    if (!run) throw new Error('missing inbox recipient');
    inboxClaimSchema.shape.expiresAt.parse(now);
    if (!run.agentInputs?.some(input => input.inboxClaim && !input.inboxClaim.acknowledgedAt && input.inboxClaim.expiresAt <= now)) return;
    this.persistence.commitIndex(new Map([[runId, { ...run, agentInputs: run.agentInputs.map(input => {
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
    const run = this.rows.peek(id);
    if (!run) throw new Error('missing wait target');
    this.persistence.commitIndex(new Map([[id, registeredWaitRecord(run, wait, input, registration)]]));
  }

  /** Record a deduplicated registration without mutating its wait. */
  commitWaitRegistration(id: string, receipt: WaitRegistrationReceipt): void {
    const run = this.rows.peek(id);
    if (!run) throw new Error('missing wait target');
    this.persistence.commitIndex(new Map([[id, registeredReceiptRecord(run, receipt)]]));
  }

  /** A usage-limit appointment withdrawn, committed at once instead of on the debounced save
   *  (hearsay-tools/cezarion#1236): a crash right after the withdrawal must not find it on disk,
   *  or recovery re-arms work the user cancelled. A run held for its resume settles `failed` by
   *  the `withdraw-hold` exit; any other run only loses its resume fields. */
  commitAutoResumeWithdrawal(id: string): void {
    const run = this.rows.peek(id);
    if (!run || (run.autoResumeAt === undefined && run.autoResumeAttempts === undefined)) return;
    if (isUsageLimitHold(run)) this.move(id, 'withdraw-hold');
    else this.persistence.commitIndex(new Map([[id, { ...run, autoResumeAt: undefined, autoResumeAttempts: undefined, autoResumeReason: undefined }]]));
  }

  /** A human message beside a run's waits (hearsay-tools/cezarion#1235): accepted durably, and
   *  every wait stays. A lifecycle opening becomes
   *  the human's and keeps its wake text, so the message opens the continuation (and answers a
   *  pending question) and the owed results still reach the agent. */
  commitHumanMessageBesideWaits(id: string, acceptedHumanMessage: QueuedMessage): void {
    const run = this.rows.peek(id);
    if (!run) throw new Error('missing queued message target');
    this.persistence.commitIndex(new Map([[id, { ...run, queuedMessages: [...(run.queuedMessages ?? []), queuedMessageSchema.parse(acceptedHumanMessage)],
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
    const run = this.rows.peek(id);
    if (!run) return { committed: false, answered: [], settled: [] };
    const staged = applyOutcomes(run, Array.isArray(outcomes) ? outcomes : [outcomes as RunOutcome], deps);
    if (!staged.changed) return { committed: false, answered: [], settled: [] };
    try { this.persistence.commitIndex(new Map([[id, staged.next]]), undefined, { exits: new Map([[id, staged.exit]]) }); }
    catch (error) {
      if (!opts.bestEffort) throw error;
      console.warn(`[hsq] outcome checkpoint failed: ${error instanceof Error ? error.message : String(error)}`);
      const live = this.rows.record(id);
      if (!live) return { committed: false, answered: staged.answered, settled: staged.settled };
      const before = snapshotRun(live);
      replaceRecord(live, staged.next);
      this.persistence.touch(live, before, staged.exit);
      return { committed: false, answered: staged.answered, settled: staged.settled };
    }
    return { committed: true, answered: staged.answered, settled: staged.settled };
  }

  /** An acknowledged inactive-root Finish must survive the async diff and restart. */
  commitRootFinishIntent(id: string): void {
    const run = this.rows.peek(id);
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
      const run = this.rows.peek(patch.id);
      if (!run || staged.has(patch.id)) throw new Error('missing or duplicate delegation patch target');
      const delegation = delegationStateSchema.parse(patch.delegation);
      if (!isDestroyProgress(run.delegation, delegation)) destroyProgress = false;
      staged.set(patch.id, { ...run, delegation });
    }
    // In-process cause only: consumers can skip metadata replay when delegation
    // is disabled without dropping real status or termination-proof notifications.
    this.persistence.commitIndex(staged, destroyProgress ? 'delegation-destroy-progress' : 'delegation-checkpoint');
  }

  /** A pending destroy's automatic retry state, or its removal (hearsay-tools/cezarion#879). Kept on
   * the record beside the strict delegation, so an older Squawk strips it rather than quarantining the
   * worker. Destroy progress: nothing the family reconcile reads changes. */
  commitDestroyRetry(id: string, retry: WorkerDestroyRetry | undefined): void {
    const run = this.rows.peek(id);
    if (run?.delegation?.role !== 'worker' || !run.delegation.destroy) throw new Error('missing pending destroy');
    if (!retry && !run.destroyRetry) return;
    // An explicit `undefined`, not an omitted key: commitIndex assigns onto the live record.
    this.persistence.commitIndex(new Map([[id, { ...run, destroyRetry: retry ? workerDestroyRetrySchema.parse(retry) : undefined }]]), 'delegation-destroy-progress');
  }

  /** Accepted execution revision is public lifecycle identity, separate from process generations. */
  commitWorkerContinuation(id: string, exit: RunExitId, patch: Omit<RunPatch, 'delegation'> = {}, step?: Pick<StepState, 'id' | 'name' | 'kind' | 'synthetic' | 'continuesStepId'>,
    conversation?: { rootId: string; state: ConversationState; input: AgentInput }): void {
    const run = this.rows.peek(id);
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
      const root = this.rows.peek(conversation.rootId);
      if (root?.delegation?.role !== 'root' || run.delegation.parentRunId !== root.id) throw new Error('missing conversation ownership');
      stageConversation(staged, root, conversation.state, { recipientRunId: id, input: conversation.input },
        runId => this.rows.peek(runId), text => this.redaction.redactText(text));
    }
    this.persistence.commitIndex(staged, undefined, { exits: new Map([[id, exit]]) });
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
      peek: (id) => this.rows.peek(id),
      hasRun: (id) => this.rows.hasRun(id),
      held: this.held, deleted: this.deleted, db: this.db,
      buildRun: (ownedInput, id) => this.buildRun(ownedInput, id),
      writeWorkerIdentity: (id, identity) => this.workerExecutions.writeWorkerIdentity(id, identity),
      writeWorkerExecution: (id, proof, fresh) => this.workerExecutions.writeWorkerExecution(id, proof, fresh),
      commitIndex: (owned) => this.persistence.commitIndex(owned),
    }, input, parentId, requestId, worker, requestHash, spawnCapacityRefusal, executionIdentity);
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
    const run = guarded ? this.rows.peek(id) : this.rows.record(id);
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
      this.persistence.commitIndex(new Map([[id, { ...(spec.settle?.(input, { ...call, now: new Date().toISOString() }) ?? input), ...applyExit(run, exit, {}, call) }]]), undefined, { exits: new Map([[id, exit]]) });
      moved = this.rows.peek(id);
    }
    if (event) this.exitEvents.write(id, event);
    return moved;
  }

  /** A write that is not a run exit. It commits at once when it changes handoff records, a
   *  completion option or task access, else the next save writes it. A status in the patch, which only test
   *  fixtures still write, takes the exit's record rule (`doneCommits`). */
  updateRun(id: string, patch: RunPatch): RunRecord | undefined {
    const run = this.rows.record(id);
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
      repoHandle: this.repoScope.repoHandle,
      restore: () => restoreHistory(this.dataDir, id),
      archive: (record: RunRecord, archived: boolean) => this.archive.applyArchived(record, archived, before, exit),
      touch: (record: RunRecord) => this.persistence.touch(record, before, exit),
    };
    if (durability === 'committed') {
      const staged = stageDurableUpdate(run, patch, hooks, exit);
      this.persistence.commitIndex(new Map([[id, staged.run]]), undefined, { before: new Map([[id, before]]), exits: new Map([[id, staged.exit]]) });
      return this.rows.record(id);
    }
    stageDebouncedUpdate(run, patch, hooks);
    return run;
  }
  private redactPatch(patch: Partial<Omit<RunRecord, 'id' | 'steps'>>): Partial<Omit<RunRecord, 'id' | 'steps'>> {
    return redactPatch(patch, text => this.redaction.redactText(text));
  }

  /** Append a step to an existing run (used by "Continue" — spec 003). */
  addStep(runId: string, step: Pick<StepState, 'id' | 'name' | 'kind' | 'synthetic' | 'continuesStepId'>): void {
    const run = this.rows.record(runId);
    if (!run || run.steps.some((s) => s.id === step.id)) return;
    const before = snapshotRun(run);
    run.steps = [...run.steps, { ...step, status: 'pending', iterations: 0, tokensUsed: 0 }];
    this.persistence.touch(run, before);
  }
  updateStep(runId: string, stepId: string, patch: Partial<Omit<StepState, 'id'>>): void {
    const run = this.rows.record(runId);
    const step = run?.steps.find((s) => s.id === stepId);
    if (!run || !step) return;
    const before = snapshotRun(run), next = { ...step, ...stageStepUpdate(patch, text => this.redaction.redactText(text)) };
    // Replaced, never changed in place, so `before` keeps the steps as they were.
    run.steps = run.steps.map((candidate) => candidate === step ? next : candidate);
    Object.assign(run, stepTotals(run.steps));
    this.persistence.touch(run, before);
  }

  /** A debounced write of the held record `id`: `apply` changes it in place, then `touch` saves it. */
  private change(id: string, apply: (run: RunRecord) => void): RunRecord | undefined {
    const run = this.rows.record(id), before = snapshotRun(run);
    if (!run) return undefined;
    apply(run);
    this.persistence.touch(run, before);
    return run;
  }

  // ---- internals -----------------------------------------------------------

  private seqs = new Map<string, number>();

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
    this.persistence.closeSave();
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

