/**
 * The archive topic of the run store (hearsay-tools/squawk#4041): the archive flag and its cascade
 * over a family, archive on merge, the completion actions that archive a finished task, and the
 * compression of archived transcripts. `RunStore` keeps one of these as `store.archive`; the
 * family collection it asks is `runs/archive-family.ts`. It owns the compressor, which it builds
 * after the transcript facts it adopts archives into.
 */
import type { ArchiveFinishedScope, ArchivePullRequestIdentity, MergedPullRequest, RunRecord } from '@open-mercato/cezar-contract';
import { automationIdOf, mergedPullRequestSchema } from '@open-mercato/cezar-contract/runs';
import { isSweepable, SWEEPABLE_RUN_RULE } from '@open-mercato/cezar-contract/run-predicates';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { archiveStoreFamily, type ArchiveFamilyState } from './archive-family.ts';
import { HistoryCompressor } from './history-compressor.ts';
import { hasPlainHistory, historyPaths, restoreHistory } from './history-file.ts';
import { snapshotRun } from './lifecycle.ts';
import type { RunArchive, RunCompletionActions } from './ports.ts';
import { archivePullRequests, pullRequestKey } from './pull-requests.ts';
import { stageArchiveFields } from './record-write-rules.ts';
import type { RunExitId } from './run-exits.ts';
import { familyKey, type ClaimOwner } from './run-claims.ts';
import type { RunDatabase, RunRow } from './run-database.ts';
import { isLiveStatus, type ListOrder } from './run-row.ts';
import { parseStoredSummary } from './run-summary-page.ts';
import { stampOf } from './transcript-facts.ts';
import type { RunTranscriptFacts } from './transcript-facts-topic.ts';
import type { WorkerExecution } from './worker-execution.ts';

export interface ArchiveOnMergeSnapshot {
  rootId: string;
  fingerprint: string;
  pullRequests: ArchivePullRequestIdentity[];
  token: string;
}
function archiveDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function archiveFields(run: RunRecord, archived: boolean, now: string): RunExitId | undefined {
  return stageArchiveFields(run, archived, now);
}

/** What the topic asks of the store; no import of `store.ts` values. */
export interface ArchiveState {
  /** The open database; null for an unavailable or closed store. */
  db(): RunDatabase | null;
  readonly held: Map<string, RunRecord>;
  readonly deleted: ReadonlySet<string>;
  readonly quarantined: ReadonlySet<string>;
  readonly pins: ReadonlyMap<string, unknown>;
  readonly claimed: ReadonlyMap<string, number>;
  readonly base: ReadonlyMap<string, { revision: number }>;
  /** Read at call time: `open` and `close` replace it. */
  owner(): ClaimOwner | undefined;
  readonly transcriptFacts: RunTranscriptFacts;
  readonly decodeRunRow: ArchiveFamilyState['decodeRunRow'];
  sortNewestFirst<T>(entries: Iterable<readonly [T, ListOrder]>): T[];
  peek(id: string): RunRecord | undefined;
  record(id: string): RunRecord | undefined;
  listWorkersOf(parentId: string): RunRecord[];
  familyOf(id: string): string;
  claimFamilies(families: Iterable<string>, opts?: { allowLive?: boolean; wait?: boolean }): Set<string>;
  writeRefusal(id: string): string | undefined;
  assertWritable(staged: ReadonlyMap<string, RunRecord | null>): void;
  decodeCold(row: RunRow): RunRecord | undefined;
  listOrder(run: RunRecord): ListOrder;
  commitIndex(input: ReadonlyMap<string, RunRecord | null>, source?: undefined, write?: { exits?: ReadonlyMap<string, RunExitId | undefined> }): void;
  touch(run: RunRecord, before: Readonly<RunRecord> | undefined, exit?: RunExitId): void;
  readWorkerExecution(id: string): WorkerExecution | undefined;
}

export class RunArchiveTopic implements RunArchive, RunCompletionActions {
  /** Background one-at-a-time compressor for archived transcripts (#818). */
  readonly compressor: HistoryCompressor;

