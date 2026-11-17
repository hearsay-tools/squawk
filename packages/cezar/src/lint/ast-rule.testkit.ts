import { join } from 'node:path';
import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';
import { oxlintAstRule, type AstRule } from './ast-rule.ts';
import { repoRoot } from './source-rule.ts';

/**
 * Valid and invalid snippets for one AST rule (hearsay-tools/squawk#3774). Oxlint's own
 * `RuleTester` parses each snippet in this process and runs the rule as oxlint does, so no case
 * starts the CLI. Every snippet sits at `file`, a path inside the rule's scope.
 */
export interface RuleCases {
  /** The repository path each snippet is linted as. */
  file: string;
  /** Snippets the rule must leave alone. */
  valid: string[];
  /** Snippets the rule must report exactly once. */
  invalid: (string | { code: string; errors: number })[];
}

RuleTester.describe = describe;
RuleTester.it = it;

export function ruleCases(rule: AstRule, { file, valid, invalid }: RuleCases): void {
  if (!rule.applies(file)) throw new Error(`${file} is outside cez/${rule.name}'s scope, so its cases would prove nothing`);
  const filename = join(repoRoot, file);
  // EsNode is a loose view of oxlint's typed nodes, so the wrapper's context type is narrower than
  // RuleTester's. Oxlint runs the same object at lint time; plugin.test.ts covers that path.
  const asOxlintRule = oxlintAstRule(rule) as unknown as Parameters<RuleTester['run']>[1];
  new RuleTester({ cwd: repoRoot }).run(rule.name, asOxlintRule, {
    valid: valid.map((code) => ({ code, filename })),
    invalid: invalid.map((entry) => typeof entry === 'string' ? { code: entry, filename, errors: 1 } : { ...entry, filename }),
  });
}
