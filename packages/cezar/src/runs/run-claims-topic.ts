/**
 * Who may write a run, and from where its files are read (hearsay-tools/squawk#4042): the family
 * claims open takes and every write is fenced by, the ownership answer controls ask first, the
 * adoption of a dead owner's family or a fallback family, and the fallback source. `RunStore` keeps
 * one of these as `store.claims`.
 */
import { dataReadDirs, runDataDir } from '../project-paths.ts';
import { projectWriteRefused } from '../server/cockpit-ownership.ts';
import { claimStoreFamilies } from './claim-families.ts';
import type { ColdReadCache, StoredRow } from './cold-reads.ts';
import type { ExitEvents } from './exit-events.ts';
import { reconcileLoadedRun, settleOrphanedRun } from './loaded-run-exits.ts';
import type { RunAccess, RunClaims } from './ports.ts';
import { copyFallbackFamily, fallbackRunDeleteError } from './project-run-sources.ts';
import { claimOwnerLive, familyKey, foreignClaimedRunIds, liveForeignClaimedRunIds, rowFamily, type ClaimOwner } from './run-claims.ts';
import { RUNS_DB_FILE, type RunDatabase, type RunRow } from './run-database.ts';
import { parseStoredSummary } from './run-summary-page.ts';
import { AUTOMATION_ORIGIN_HEAL_COMPLETE_KEY, AUTOMATION_ORIGIN_HEAL_SQL, LEGACY_REFERENCE_HEAL_SQL, saveHealMeta } from './store-open.ts';
import type { DecodedRun, RunRecord } from './store.ts';

/**
 * Who may change a run, as this store sees it (#779, plan step 3; `RunClaimsTopic.runOwnership`):
 * - `held`: this store claims its delegation family;
 * - `free`: no live process claims it and nothing in its family is live; a write takes it. A
 *   proven-dead owner's claim on such a family counts for nothing: there is nothing to recover;
 * - `orphaned`: nobody alive owns a family that still has a live run (its owner died, or nobody
 *   claimed it): taking it means adopting it first (`RunClaimsTopic.adoptFamily` settles it, then the
 *   manager recovers the family);
 * - `foreign`: another process that is alive (or cannot be proven dead) holds it: read-only here;
 * - `quarantined`: a write found it changed under this store; refused until Squawk restarts;
 * - `fallback`: a family member is read from the fallback directory: refused as `foreign` until a control adopts it.
 */
export type RunOwnership = 'held' | 'free' | 'orphaned' | 'foreign' | 'quarantined' | 'fallback';

/** The one answer every control gives for a run another Squawk process owns (`409 { error }`). */
export const RUN_IN_USE_ELSEWHERE = `run is in use by another Squawk process`;
/** The answer for a run this process stopped writing after a conflicting write. */
export const RUN_QUARANTINED = `run changed under this Squawk process — restart Squawk to reload it`;

/** A write this store must not make: another process owns the run, its owner died with work
 *  still live (adopt it first), or a conflict quarantined it. Nothing was changed. */
export class RunWriteRefusedError extends Error {
  constructor(readonly runId: string, readonly ownership: Exclude<RunOwnership, 'held' | 'free'>, fallbackError?: string) {
    super(ownership === 'fallback' ? fallbackError ?? `run ${runId} is read only in the fallback project directory`
      : ownership === 'quarantined' ? `${RUN_QUARANTINED}: ${runId}`
      : ownership === 'orphaned' ? `run ${runId} belongs to a Squawk process that exited; take it over before writing it`
        : `${RUN_IN_USE_ELSEWHERE}: ${runId}`);
    this.name = 'RunWriteRefusedError';
  }
}

/** What the topic asks of the store; no import of `store.ts` values. */
export interface ClaimsState {
  /** The open database; null for an unavailable or closed store. */
  db(): RunDatabase | null;
  /** This store's identity in `run_claims`; undefined without a database. */
  owner(): ClaimOwner | undefined;
  /** `open()`'s `keepLive`. */
  keepLive(): boolean;
  readonly held: Map<string, RunRecord>;
  readonly base: Map<string, StoredRow>;
  readonly dirty: Set<string>;
  readonly deleted: ReadonlySet<string>;
  readonly quarantined: ReadonlySet<string>;
  readonly unreadable: Set<string>;
  readonly claimed: Map<string, number>;
  readonly pendingClaims: Map<string, { session: string; generation: number } | null>;
  readonly exitEvents: Pick<ExitEvents, 'loadCancelled' | 'writeLoaded'>;
  readonly coldReads: Pick<ColdReadCache, 'forget'>;
  decodeRunRow(data: string): DecodedRun | undefined;
  /** The family roots with an anchoring member in memory. */
  anchoredFamilies(): Set<string>;
  scheduleSave(): void;
}

