import type { DatabaseSync } from 'node:sqlite';
import type { ConversationMessage, RequestOutcome } from '@open-mercato/cezar-contract';
import { byCreatedAtAndId, type ConversationCursor } from './conversation-ledger.ts';

/** A ledger entry the store moved out of a root's row: the message, and its request's outcome. */
export type ArchivedConversationEntry = { message: ConversationMessage; outcome?: RequestOutcome | undefined };

/** What one ledger commit moves to the archive, in the same transaction as the root's row:
 *  `entries` leave the row; `outcomes` replace the stored outcome of a request already archived
 *  (a late reply to an archived timed-out request). */
export type ConversationArchiveWrite = { rootId: string; entries: readonly ArchivedConversationEntry[]; outcomes: readonly RequestOutcome[] };

/** Archive the settled entries of the family conversation ledgers (hearsay-tools/squawk#4192). */
export const CONVERSATION_ARCHIVE_MIGRATION = `
  -- Schema 16 adds conversation_archive: ledger entries a root's row no longer holds. A ledger
  -- commit moves settled entries here in its own transaction once the row holds 256 or more, so
  -- the row (re-serialized and parsed on every write, and sent whole over SSE) stays bounded while
  -- every message and request ID stays findable. Rows are deleted with their root.
  -- conversation_archive_members is who the archived entries name, so conversation_members, the
  -- union of row and archive members, is rebuilt with each root write without reading messages.
  -- Readers of runs are unchanged; existing ledgers compact on their next commit.
  CREATE TABLE IF NOT EXISTS conversation_archive (
    root_id TEXT NOT NULL,
    id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sender_run_id TEXT NOT NULL,
    recipient_run_id TEXT NOT NULL,
    peer INTEGER NOT NULL,
    message TEXT NOT NULL,
    outcome TEXT
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS conversation_archive_id ON conversation_archive (root_id, id);
  CREATE INDEX IF NOT EXISTS conversation_archive_order ON conversation_archive (root_id, created_at, id);
  CREATE TABLE IF NOT EXISTS conversation_archive_members (
    root_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    PRIMARY KEY (root_id, member_id)
  ) STRICT, WITHOUT ROWID;
  `;

/** The archive's columns, in the order every read and copy uses. */
export const CONVERSATION_ARCHIVE_COLUMNS = 'root_id, id, created_at, sender_run_id, recipient_run_id, peer, message, outcome';

const instances = new WeakMap<DatabaseSync, ConversationArchiveRows>();
type Execute = <T>(work: () => T) => T;
export function conversationArchiveRows(db: DatabaseSync, execute: Execute): ConversationArchiveRows {
  let rows = instances.get(db);
  if (!rows) { rows = new ConversationArchiveRows(db, execute); instances.set(db, rows); }
  return rows;
}

const PAIR = `((sender_run_id = :self AND recipient_run_id = :other) OR (sender_run_id = :other AND recipient_run_id = :self))`;
const message = (row: Record<string, unknown>): ConversationMessage => JSON.parse(row.message as string) as ConversationMessage;
const outcome = (row: Record<string, unknown>): RequestOutcome | undefined => row.outcome === null || row.outcome === undefined ? undefined : JSON.parse(row.outcome as string) as RequestOutcome;

/** The archive's reads and writes, prepared once per connection. The writes join the run write
 *  transaction that calls them (`RunDatabase.transaction`). */
