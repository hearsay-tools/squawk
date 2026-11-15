import { AUTOMATION_RUNS_INDEX } from './automation-runs.ts';
import { CONVERSATION_MEMBERS_INDEX } from './conversation-members.ts';
import type { RunRowInput } from './run-database.ts';
import type { RunIndexRow, RunIndexTable } from './run-index-rows.ts';

/** Every table of rows derived from run records, with the rows a write gives it. */
export const RUN_INDEXES: ReadonlyArray<{ index: RunIndexTable; rowsOf(row: RunRowInput): readonly RunIndexRow[] | null }> = [
  { index: CONVERSATION_MEMBERS_INDEX, rowsOf: row => row.conversationMembers?.map(member => [member]) ?? null },
  { index: AUTOMATION_RUNS_INDEX, rowsOf: row => row.automationRuns },
];
