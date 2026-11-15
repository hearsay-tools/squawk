import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ATTENTION_RANK } from '@open-mercato/cezar-contract/attention';
import { ruleTestsDir, rulesDir } from './ast-grep-rules.testkit.ts';

/**
 * The `attention-bucket-compare-outside-owner` rules name the attention buckets in a regex, which
 * no type checks (hearsay-tools/squawk#2275). A bucket the contract adds would escape the rule, so
 * this test holds the regex to `ATTENTION_RANK`, and the `.tsx` twin to the `.ts` rule.
 */

interface RuleFile { severity: string; message: string; ignores: string[]; rule: { all: { has: { kind?: string; regex?: string } }[] } }

const read = (id: string): RuleFile => parse(readFileSync(join(rulesDir, `${id}.yml`), 'utf8')) as RuleFile;

const TS = 'attention-bucket-compare-outside-owner';
const TSX = `${TS}-tsx`;

function bucketNames(rule: RuleFile): string[] {
  const regex = rule.rule.all.map((part) => part.has).find((has) => has.kind === 'string')?.regex ?? '';
  return (/\((.*)\)/.exec(regex)?.[1] ?? '').split('|').sort();
}

describe('the attention-bucket-compare-outside-owner rules', () => {
  it('match every attention bucket the contract names', () => {
    expect(bucketNames(read(TS))).toEqual(Object.keys(ATTENTION_RANK).sort());
  });

  it('keep the .tsx twin equal to the .ts rule below its language and files', () => {
    const { severity, message, ignores, rule } = read(TS);
    const twin = read(TSX);
    expect({ severity: twin.severity, message: twin.message, ignores: twin.ignores, rule: twin.rule }).toEqual({ severity, message, ignores, rule });
  });

  it('have an invalid snippet for every bucket name, so the regex is used for each', () => {
    const { invalid } = parse(readFileSync(join(ruleTestsDir, `${TS}-test.yml`), 'utf8')) as { invalid: string[] };
    for (const bucket of Object.keys(ATTENTION_RANK)) {
      expect(invalid.some((snippet) => snippet.includes(`'${bucket}'`) || snippet.includes(`"${bucket}"`)), `no invalid snippet for '${bucket}'`).toBe(true);
    }
  });
});