  constructor(private readonly dataDir: string, private readonly state: ArchiveState) {
    this.compressor = new HistoryCompressor(dataDir, (id) => this.isHistoryCompressEligible(id),
      (id, plain, archive) => this.state.transcriptFacts.index.adoptArchive(id, plain, stampOf(archive)));
  }

  completionArchiveBlocker(root: RunRecord): string | undefined {
    const family = [root, ...this.state.listWorkersOf(root.id)];
    for (const run of family) {
      const facts = this.state.transcriptFacts.factsFor(run.id).peek(run.id);
      if (!facts || !['done', 'review', 'failed', 'cancelled'].includes(run.status) || run.waits?.some(wait => wait.phase === 'open') ||
        run.hasPendingPermission || facts.pendingAsk !== undefined)
        return 'Task or worker work still needs attention. Open the task or archive manually.';
      if (run.delegation?.role === 'invalid' || (run.delegation?.role === 'worker' && this.state.readWorkerExecution(run.id)?.phase !== 'complete'))
        return 'Worker execution has not settled. Open the worker or archive manually.';
    }
    return undefined;
  }

  /** One archive write for manual actions, merge observations, completion, and sweeps.
   * Archiving files history away; it never stops a process or removes a worktree. */
  stageArchive(staged: Map<string, RunRecord | null>, root: RunRecord, archived: boolean, exits?: Map<string, RunExitId | undefined>): void {
    const ids = root.delegation?.role === 'worker' ? [root.id] :
      [root.id, ...new Set([...(this.state.db()?.listIdsByParent(root.id) ?? []), ...this.state.listWorkersOf(root.id).map(run => run.id)])];
    const now = new Date().toISOString();
    for (const id of ids) {
      const member = staged.get(id) ?? this.state.peek(id);
      if (!member) continue;
      if (!archived) { this.compressor.cancel(id); restoreHistory(this.dataDir, id); }
      const next = { ...member, archiveBlocker: undefined };
      const exit = archiveFields(next, archived, now);
      if (exit) exits?.set(id, exit);
      staged.set(id, next);
    }
  }

  /** A bounded persisted queue also covers projects without a live RunManager. */
  listCompletionCandidates(afterSeq = 0, limit = 32): Array<{ id: string; seq: number }> {
    return this.state.db()?.listCompletionCandidates(afterSeq, limit) ?? [];
  }

  canCompleteAction(id: string, token: string): boolean {
    const run = this.state.record(id);
    return Boolean(run && run.status === 'done' && !run.archived && (run.autoMergePr || run.archiveWhenDone) &&
      run.completionAction?.id === token && run.completionAction.phase !== 'complete' && !this.state.writeRefusal(id));
  }

  claimCompletionAction(id: string, token: string): boolean {
    if (!this.canCompleteAction(id, token)) return false;
    const run = this.state.record(id)!;
    this.state.assertWritable(new Map([[id, run]]));
    // A normal write may defer its claim until the transaction. A remote mutation
    // needs the committed claim now, and must not act on a stale row read before it.
    const claim = this.state.db()?.getClaim(familyKey(run));
    return Boolean(claim && claim.session === this.state.owner()?.session &&
      claim.generation === this.state.claimed.get(familyKey(run)) &&
      this.state.db()?.get(id)?.revision === this.state.base.get(id)?.revision);
  }

  completeAction(id: string, token: string, phase: 'blocked' | 'complete', message?: string): boolean {
    const run = this.state.record(id);
    if (!run || !this.canCompleteAction(id, token)) return false;
    if (run.completionAction?.phase === phase && run.completionAction.message === message) return true;
    const next: RunRecord = { ...run, completionAction: { id: token, phase, ...(message ? { message } : {}) } };
    const staged = new Map<string, RunRecord | null>([[id, next]]);
    if (phase === 'complete' && next.archiveWhenDone) {
      const blocker = this.completionArchiveBlocker(next);
      if (blocker) next.completionAction = { id: token, phase: 'blocked', message: blocker };
      else this.stageArchive(staged, next, true);
    }
    this.state.commitIndex(staged);
    return true;
  }

