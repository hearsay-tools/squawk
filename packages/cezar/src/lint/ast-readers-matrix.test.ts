import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkRule } from './ast-rule.testkit.ts';
import { runFactReader } from './run-fact-reader.ts';
import { runHistoryReader } from './run-history-reader.ts';
import { factProbes, historyProbes } from './reader-matrix/probes.ts';

/** Expected IDs were generated once by the 9f43ee092 scanners, never by the AST rules.
 * Each generated cell must match; there are no accepted differences (hearsay-tools/squawk#3789). */
describe('run reader generated parity matrices', () => {
  it.each([
    { rule: runHistoryReader, probes: historyProbes },
    { rule: runFactReader, probes: factProbes },
  ])('$rule.name matches all old scanner cells', ({ rule, probes }) => {
    const expected = JSON.parse(readFileSync(new URL(`./reader-matrix/${rule.name}.json`, import.meta.url), 'utf8')) as {
      revision: string; digest: string; findingSets: string[][]; outcomes: number[];
    };
    expect(expected.revision).toBe('9f43ee092');
    const generated = probes();
    expect(createHash('sha256').update(JSON.stringify(generated)).digest('hex')).toBe(expected.digest);
    expect(generated).toHaveLength(expected.outcomes.length);
    expect(new Set(generated.map(cell => cell.id)).size).toBe(generated.length);
    const differences = generated.flatMap(({ id, code }, index) => {
      const findings = expected.findingSets[expected.outcomes[index]!]!;
      const actual = checkRule(rule, 'packages/cezar/src/reader-matrix-probe.ts', code)
        .map(finding => finding.message.split(':')[0]!).sort();
      return JSON.stringify(actual) === JSON.stringify(findings) ? [] : [{ id, code, expected: findings, actual }];
    });
    expect(differences).toEqual([]);
  });
});
