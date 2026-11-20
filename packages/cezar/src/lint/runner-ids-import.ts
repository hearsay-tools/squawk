import { posix } from 'node:path';
import type { AstRule } from './ast-rule.ts';
import { insideLoader } from './run-store-testkit-import.ts';

/**
 * `runners/ids.ts` lists the built-in runner ids as plain data for tests, testkits, the global
 * test setup and the lint rules that need the ids. Production code reads the runner registry
 * instead: an import from production would grow the closed runner list back (spec
 * 2026-11-18-runner-definitions, decision 5; hearsay-tools/squawk#3936).
 *
 * Static scope: non-test `.ts` files in `packages/cezar/src`, except the two lint rules that read
 * the ids (`lint/runner-roster-literal.ts`, `lint/runner-id-branch.ts`). The rule reports a
 * relative string literal that resolves to `runners/ids` (with or without `.ts`/`.js`) inside an
 * import, an export, an `import()`, an `import x = require()` or any call. A template literal and
 * a path assembled from pieces are out of scope.
 */

const MESSAGE =
  'Production code reads runner ids from the registry (registeredRunners, runnerDefinition in core/runner-registry.ts), ' +
  'never from runners/ids.ts, which only tests and lint rules read (hearsay-tools/squawk#3936).';

const IDS_MODULE = 'packages/cezar/src/runners/ids';

const ID_READERS = new Set([
  'packages/cezar/src/lint/runner-roster-literal.ts',
  'packages/cezar/src/lint/runner-id-branch.ts',
]);

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
  create: (report, { file }) => ({
    Literal(node) {
      if (typeof node.value === 'string' && namesRunnerIds(file, node.value) && insideLoader(node)) report(node, MESSAGE);
    },
  }),
};