  listArchiveOnMergeCandidates(afterSeq = 0, limit = 32): Array<{ id: string; seq: number }> {
    return this.state.db()?.listArchiveOnMergeCandidates(afterSeq, limit) ?? [];
  }

  /** Use unnormalized persisted evidence: cold reads must not turn interrupted work into safety. */
  private archiveFamily(id: string, isActive: (id: string) => boolean): RunRecord[] | undefined {
    return archiveStoreFamily({
      db: this.state.db(),
      held: this.state.held,
      deleted: this.state.deleted,
      quarantined: this.state.quarantined,
      pins: this.state.pins,
      listWorkersOf: (parentId) => this.state.listWorkersOf(parentId),
      setArchiveBlocker: (runId, blocker) => this.setArchiveBlocker(runId, blocker),
      decodeRunRow: this.state.decodeRunRow,
      decodeCold: (row) => this.state.decodeCold(row),
      writeRefusal: (memberId) => this.state.writeRefusal(memberId),
      factsPeek: (memberId) => this.state.transcriptFacts.factsFor(memberId).peek(memberId),
      readWorkerExecution: (memberId) => this.state.readWorkerExecution(memberId),
    }, id, isActive);
  }

  /** Blockers are feedback, never archive authority or cleanup permission. */
  setArchiveBlocker(id: string, blocker: RunRecord['archiveBlocker']): void {
    const run = this.state.record(id);
    if (!run || run.archived || isDeepStrictEqual(run.archiveBlocker, blocker)) return;
    this.state.commitIndex(new Map([[id, { ...run, archiveBlocker: blocker }]]));
  }

  archiveMergeBlocker(snapshot: ArchiveOnMergeSnapshot, missing: ArchivePullRequestIdentity, repoBase?: string): void {
    const url = `https://github.com/${missing.owner}/${missing.repo}/pull/${missing.number}`;
    const family = [snapshot.rootId, ...(this.state.db()?.listIdsByParent(snapshot.rootId) ?? [])].flatMap(id => {
      const run = this.state.peek(id); return run ? [run] : [];
    });
    const member = family.find(run => archivePullRequests([run], repoBase)?.some(pr => pullRequestKey(pr) === pullRequestKey(missing)));
    this.setArchiveBlocker(snapshot.rootId, { message: `PR ${missing.owner}/${missing.repo}#${missing.number} is not confirmed merged. Check the PR association or archive manually.`,
      runId: member?.id ?? snapshot.rootId, pullRequestUrl: url });
  }

  hasArchiveOnMergeAssociations(id: string): boolean {
    return this.state.db()?.archiveFamilyHasPullRequests(id) ?? false;
  }

  async prepareArchiveOnMerge(id: string): Promise<void> {
    const ids = [id, ...(this.state.db()?.listIdsByParent(id) ?? [])];
    if (ids.length > 1025) return;
    for (const memberId of ids) await this.state.transcriptFacts.factsFor(memberId).ready(memberId);
  }

  archiveOnMergeSnapshot(id: string, repoBase?: string, isActive: (id: string) => boolean = () => false): ArchiveOnMergeSnapshot | undefined {
    const family = this.archiveFamily(id, isActive);
    if (!family) return undefined;
    return this.archiveSnapshot(family, repoBase);
  }

  private archiveSnapshot(family: RunRecord[], repoBase?: string): ArchiveOnMergeSnapshot | undefined {
    const pullRequests = archivePullRequests(family, repoBase);
    if (!pullRequests) {
      this.setArchiveBlocker(family[0]!.id, { message: 'PR associations cannot be resolved. Check task and worker PRs, or archive manually.' });
      return undefined;
    }
    const fingerprint = archiveDigest(pullRequests);
    if (family[0]!.autoArchive?.fingerprint === fingerprint) return undefined;
    return { rootId: family[0]!.id, fingerprint, pullRequests, token: archiveDigest(family.map(({ archiveBlocker: _blocker, ...run }) => run)) };
  }

