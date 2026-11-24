import type { DatabaseSync } from 'node:sqlite';
import { conversationArchiveRows, type ConversationArchiveRows, type ConversationArchiveWrite } from './conversation-archive.ts';
import { runIndexRows, type RunIndexTable } from './run-index-rows.ts';
import { RUN_INDEXES } from './run-indexes.ts';
import type { RunRowInput } from './run-database.ts';

type Execute = <T>(work: () => T) => T;

/** The rows `RunDatabase.transaction` derives from each run write: the index tables
 *  (`RUN_INDEXES`) and a root's conversation archive (hearsay-tools/squawk#4192). Each write
 *  method runs inside that transaction. */
export class RunDerivedRows {
  private archiveRows: ConversationArchiveRows | null | undefined;
  constructor(private readonly db: DatabaseSync, private readonly execute: Execute) {}

  indexTable(index: RunIndexTable) { return runIndexRows(this.db, index, this.execute); }

  /** The archived entries of the family conversation ledgers (`conversation_archive`, schema 16);
   *  undefined for a read-only database an older Squawk left without the table. */
  get archive(): ConversationArchiveRows | undefined {
    this.archiveRows ??= this.execute(() => this.db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = 'conversation_archive'").get())
      ? this.execute(() => conversationArchiveRows(this.db, this.execute)) : null;
    return this.archiveRows ?? undefined;
  }

  /** A deleted run's derived rows go with it, a root's archived ledger entries too. */
  deleteRun(id: string): void {
    for (const { index } of RUN_INDEXES) this.indexTable(index).deleteRun(id);
    this.archive?.deleteRoot(id);
  }

  /** A written run's derived rows; conversation_members is the union of the row's members and the archive's. */
  replace(row: RunRowInput): void {
    for (const { index, rowsOf } of RUN_INDEXES) this.indexTable(index).replace(row.id, rowsOf(row));
    this.archive?.unionMembers(row.id);
  }

  /** Before the roots' rows and their members are written. */
  writeArchive(writes: readonly ConversationArchiveWrite[] | undefined): void {
    if (!writes?.length) return;
    const archive = this.archive;
    if (!archive) throw new Error('conversation archive unavailable: the database predates schema 16');
    for (const write of writes) archive.write(write);
  }
}
