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
import type { ArchivedRunsResponse, ArchiveFinishedScope, ArchivePullRequestIdentity, MergedPullRequest, RunSummary, WorkerCollectedResult } from '@open-mercato/cezar-contract';
import type { AutomationNames } from '@open-mercato/cezar-contract/run-search';
import type { RepoHandle, RunEvent, RunRecord, RunStore } from './store.ts';
import type { BranchOwner } from './branch-owners.ts';
import type { PeerTaskPageOptions } from './run-summary-page.ts';
import type { ArchiveOnMergeSnapshot } from './run-archive.ts';
import type { RunOwnership } from './run-claims-topic.ts';
import type { RunPinHolder } from './run-pins.ts';
import type { RunDatabase } from './run-database.ts';
import type { RunStoreOpenError } from './store-open-error.ts';
import type { TranscriptFacts } from './transcript-facts.ts';
import type { WorkerExecution } from './worker-execution.ts';
import type { WorkerProcessRecord } from '../core/process-stat.ts';
import type { AgentRunSpec } from '../core/agent-runner.ts';

export type { RunLifecycleSource } from './lifecycle.ts';

/** One run's record, by id. Nearly every caller needs only this. */
export interface RunLookup {
  getRun: RunStore['getRun'];
}

/** A run's record, and whether a row exists whose record cannot be read. */
export interface RunReads extends RunLookup {
  isUnreadable: RunStore['isUnreadable'];
}

/** Lists and finds over many runs (`runs/run-queries.ts`, `store.queries`). */
export interface RunQueries {
  /** Revision-verified completed destroys; only used for receipts with complete cleanup. */
  verifiedWorkerReleases(): { skip(id: string): boolean; flush(): void };
  listRuns(): RunRecord[];
  listAllRunsForLegacyRoute(): RunRecord[];
  listPeerTaskSummaries(options: PeerTaskPageOptions): { runs: RunSummary[]; nextOffset?: number };
  listRunSummaries(options?: { archivedWindow?: number | undefined; roots?: boolean }): { runs: RunSummary[]; truncated: boolean };
  listArchivedRuns(options: { before?: string; limit: number; q?: string; automationNames?: AutomationNames }): ArchivedRunsResponse | { error: string };
  searchRunSummaries(query: string, limit: number): { runs: RunSummary[]; truncated: boolean };
  heldIds(): string[];
  listWorkerIds(): string[];
  listQuarantinedRunIds(): string[];
  countAutomationRuns(automationId: string): number;
  findNonArchivedRunByIssue(repo: string, number: number): string | undefined;
  findRunIdsByAutomationReceipt(receiptIds: readonly string[]): Map<string, string>;
  listConversationRootIds(naming?: string): string[];
  listRunIds(): string[];
  listRunsWithWorktree(): RunRecord[];
  listBranchOwners(): BranchOwner[];
  findRunByClientRequestId(clientRequestId: string): RunRecord | undefined;
  listFamilyRunIds(rootId: string): string[];
  withReadCache<T>(fn: () => T): T;
}

