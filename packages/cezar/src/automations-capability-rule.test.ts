import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { rulesDir } from './ast-grep-rules.testkit.ts';

/**
 * The `automations-capability-read-outside-owner` rules are a `.ts` and a `.tsx` twin, because
 * ast-grep parses the two with different grammars (hearsay-tools/squawk#1401). This test holds the
 * twin equal to the `.ts` rule below its language and files, so an edit to one reaches both.
 */

interface RuleFile { severity: string; message: string; ignores: string[]; files: string[]; rule: unknown }

const read = (id: string): RuleFile => parse(readFileSync(join(rulesDir, `${id}.yml`), 'utf8')) as RuleFile;

const TS = 'automations-capability-read-outside-owner';

describe('the automations-capability-read-outside-owner rules', () => {
  it('keep the .tsx twin equal to the .ts rule below its language and files', () => {
    const { severity, message, ignores, rule } = read(TS);
    const twin = read(`${TS}-tsx`);
    expect({ severity: twin.severity, message: twin.message, ignores: twin.ignores, rule: twin.rule }).toEqual({ severity, message, ignores, rule });
  });

  it('cover every cockpit source file between them', () => {
    expect([...read(TS).files, ...read(`${TS}-tsx`).files]).toEqual(['packages/web/src/**/*.ts', 'packages/web/src/**/*.tsx']);
  });
});
