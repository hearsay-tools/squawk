/**
 * The list and find queries over a project's runs (hearsay-tools/squawk#4044): the live set, the
 * list rows and their archived window and pages, the workspace search, the workers of a run and
 * the indexed finds. Each query lays the held records over the rows it read. `RunStore` keeps one
 * of these as `store.queries`.
 */
import { toRunSummary } from '@open-mercato/cezar-contract/runs';
import type { ArchivedRunsResponse, RunSummary } from '@open-mercato/cezar-contract';
import { matchesRunSearch, sqlPrefilterTokens, type AutomationNames } from '@open-mercato/cezar-contract/run-search';
import { listBranchOwners, type BranchOwner } from './branch-owners.ts';
import type { ColdReadCache, StoredRow } from './cold-reads.ts';
import { guardedJsonSql } from './guarded-json-sql.ts';
import type { RunFamilyReads, RunQueries } from './ports.ts';
import type { RunColdReadsTopic } from './run-cold-reads.ts';
import { ARCHIVED_ROOT, type RunDatabase, type RunRow } from './run-database.ts';
import type { RunPinHolder } from './run-pins.ts';
import { ISSUE_URL_RE } from './run-references.ts';
import { familyRootOf, isLiveRecord, materializedWorktreePath, newestFirst, type ListOrder } from './run-row.ts';
import { listPeerTaskSummaries, parseStoredSummary, type PeerTaskPageOptions } from './run-summary-page.ts';
import type { RunRecord } from './store.ts';

/** An archived root's place in the archived list, with its summary once it is known: a held run's,
 *  or a searched row's. A row ranked by key alone has none, and its page reads it. */
type ArchivedKey = ListOrder & { summary?: RunSummary };

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
export function sortNewestFirst<T>(entries: Iterable<readonly [T, ListOrder]>): T[] {
  return [...entries].sort(([, a], [, b]) => newestFirst(a, b)).map(([item]) => item);
}

/** What the topic asks of the store; no import of `store.ts` values. */
export interface QueriesState {
  /** The open database; null for an unavailable or closed store. */
  db(): RunDatabase | null;
  readonly held: Map<string, RunRecord>;
  readonly pins: Map<string, Set<RunPinHolder>>;
  readonly deleted: Set<string>;
  readonly unreadable: Set<string>;
  readonly base: Map<string, StoredRow>;
  readonly coldReads: Pick<ColdReadCache, 'scope'>;
  readonly rows: Pick<RunColdReadsTopic, 'loadCold' | 'decodeCold' | 'fromRow'>;
  /** The store's `getRun`, so a spy on it sees the queries' reads. */
  getRun(id: string): RunRecord | undefined;
}

export class RunQueriesTopic implements RunQueries, RunFamilyReads {
  constructor(private readonly state: QueriesState) {}
  private get db(): RunDatabase | null { return this.state.db(); }
  private get held(): Map<string, RunRecord> { return this.state.held; }
  private get pins(): Map<string, Set<RunPinHolder>> { return this.state.pins; }
  private get deleted(): Set<string> { return this.state.deleted; }
  private get unreadable(): Set<string> { return this.state.unreadable; }
  private get base(): Map<string, StoredRow> { return this.state.base; }
  private get coldReads(): QueriesState['coldReads'] { return this.state.coldReads; }
  private loadCold(id: string): RunRecord | undefined { return this.state.rows.loadCold(id); }
  private decodeCold(row: RunRow): RunRecord | undefined { return this.state.rows.decodeCold(row); }
  private fromRow(row: RunRow): RunRecord | undefined { return this.state.rows.fromRow(row); }
  private getRun(id: string): RunRecord | undefined { return this.state.getRun(id); }

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
  listOrder(run: RunRecord): ListOrder {
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

  /** Run `fn` reading each run that is not held at most once (`ColdReadCache`, hearsay-tools/cezarion#2378). */
  withReadCache<T>(fn: () => T): T { return this.coldReads.scope(fn); }

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
}