/** The workers of one run (`runs/run-queries.ts`, `store.queries`). */
export interface RunFamilyReads {
  listWorkersOf(parentId: string): RunRecord[];
  listOwnedWorkers(parentId: string): RunRecord[];
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

/** One run's event log (`runs/event-log.ts`, `store.eventLog`). */
export interface RunEventLog {
  appendEvent(runId: string, event: { type: string; stepId?: string | undefined; [key: string]: unknown }): RunEvent;
  emitEphemeral(runId: string, event: { type: string; stepId?: string; [key: string]: unknown }): RunEvent;
  readEvents(runId: string): RunEvent[];
  readEventsAsync(runId: string): Promise<RunEvent[]>;
  hasProjection(runId: string, projectionId: string): boolean;
}

/** The reference markers an agent declares and the PR a run created (`runs/event-log.ts`, `store.eventLog`). */
export interface RunMarkerRefs {
  applyMarkerRefs(runId: string, refs: { pr?: number | undefined; prs?: readonly number[] | undefined; issue?: number | undefined }): RunRecord | undefined;
  recordCreatedPr(runId: string, url: string): RunRecord | undefined;
}

/** The scrub of events and free text before they are written or sent (`runs/run-redaction.ts`, `store.redaction`). */
export interface RunRedaction {
  redactText(text: string): string;
  registerSessionSecret(value: string): void;
  containsSessionSecret(value: string): boolean;
}

/** What the transcript says about a run. The type `TranscriptFacts` is the facts themselves. */
export interface TranscriptFactsPort {
  transcriptFacts(runId: string): Readonly<TranscriptFacts>;
  knownTranscriptFacts(runId: string): Readonly<TranscriptFacts> | undefined;
  prepareTranscriptFacts(runIds: Iterable<string>): Promise<void>;
  prepareRecoveryFacts(familyRootId?: string): Promise<void>;
  factsWarmIdle(): Promise<void>;
}

/** A worker's collected result (`runs/worker-results.ts`, `store.workerResults`). */
export interface WorkerResults {
  readWorkerResult(parentId: string, workerId: string): WorkerCollectedResult | undefined;
  readWorkerResultDiff(parentId: string, workerId: string): string | undefined;
  readDeletedWorkerResult(parentId: string, workerId: string): WorkerCollectedResult | undefined;
  workerResultSnapshotPath(parentId: string, workerId: string, snapshotId: string): string;
  commitWorkerResult(parentId: string, value: WorkerCollectedResult, diffSnapshot?: string, opts?: { ignoreCleanup?: boolean }): WorkerCollectedResult;
}

/** The processes of a worker's scope that a core caller stops (`workflows/run/worker-orphans.ts`). */
export interface WorkerScopeControl {
  empty(workerId: string): boolean;
  stopped(workerId: string): boolean;
  kill(workerId: string): void;
}

/** A worker's execution, scope and processes (`delegation/worker-executions.ts`, `store.workerExecutions`). */
export interface WorkerExecutions {
  readWorkerExecution(id: string): WorkerExecution | undefined;
  workerResourcesSafe(id: string, generation: string, resourceId: string): boolean;
  workerResourceHolders(id: string, generation: string, resourceId: string, opts?: { admittingQueued?: boolean }): 'safe' | number[];
  retainWorkerScratchCleanup(id: string): void;
  workerScratchResourcesSafe(id: string, generation: string, resourceId: string): boolean;
  commitWorkerExecutionStart(id: string): string;
  readWorkerProcesses(id: string, generation: string): WorkerProcessRecord | 'absent' | 'unknown';
  spawnScope(id: string): AgentRunSpec['scope'];
  appendWorkerProcess(id: string, generation: string, pid: number, pgid?: number): boolean;
  commitWorkerExecutionComplete(id: string, generation: string, opts?: { interrupted?: boolean }): boolean;
  readonly scopes: WorkerScopeControl;
}

/** The worker records the store's own paths write, check and remove: owned-run creation, the
 *  archive checks and the delegated deletion. */
export interface WorkerExecutionRecords {
  /** `identity` is checked against the worker identity schema before it is written. */
  writeWorkerIdentity(id: string, identity: unknown): void;
  /** Atomically update an existing worker identity (same-runner model/effort override). */
  updateWorkerIdentity(id: string, identity: unknown): void;
  writeWorkerExecution(id: string, proof: WorkerExecution, fresh?: boolean): void;
  /** A deleted child's receipt replaces the private proof only after the deletion checkpoint. */
  workerDeletionEvidence(id: string): boolean;
  identityPath(id: string, write?: boolean): string;
  executionPath(id: string, write?: boolean): string;
  processesPath(id: string, write?: boolean): string;
  scopePath(id: string, write?: boolean): string;
}

/** Whether a run may go, and its deletion (`runs/run-retention.ts`, `store.retention`). */
export interface RunRetention {
  canDeleteRun(id: string, kind?: 'record' | 'worktree'): boolean;
  deleteRun(id: string): boolean;
  fallbackDeleteError(id: string, kind?: 'record' | 'worktree'): string | undefined;
}

/** The archive flag, archive on merge and the compression of archived history (`runs/run-archive.ts`, `store.archive`). */
export interface RunArchive {
  setArchived(id: string, archived: boolean): RunRecord | undefined;
  archiveFinished(scope?: ArchiveFinishedScope, automation?: boolean): { archived: number; ids: string[]; pinnedIds: string[] };
  archiveOnMergeSnapshot(id: string, repoBase?: string, isActive?: (id: string) => boolean): ArchiveOnMergeSnapshot | undefined;
  archiveAfterMerge(snapshot: ArchiveOnMergeSnapshot, observations: readonly MergedPullRequest[], repoBase?: string, isActive?: (id: string) => boolean): boolean;
  archiveMergeBlocker(snapshot: ArchiveOnMergeSnapshot, missing: ArchivePullRequestIdentity, repoBase?: string): void;
  setArchiveBlocker(id: string, blocker: RunRecord['archiveBlocker']): void;
  hasArchiveOnMergeAssociations(id: string): boolean;
  prepareArchiveOnMerge(id: string): Promise<void>;
  listArchiveOnMergeCandidates(afterSeq?: number, limit?: number): Array<{ id: string; seq: number }>;
  compressArchivedHistory(): void;
  historyIdle(): Promise<void>;
}

/** The completion action a finished task waits on (`runs/run-archive.ts`, `store.archive`). */
export interface RunCompletionActions {
  listCompletionCandidates(afterSeq?: number, limit?: number): Array<{ id: string; seq: number }>;
  canCompleteAction(id: string, token: string): boolean;
  claimCompletionAction(id: string, token: string): boolean;
  completeAction(id: string, token: string, phase: 'blocked' | 'complete', message?: string): boolean;
}

/** The user's pin and the read receipt (`runs/run-read-flags.ts`, `store.readFlags`). */
export interface RunReadFlags {
  setPinned(id: string, pinned: boolean): RunRecord | undefined;
  setRead(id: string): RunRecord | undefined;
  setUnread(id: string): RunRecord | undefined;
  markAllRead(automation?: boolean): number;
}

/** Whether this process may write a run, and where its files are (`runs/run-claims-topic.ts`, `store.claims`). */
export interface RunAccess {
  writeRefusal(id: string): string | undefined;
  sourceDataDir(id: string): string;
  isFallbackRun(id: string): boolean;
  hasFallbackRun(id: string): boolean;
  runOwnership(id: string): RunOwnership | undefined;
}

/** The adoption of a dead owner's or a fallback family, and the runs other processes claim (`runs/run-claims-topic.ts`, `store.claims`). */
export interface RunClaims {
  adoptFamily(id: string, opts?: { stop?: boolean }): string | undefined;
  adoptFallbackFamily(id: string): boolean;
  listForeignClaimedRunIds(): string[];
  persistedLiveRunIds(): { live: string[]; foreign: string[] };
}

/** The hold that keeps a run loaded while a process works on it, and a publish without a write (`runs/run-pins.ts`, `store.runPins`). Not in the spec's table: retention needs it. */
export interface RunPins {
  pin(id: string, holder: RunPinHolder): RunRecord | undefined;
  unpin(id: string, holder: RunPinHolder): void;
  republish(id: string): void;
}

/** The repository identity a store learns after it opens (`runs/run-repo-scope.ts`, `store.repoScope`). */
export interface RunRepoHandle {
  setRepoHandle(handle: RepoHandle | null): void;
}

/** Whether the store opened, and closing it. */
export interface StoreHandle {
  readonly unavailable: RunStore['unavailable'];
  close: RunStore['close'];
}

/** Writing the pending rows out now, and what the reports index reads the rows from (`runs/run-persistence.ts`, `store.persistence`). */
export interface RunPersistence {
  flush(): void;
  reportSource(): { db: RunDatabase | null; dataDir: string; openFailure: RunStoreOpenError | undefined };
}

/** A run's record patch, as `updateRun` takes it. */
export type RunPatchInput = Parameters<RunWrites['updateRun']>[1];
/** The input of `createRun`. */
export type CreateRunInput = Parameters<RunWrites['createRun']>[0];
/** An event as `appendEvent` takes it. */
export type RunEventInput = Parameters<RunEventLog['appendEvent']>[1];

/** What `projectLiveTasks` reads: the live task view of a project, over a store or over its files read-only. */
export interface LiveRunReads {
  readonly queries: Pick<RunQueries, 'listRuns'>;
  readonly claims: Pick<RunClaims, 'persistedLiveRunIds'>;
  getRun: RunStore['getRun'];
}
