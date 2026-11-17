import { describe, expect, it } from 'vitest';
import { checkRule } from './ast-rule.testkit.ts';
import { attentionBucketCompareOutsideOwner } from './attention-bucket-compare-outside-owner.ts';
import { automationsCapabilityReadOutsideOwner } from './automations-capability-read-outside-owner.ts';
import { subagentChildrenOutsideDock } from './subagent-children-outside-dock.ts';
import { testEnumLiteral } from './test-enum-literal.ts';
import { attentionProbes, otherTwinProbes } from './ast-twins-matrix.testkit.ts';
import { MATRIX_BASELINES } from './ast-twins-matrix-data.testkit.ts';

/** Compare the current visitors with old parser counts without invoking ast-grep.
 * Accepted widenings are probe-only syntax cells, with no repository lint site
 * (hearsay-tools/squawk#3774). The four angle-assertion misses must match old counts. */
describe('twin rule generated parity matrices', () => {
  it.each([attentionBucketCompareOutsideOwner, automationsCapabilityReadOutsideOwner, subagentChildrenOutsideDock, testEnumLiteral])('$name has no unexpected difference', (rule) => {
    const baseline = MATRIX_BASELINES[rule.name]!;
    const probes = rule === attentionBucketCompareOutsideOwner ? attentionProbes() : otherTwinProbes(rule.name);
    expect(probes).toHaveLength(baseline.counts.length);
    const key = (ext: string, code: string) => `${ext}\0${code}`;
    const accepted = new Map(baseline.accepted.map((cell) => [key(cell.ext, cell.code), cell.count]));
    expect(accepted.size).toBe(baseline.accepted.length);
    const seen = new Set<string>();
    for (const [index, { ext, code }] of probes.entries()) {
      const oldCount = baseline.counts[index]!;
      if (oldCount === '-') continue; // Invalid TypeScript grammar; measured and excluded once.
      const cell = key(ext, code);
      const expected = accepted.get(cell) ?? Number(oldCount);
      if (accepted.has(cell)) {
        expect(oldCount).toBe('0');
        seen.add(cell);
      }
      const file = `packages/web/src/matrix${rule === testEnumLiteral ? '.test' : ''}.${ext}`;
      expect(checkRule(rule, file, code).length, `${rule.name}: ${ext}: ${code}`).toBe(expected);
    }
    expect([...seen].sort()).toEqual([...accepted.keys()].sort());
  });
});
