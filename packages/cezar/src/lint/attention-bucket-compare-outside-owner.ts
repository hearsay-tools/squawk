import { child, type AstRule, type AstContext, type EsNode } from './ast-rule.ts';
import { namedMember, sameBoundary } from './twin-syntax.ts';

// attention-bucket-compare-outside-owner (hearsay-tools/squawk#3774).
const MESSAGE =
  "Ask the attention owner, packages/contract/src/attention.ts, instead of comparing an attention " +
  "bucket to a name: `needsYou(run)` for \"Needs you\" and its dots, `rungNeedsYou(rung)` for a " +
  "reader that holds only the rung (hearsay-tools/squawk#2275). A second copy of the rule drifts: " +
  "the sidebar, the tab dot and the project rail left pending permission requests out of Needs you. " +
  "Readers with a rule of their own (a thread's copy, a group heading) use a reasoned oxlint " +
  "suppression.";

export const ATTENTION_BUCKETS = ['permission', 'error', 'waiting', 'running', 'unseen', 'none'];
const OPERATORS = new Set(['===', '!==', '==', '!=']);

function bucketLiteral(node: EsNode, { sourceCode }: AstContext): boolean {
  if (node.type !== 'Literal' || typeof node.value !== 'string') return false;
  return ATTENTION_BUCKETS.includes(sourceCode.getText(node).slice(1, -1));
}

const WRAPPERS = new Set(['ChainExpression', 'TSNonNullExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'ParenthesizedExpression']);
const TRAILING_CASTS = new Set(['TSNonNullExpression', 'TSAsExpression', 'TSSatisfiesExpression']);

/** Peel wrappers in AST order, retaining the old grammar's operand and precedence limits. */
function comparisonOperand(node: EsNode, side: 'left' | 'right', context: AstContext): EsNode | undefined {
  while (WRAPPERS.has(node.type)) {
    const expression = child(node, 'expression');
    if (!expression) return undefined;
    // Tree-sitter puts trailing casts around the comparison; ESTree puts them on its right.
    // A cast on the left, an angle assertion or parentheses still blocks the old direct match.
    if (node.type !== 'ChainExpression' &&
        (side !== 'right' || !TRAILING_CASTS.has(node.type) || !sameBoundary(node, expression, 0, context))) return undefined;
    node = expression;
  }
  return node;
}

/** Direct equality operands with tree-sitter precedence; no type or value flow. */
export const attentionBucketCompareOutsideOwner: AstRule = {
  name: 'attention-bucket-compare-outside-owner',
  description: 'Ask the attention owner before comparing buckets (hearsay-tools/squawk#2275)',
  applies: (file) => /^(?:packages\/web|packages\/cezar)\/src\/.*\.tsx?$/.test(file) && !/\.(?:test\.tsx?|testkit\.ts)$/.test(file),
  create: (report, context) => ({
    BinaryExpression(node) {
      if (!OPERATORS.has(String(node.operator))) return;
      let left = child(node, 'left');
      let right = child(node, 'right');
      if (!left || !right || !sameBoundary(node, left, 0, context) || !sameBoundary(node, right, 1, context)) return;
      left = comparisonOperand(left, 'left', context);
      right = comparisonOperand(right, 'right', context);
      if (!left || !right) return;
      if ((namedMember(left, 'bucket', context) && bucketLiteral(right, context)) ||
          (namedMember(right, 'bucket', context) && bucketLiteral(left, context))) report(node, MESSAGE);
    },
  }),
};
