/**
 * The ports of the run store: what a caller may ask of a store, by topic. A caller takes the port
 * (or an intersection of ports) that holds what it calls, never a `Pick` of `RunStore`: the guard in
 * `runs/ports-guard.test.ts` refuses that in every non-test file. Each port is an interface whose
 * members are `RunStore`'s own method types, so a port never drifts from the store's signatures.
 *
 * Each topic leaves the class in its own slice (the D slices of
 * `.ai/specs/2026-11-21-run-lifecycle-and-store-ports.md`), and the port then points at the module
 * that implements it. A later slice may move a method between ports when its topic moves. The store stays the only writer of status and exit fields (ADR 0056).
 */
import type { EventEmitter } from 'node:events';
import type { RunStore } from './store.ts';

export type { RunLifecycleSource } from './lifecycle.ts';

/** One run's record, by id. Nearly every caller needs only this. */
export interface RunLookup {
  getRun: RunStore['getRun'];
}

/** A run's record, and whether a row exists whose record cannot be read. */
export interface RunReads extends RunLookup {
  isUnreadable: RunStore['isUnreadable'];
}

/** Lists and finds over many runs. */
export interface RunQueries {
  listRuns: RunStore['listRuns'];
  listAllRunsForLegacyRoute: RunStore['listAllRunsForLegacyRoute'];
  listPeerTaskSummaries: RunStore['listPeerTaskSummaries'];
  listRunSummaries: RunStore['listRunSummaries'];
  listArchivedRuns: RunStore['listArchivedRuns'];
  searchRunSummaries: RunStore['searchRunSummaries'];
  persistedLiveRunIds: RunStore['persistedLiveRunIds'];
  listForeignClaimedRunIds: RunStore['listForeignClaimedRunIds'];
  heldIds: RunStore['heldIds'];
  listWorkerIds: RunStore['listWorkerIds'];
  listQuarantinedRunIds: RunStore['listQuarantinedRunIds'];
  countAutomationRuns: RunStore['countAutomationRuns'];
  findNonArchivedRunByIssue: RunStore['findNonArchivedRunByIssue'];
  findRunIdsByAutomationReceipt: RunStore['findRunIdsByAutomationReceipt'];
  listConversationRootIds: RunStore['listConversationRootIds'];
  listRunIds: RunStore['listRunIds'];
  listRunsWithWorktree: RunStore['listRunsWithWorktree'];
  listBranchOwners: RunStore['listBranchOwners'];
  findRunByClientRequestId: RunStore['findRunByClientRequestId'];
  listFamilyRunIds: RunStore['listFamilyRunIds'];
  withReadCache: RunStore['withReadCache'];
}

/** The workers of one run. */
export interface RunFamilyReads {
  listWorkersOf: RunStore['listWorkersOf'];
  listOwnedWorkers: RunStore['listOwnedWorkers'];
}

/** Every write that creates a run or changes its record, step or outcome. */
export interface RunWrites {
  createRun: RunStore['createRun'];
  createOwnedRun: RunStore['createOwnedRun'];
  move: RunStore['move'];
  updateRun: RunStore['updateRun'];
  addStep: RunStore['addStep'];
  updateStep: RunStore['updateStep'];
  commitConversation: RunStore['commitConversation'];
  commitAgentInputsUnconfirmed: RunStore['commitAgentInputsUnconfirmed'];
  commitAgentInputs: RunStore['commitAgentInputs'];
  commitWait: RunStore['commitWait'];
  commitWaitRegistration: RunStore['commitWaitRegistration'];
  commitAutoResumeWithdrawal: RunStore['commitAutoResumeWithdrawal'];
  commitHumanMessageBesideWaits: RunStore['commitHumanMessageBesideWaits'];
  commitOutcome: RunStore['commitOutcome'];
  commitRootFinishIntent: RunStore['commitRootFinishIntent'];
  commitDelegation: RunStore['commitDelegation'];
  commitDestroyRetry: RunStore['commitDestroyRetry'];
  commitWorkerContinuation: RunStore['commitWorkerContinuation'];
}

/** One run's event log. */
export interface RunEventLog {
  appendEvent: RunStore['appendEvent'];
  emitEphemeral: RunStore['emitEphemeral'];
  readEvents: RunStore['readEvents'];
  readEventsAsync: RunStore['readEventsAsync'];
  hasProjection: RunStore['hasProjection'];
}

