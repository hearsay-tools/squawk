import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage, RequestOutcome } from '@open-mercato/cezar-contract';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { RunDatabase, type RunRowInput } from './run-database.ts';
import { CONVERSATION_MEMBERS_INDEX } from './conversation-members.ts';
import type { ConversationArchiveWrite } from './conversation-archive.ts';

let dir: string;
let path: string;
const open: RunDatabase[] = [];
const openDb = () => { const db = RunDatabase.open(path); open.push(db); return db; };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-24T12:00:00.000Z') });
  dir = mkdtempSync(join(tmpdir(), 'cez-conversation-archive-')); path = join(dir, 'runs.db');
});
afterEach(() => { vi.useRealTimers(); for (const db of open.splice(0)) db.close(); rmSync(dir, { recursive: true, force: true }); });

const row = (id: string, members: string[] | null = null): RunRowInput => ({ id, createdAt: '2026-11-24T00:00:00.000Z', status: RUN_STATUS.running,
  archived: false, live: true, data: JSON.stringify({ id }), summary: JSON.stringify({ id }), conversationMembers: members, automationRuns: null });
const message = (id: string, senderRunId: string, recipientRunId: string, createdAt: string, extra: Partial<ConversationMessage> = {}): ConversationMessage =>
  ({ id, senderRunId, recipientRunId, kind: 'request', text: id, createdAt, requestHash: 'a'.repeat(64), state: 'accepted', ...extra });
const members = (db: RunDatabase, id: string) => db.indexRows(CONVERSATION_MEMBERS_INDEX, id)?.map(([member]) => member) ?? null;

describe('conversation_archive (hearsay-tools/squawk#4192)', () => {
  const replied: RequestOutcome = { requestId: 'm1', status: 'timed-out', observedAt: '2026-11-24T10:05:00.000Z' };
  const archive: ConversationArchiveWrite = { rootId: 'root', outcomes: [], entries: [
    { message: message('m1', 'root', 'worker', '2026-11-24T10:00:00.000Z'), outcome: replied },
    { message: message('m2', 'worker', 'root', '2026-11-24T10:01:00.000Z', { kind: 'progress' }) },
    { message: message('m3', 'root', 'peer', '2026-11-24T10:02:00.000Z', { kind: 'progress', relationship: 'peer' }) },
    { message: message('m4', 'root', 'worker', '2026-11-24T10:01:00.000Z', { kind: 'progress' }) },
  ] };

  it('stores entries with their root row, finds them by ID and pages one pair newest first', () => {
    const db = openDb();
    db.transaction({ upserts: [row('root', ['', 'root', 'other'])], deletes: [], conversationArchive: [archive] });
    expect(db.archive?.find('root', 'm1')).toEqual(archive.entries[0]);
    expect(db.archive?.find('root', 'm2')).toEqual({ message: archive.entries[1]!.message, outcome: undefined });
    expect(db.archive?.find('other-root', 'm1')).toBeUndefined();
    const pair = ['worker', 'root'] as const;
    expect(db.archive?.page(['root'], pair, undefined, 10).map(entry => entry.message.id)).toEqual(['m1', 'm2', 'm4']);
    expect(db.archive?.page(['root'], pair, undefined, 2).map(entry => entry.message.id)).toEqual(['m2', 'm4']);
    expect(db.archive?.page(['root'], pair, { createdAt: '2026-11-24T10:01:00.000Z', id: 'm4' }, 10).map(entry => entry.message.id)).toEqual(['m1', 'm2']);
    expect(db.archive?.page(['elsewhere'], pair, undefined, 10)).toEqual([]);
    expect(db.archive?.peerExchanged('peer', 'root')).toBe(true);
    expect(db.archive?.peerExchanged('worker', 'root')).toBe(false);
    // A late reply amends the archived outcome in place.
    const late: RequestOutcome = { requestId: 'm1', status: 'replied-late', observedAt: '2026-11-24T11:00:00.000Z', replyId: 'r1' };
    db.transaction({ upserts: [row('root', ['', 'root'])], deletes: [], conversationArchive: [{ rootId: 'root', entries: [], outcomes: [late] }] });
    expect(db.archive?.find('root', 'm1')?.outcome).toEqual(late);
  });

  it('keeps conversation_members the union of row and archive members on every root write', () => {
    const db = openDb();
    db.transaction({ upserts: [row('root', ['', 'root', 'other'])], deletes: [], conversationArchive: [archive] });
    expect(members(db, 'root')).toEqual(['', 'other', 'peer', 'root', 'worker']);
    db.transaction({ upserts: [row('root', ['', 'root'])], deletes: [] });
    expect(members(db, 'root')).toEqual(['', 'peer', 'root', 'worker']);
    expect(db.listConversationRoots('worker')).toEqual(['root']);
    expect(db.archive?.names('root', 'peer')).toBe(true);
    expect(db.archive?.names('root', 'other')).toBe(false);
  });

  it('writes the archive in the root row\'s transaction: nothing without the row, nothing when the commit fails, all gone with the root', () => {
    const db = openDb();
    expect(() => db.transaction({ upserts: [], deletes: [], conversationArchive: [archive] })).toThrow('conversation archive of root without its root row');
    expect(() => db.transaction({ upserts: [row('root')], deletes: [], conversationArchive: [archive], beforeCommit: () => { throw new Error('refused'); } })).toThrow('refused');
    expect(db.archive?.count('root')).toBe(0);
    db.transaction({ upserts: [row('root', ['', 'root'])], deletes: [], conversationArchive: [archive] });
    expect(db.archive?.count('root')).toBe(4);
    db.transaction({ upserts: [], deletes: ['root'] });
    expect(db.archive?.count('root')).toBe(0);
    expect(db.archive?.names('root', 'worker')).toBe(false);
    expect(members(db, 'root')).toBeNull();
  });

  it('migrates a schema-15 database by adding the archive, keeping its rows; an older read-only database has none', () => {
    openDb().transaction({ upserts: [row('root', ['', 'root'])], deletes: [] });
    for (const db of open.splice(0)) db.close();
    const raw = new DatabaseSync(path);
    raw.exec('DROP TABLE conversation_archive; DROP TABLE conversation_archive_members; PRAGMA user_version = 15');
    raw.close();
    const older = RunDatabase.openReadOnly(path)!;
    try {
      expect(older.archive).toBeUndefined();
      expect(older.get('root')?.data).toBe(row('root').data);
    } finally { older.close(); }
    const db = openDb();
    expect(db.get('root')?.data).toBe(row('root').data);
    expect(members(db, 'root')).toEqual(['', 'root']);
    db.transaction({ upserts: [row('root', ['', 'root'])], deletes: [], conversationArchive: [archive] });
    expect(db.archive?.count('root')).toBe(4);
  });
});