  /** No await between final revalidation and the fenced, all-or-nothing cascade. */
  archiveAfterMerge(snapshot: ArchiveOnMergeSnapshot, observations: readonly MergedPullRequest[], repoBase?: string,
    isActive: (id: string) => boolean = () => false): boolean {
    const family = this.archiveFamily(snapshot.rootId, isActive);
    if (!family) return false;
    const current = this.archiveSnapshot(family, repoBase);
    if (!current || current.token !== snapshot.token || current.fingerprint !== snapshot.fingerprint) return false;
    const parsed = observations.map(observation => mergedPullRequestSchema.safeParse(observation));
    if (parsed.some(result => !result.success)) return false;
    const merged = parsed.flatMap(result => result.success ? [result.data] : []);
    const byKey = new Map(merged.map(pr => [pullRequestKey(pr), pr]));
    if (byKey.size !== current.pullRequests.length || current.pullRequests.some(pr => !byKey.has(pullRequestKey(pr)))) return false;
    const restoredAt = Math.max(0, ...family.map(run => run.manualUnarchivedAt ? Date.parse(run.manualUnarchivedAt) : 0));
    if (restoredAt && merged.every(pr => Date.parse(pr.mergedAt) <= restoredAt)) return false;
    const now = new Date().toISOString();
    if (merged.some(pr => Date.parse(pr.mergedAt) > Date.parse(now))) return false;
    const staged = new Map<string, RunRecord | null>(), exits = new Map<string, RunExitId | undefined>();
    this.stageArchive(staged, family[0]!, true, exits);
    staged.get(snapshot.rootId)!.autoArchive = { reason: 'pull-requests-merged', archivedAt: now, fingerprint: current.fingerprint, pullRequests: merged };
    this.state.commitIndex(staged, undefined, { exits });
    for (const id of staged.keys()) this.compressor.enqueue(id);
    return true;
  }

  setArchived(id: string, archived: boolean): RunRecord | undefined {
    const run = this.state.record(id);
    if (!run) return undefined;
    this.applyArchivedCascade(run, archived);
    return run;
  }

  /** Parent + owned workers; returns how many records flipped `archived`. */
  private applyArchivedCascade(run: RunRecord, archived: boolean): number {
    const staged = new Map<string, RunRecord | null>(), exits = new Map<string, RunExitId | undefined>();
    this.stageArchive(staged, run, archived, exits);
    let changed = 0;
    for (const [id, next] of staged) {
      if (next && this.state.peek(id)?.archived !== archived) changed++;
      if (next) next.completionAction = undefined; // an explicit filing/restoration retires pending work
    }
    this.state.commitIndex(staged, undefined, { exits });
    return changed;
  }

  applyArchived(run: RunRecord, archived: boolean, before = snapshotRun(run), exit?: RunExitId): boolean {
    const changed = run.archived !== archived;
    // Transcript first: a restore throw aborts with the record unchanged (#818 S3).
    this.syncTranscriptForm(run.id, archived);
    this.state.touch(run, before, archiveFields(run, archived, new Date().toISOString()) ?? exit);
    return changed;
  }

  /** Transcript form follows `archived`: enqueue compression, or restore the plain file now. */
  syncTranscriptForm(id: string, archived: boolean): void {
    if (archived) this.compressor.enqueue(id);
    else {
      this.compressor.cancel(id);
      restoreHistory(this.dataDir, id);
    }
  }

  /**
   * Whether this store may compress `id`'s transcript: the run exists, is archived, is not in a
   * live status (queued/running/waiting), and this process holds the family's claim in `claimed`
   * (not merely `pendingClaims`). Two processes never both write a run (#779, #818 B1).
   */
  private isHistoryCompressEligible(id: string): boolean {
    if (this.state.deleted.has(id)) return false;
    try {
      const run = this.state.held.get(id) ?? this.state.peek(id);
      if (!run || run.archived !== true || isLiveStatus(run.status)) return false;
      return this.holdsCompressClaim(id);
    } catch {
      return false;
    }
  }

