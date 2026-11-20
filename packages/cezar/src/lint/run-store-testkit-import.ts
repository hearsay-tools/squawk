import type { AstRule, EsNode } from './ast-rule.ts';

/**
 * Production code changes a run's status through `RunStore.move`; the run-store testkits seed
 * fixtures only (hearsay-tools/cezarion#2685). Non-test `.ts` files in `packages/cezar/src` hold
 * no string literal that ends in `run-store.testkit` or `run-store-open.testkit` (with or without
 * `.ts`/`.js`) inside an import, an export, an `import()` or any call. A template literal and a
 * path assembled from pieces are out of scope.
 */

const MESSAGE =
  'Production must use RunStore.move for status changes; run-store.testkit and run-store-open.testkit ' +
  'are for fixtures only (hearsay-tools/cezarion#2685).';

const TESTKIT = /run-store(-open)?\.testkit(\.ts|\.js)?$/;

const LOADERS = new Set([
  'ImportDeclaration',
  'ExportNamedDeclaration',
  'ExportAllDeclaration',
  'ExportDefaultDeclaration',
  'ImportExpression',
  'TSImportEqualsDeclaration',
  'CallExpression',
]);

/** Whether `node` sits inside an import, an export, an `import()`, an `import x = require()` or a call. */
export function insideLoader(node: EsNode): boolean {
  for (let at = node.parent; at; at = at.parent) if (LOADERS.has(at.type)) return true;
  return false;
}

export const runStoreTestkitImport: AstRule = {
  name: 'run-store-testkit-import',
  description: 'A run-store testkit loaded from production code (hearsay-tools/cezarion#2685)',
  applies: (file) =>
    file.startsWith('packages/cezar/src/') && file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.testkit.ts'),
  create: (report) => ({
    Literal(node) {
      if (typeof node.value === 'string' && TESTKIT.test(node.value) && insideLoader(node)) report(node, MESSAGE);
    },
  }),
};
