import { matchesGlob } from 'node:path';
import { child, type AstRule, type AstContext, type EsNode } from './ast-rule.ts';
import { sameBoundary } from './twin-syntax.ts';
import { BUILT_IN_WAIT_VIAS, CONTRACT_WAIT_KINDS } from '../workflows/wait-kind-ids.ts';
import { CONTRACT_STEP_KINDS } from '../workflows/step-kind-ids.ts';

// test-enum-literal (hearsay-tools/squawk#3774).
const MESSAGE =
  "Name a contract enum value in a test through its constant, and build run records, waits and " +
  "events with the typed factories: RUN_STATUS, STEP_STATUS, STEP_KIND, WAIT_KIND, WAIT_PHASE, " +
  "WAIT_VIA, WAIT_SOURCE and makeRunRecord, makeTimerWait and the rest, from " +
  "packages/contract/src/test-factories.testkit.ts, and the wait constants and factories from " +
  "packages/contract/src/wait-factories.testkit.ts " +
  "(@open-mercato/cezar-api-client/contract/test-factories.testkit and .../wait-factories.testkit in the cockpit). A renamed field " +
  "or value then stops compiling in every test that uses it, where a literal still compiles and " +
  "asserts the old value (hearsay-tools/cezarion#1300, hearsay-tools/cezarion#1504, " +
  "hearsay-tools/cezarion#1812). An object that only shares the word, such as a GitHub status, " +
  "takes `// oxlint-disable-next-line cez/test-enum-literal -- <reason>` on the line above, with " +
  "the reason.";

export const TEST_ENUM_VALUES: Record<string, readonly string[]> = {
  status: ['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled', 'pending', 'skipped'],
  kind: [...new Set([...CONTRACT_WAIT_KINDS, ...CONTRACT_STEP_KINDS])],
  phase: ['open', 'resolved', 'delivered', 'cancelled'],
  via: BUILT_IN_WAIT_VIAS,
  source: ['agent', 'cezar'],
};
const FILES = ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.testkit.ts', 'packages/web/src/test/**/*.ts', 'packages/cezar/test/**/*.ts', 'packages/web/e2e/**/*.ts', 'packages/*/src/**/*.test.tsx', 'packages/web/src/test/**/*.tsx', 'packages/web/e2e/**/*.tsx'];
const ESCAPE = /\\(?:u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|\r\n|[\s\S])/;

/** Tree-sitter checks each raw string fragment, without decoding an escape sequence. */
function enumLiteral(node: EsNode, values: readonly string[], { sourceCode }: AstContext): boolean {
  return node.type === 'Literal' && typeof node.value === 'string' && sourceCode.getText(node).slice(1, -1).split(ESCAPE).some((fragment) => values.includes(fragment));
}

/** Keep tree-sitter's cast boundary when ESTree accepts a JSDoc non-null type. */
function outsideDirectCast(value: EsNode, context: AstContext): boolean {
  const annotation = child(value, 'typeAnnotation');
  if (annotation?.type !== 'TSJSDocNonNullableType') return false;
  const atEnd = sameBoundary(value, annotation, 1, context);
  if (annotation.postfix !== true) return !atEnd;
  const type = child(annotation, 'typeAnnotation');
  return atEnd && type !== undefined && sameBoundary(annotation, type, 0, context);
}

/** Object-expression pairs only; one direct `as` cast is allowed, other wrappers stay out. */
export const testEnumLiteral: AstRule = {
  name: 'test-enum-literal',
  description: 'Build test enum values through contract constants (hearsay-tools/cezarion#1812)',
  applies: (file) => FILES.some((glob) => matchesGlob(file, glob)),
  create: (report, context) => ({
    Property(node) {
      if (node.parent?.type !== 'ObjectExpression' || node.computed || node.method || node.kind !== 'init') return;
      const key = child(node, 'key');
      let value = child(node, 'value');
      if (!key || !value || !sameBoundary(node, value, 1, context)) return;
      const rawKey = context.sourceCode.getText(key);
      const name = key.type === 'Literal' ? rawKey.slice(1, -1) : rawKey;
      const values = Object.hasOwn(TEST_ENUM_VALUES, name) ? TEST_ENUM_VALUES[name] : undefined;
      if (!values) return;
      if (value.type === 'TSAsExpression') {
        // ESTree parses `as any!` as a JSDoc type; tree-sitter puts `!` around the cast.
        if (outsideDirectCast(value, context)) return;
        const expression = child(value, 'expression');
        if (!expression || !sameBoundary(value, expression, 0, context)) return;
        value = expression;
      }
      if (enumLiteral(value, values, context)) report(node, MESSAGE);
    },
  }),
};
