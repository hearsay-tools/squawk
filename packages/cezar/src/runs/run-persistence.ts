/**
 * How the store's writes reach `runs.db` (hearsay-tools/squawk#4043): the durable commit, the
 * debounced save and its timer, the fenced transaction, conflict handling and the pending
 * deletions. `RunStore` keeps one of these as `store.persistence`; `close` stays on the store.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertProjectWritable, projectWriteRefused } from '../server/cockpit-ownership.ts';
import { storedRow, type ColdReadCache, type StoredRow } from './cold-reads.ts';
import { publishRunWrite, snapshotRun, type RunLifecycle } from './lifecycle.ts';
import type { LiveItemSnapshots } from './live-item-snapshots.ts';
import { reconcileLoadedRun } from './loaded-run-exits.ts';
import type { RunPersistence } from './ports.ts';
import { encodeRawRecord, type RawExtras } from './raw-record.ts';
import { stageCommit } from './record-write-rules.ts';
import type { RunArchiveTopic } from './run-archive.ts';
import { familyKey, type ClaimOwner } from './run-claims.ts';
import { RunWriteRefusedError, type RunClaimsTopic } from './run-claims-topic.ts';
import {
  RUNS_DB_FILE, RunConflictError,
  type RunConflictEvidence, type RunDatabase, type RunDatabaseChanges, type RunDatabaseCommit, type RunFenceClaim, type RunRowInput, type RunWriteFence,
} from './run-database.ts';
import type { RunExitId } from './run-exits.ts';
import { rescopeRun, restoreOriginatingIssue } from './run-references.ts';
import type { RunRetentionTopic } from './run-retention.ts';
import { encodeRunRow } from './run-row.ts';
import type { RunStoreOpenError } from './store-open-error.ts';
import type { DecodedRun, RepoHandle, RunRecord } from './store.ts';

/** Per-store persistence adapter; the second argument is the normal fenced transaction. */
export type RunStorePersistence = (changes: RunDatabaseChanges, transaction: RunDatabase['transaction']) => RunDatabaseCommit;

/** Why a `run` event fired, when a delegation checkpoint caused it or nothing durable changed
 *  (`republish`) (in-process only). */
export type CommitSource = 'delegation-checkpoint' | 'delegation-destroy-progress' | 'live-release';

/** Make `target` hold exactly `source`'s fields, keeping the object every holder references. */
export function replaceRecord(target: RunRecord, source: RunRecord): void {
  for (const key of Object.keys(target)) if (!(key in source)) delete (target as Record<string, unknown>)[key];
  Object.assign(target, source);
}

/** What the topic asks of the store; no import of `store.ts` values. */
export interface PersistenceState {
  /** The open database; null for an unavailable or closed store. */
  db(): RunDatabase | null;
  /** This store's identity in `run_claims`; undefined without a database. */
  owner(): ClaimOwner | undefined;
  /** Why `open` failed, in a `RunStore.unavailable` store. */
  openFailure(): RunStoreOpenError | undefined;
  /** The repository this project is, once `setRepoHandle` armed it. */
  repoHandle(): RepoHandle | null | undefined;
  readonly held: Map<string, RunRecord>;
  readonly committing: Set<string>;
  readonly dirty: Set<string>;
  readonly deleted: Set<string>;
  readonly historyOwed: Set<string>;
  readonly quarantined: Set<string>;
  readonly claimed: Map<string, number>;
  readonly pendingClaims: Map<string, { session: string; generation: number } | null>;
  readonly base: Map<string, StoredRow>;
  readonly coldBase: Map<string, StoredRow & { owned: boolean }>;
  readonly coldReads: Pick<ColdReadCache, 'forget'>;
  readonly liveItems: Pick<LiveItemSnapshots, 'forget'>;
  readonly published: RunLifecycle;
  readonly archive: Pick<RunArchiveTopic, 'completionArchiveBlocker' | 'stageArchive' | 'maybeEnqueueHistoryCompress' | 'compressor'>;
  readonly claims: Pick<RunClaimsTopic, 'claimFamilies' | 'runOwnership' | 'fallbackRefusal' | 'isFallbackRun'>;
  readonly retention: Pick<RunRetentionTopic, 'removeOwedHistory'>;
  decodeRunRow(data: string): DecodedRun | undefined;
  /** Read held legacy family members, or a detached cold record. */
  peek(id: string): RunRecord | undefined;
  /** Whether a held run anchors itself (and its family) in memory. */
  isAnchor(id: string, run: RunRecord): boolean;
  /** Drop every held run that is neither an anchor nor in an anchored family. */
  evictSettled(): void;
}

