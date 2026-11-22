/**
 * How the store reads a run it does not hold, and which runs it holds (hearsay-tools/squawk#4044):
 * the anchors and the eviction of the held set, the cold load and decode of a row, the hold a write
 * takes, and the detached reads. `RunStore` keeps one of these as its private `rows`; `getRun` and
 * `isUnreadable` stay on the store.
 */
import { ColdReadCache, storedRow, type StoredRow } from './cold-reads.ts';
import { reconcileLoadedRun } from './loaded-run-exits.ts';
import { familyKey, rowFamily } from './run-claims.ts';
import type { RunClaimsTopic } from './run-claims-topic.ts';
import type { RunDatabase, RunRow } from './run-database.ts';
import type { PersistenceState, RunPersistenceTopic } from './run-persistence.ts';
import type { RunPinHolder } from './run-pins.ts';
import { rescopeRun } from './run-references.ts';
import { familyRootOf, isLiveRecord } from './run-row.ts';
import type { RepoHandle, RunRecord } from './store.ts';

/** Tests freeze the copies of cold runs, so an in-place write to one throws instead of vanishing. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** What the topic asks of the store; no import of `store.ts` values. The members it shares with
 *  the persistence topic are the same store state, so they keep that topic's types. */
export interface ColdReadsState extends Pick<PersistenceState, 'db' | 'repoHandle' | 'held' | 'committing' | 'dirty' | 'deleted' | 'quarantined' | 'claimed' | 'pendingClaims' | 'base' | 'decodeRunRow'> {
  /** `open()`'s `keepLive`, which a run read later from `runs.db` is reconciled with too. */
  keepLive(): boolean;
  readonly pins: Map<string, Set<RunPinHolder>>;
  claims(): Pick<RunClaimsTopic, 'claimFamilies' | 'releaseUnheldClaims'>;
  persistence(): Pick<RunPersistenceTopic, 'scheduleSave'>;
}

export class RunColdReadsTopic {
  /** Rows read cold in the current synchronous turn, so a commit staged from one is fenced against
   *  the version it was computed from. `owned`: its family was already this store's when read.
   *  Cleared at the next microtask: no commit spans a turn. */
  readonly coldBase = new Map<string, StoredRow & { owned: boolean }>();
  readonly coldReads = new ColdReadCache();
  /** Rows whose `data` this store tried to decode and could not: left in the database untouched,
   *  and left out of the list rows from then on, as the cold reader leaves them out (run-index.ts). */
  readonly unreadable = new Set<string>();
  constructor(private readonly state: ColdReadsState) {}
  private get db(): RunDatabase | null { return this.state.db(); }
  private get keepLive(): boolean { return this.state.keepLive(); }
  private get repoHandle(): RepoHandle | null | undefined { return this.state.repoHandle(); }
  private get held(): Map<string, RunRecord> { return this.state.held; }
  private get pins(): Map<string, Set<RunPinHolder>> { return this.state.pins; }
  private get committing(): Set<string> { return this.state.committing; }
  private get dirty(): Set<string> { return this.state.dirty; }
  private get deleted(): Set<string> { return this.state.deleted; }
  private get quarantined(): Set<string> { return this.state.quarantined; }
  private get claimed(): Map<string, number> { return this.state.claimed; }
  private get pendingClaims(): ColdReadsState['pendingClaims'] { return this.state.pendingClaims; }
  private get base(): Map<string, StoredRow> { return this.state.base; }
  private get claims(): ReturnType<ColdReadsState['claims']> { return this.state.claims(); }
  private get persistence(): ReturnType<ColdReadsState['persistence']> { return this.state.persistence(); }

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
  isAnchor(id: string, run: RunRecord): boolean {
    return isLiveRecord(run) || this.pins.has(id) || this.dirty.has(id) || this.committing.has(id);
  }

  /** The family roots with an anchoring member in memory. */
  anchoredFamilies(): Set<string> {
    const roots = new Set<string>();
    for (const [id, run] of this.held) {
      const root = familyRootOf(run);
      if (root !== undefined && this.isAnchor(id, run)) roots.add(root);
    }
    return roots;
  }

  /** Drop every held run that is neither an anchor nor in an anchored family. A store without a
   *  database keeps everything: memory is the only copy it has. */
  evictSettled(): void {
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
  loadCold(id: string): RunRecord | undefined {
    if (!this.db || this.deleted.has(id)) return undefined;
    const row = this.db.get(id);
    return row ? this.decodeCold(row) : undefined;
  }

  /** `loaded` sees the record once the load has normalized it, before it is scoped: a heal's `before`. */
  decodeCold(row: RunRow, loaded?: (run: RunRecord) => void): RunRecord | undefined {
    this.coldReads.at(row.id, row.revision); // the fence below moves to this revision
    const decoded = this.state.decodeRunRow(row.data);
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
  holdDecoded(run: RunRecord): RunRecord {
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
  hold(id: string): RunRecord | undefined {
    const held = this.held.get(id);
    if (held) return held;
    const family = this.db && !this.deleted.has(id) ? this.db.familyOf(id) : undefined;
    if (family === undefined || !this.claims.claimFamilies([family]).has(family)) return undefined;
    const run = this.coldReads.claimed(id, this.coldBase.get(id), () => this.db?.revisionOf(id)) ?? this.loadCold(id);
    if (!run) return undefined;
    this.holdDecoded(run);
    this.persistence.scheduleSave();
    return run;
  }

  /** The record a store write changes in place: held, or loaded to be. Undefined for a run this
   *  store may not write (another process's, or quarantined), so the write changes nothing. */
  record(id: string): RunRecord | undefined {
    if (this.quarantined.has(id)) return undefined;
    return this.held.get(id) ?? this.hold(id);
  }

  /** Read held legacy family members, or a detached cold record. */
  peek(id: string): RunRecord | undefined {
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
  answerCold(run: RunRecord, freeze: boolean): RunRecord {
    const root = familyRootOf(run);
    if (root !== undefined && this.anchoredFamilies().has(root)) return this.holdDecoded(run);
    return freeze && process.env.VITEST ? deepFreeze(run) : run;
  }

  /** `getRun` for a row a query already read: the held object, else decoded from `row`. */
  fromRow(row: RunRow): RunRecord | undefined {
    const held = this.held.get(row.id);
    if (held) return held;
    if (this.deleted.has(row.id)) return undefined;
    const cached = this.coldReads.at(row.id, row.revision);
    if (cached) return cached;
    const run = this.decodeCold(row);
    return run && this.coldReads.keep(this.answerCold(run, true), this.coldBase.get(row.id), this.held.has(row.id));
  }

  /** Whether the run exists, held or not, without decoding it. */
  hasRun(id: string): boolean {
    return this.held.has(id) || (!!this.db && !this.deleted.has(id) && this.db.has(id));
  }
}