  /** Take the family claim if free and require it to be in `this.state.claimed`, not only pending. */
  private holdsCompressClaim(id: string): boolean {
    const family = this.state.familyOf(id);
    return this.state.claimFamilies([family]).has(family) && this.state.claimed.has(family);
  }

  /** Startup sweep: enqueue every archived non-live run that still has a plain transcript. */
  compressArchivedHistory(): void {
    try {
      const ids = new Set<string>();
      for (const key of this.state.db()?.listKeysWhere('archived = 1 AND live = 0') ?? []) {
        if (!this.state.deleted.has(key.id)) ids.add(key.id);
      }
      for (const run of this.state.held.values()) {
        if (run.archived && !isLiveStatus(run.status) && !this.state.deleted.has(run.id)) ids.add(run.id);
      }
      for (const id of ids) {
        try {
          const { plain } = historyPaths(this.dataDir, id);
          // Claim only ids with work: a plain file to compress, including both-present leftovers.
          if (!existsSync(plain)) continue;
          if (!this.holdsCompressClaim(id)) continue;
          if (hasPlainHistory(this.dataDir, id)) this.compressor.enqueue(id);
        } catch {
          // Best effort: one id must not stop the sweep or boot (#818 S2).
        }
      }
    } catch {
      // listKeysWhere / open-time fs: never throw out of boot.
    }
  }

  /** Resolves when the transcript compressor is idle (tests, shutdown). */
  historyIdle(): Promise<void> {
    return this.compressor.idle();
  }

  /** Bulk-archive finished runs (#780). `isSweepable` decides which; `archived` counts every
   *  record that flipped (cascaded workers included), `ids` lists the top-level runs picked and
   *  `pinnedIds` the subset that carried a pin before `clearPin` dropped it. */
  archiveFinished(scope?: ArchiveFinishedScope, automation?: boolean): { archived: number; ids: string[]; pinnedIds: string[] } {
    let archived = 0;
    // Snapshot first: cascade may archive still-live workers, mutating the held set, and the pin
    // has to be read before `applyArchived` clears it. Runs not in memory are picked off their
    // stored summary, which carries every field `isSweepable` reads.
    const picked: Array<readonly [Parameters<typeof isSweepable>[0] & { id: string }, ListOrder]> =
      [...this.state.held.values()].filter((run) => SWEEPABLE_RUN_RULE.matches({ ...run, automationId: automationIdOf(run) }, scope, automation))
        .map((run) => [run, this.state.listOrder(run)]);
    for (const row of this.state.db()?.listWhere(SWEEPABLE_RUN_RULE.sql) ?? []) {
      if (this.state.held.has(row.id) || this.state.deleted.has(row.id)) continue;
      const summary = parseStoredSummary(row.summary);
      if (summary && SWEEPABLE_RUN_RULE.matches(summary, scope, automation)) picked.push([summary, row]);
    }
    // Another process's runs are not this store's to archive (#779, plan step 3): they stay out.
    // A sweepable run is never a worker (`isSweepable`), so each is its own family.
    const writable = this.state.claimFamilies(picked.map(([run]) => run.id));
    const mine = this.state.sortNewestFirst(picked.filter(([run]) => writable.has(run.id)));
    const ids = mine.map((run) => run.id);
    const pinnedIds = mine.filter((run) => run.pinned).map((run) => run.id);
    for (const id of ids) {
      // Re-check: a prior cascade may already have archived this id.
      const run = this.state.record(id);
      if (!run || run.archived) continue;
      archived += this.applyArchivedCascade(run, true);
    }
    return { archived, ids, pinnedIds };
  }

  /** Form follows archived: a terminal archived run with a plain transcript is queued again. */
  maybeEnqueueHistoryCompress(run: RunRecord): void {
    if (run.archived && !isLiveStatus(run.status) && hasPlainHistory(this.dataDir, run.id)) {
      this.compressor.enqueue(run.id);
    }
  }
}