/** What the transcript says about a run. The type `TranscriptFacts` is the facts themselves. */
export interface TranscriptFactsPort {
  transcriptFacts: RunStore['transcriptFacts'];
  knownTranscriptFacts: RunStore['knownTranscriptFacts'];
  prepareTranscriptFacts: RunStore['prepareTranscriptFacts'];
  prepareRecoveryFacts: RunStore['prepareRecoveryFacts'];
  factsWarmIdle: RunStore['factsWarmIdle'];
}

/** A worker's collected result. */
export interface WorkerResults {
  readWorkerResult: RunStore['readWorkerResult'];
  readWorkerResultDiff: RunStore['readWorkerResultDiff'];
  readDeletedWorkerResult: RunStore['readDeletedWorkerResult'];
  workerResultSnapshotPath: RunStore['workerResultSnapshotPath'];
  commitWorkerResult: RunStore['commitWorkerResult'];
}

/** A worker's execution, scope and processes. */
export interface WorkerExecutions {
  readWorkerIdentity: RunStore['readWorkerIdentity'];
  readWorkerExecution: RunStore['readWorkerExecution'];
  workerResourcesSafe: RunStore['workerResourcesSafe'];
  workerResourceHolders: RunStore['workerResourceHolders'];
  retainWorkerScratchCleanup: RunStore['retainWorkerScratchCleanup'];
  workerScratchResourcesSafe: RunStore['workerScratchResourcesSafe'];
  commitWorkerExecutionStart: RunStore['commitWorkerExecutionStart'];
  readWorkerProcesses: RunStore['readWorkerProcesses'];
  readWorkerScope: RunStore['readWorkerScope'];
  writeWorkerScope: RunStore['writeWorkerScope'];
  spawnScope: RunStore['spawnScope'];
  appendWorkerProcess: RunStore['appendWorkerProcess'];
  commitWorkerExecutionComplete: RunStore['commitWorkerExecutionComplete'];
}

/** Deleting a run, and the archive methods. */
export interface RunRetention {
  canDeleteRun: RunStore['canDeleteRun'];
  deleteRun: RunStore['deleteRun'];
  fallbackDeleteError: RunStore['fallbackDeleteError'];
  setArchived: RunStore['setArchived'];
  archiveFinished: RunStore['archiveFinished'];
  archiveOnMergeSnapshot: RunStore['archiveOnMergeSnapshot'];
  archiveAfterMerge: RunStore['archiveAfterMerge'];
  archiveMergeBlocker: RunStore['archiveMergeBlocker'];
  setArchiveBlocker: RunStore['setArchiveBlocker'];
  hasArchiveOnMergeAssociations: RunStore['hasArchiveOnMergeAssociations'];
  prepareArchiveOnMerge: RunStore['prepareArchiveOnMerge'];
  listArchiveOnMergeCandidates: RunStore['listArchiveOnMergeCandidates'];
}

/** Whether this process may write a run, where its files are, and the redaction of its text. */
export interface RunAccess {
  writeRefusal: RunStore['writeRefusal'];
  readonly unavailable: RunStore['unavailable'];
  sourceDataDir: RunStore['sourceDataDir'];
  redactText: RunStore['redactText'];
  isFallbackRun: RunStore['isFallbackRun'];
}

/** The hold that keeps a run loaded while a process works on it. Not in the spec's table: retention needs it. */
export interface RunPins {
  pin: RunStore['pin'];
  unpin: RunStore['unpin'];
}

/**
 * The store's own `EventEmitter` surface. Transitional: the activity publisher still listens
 * through it, and slice B4 (hearsay-tools/squawk#4032) moves that listener to `RunLifecycleSource`
 * and deletes this port. The members are `EventEmitter`'s: the store's own `on` returns `this`, a
 * `RunStore`, which no other emitter is.
 */
export interface RunStoreEvents {
  on: EventEmitter['on'];
  off: EventEmitter['off'];
}

/** The repository identity a store learns after it opens. */
export interface RunRepoHandle {
  setRepoHandle: RunStore['setRepoHandle'];
}

/** Closing the store and writing it out. */
export interface StoreHandle {
  close: RunStore['close'];
  flush: RunStore['flush'];
}

/** A run's record patch, as `updateRun` takes it. */
export type RunPatchInput = Parameters<RunWrites['updateRun']>[1];
/** The input of `createRun`. */
export type CreateRunInput = Parameters<RunWrites['createRun']>[0];
/** An event as `appendEvent` takes it. */
export type RunEventInput = Parameters<RunEventLog['appendEvent']>[1];

/** What `projectLiveTasks` reads: the live task view of a project, over a store or over its files read-only. */
export interface LiveRunReads {
  listRuns: RunStore['listRuns'];
  persistedLiveRunIds: RunStore['persistedLiveRunIds'];
  getRun: RunStore['getRun'];
}
