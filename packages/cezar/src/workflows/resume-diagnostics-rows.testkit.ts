import { PARITY_ROSTER, runsOn } from '../core/parity-classes.testkit.ts';

/** The resume-diagnostics families and rows, apart from the cells so guards load no run engine. */
export const RESUME_DIAGNOSTICS_FAMILY_ROWS = {
  'failure-context': ['R85', 'R89'],
  'human-text': ['R87', 'R91'],
  'restart-context': ['R88', 'R90'],
  'saved-continuation': ['R86:running', 'R86:queued'],
} as const;

export type ResumeDiagnosticsFamily = keyof typeof RESUME_DIAGNOSTICS_FAMILY_ROWS;

export const RESUME_DIAGNOSTICS_GROUPS: Readonly<Record<ResumeDiagnosticsFamily, ReadonlyArray<{ runner: string; family: ResumeDiagnosticsFamily }>>> = {
  'failure-context': PARITY_ROSTER.map(runner => ({ runner, family: 'failure-context' as const })),
  'human-text': PARITY_ROSTER.map(runner => ({ runner, family: 'human-text' as const })),
  'restart-context': PARITY_ROSTER.map(runner => ({ runner, family: 'restart-context' as const })),
  'saved-continuation': PARITY_ROSTER.map(runner => ({ runner, family: 'saved-continuation' as const })),
};

export function resumeDiagnosticsExpectedKeys(): string[] {
  return (Object.entries(RESUME_DIAGNOSTICS_FAMILY_ROWS) as Array<[ResumeDiagnosticsFamily, readonly string[]]>).flatMap(([, rows]) =>
    PARITY_ROSTER.flatMap(runner => rows.filter(row => runsOn('resume-diagnostics', row.split(':')[0], runner)).map(row => `${runner}:${row}`)));
}