export class ConversationArchiveRows {
  private statements;
  constructor(db: DatabaseSync, private execute: Execute) {
    this.statements = {
      insert: db.prepare(`INSERT OR IGNORE INTO conversation_archive (${CONVERSATION_ARCHIVE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
      amend: db.prepare('UPDATE conversation_archive SET outcome = ? WHERE root_id = ? AND id = ?'),
      member: db.prepare('INSERT OR IGNORE INTO conversation_archive_members (root_id, member_id) VALUES (?, ?)'),
      deleteRoot: db.prepare('DELETE FROM conversation_archive WHERE root_id = ?'),
      deleteMembers: db.prepare('DELETE FROM conversation_archive_members WHERE root_id = ?'),
      unionMembers: db.prepare(`INSERT OR IGNORE INTO conversation_members (root_id, member_id)
        SELECT root_id, member_id FROM conversation_archive_members WHERE root_id = ?`),
      names: db.prepare('SELECT 1 FROM conversation_archive_members WHERE root_id = ? AND member_id = ?'),
      find: db.prepare('SELECT message, outcome FROM conversation_archive WHERE root_id = ? AND id = ?'),
      page: db.prepare(`SELECT message, outcome FROM conversation_archive
        WHERE root_id IN (SELECT value FROM json_each(:roots)) AND ${PAIR}
          AND (:createdAt IS NULL OR created_at < :createdAt OR (created_at = :createdAt AND id < :id))
        ORDER BY created_at DESC, id DESC LIMIT :limit`),
      peer: db.prepare(`SELECT 1 FROM conversation_archive WHERE root_id IN (:self, :other) AND peer = 1 AND ${PAIR} LIMIT 1`),
      count: db.prepare('SELECT count(*) AS count FROM conversation_archive WHERE root_id = ?'),
      sentSince: db.prepare(`SELECT 1 FROM conversation_archive WHERE root_id = ? AND created_at >= ? AND sender_run_id = ? AND recipient_run_id = ? LIMIT 1`),
    };
  }

  /** Store one commit's archive write. Inside the caller's transaction. */
  write(archive: ConversationArchiveWrite): void {
    const { rootId } = archive;
    for (const entry of archive.entries) {
      const stored = entry.message;
      this.statements.insert.run(rootId, stored.id, stored.createdAt, stored.senderRunId, stored.recipientRunId,
        stored.relationship === 'peer' ? 1 : 0, JSON.stringify(stored), entry.outcome ? JSON.stringify(entry.outcome) : null);
      for (const member of ['', stored.senderRunId, stored.recipientRunId]) this.statements.member.run(rootId, member);
    }
    for (const amended of archive.outcomes) this.statements.amend.run(JSON.stringify(amended), rootId, amended.requestId);
  }

  /** A root's archived members join its `conversation_members` rows. Inside the caller's transaction. */
  unionMembers(rootId: string): void { this.statements.unionMembers.run(rootId); }

  /** A root's history is deleted: its archive goes with it. Inside the caller's transaction. */
  deleteRoot(rootId: string): void {
    this.statements.deleteRoot.run(rootId);
    this.statements.deleteMembers.run(rootId);
  }

  /** Whether root `rootId`'s archived entries name `memberId`. */
  names(rootId: string, memberId: string): boolean { return this.execute(() => this.statements.names.get(rootId, memberId)) !== undefined; }

  find(rootId: string, id: string): ArchivedConversationEntry | undefined {
    const row = this.execute(() => this.statements.find.get(rootId, id));
    return row ? { message: message(row), outcome: outcome(row) } : undefined;
  }

  /** The newest `limit` archived messages between the runs of `pair` in the ledgers of `rootIds`,
   *  before `before`, oldest first. */
  page(rootIds: readonly string[], pair: readonly [string, string], before: ConversationCursor | undefined, limit: number): ArchivedConversationEntry[] {
    const rows = this.execute(() => this.statements.page.all({ roots: JSON.stringify(rootIds), self: pair[0], other: pair[1],
      createdAt: before?.createdAt ?? null, id: before?.id ?? null, limit }));
    return rows.map(row => ({ message: message(row), outcome: outcome(row) })).sort((a, b) => byCreatedAtAndId(a.message, b.message));
  }

  /** Whether an archived peer message passed between `a` and `b` in either one's ledger. */
  peerExchanged(a: string, b: string): boolean { return this.execute(() => this.statements.peer.get({ self: a, other: b })) !== undefined; }

  /** Whether root `rootId`'s archive holds a message from `senderRunId` to `recipientRunId` created at or after `since`. */
  sentSince(rootId: string, senderRunId: string, recipientRunId: string, since: string): boolean {
    return this.execute(() => this.statements.sentSince.get(rootId, since, senderRunId, recipientRunId)) !== undefined;
  }

  /** How many entries root `rootId`'s archive holds. */
  count(rootId: string): number { return Number(this.execute(() => this.statements.count.get(rootId))?.count ?? 0); }
}
