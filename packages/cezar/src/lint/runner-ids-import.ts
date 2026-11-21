import { posix } from 'node:path';
import { stringOf, type AstRule, type EsNode } from './ast-rule.ts';
import { insideLoader } from './run-store-testkit-import.ts';

/**
 * `runners/ids.ts` lists the built-in runner ids as plain data for tests, testkits, the global
 * test setup and the lint rules that need the ids. Production code reads the runner registry
 * instead: an import from production would grow the closed runner list back (spec
 * 2026-11-18-runner-definitions, decision 5; hearsay-tools/squawk#3936).
 *
 * Static scope: non-test `.ts` files in `packages/cezar/src`, except the lint rules that read
 * the ids (`lint/runner-roster-literal.ts`, `lint/runner-id-branch.ts`, `lint/mock-scenario-boundary.ts`). The rule reports a
 * relative string literal, or template literal with no substitution, that resolves to `runners/ids`
 * (with or without `.ts`/`.js`) inside an import, an export, an `import()`, an `import x = require()`,
 * a type import (`import('…').T`, `typeof import('…')`) or any call. A path assembled from pieces is out of scope.
 */

const MESSAGE =
  'Production code reads runner ids from the registry (registeredRunners, runnerDefinition in core/runner-registry.ts), ' +
  'never from runners/ids.ts, which only tests and lint rules read (hearsay-tools/squawk#3936).';

const IDS_MODULE = 'packages/cezar/src/runners/ids';

const ID_READERS = new Set([
  'packages/cezar/src/lint/runner-roster-literal.ts',
  'packages/cezar/src/lint/runner-id-branch.ts',
  'packages/cezar/src/lint/mock-scenario-boundary.ts',
]);

/** Whether `node` sits in a type import, `import('…').T` or `typeof import('…')`. */
function insideTypeImport(node: EsNode): boolean {
  for (let at = node.parent; at; at = at.parent) if (at.type === 'TSImportType') return true;
  return false;
}

/** Whether `specifier`, written in `file`, names `runners/ids.ts`. */
export function namesRunnerIds(file: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return false;
  return posix.join(posix.dirname(file), specifier).replace(/\.(ts|js)$/, '') === IDS_MODULE;
}

export const runnerIdsImport: AstRule = {
  name: 'runner-ids-import',
  description: 'runners/ids.ts loaded from production code (hearsay-tools/squawk#3936)',
  applies: (file) =>
    file.startsWith('packages/cezar/src/') && file.endsWith('.ts') && !file.endsWith('.test.ts')
    && !file.endsWith('.testkit.ts') && !ID_READERS.has(file),
  create: (report, { file }) => {
    const check = (node: EsNode) => {
      const specifier = stringOf(node);
      if (specifier !== undefined && namesRunnerIds(file, specifier) && (insideLoader(node) || insideTypeImport(node))) report(node, MESSAGE);
    };
    return { Literal: check, TemplateLiteral: check };
  },
};
