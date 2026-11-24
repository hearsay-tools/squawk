import { registrationCalls } from '../core/split-registration.testkit.ts';
import { expect, it } from 'vitest';
import { PARITY_ROSTER, runsOn } from '../core/parity-classes.testkit.ts';
import { collectResumeDiagnosticsTitles, RESUME_DIAGNOSTICS_GROUPS } from './resume-diagnostics-rows.testkit.ts';

function titleKey(title: string): string {
  const match = title.match(/^(\S+)\s+(R\d+)\b/);
  if (!match) throw new Error(`unexpected resume-diagnostics title: ${title}`);
  const [, runner, row] = match;
  if (row === 'R86') {
    const status = title.match(/saved (running|queued) continuation/)?.[1];
    if (!status) throw new Error(`R86 title missing status: ${title}`);
    return `${runner}:R86:${status}`;
  }
  return `${runner}:${row}`;
}

it('registers every resume-diagnostics row exactly once', () => {
  const actual = collectResumeDiagnosticsTitles().map(titleKey);
  const expected = PARITY_ROSTER.flatMap(runner => ['R85', 'R87', 'R88', 'R89', 'R90', 'R91', 'R86:running', 'R86:queued']
    .filter(row => runsOn('resume-diagnostics', row.split(':')[0], runner)).map(row => `${runner}:${row}`));
  expect(actual.sort()).toEqual(expected.sort());
  const calls = registrationCalls(new URL('.', import.meta.url), 'resume-diagnostics-', 'registerResumeDiagnosticsGroup');
  expect(calls.sort()).toEqual(Object.keys(RESUME_DIAGNOSTICS_GROUPS).sort());
});
