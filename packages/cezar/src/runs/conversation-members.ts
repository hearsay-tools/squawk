import type { DatabaseSync } from 'node:sqlite';

/**
 * `conversation_members` rows for the roots of the runs-shaped table `source` (alias `s`) that
 * `where` selects, read from each row's record: the marker `''` for a root with a conversation,
 * then each sender and recipient (`conversationMembersOf`, run-row.ts). A root is what the stored
 * summary calls one, as the scan this table replaces read it. A row whose data or summary is not
 * JSON gives none: the store skips that row. Each record is parsed once, for its message list.
 */
export function conversationMembersSelect(source: string, where = '1'): string {
  const member = (field: string) => `SELECT root_id, CASE WHEN m.type = 'object' THEN json_extract(m.value, '$.${field}') END AS member_id
    FROM conversation_roots, json_each(coalesce(messages, '[]')) m WHERE member_id IS NOT NULL`;
  return `WITH conversation_roots AS MATERIALIZED (
      SELECT s.id AS root_id, json_extract(s.data, '$.delegation.conversation.messages') AS messages FROM ${source} s
      WHERE ${where} AND CASE WHEN json_valid(s.summary) AND json_valid(s.data) THEN json_extract(s.summary, '$.delegation.role') = 'root'
        AND json_extract(s.data, '$.delegation.conversation') IS NOT NULL ELSE 0 END)
    SELECT root_id, '' AS member_id FROM conversation_roots UNION ${member('senderRunId')} UNION ${member('recipientRunId')}`;
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

const instances = new WeakMap<DatabaseSync, ConversationMembers>();
type Execute = <T>(work: () => T) => T;
export function conversationMembers(db: DatabaseSync, execute: Execute): ConversationMembers {
  let rows = instances.get(db);
  if (!rows) { rows = new ConversationMembers(db, execute); instances.set(db, rows); }
  return rows;
}

/** Prepared once per connection. `replace` and `deleteRun` join the run write that calls them. */
export class ConversationMembers {
  private statements;
  constructor(db: DatabaseSync, private execute: Execute) {
    this.statements = {
      roots: db.prepare(`SELECT r.id AS id FROM conversation_members c JOIN runs r ON r.id = c.root_id
        WHERE c.member_id = ? ORDER BY r.created_at DESC, r.seq`),
      members: db.prepare('SELECT member_id FROM conversation_members WHERE root_id = ? ORDER BY member_id'),
      delete: db.prepare('DELETE FROM conversation_members WHERE root_id = ?'),
      insert: db.prepare('INSERT OR IGNORE INTO conversation_members (root_id, member_id) VALUES (?, ?)'),
    };
  }

  /** The roots whose conversation names `memberId`, newest first; `''` lists every root with one. */
  roots(memberId: string): string[] {
    return this.execute(() => this.statements.roots.all(memberId)).map((row) => row.id as string);
  }

  /** A row's stored members: null for none. */
  membersOf(rootId: string): string[] | null {
    const members = this.execute(() => this.statements.members.all(rootId)).map((row) => row.member_id as string);
    return members.length > 0 ? members : null;
  }

  replace(rootId: string, members: readonly string[] | null): void {
    this.statements.delete.run(rootId);
    for (const member of members ?? []) this.statements.insert.run(rootId, member);
  }

  deleteRun(rootId: string): void { this.statements.delete.run(rootId); }
}