export class RunClaimsTopic implements RunAccess, RunClaims {
  constructor(private readonly dataDir: string, private readonly state: ClaimsState) {}
  /** Heal verification stamps found by open(); written at close, so open makes no commit. */
  private pendingHealMeta: Record<string, string> = {};
  private get db(): RunDatabase | null { return this.state.db(); }
  private get owner(): ClaimOwner | undefined { return this.state.owner(); }
  private get keepLive(): boolean { return this.state.keepLive(); }

  /** Every sidecar for a run follows the winning record, never file-by-file fallback. */
  sourceDataDir(id: string): string { return this.isFallbackRun(id) ? dataReadDirs(this.dataDir)[1]! : runDataDir(this.dataDir, id); }
  isFallbackRun(id: string): boolean { return this.db?.isFallback(id) ?? false; }
  hasFallbackRun(id: string): boolean { return this.db?.hasFallback(id) ?? false; }
  /**
   * Open-time load: the live rows, the finished rows a load normalization repairs, then the
   * delegation families of the live ones. A row that does not parse is skipped and left in the
   * database untouched; one warning says how many.
   *
   * Only rows this store can claim are loaded (#779, plan step 3). A live row whose family another
   * live process claims — `serve`'s parked run, seen by a headless `cez run` — is that process's:
   * it is not loaded, normalized or recovered here, and stays readable through `getRun` and the
   * list rows. A live row nobody alive claims is taken over, as before: this open recovers it
   * (`keepLive`) or settles it as interrupted.
   */
  loadHeldRows(): void {
    let unreadable = 0;
    const decode = (row: RunRow): DecodedRun | undefined => {
      const decoded = this.state.decodeRunRow(row.data);
      if (!decoded) {
        unreadable++;
        this.state.unreadable.add(row.id);
      }
      return decoded;
    };
    const live = this.db!.listLive();
    const owned = this.claimFamilies(live.map(rowFamily), { allowLive: true, wait: true });
    for (const row of live) {
      if (!owned.has(rowFamily(row))) continue;
      const decoded = decode(row);
      if (decoded) this.adoptLoadedRun(decoded, { keepLive: this.keepLive }, row);
    }
    const verified: Record<string, string> = {};
    const heal = this.db!.listWhere(LEGACY_REFERENCE_HEAL_SQL).filter((row) => !this.state.held.has(row.id));
    const healable = this.claimFamilies(heal.map(rowFamily));
    for (const row of heal) {
      if (!healable.has(rowFamily(row))) continue;
      const decoded = decode(row);
      // Held only when the repair changed it: the next save writes it, then it leaves.
      if (decoded) {
        // Persist verification once even when legacy issue attribution was already correct.
        const needsIssueCheck = decoded.run.markerRefs?.issue !== undefined &&
          this.db!.getMeta(`issue-attribution:${row.id}`) !== String(row.revision);
        this.adoptLoadedRun(decoded, { keepLive: this.keepLive, onlyIfChanged: !needsIssueCheck }, row);
        if (needsIssueCheck) this.state.dirty.add(row.id);
        if (!this.state.held.has(row.id) && !this.db!.familyHasFallback(rowFamily(row))) {
          verified[`pr-reference-heal:${row.id}`] = String(row.revision);
        }
      }
    }
    const stale = this.automationHealRows(verified);
    if (!projectWriteRefused(this.dataDir)) this.pendingHealMeta = verified;
    const restamp = this.claimFamilies(stale.map(rowFamily));
    for (const row of stale) {
      if (this.state.held.has(row.id)) continue;
      if (!restamp.has(rowFamily(row))) continue;
      const decoded = decode(row);
      // Nothing in the record changes, only its summary: held dirty, the next save rewrites it.
      if (decoded) {
        this.adoptLoadedRun(decoded, { keepLive: this.keepLive }, row);
        this.state.dirty.add(row.id);
      }
    }
    for (const rootId of this.state.anchoredFamilies()) this.holdFamily(rootId, decode);
    this.releaseUnheldClaims();
    if (unreadable > 0) console.warn(`[hsq] ${unreadable} run(s) in ${RUNS_DB_FILE} could not be read; they are left in the database untouched.`);
  }

