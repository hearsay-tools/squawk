import { familyCells, PARITY_ROSTER } from '../core/parity-classes.testkit.ts';

export type ResumeDiagnosticsFamily = 'failure-context' | 'human-text' | 'restart-context' | 'saved-continuation';

export type ResumeDiagnosticsRegister = (title: string, fn: () => Promise<void>, timeout?: number) => unknown;

export type ResumeDiagnosticsCells = {
  R85: (runner: string) => () => Promise<void>;
  R89: (runner: string) => () => Promise<void>;
  R87: (runner: string) => () => Promise<void>;
  R91: (runner: string) => () => Promise<void>;
  R88: (runner: string) => () => Promise<void>;
  R90: (runner: string) => () => Promise<void>;
  R86: (runner: string, status: 'running' | 'queued') => () => Promise<void>;
};

export const RESUME_DIAGNOSTICS_GROUPS: Readonly<Record<ResumeDiagnosticsFamily, ReadonlyArray<{ runner: string; family: ResumeDiagnosticsFamily }>>> = {
  'failure-context': PARITY_ROSTER.map(runner => ({ runner, family: 'failure-context' as const })),
  'human-text': PARITY_ROSTER.map(runner => ({ runner, family: 'human-text' as const })),
  'restart-context': PARITY_ROSTER.map(runner => ({ runner, family: 'restart-context' as const })),
  'saved-continuation': PARITY_ROSTER.map(runner => ({ runner, family: 'saved-continuation' as const })),
};

/** Single registrar shared by `resume-diagnostics.testkit.ts` and the registration guards, without loading the run engine. */
export function registerResumeDiagnosticsFamily(
  family: ResumeDiagnosticsFamily,
  runner: string,
  cells: ResumeDiagnosticsCells,
  register: ResumeDiagnosticsRegister,
): void {
  const it = familyCells('resume-diagnostics', runner, register);
  if (family === 'failure-context') {
    it(`${runner} R85 checkpoints and delivers the failed step and continuation causes before Continue text`, cells.R85(runner), 60_000);
    it(`${runner} R89 keeps multiline errors on one line without hiding a slash skill or changing human history`, cells.R89(runner), 30_000);
    return;
  }
  if (family === 'human-text') {
    it(`${runner} R87 leaves a non-error Continue unchanged`, cells.R87(runner), 30_000);
    it(`${runner} R91 preserves human text that equals the legacy restart fallback`, cells.R91(runner), 30_000);
    return;
  }
  if (family === 'restart-context') {
    it(`${runner} R88 keeps the accepted failure cause and attachment through a restart`, cells.R88(runner), 60_000);
    it(`${runner} R90 explains repeated recovery once when the interrupted task had no saved message`, cells.R90(runner), 60_000);
    return;
  }
  for (const status of ['running', 'queued'] as const) {
    it(`${runner} R86 explains restart ahead of a saved ${status} continuation, without a live session`, cells.R86(runner, status), 60_000);
  }
}

const collectedOnly = () => async () => { throw new Error('registration collector cell should not run'); };
const COLLECTED_CELLS: ResumeDiagnosticsCells = {
  R85: collectedOnly, R89: collectedOnly, R87: collectedOnly, R91: collectedOnly, R88: collectedOnly, R90: collectedOnly, R86: collectedOnly,
};

/** Collect the real test titles registered across every resume-diagnostics family. */
export function collectResumeDiagnosticsTitles(): string[] {
  const titles: string[] = [];
  const collect: ResumeDiagnosticsRegister = (title) => { titles.push(title); };
  for (const rows of Object.values(RESUME_DIAGNOSTICS_GROUPS)) {
    for (const row of rows) registerResumeDiagnosticsFamily(row.family, row.runner, COLLECTED_CELLS, collect);
  }
  return titles;
}
