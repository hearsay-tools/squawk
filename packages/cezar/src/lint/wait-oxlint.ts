import { join } from 'node:path';
import { RuleTester } from 'oxlint/plugins-dev';
import { oxlintAstRule, type AstContext, type AstRule, type Visitors } from './ast-rule.ts';
import { repoRoot } from './source-rule.ts';

/**
 * Runs AST visitors over files as oxlint parses them, in this process (hearsay-tools/squawk#3774).
 * The wait rules' baseline runner reads every site of a file, the baselined ones too, so it cannot
 * take the rule's findings; it runs the rule's own visitors here instead. Oxlint's `RuleTester`
 * parses and walks each file; nothing starts the CLI.
 */
export function inOxlint(files: ReadonlyArray<{ file: string; code: string }>, create: (context: AstContext) => Visitors): void {
  const rule: AstRule = { name: 'in-process', description: 'Runs visitors in this process.', applies: () => true, create: (_report, context) => create(context) };
  const asOxlintRule = oxlintAstRule(rule) as unknown as Parameters<RuleTester['run']>[1];
  const unique = new Map(files.map(each => [`${each.file}\0${each.code}`, each]));
  const previous = { describe: RuleTester.describe, it: RuleTester.it };
  const immediate = (_name: string, run: () => void): void => run();
  try {
    RuleTester.describe = immediate as typeof RuleTester.describe;
    RuleTester.it = immediate as typeof RuleTester.it;
    new RuleTester({ cwd: repoRoot }).run(rule.name, asOxlintRule, {
      valid: [...unique.values()].map(each => ({
        code: each.code, filename: join(repoRoot, each.file), languageOptions: { parserOptions: { ignoreNonFatalErrors: true } },
      })),
      invalid: [],
    });
  } finally {
    RuleTester.describe = previous.describe;
    RuleTester.it = previous.it;
  }
}