export class RunPersistenceTopic implements RunPersistence {
  private saveTimer: NodeJS.Timeout | null = null;
  /** The family of each pending deletion, whose claim the deleting write is fenced against. */
  private readonly deletedFamilies = new Map<string, string>();
  constructor(private readonly dataDir: string, private readonly persistence: RunStorePersistence | undefined,
    private readonly state: PersistenceState) {}
  private get db(): RunDatabase | null { return this.state.db(); }
  private get owner(): ClaimOwner | undefined { return this.state.owner(); }
  private get openFailure(): RunStoreOpenError | undefined { return this.state.openFailure(); }
  private get repoHandle(): RepoHandle | null | undefined { return this.state.repoHandle(); }
  private get held(): Map<string, RunRecord> { return this.state.held; }
  private get committing(): Set<string> { return this.state.committing; }
  private get dirty(): Set<string> { return this.state.dirty; }
  private get deleted(): Set<string> { return this.state.deleted; }
  private get historyOwed(): Set<string> { return this.state.historyOwed; }
  private get quarantined(): Set<string> { return this.state.quarantined; }
  private get claimed(): Map<string, number> { return this.state.claimed; }
  private get pendingClaims(): Map<string, { session: string; generation: number } | null> { return this.state.pendingClaims; }
  private get base(): Map<string, StoredRow> { return this.state.base; }
  private get coldBase(): Map<string, StoredRow & { owned: boolean }> { return this.state.coldBase; }
  private get coldReads(): PersistenceState['coldReads'] { return this.state.coldReads; }
  private get liveItems(): PersistenceState['liveItems'] { return this.state.liveItems; }
  private get published(): RunLifecycle { return this.state.published; }
  private get archive(): PersistenceState['archive'] { return this.state.archive; }
  private get claims(): PersistenceState['claims'] { return this.state.claims; }
  private get retention(): PersistenceState['retention'] { return this.state.retention; }
  private peek(id: string): RunRecord | undefined { return this.state.peek(id); }
  private isAnchor(id: string, run: RunRecord): boolean { return this.state.isAnchor(id, run); }
  private evictSettled(): void { this.state.evictSettled(); }

  /** Persistence source for consumers that build the reports index. No index is created here. */
  reportSource() { return { db: this.db, dataDir: this.dataDir, openFailure: this.openFailure }; }

  /**
   * Durably replace or delete staged rows together with pending dirty rows. Persist before
   * changing held objects or notifying subscribers. On failure retain all pending state; flush()
   * remains best-effort.
   */
  commitIndex(input: ReadonlyMap<string, RunRecord | null>, source?: CommitSource,
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
  assertWritable(staged: ReadonlyMap<string, RunRecord | null>): void {
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
  familyOf(id: string): string {
    const held = this.held.get(id);
    return held ? familyKey(held) : this.deletedFamilies.get(id) ?? this.db?.familyOf(id) ?? id;
  }

  /** Schedule the sweep that lets any of `ids` leave memory, when one of them now can. */
  sweepIfSettled(ids: Iterable<string>): void {
    for (const id of ids) {
      const run = this.held.get(id);
      if (run && !this.isAnchor(id, run)) { this.scheduleSave(); return; }
    }
  }

  /** Write the pending rows out now (used on shutdown). `close` passes `evict` false: its final save
   *  evicts nothing. */
  flush(evict = true): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveNow(evict);
  }

  /** Save `run` debounced and publish it; `before` is the record at the write's entry (none: created). */
  touch(run: RunRecord, before: Readonly<RunRecord> | undefined, exit?: RunExitId): void {
    this.dirty.add(run.id);
    this.scheduleSave();
    publishRunWrite(this.published, run, before, undefined, exit);
    this.archive.maybeEnqueueHistoryCompress(run);
  }

  /** The held record is gone; the next save or commit deletes its row, fenced by `family`'s claim
   *  and by the revision this store last saw (kept in `base` until the delete is written). */
  markDeleted(id: string, family: string): void {
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
  scheduleSave(): void {
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
      const decoded = conflict.current ? this.state.decodeRunRow(conflict.current.data) : undefined;
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
}
