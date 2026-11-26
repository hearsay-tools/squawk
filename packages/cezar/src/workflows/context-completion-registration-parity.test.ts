import { describe, expect, it } from 'vitest';
import { PARITY_ROSTER, runsOn, type ParityFamilyName } from '../core/parity-classes.testkit.ts';
import { registrationGroupsIn } from '../core/registration-coverage.testkit.ts';
import { collectSessionContextTitles, SESSION_CONTEXT_GROUPS } from './session-context-rows.testkit.ts';

function registeredGroups(callee: string, catalog: string, known: string[]): string[] {
  return registrationGroupsIn(new URL('.', import.meta.url), 'session-context-', callee, catalog, known);
}

function titlePair(title: string): string {
  const match = title.match(/^(\S+)\s+(R\d+)\b/);
  if (!match) throw new Error(`unexpected session-context title: ${title}`);
  return `${match[1]} ${match[2]}`;
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
    const pairs = registered.flatMap(group =>
      collectSessionContextTitles(SESSION_CONTEXT_GROUPS[group as keyof typeof SESSION_CONTEXT_GROUPS]).map(titlePair));
    expectCells(pairs, ['R120', 'R121', 'R122', 'R123', 'R124'], 'session-context');
  });
});
