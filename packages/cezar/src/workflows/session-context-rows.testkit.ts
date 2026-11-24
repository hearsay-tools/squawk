import { PARITY_ROSTER, runsOn } from '../core/parity-classes.testkit.ts';

/** The session-context parity groups, apart from the cells so registration guards load no run engine. */
export const SESSION_CONTEXT_GROUPS = {
  opening: ['R120'],
  live: ['R121'],
  retry: ['R122'],
  recovery: ['R123'],
  worker: ['R124'],
} as const;

export type SessionContextGroup = keyof typeof SESSION_CONTEXT_GROUPS;

/** The runner/row pairs registered for the given row ids. */
export function sessionContextRowPairs(rows: readonly string[]): string[] {
  return PARITY_ROSTER.flatMap(runner => rows.filter(row => runsOn('session-context', row, runner)).map(row => `${runner} ${row}`));
}
