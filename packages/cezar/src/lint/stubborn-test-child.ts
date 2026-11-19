import { child, children, stringOf, type AstContext, type AstRule, type EsNode } from './ast-rule.ts';
import { nodeLine, propertyName, unwrap } from './ast-syntax.ts';

/**
 * A test child that ignores SIGTERM outlives a test runner that is SIGKILLed before its cleanup
 * (hearsay-tools/squawk#3941). Tests build one with `packages/cezar/src/stubborn-child.testkit.ts`,
 * which adds an owner-death check.
 *
 * Static scope: test and testkit files, `fixtures/` and `__fixtures__/` files and native mocks
 * under `packages/`, and `scripts/*.test.mjs` (oxlint does not read `scripts/`;
 * `stubborn-test-child.test.ts` runs this rule over them). It reports
 * - a string literal or a template literal whose text ignores SIGTERM: a Node
 *   `process.on('SIGTERM', () => {})`, a shell `trap '' TERM` or a Python `SIG_IGN` for SIGTERM;
 * - a `process.on`/`process.once` call that installs an empty SIGTERM handler.
 * A template literal that interpolates `ownerGuardShell(…)` or `ownerGuardSource(…)` carries the
 * guard and passes. The helper, its cockpit copy and lint rule tests are exempt. A line with `// stubborn-child: <reason>` passes. The rule follows no value: a
 * pattern split across a template substitution is not seen.
 */

const HELPER = 'packages/cezar/src/stubborn-child.testkit.ts';
const WEB_COPY = 'packages/web/src/test/stubborn-child.ts';
/** Lint rule tests spell violations on purpose. */
const LINT_DIR = 'packages/cezar/src/lint/';
const GUARDS = new Set(['ownerGuardShell', 'ownerGuardSource']);

const IGNORES_TERM = [
  /process\.(?:on|once)\(\s*['"`]SIGTERM['"`]\s*,\s*(?:\(\s*\)\s*=>|function\s*\(\s*\))\s*(?:\{\s*\}|undefined|void 0)\s*\)/,
  /\btrap\s+(?:''|"")\s+(?:SIG)?(?:TERM|15)\b/,
  /SIGTERM\s*,\s*(?:\w+\.)?SIG_IGN\b/,
];

export const STUBBORN_TEST_CHILD_MESSAGE =
  'A SIGTERM-ignoring test child outlives a SIGKILLed test runner. Build it with ignoreTermSource, ' +
  'ignoreTermShell, ownerGuardShell or ignoreTermPython from packages/cezar/src/stubborn-child.testkit.ts, ' +
  'or add // stubborn-child: <reason> on this line (hearsay-tools/squawk#3941).';

const TEST_FILE = /\.(?:test|testkit)\.(?:[cm]?[jt]sx?)$/;

/** Whether the rule reads `file`, a repository-relative path. */
function inScope(file: string): boolean {
  if (file === HELPER || file === WEB_COPY || file.startsWith(LINT_DIR) || file.includes('/node_modules/')) return false;
  if (/^scripts\/[^/]+\.test\.mjs$/.test(file)) return true;
  if (!file.startsWith('packages/')) return false;
  return TEST_FILE.test(file) || /\/(?:__fixtures__|fixtures)\//.test(file) || /\/scripts\/mock-[^/]+\.mjs$/.test(file);
}

const ignoresTerm = (text: string) => IGNORES_TERM.some(pattern => pattern.test(text));

/** The text of a template literal's static parts, joined; a substitution splits a pattern. */
function templateText(node: EsNode): string {
  return children(node, 'quasis').map(quasi => (quasi.value as { cooked?: string | null; raw: string }).cooked ?? (quasi.value as { raw: string }).raw).join('\0');
}

/** A template that interpolates an owner guard for the trap or handler it spells. */
function interpolatesGuard(node: EsNode): boolean {
  return children(node, 'expressions').some(expression => {
    const call = unwrap(expression);
    return call?.type === 'CallExpression' && GUARDS.has(propertyName(child(call, 'callee')) ?? '');
  });
}

/** `() => {}`, `function () {}` or `() => undefined`. */
function isEmptyHandler(node: EsNode | undefined): boolean {
  if (node?.type !== 'ArrowFunctionExpression' && node?.type !== 'FunctionExpression') return false;
  const body = child(node, 'body');
  if (body?.type === 'BlockStatement') return children(body, 'body').length === 0;
  return body?.type === 'Identifier' && body.name === 'undefined';
}

/** `process.on('SIGTERM', () => {})` in code. */
function isIgnoringCall(node: EsNode): boolean {
  const callee = unwrap(child(node, 'callee'));
  if (callee?.type !== 'MemberExpression' || propertyName(child(callee, 'object')) !== 'process') return false;
  if (!['on', 'once'].includes(propertyName(callee) ?? '')) return false;
  const [signal, handler] = children(node, 'arguments');
  return stringOf(signal) === 'SIGTERM' && isEmptyHandler(handler);
}

/** Lines with a `// stubborn-child: <reason>` comment. */
function reasonedLines(sourceCode: AstContext['sourceCode']): Set<number> {
  return new Set(sourceCode.getAllComments()
    .filter(comment => comment.type === 'Line' && typeof comment.value === 'string' && /^\s*stubborn-child:\s*\S/.test(comment.value))
    .map(nodeLine));
}

export const stubbornTestChild: AstRule = {
  name: 'stubborn-test-child',
  description: 'A SIGTERM-ignoring test child needs an owner-death check (hearsay-tools/squawk#3941).',
  applies: inScope,
  create(report, { sourceCode }) {
    let reasoned: Set<number> | undefined;
    const found = (node: EsNode) => {
      reasoned ??= reasonedLines(sourceCode);
      if (!reasoned.has(nodeLine(node))) report(node, STUBBORN_TEST_CHILD_MESSAGE);
    };
    return {
      Literal(node) {
        const text = stringOf(node);
        if (text !== undefined && ignoresTerm(text)) found(node);
      },
      TemplateLiteral(node) {
        if (ignoresTerm(templateText(node)) && !interpolatesGuard(node)) found(node);
      },
      CallExpression(node) {
        if (isIgnoringCall(node)) found(node);
      },
    };
  },
};
