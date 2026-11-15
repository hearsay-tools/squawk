import type { DatabaseSync } from 'node:sqlite';
import { guardedJsonSql } from './guarded-json-sql.ts';
import type { RunIndexTable } from './run-index-rows.ts';

/**
 * `conversation_members` rows for the roots of the runs-shaped table `source` (alias `s`) that
 * `where` selects, read from each row's record: the marker `''` for a root with a conversation,
 * then each sender and recipient (`conversationMembersOf`, run-row.ts). A root is what the stored
 * summary calls one, as the scan this table replaces read it. A row whose data or summary is not
 * JSON gives none: the store skips that row. A message list that is not an array gives the marker
 * only. Each record is parsed once, for its message list.
 */
export function conversationMembersSelect(source: string, where = '1'): string {
  return `WITH conversation_roots AS MATERIALIZED (
      SELECT s.id AS root_id, CASE WHEN json_type(s.data, '$.delegation.conversation.messages') = 'array'
        THEN json_extract(s.data, '$.delegation.conversation.messages') END AS messages FROM ${source} s
      WHERE ${where} AND ${guardedJsonSql(`json_extract(s.summary, '$.delegation.role') = 'root'
        AND json_extract(s.data, '$.delegation.conversation') IS NOT NULL`, 0, ['s.summary', 's.data'])})
    SELECT root_id, '' AS member_id FROM conversation_roots UNION ${messageMembers('senderRunId')} UNION ${messageMembers('recipientRunId')}`;
}

/** One message field of every listed root's messages, as `conversation_members` rows. */
function messageMembers(field: 'senderRunId' | 'recipientRunId'): string {
  return `SELECT root_id, CASE WHEN m.type = 'object' THEN json_extract(m.value, '$.${field}') END AS member_id
    FROM conversation_roots, json_each(coalesce(messages, '[]')) m WHERE member_id IS NOT NULL`;
}

/** Index who each root's conversation names, so a lookup reads a few rows instead of every record. */
export const CONVERSATION_MEMBERS_MIGRATION = `
  -- Schema 13 adds conversation_members: which runs each root's conversation names, with the
  -- marker '' for every root that has a conversation. RunDatabase.transaction keeps it in step
  -- with every row it writes or deletes. It replaces a scan of every row's summary and record
  -- (json_extract over data), about 260 ms on 1,332 roots, which every read of a root task with
  -- workers ran through the completion gate. Readers of runs are unchanged.
  CREATE TABLE IF NOT EXISTS conversation_members (
    root_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    PRIMARY KEY (member_id, root_id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS conversation_members_root ON conversation_members (root_id);
  INSERT OR IGNORE INTO conversation_members (root_id, member_id) ${conversationMembersSelect('runs')};
  `;

/** The index's rows: `[member_id]` per root, the root id implied. */
export const CONVERSATION_MEMBERS_INDEX: RunIndexTable = { table: 'conversation_members', columns: ['root_id', 'member_id'], select: conversationMembersSelect };

const instances = new WeakMap<DatabaseSync, ConversationRoots>();
type Execute = <T>(work: () => T) => T;
export function conversationRoots(db: DatabaseSync, execute: Execute): ConversationRoots {
  let roots = instances.get(db);
  if (!roots) { roots = new ConversationRoots(db, execute); instances.set(db, roots); }
  return roots;
}

/** The index's lookup, prepared once per connection. */
export class ConversationRoots {
  private statement;
  constructor(db: DatabaseSync, private execute: Execute) {
    this.statement = db.prepare(`SELECT r.id AS id FROM conversation_members c JOIN runs r ON r.id = c.root_id
      WHERE c.member_id = ? ORDER BY r.created_at DESC, r.seq`);
  }

  /** The roots whose conversation names `memberId`, newest first; `''` lists every root with one. */
  roots(memberId: string): string[] {
    return this.execute(() => this.statement.all(memberId)).map((row) => row.id as string);
  }
}
