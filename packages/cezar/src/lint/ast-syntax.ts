import { child, children, nameOf, stringOf, type EsNode } from './ast-rule.ts';

/** Expression wrappers keep the expression's syntax identity (hearsay-tools/squawk#3774). */
export function unwrap(node: EsNode | undefined): EsNode | undefined {
  while (node && ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'ParenthesizedExpression', 'ChainExpression', 'TSInstantiationExpression'].includes(node.type)) {
    node = child(node, 'expression');
  }
  return node;
}

export const literal = (node: EsNode | undefined): string | undefined => stringOf(unwrap(node));
export function propertyName(node: EsNode | undefined): string | undefined {
  node = unwrap(node);
  if (!node) return undefined;
  if (node.type !== 'MemberExpression') return nameOf(node) ?? literal(node);
  return node.computed ? literal(child(node, 'property')) : nameOf(child(node, 'property'));
}
export const offset = (node: EsNode): number => (node.range as [number, number])[0];
export const nodeLine = (node: EsNode): number => (node.loc as { start: { line: number } }).start.line;

/** Walk a selected subtree; oxlint's parent links are deliberately excluded. */
export function walk(node: EsNode, accept: (node: EsNode) => void): void {
  accept(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const one = child(node, key);
    if (one) walk(one, accept);
    else for (const item of children(node, key)) walk(item, accept);
  }
}