  /** Write the heal stamps open() found; best effort, so a failed write never blocks close. */
  flushHealMeta(): void {
    const meta = this.pendingHealMeta;
    this.pendingHealMeta = {};
    if (this.db) saveHealMeta(this.db, meta);
  }

  /** Complete only after a scan finds no stale row, including rows already held for saving. */
  private automationHealRows(meta: Record<string, string>): RunRow[] {
    if (this.db!.getMeta(AUTOMATION_ORIGIN_HEAL_COMPLETE_KEY) === '1') return [];
    const stale = this.db!.listWhere(AUTOMATION_ORIGIN_HEAL_SQL);
    if (stale.length === 0 && !this.db!.listKeysWhere('1').some(({ id }) => this.db!.hasFallback(id))) {
      meta[AUTOMATION_ORIGIN_HEAL_COMPLETE_KEY] = '1';
    }
    return stale;
  }

  /** Normalize a record just read from `row` (see `reconcileLoadedRun`) and hold it. Marks the row
   *  dirty only when normalization changed it, so the next save persists exactly the runs open()
   *  rewrote. A row read up from schema-3 wait fields counts as changed: its rewrite drops them
   *  and recomputes its summary and live column (`upgradeLegacyWaits`), as does a summary that does
   *  not parse (hearsay-tools/squawk#3530). The caller has claimed the row's family. */
  private adoptLoadedRun({ run, extras, upgraded }: DecodedRun, opts: { keepLive?: boolean; onlyIfChanged?: boolean; settle?: boolean; stop?: boolean }, row: RunRow): void {
    if (this.db?.familyHasFallback(rowFamily(row))) return;
    // Serialized, so a key set to `undefined` reads as the absent key it is once written.
    const before = JSON.stringify(run);
    const wasCancelled = run.status === 'cancelled';
    if (opts.settle) settleOrphanedRun(run, { stop: opts.stop });
    else reconcileLoadedRun(run, opts);
    const changed = upgraded === true || JSON.stringify(run) !== before || parseStoredSummary(row.summary) === undefined;
    if (opts.onlyIfChanged && !changed) return;
    this.state.held.set(run.id, run);
    this.state.base.set(run.id, { revision: row.revision, seq: row.seq, data: row.data, extras });
    if (changed) this.state.dirty.add(run.id);
    if (!wasCancelled && run.status === 'cancelled') this.state.exitEvents.loadCancelled(run.id);
  }

  /**
   * Hold one delegation family: its root and every worker filed under it, read through the
   * `parent_run_id` index. No recursion: a worker's own id never names a family. The caller has claimed it. `settle` settles its live rows instead of keeping
   * them for recovery (`settleOrphanedRun`); `stopId` is the run a Stop settles as cancelled.
   */
  private holdFamily(rootId: string, decode: (row: RunRow) => DecodedRun | undefined = (row) => this.state.decodeRunRow(row.data), settle = false, stopId?: string): void {
    const rows = [this.db!.get(rootId), ...this.db!.listByParent(rootId)];
    for (const row of rows) {
      if (!row || this.state.held.has(row.id) || this.state.deleted.has(row.id)) continue;
      const decoded = decode(row);
      if (decoded) this.adoptLoadedRun(decoded, { keepLive: this.keepLive, settle, stop: row.id === stopId }, row);
    }
  }

  /** Make sure this store claims each of `families`; `claimStoreFamilies` takes the free ones. */
  claimFamilies(families: Iterable<string>, opts: { allowLive?: boolean; wait?: boolean } = {}): Set<string> {
    return projectWriteRefused(this.dataDir) ? new Set() : claimStoreFamilies({
      claimed: this.state.claimed,
      pendingClaims: this.state.pendingClaims,
      db: this.db,
      owner: this.owner,
      scheduleSave: () => this.state.scheduleSave(),
    }, families, opts);
  }

