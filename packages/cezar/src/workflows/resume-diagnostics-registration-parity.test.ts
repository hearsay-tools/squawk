import { registrationCalls } from '../core/split-registration.testkit.ts';
import { expect, it } from 'vitest';
import { PARITY_ROSTER, runsOn } from '../core/parity-classes.testkit.ts';
import { RESUME_DIAGNOSTICS_FAMILY_ROWS, RESUME_DIAGNOSTICS_GROUPS, resumeDiagnosticsExpectedKeys } from './resume-diagnostics-rows.testkit.ts';

it('registers every resume-diagnostics row exactly once', () => {
  const actual = resumeDiagnosticsExpectedKeys();
  const expected = PARITY_ROSTER.flatMap(runner => ['R85', 'R87', 'R88', 'R89', 'R90', 'R91', 'R86:running', 'R86:queued']
    .filter(row => runsOn('resume-diagnostics', row.split(':')[0], runner)).map(row => `${runner}:${row}`));
  expect(actual.sort()).toEqual(expected.sort());
  const calls = registrationCalls(new URL('.', import.meta.url), 'resume-diagnostics-', 'registerResumeDiagnosticsGroup');
  expect(calls.sort()).toEqual(Object.keys(RESUME_DIAGNOSTICS_GROUPS).sort());
  expect(Object.keys(RESUME_DIAGNOSTICS_FAMILY_ROWS).sort()).toEqual(Object.keys(RESUME_DIAGNOSTICS_GROUPS).sort());
});
