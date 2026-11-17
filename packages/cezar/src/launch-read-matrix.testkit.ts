import { createRequire } from 'node:module';
import { join } from 'node:path';
import { RuleTester } from 'oxlint/plugins-dev';
import { expect } from 'vitest';
import { oxlintAstRule, type AstRule } from './lint/ast-rule.ts';
import { launchReadOutsideResolver } from './lint/launch-read-outside-resolver.ts';
import { repoRoot } from './lint/source-rule.ts';

const require = createRequire(import.meta.url);
interface LimitCell { family: string; axes: string[]; code: string; reason: string }
interface Matrix { generated: Record<string, { valid: string[]; invalid: string[] }>; documentedLimits: LimitCell[] }
export const { generated, documentedLimits } = require('./lint/launch-read/matrix.cjs') as Matrix;
export const curated = require('./lint/launch-read/cases.json') as Array<{ id: string; valid: string[]; invalid: string[] }>;

/** Compare detection, as the former family-union matrix did, while the production rule keeps every location. */
export const detectionRule: AstRule = {
  ...launchReadOutsideResolver,
  create(report) {
    let reported = false;
    return launchReadOutsideResolver.create((node, message) => {
      if (!reported) { reported = true; report(node, message); }
    });
  },
};

export function checkLaunchReadMatrix(family: keyof typeof generated): void {
  expect(documentedLimits).toHaveLength(3456);
  const filename = join(repoRoot, 'packages/cezar/src/workflows/run/matrix.ts');
  const saved = { it: RuleTester.it, describe: RuleTester.describe };
  const failures: string[] = [];
  // Execute in one Vitest cell per family: tens of thousands of named test registrations add no proof.
  RuleTester.describe = (_name, run) => run();
  RuleTester.it = (name, run) => { try { run(); } catch (error) { failures.push(`${name}\n${String(error)}`); } };
  try {
    new RuleTester({ cwd: repoRoot }).run(detectionRule.name, oxlintAstRule(detectionRule) as unknown as Parameters<RuleTester['run']>[1], {
      valid: [...new Set([...generated[family]!.valid, ...documentedLimits.filter(cell => cell.family === family).map(cell => cell.code)])].map(code => ({ code, filename })),
      invalid: [...new Set(generated[family]!.invalid)].map(code => ({ code, filename, errors: 1 })),
    });
  } finally {
    RuleTester.it = saved.it;
    RuleTester.describe = saved.describe;
  }
  expect(failures, failures.slice(0, 12).join('\n\n')).toEqual([]);
}
