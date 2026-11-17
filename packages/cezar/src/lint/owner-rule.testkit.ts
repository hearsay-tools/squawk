import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AstRule, EsNode } from './ast-rule.ts';
import { ruleCases } from './ast-rule.testkit.ts';
import { OWNER_POLICIES } from './owner-policies.ts';
import { repoRoot } from './source-rule.ts';

/** Check only the named exceptions, with AST visitors, never a repository scan (hearsay-tools/squawk#3774). */
export function ownerExceptions(rule: AstRule): void {
  const exceptions = OWNER_POLICIES[rule.name]!.ignores.filter(file => !file.includes('*'));
  for (const file of exceptions) {
    const probe: AstRule = {
      ...rule,
      name: `${rule.name}: ${file} still needs its exception`,
      applies: () => true,
      create(report, context) {
        let hit: EsNode | undefined;
        const visitors = rule.create(node => { hit = node; }, context);
        return { ...visitors, 'Program:exit'() { if (hit) report(hit, 'Remove a stale owner exception.'); } };
      },
    };
    ruleCases(probe, { file, valid: [], invalid: [readFileSync(join(repoRoot, file), 'utf8')] });
  }
}
