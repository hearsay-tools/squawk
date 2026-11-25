/**
 * The repository a project is, armed after the store opens, and the repair of the runs it rescopes
 * (hearsay-tools/squawk#4044). `RunStore` keeps one of these as `store.repoScope`.
 */
import { isDeepStrictEqual } from 'node:util';
import { REFERENCED_RUN_RULE } from '@open-mercato/cezar-contract/run-predicates';
import { projectWriteRefused } from '../server/cockpit-ownership.ts';
import { guardedJsonSql } from './guarded-json-sql.ts';
import { snapshotRun } from './lifecycle.ts';
import type { RunRepoHandle } from './ports.ts';
import { familyKey, rowFamily } from './run-claims.ts';
import type { RunClaimsTopic } from './run-claims-topic.ts';
import type { RunColdReadsTopic } from './run-cold-reads.ts';
import type { RunDatabase, RunRow } from './run-database.ts';
import type { RunPersistenceTopic } from './run-persistence.ts';
import { isOriginatingIssueCurrent, isPrReferenceCurrent, namesForeignReference, rescopeRun } from './run-references.ts';
import { parseStoredSummary } from './run-summary-page.ts';
import { repoScopeStamp, saveHealMeta } from './store-open.ts';
import type { RepoHandle, RunRecord } from './store.ts';

/** What the topic asks of the store; no import of `store.ts` values. */
export interface RepoScopeState {
  readonly dataDir: string;
  /** The open database; null for an unavailable or closed store. */
  db(): RunDatabase | null;
  readonly held: Map<string, RunRecord>;
  readonly dirty: ReadonlySet<string>;
  readonly deleted: Set<string>;
  readonly claims: Pick<RunClaimsTopic, 'claimFamilies'>;
  readonly persistence: Pick<RunPersistenceTopic, 'touch' | 'flush'>;
  readonly rows: Pick<RunColdReadsTopic, 'decodeCold' | 'holdDecoded'>;
}

export class RunRepoScopeTopic implements RunRepoHandle {
  /** The repository this project IS (#945), armed after `open()` by `setRepoHandle`. Undefined
   *  until it arrives and `null` when it cannot be known — both mean "unscoped", which is
   *  exactly the pre-#945 behavior. */
  repoHandle: RepoHandle | null | undefined;
  constructor(private readonly state: RepoScopeState) {}
  private get db(): RunDatabase | null { return this.state.db(); }
  private get held(): Map<string, RunRecord> { return this.state.held; }
  private get deleted(): Set<string> { return this.state.deleted; }
  private get claims(): RepoScopeState['claims'] { return this.state.claims; }
  private get persistence(): RepoScopeState['persistence'] { return this.state.persistence; }
  private decodeCold(row: RunRow, loaded?: (run: RunRecord) => void): RunRecord | undefined { return this.state.rows.decodeCold(row, loaded); }
  private holdDecoded(run: RunRecord): RunRecord { return this.state.rows.holdDecoded(run); }

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
    const keys = this.db?.listKeysWhere(guardedJsonSql(`${REFERENCED_RUN_RULE.sql} OR json_extract(summary, '$.pullRequests') IS NOT NULL`, 0)) ?? [];
    const summaries = this.db?.getSummaries(keys.filter(({ id }) => !this.held.has(id) && !this.deleted.has(id)).map(({ id }) => id)) ?? [];
    const needDecode = summaries.filter((row) => {
      const summary = parseStoredSummary(row.summary);
      return !summary || (namesForeignReference(summary, handle) &&
        this.db!.getMeta(`repo-scope:${row.id}`) !== repoScopeStamp(handle, row.revision));
    });
    const stored = this.db?.getMany(needDecode.map(({ id }) => id)) ?? [];
    const verified: Record<string, string> = {};
    for (const run of [...this.held.values()]) {
      const before = snapshotRun(run);
      if (rescopeRun(run, this.repoHandle)) {
        this.persistence.touch(run, before);
        healed = true;
      } else {
        this.stampHeldVerification(run, handle, verified);
      }
    }
    // Only rows this store may write: another process's runs heal when their owner arms its handle.
    const writable = this.claims.claimFamilies(stored.map(rowFamily));
    for (const row of stored) {
      if (!writable.has(rowFamily(row))) continue;
      let before: Readonly<RunRecord> | undefined;
      const run = this.decodeCold(row, (loaded) => { before = snapshotRun(loaded); });
      // `decodeCold` already scoped it with the handle just armed; write it when that changed it.
      if (!run) continue;
      if (!this.storedScopeDiffers(row, run)) {
        if (!this.db!.familyHasFallback(rowFamily(row))) verified[`repo-scope:${row.id}`] = repoScopeStamp(handle, row.revision);
        continue;
      }
      this.holdDecoded(run);
      this.persistence.touch(run, before ?? snapshotRun(run));
      healed = true;
    }
    // Discovery may finish after headless shutdown's final flush. Persist repairs now: the
    // debounced save is unref'd, so it cannot keep the CLI alive once the lookup completes.
    if (this.db && !projectWriteRefused(this.state.dataDir)) saveHealMeta(this.db, verified);
    if (healed) this.persistence.flush();
  }

  /** Record scoped verification stamps for an already-clean held row written before the handle arrived. */
  private stampHeldVerification(run: RunRecord, handle: RepoHandle, verified: Record<string, string>): void {
    if (!this.db || this.state.dirty.has(run.id) || this.db.familyHasFallback(familyKey(run))) return;
    const revision = this.db.revisionOf(run.id);
    if (revision === undefined) return;
    const rev = String(revision);
    if (run.markerRefs?.pr !== undefined && isPrReferenceCurrent(run, handle) &&
      this.db.getMeta(`pr-reference-heal:${run.id}`) !== rev) {
      verified[`pr-reference-heal:${run.id}`] = rev;
    }
    if (run.markerRefs?.issue !== undefined && isOriginatingIssueCurrent(run, handle) &&
      this.db.getMeta(`issue-attribution:${run.id}`) !== rev) {
      verified[`issue-attribution:${run.id}`] = rev;
    }
  }

  /** Whether the stored summary still names a reference the scoped record no longer has. */
  private storedScopeDiffers(row: RunRow, run: RunRecord): boolean {
    const summary = parseStoredSummary(row.summary);
    return summary?.referencedPullRequestUrl !== run.referencedPullRequestUrl ||
      summary?.referencedIssueUrl !== run.referencedIssueUrl || summary?.issueNumber !== run.issueNumber || !isDeepStrictEqual(summary?.pullRequests, run.pullRequests);
  }
}
