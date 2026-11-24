import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PARITY_ROSTER, runsOn, type ParityFamilyName } from '../core/parity-classes.testkit.ts';
import { registrationGroups } from '../core/registration-coverage.testkit.ts';
import { SESSION_CONTEXT_GROUPS, sessionContextRowPairs } from './session-context-rows.testkit.ts';

function registeredGroups(callee: string, catalog: string, known: string[]): string[] {
  const guard = 'context-completion-registration-parity.test.ts';
  return readdirSync(new URL('.', import.meta.url))
    .filter(file => file.endsWith('.ts') && file !== guard)
    .flatMap(file => registrationGroups(readFileSync(new URL(file, import.meta.url), 'utf8'), file, callee, catalog, known));
}

function expectCells(actual: string[], rows: string[], family: ParityFamilyName) {
  const expected = PARITY_ROSTER.flatMap(runner => rows.filter(row => runsOn(family, row, runner)).map(row => `${runner} ${row}`)).sort();
  expect([...actual].sort()).toEqual(expected);
}

describe('session-context family registration', () => {
  it('registers every session-context runner and row exactly once', () => {
    const known = Object.keys(SESSION_CONTEXT_GROUPS) as Array<keyof typeof SESSION_CONTEXT_GROUPS>;
    const registered = registeredGroups('describeSessionContext', 'SESSION_CONTEXT_GROUPS', known);
    expect(registered.sort()).toEqual([...known].sort());
    const pairs = registered.flatMap(group => sessionContextRowPairs(SESSION_CONTEXT_GROUPS[group as keyof typeof SESSION_CONTEXT_GROUPS]));
    expectCells(pairs, ['R120', 'R121', 'R122', 'R123', 'R124'], 'session-context');
  });
});
