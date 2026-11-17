import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkRule } from './ast-rule.testkit.ts';
import { runFactReader } from './run-fact-reader.ts';
import { runHistoryReader } from './run-history-reader.ts';
import { factProbes, historyProbes } from './reader-matrix/probes.ts';
import { factDocumentedLimits } from './reader-matrix/review-probes.ts';

/** Parity IDs were captured from 9f43ee092; limit expectations record approved scope decisions.
 * A separate list pins those limits beside the historical findings (hearsay-tools/squawk#3789). */
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
    const differences = generated.flatMap(({ id, code, file }, index) => {
      const findings = expected.findingSets[expected.outcomes[index]!]!;
      const actual = checkRule(rule, file ?? 'packages/cezar/src/reader-matrix-probe.ts', code)
        .map(finding => finding.message.split(':')[0]!).sort();
      return JSON.stringify(actual) === JSON.stringify(findings) ? [] : [{ id, code, expected: findings, actual }];
    });
    expect(differences).toEqual([]);
    // bound: a matrix parses up to 19,548 snippets synchronously; only a hung rule should hit this.
  }, 30_000);

  it('pins the documented fact-reader limits beside historical findings', () => {
    const oracle = JSON.parse(readFileSync(new URL('./reader-matrix/run-fact-reader.json', import.meta.url), 'utf8')) as {
      limitsDigest: string; documentedLimits: { id: string; expected: string[]; old: string[] }[];
    };
    const probes = factDocumentedLimits();
    expect(createHash('sha256').update(JSON.stringify(probes)).digest('hex')).toBe(oracle.limitsDigest);
    expect(probes.length).toBeGreaterThan(0);
    expect(oracle.documentedLimits).toHaveLength(probes.length);
    for (const [index, probe] of probes.entries()) {
      const stored = oracle.documentedLimits[index]!;
      expect(stored.id).toBe(probe.id);
      expect(stored.expected).toEqual(probe.expected);
      expect(stored.old.length).toBeGreaterThan(stored.expected.length);
      const actual = checkRule(runFactReader, probe.file ?? 'packages/cezar/src/reader-matrix-probe.ts', probe.code)
        .map(finding => finding.message.split(':')[0]!).sort();
      expect({ id: probe.id, findings: actual }).toEqual({ id: probe.id, findings: stored.expected });
    }
  });
});