  /** Release the claim of every family with nothing left in memory, once nothing is pending: a
   *  failed save keeps its families claimed until it succeeds. A failed release retries at the
   *  next sweep; `close()` releases the rest. */
  releaseUnheldClaims(): void {
    if (!this.db || !this.owner || this.state.dirty.size > 0 || this.state.deleted.size > 0) return;
    const kept = new Set<string>();
    for (const run of this.state.held.values()) kept.add(familyKey(run));
    // A claim never taken has nothing to release in the database.
    for (const family of this.state.pendingClaims.keys()) if (!kept.has(family)) this.state.pendingClaims.delete(family);
    const released = [...this.state.claimed.keys()].filter((family) => !kept.has(family));
    if (released.length === 0) return;
    try {
      this.db.releaseClaims(this.owner.session, released);
      for (const family of released) this.state.claimed.delete(family);
    } catch {
      // Busy or failing: the next sweep tries again.
    }
  }

  /**
   * Who may change this run right now (see `RunOwnership`), or undefined when there is no such
   * run. Read-only: nothing is claimed. Controls ask this first, so a run another process owns is
   * refused with `RUN_IN_USE_ELSEWHERE` and a dead process's run is adopted before it is changed.
   */
  runOwnership(id: string): RunOwnership | undefined {
    if (this.state.quarantined.has(id)) return 'quarantined';
    const held = this.state.held.get(id);
    if (!this.db) return held ? 'held' : undefined;
    const family = held ? familyKey(held) : this.state.deleted.has(id) ? undefined : this.db.familyOf(id);
    if (family === undefined) return undefined;
    if (this.db.familyHasFallback(family)) return 'fallback';
    if (this.state.claimed.has(family) || this.state.pendingClaims.has(family)) return 'held';
    const claim = this.db.getClaim(family);
    if (claim && claimOwnerLive(claim)) return 'foreign';
    // The same rule `claimFamilies` writes by: a dead owner left only settled runs → free.
    return this.db.familyHasLive(family) ? 'orphaned' : 'free';
  }

  /** Why a control on this run must be refused here, or undefined when this store may change it. */
  writeRefusal(id: string): string | undefined {
    const ownership = this.runOwnership(id);
    if (ownership === 'quarantined') return RUN_QUARANTINED;
    if (ownership === 'fallback') return this.fallbackRefusal(id).message;
    return ownership === 'foreign' || ownership === 'orphaned' ? RUN_IN_USE_ELSEWHERE : undefined;
  }

  /**
   * Claim an orphaned family before a control, then settle its live rows.
   * Stop cancels its target. Return the root id, or undefined for a live owner or missing run.
   */
  adoptFamily(id: string, opts: { stop?: boolean } = {}): string | undefined {
    const family = this.db?.familyOf(id);
    if (family === undefined || !this.claimFamilies([family], { allowLive: true, wait: true }).has(family)) return undefined;
    this.holdFamily(family, undefined, true, opts.stop ? id : undefined);
    this.state.exitEvents.writeLoaded();
    return family;
  }

  /** Explicit controls only (`requireRunControl`): copy a fallback family in so it can be written. */
  adoptFallbackFamily(id: string): boolean {
    const members = copyFallbackFamily(this.db, id, this.owner);
    for (const member of members) this.state.coldReads.forget(member);
    return members.length > 0;
  }
  fallbackRefusal(id: string): RunWriteRefusedError { return new RunWriteRefusedError(id, 'fallback', fallbackRunDeleteError(this.dataDir, true)); }
  /** Run files are written only for a family this store may write, never a fallback family. */
  /** The error `appendEvent` throws for a run this store cannot write or does not know. */
  missingRunError(runId: string): Error {
    const ownership = this.runOwnership(runId);
    if (ownership === 'fallback') return this.fallbackRefusal(runId);
    if (ownership === 'foreign' || ownership === 'orphaned' || ownership === 'quarantined') return new RunWriteRefusedError(runId, ownership);
    return new Error(`unknown run: ${runId}`);
  }

  writeDir(id: string): string { if (this.runOwnership(id) === 'fallback') throw this.fallbackRefusal(id); return runDataDir(this.dataDir, id); }

  /** Every run whose family another process owns (`foreignClaimedRunIds`). */
  listForeignClaimedRunIds(): string[] { return foreignClaimedRunIds(this.db, this.owner); }
  /** Non-terminal rows in the database (both directories) and the runs of families another live store claims. */
  persistedLiveRunIds(): { live: string[]; foreign: string[] } { return { live: this.db?.listLive().map((row) => row.id) ?? [], foreign: liveForeignClaimedRunIds(this.db, this.owner) }; }
}
