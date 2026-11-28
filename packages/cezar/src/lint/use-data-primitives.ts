import { child, children, nameOf, type AstRule, type EsNode } from './ast-rule.ts';

const OWNER = 'hearsay-tools/squawk#4377';

const SHA_MESSAGE =
  `Use <Sha /> or shortSha() from @/components/data-primitives instead of ad-hoc SHA slicing → ${OWNER}`;

const TIME_MESSAGE =
  `Use <RelativeTime /> from @/components/data-primitives instead of rendering shortAge() directly in JSX → ${OWNER}`;

const SHA_NAME = /(?:^|[^a-zA-Z])(?:sha|hash|SHA|HASH)$|(?:Sha|Hash)$/;

function literalNumber(node: EsNode | undefined): number | undefined {
  if (!node || node.type !== 'Literal' || typeof node.value !== 'number') return undefined;
  return node.value;
}

function unwrapped(node: EsNode | undefined): EsNode | undefined {
  let current = node;
  while (
    current &&
    (current.type === 'ChainExpression' ||
      current.type === 'ParenthesizedExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSAsExpression' ||
      current.type === 'TSTypeAssertion')
  ) {
    current = child(current, 'expression');
  }
  return current;
}

function isShaReceiver(node: EsNode | undefined): boolean {
  const target = unwrapped(node);
  if (!target) return false;
  if (target.type === 'Identifier') return SHA_NAME.test(String(target.name ?? ''));
  if (target.type === 'MemberExpression' && !target.computed) {
    const prop = nameOf(child(target, 'property'));
    return prop !== undefined && SHA_NAME.test(prop);
  }
  if (target.type === 'LogicalExpression') {
    return isShaReceiver(child(target, 'left')) || isShaReceiver(child(target, 'right'));
  }
  if (target.type === 'ConditionalExpression') {
    return isShaReceiver(child(target, 'consequent')) || isShaReceiver(child(target, 'alternate'));
  }
  return false;
}

function isAdHocShaSlice(node: EsNode): boolean {
  const callee = unwrapped(child(node, 'callee'));
  if (!callee || callee.type !== 'MemberExpression' || callee.computed) return false;
  if (nameOf(child(callee, 'property')) !== 'slice') return false;
  const args = children(node, 'arguments');
  if (args.length !== 2) return false;
  const start = literalNumber(args[0]);
  const end = literalNumber(args[1]);
  if (start !== 0 || end === undefined || end < 6 || end > 12) return false;
  return isShaReceiver(child(callee, 'object'));
}

function rendersInJsx(node: EsNode): boolean {
  let current = node.parent;
  while (
    current &&
    (current.type === 'TemplateLiteral' ||
      current.type === 'ConditionalExpression' ||
      current.type === 'LogicalExpression' ||
      current.type === 'BinaryExpression')
  ) {
    current = current.parent;
  }
  return current?.type === 'JSXExpressionContainer' && current.parent?.type !== 'JSXAttribute';
}

function isDirectJsxShortAge(node: EsNode): boolean {
  const callee = unwrapped(child(node, 'callee'));
  if (!callee || callee.type !== 'Identifier' || callee.name !== 'shortAge') return false;
  return rendersInJsx(node);
}

const EXEMPT_FILES = new Set([
  'packages/web/src/components/data-primitives.tsx',
  'packages/web/src/components/diff-stat.tsx',
]);

/**
 * Guard against ad-hoc SHA slicing and direct JSX `shortAge()` rendering in cockpit UI files.
 * Enforces the shared `Sha`, `DiffStat`, `Count`, `RelativeTime`, and `Path` primitives
 * (hearsay-tools/squawk#4377).
 */
export const useDataPrimitives: AstRule = {
  name: 'use-data-primitives',
  description: 'Use shared data primitives (Sha, DiffStat, Count, RelativeTime, Path) instead of ad-hoc formatting (hearsay-tools/squawk#4377)',
  applies: (file) =>
    file.startsWith('packages/web/src/') &&
    file.endsWith('.tsx') &&
    !EXEMPT_FILES.has(file) &&
    !/\.(?:test|testkit)\.tsx$/.test(file),
  create: (report) => ({
    CallExpression(node) {
      if (isAdHocShaSlice(node)) report(node, SHA_MESSAGE);
      if (isDirectJsxShortAge(node)) report(node, TIME_MESSAGE);
    },
  }),
};
