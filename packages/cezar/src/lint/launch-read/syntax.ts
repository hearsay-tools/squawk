import { child, children, nameOf, stringOf, type EsNode } from '../ast-rule.ts';

export function nodes(node: EsNode): EsNode[] {
  return Object.keys(node).filter(key => key !== 'parent').flatMap(key => child(node, key) ?? children(node, key));
}
export function walk(node: EsNode, visit: (node: EsNode) => void): void {
  visit(node);
  for (const next of nodes(node)) walk(next, visit);
}
export function unwrap(node: EsNode | undefined): EsNode | undefined {
  if (!node) return undefined;
  if (['ParenthesizedExpression', 'TSNonNullExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'ChainExpression'].includes(node.type)) return unwrap(child(node, 'expression'));
  return node;
}
export function keyOf(node: EsNode): string | undefined {
  const key = child(node, node.type === 'MemberExpression' ? 'property' : 'key');
  return node.computed ? stringOf(key) : nameOf(key) ?? stringOf(key);
}
export function annotation(node: EsNode | undefined): EsNode | undefined {
  if (!node) return undefined;
  const type = child(node, 'typeAnnotation');
  return type?.type === 'TSTypeAnnotation' ? child(type, 'typeAnnotation') : type;
}
export function bindingNames(node: EsNode): string[] {
  const name = nameOf(node);
  if (name) return [name];
  if (node.type === 'Property') return bindingNames(child(node, 'value')!);
  if (node.type === 'AssignmentPattern') return bindingNames(child(node, 'left')!);
  if (node.type === 'RestElement') return bindingNames(child(node, 'argument')!);
  if (node.type === 'TSParameterProperty') return bindingNames(child(node, 'parameter')!);
  return [...children(node, 'properties'), ...children(node, 'elements')].flatMap(bindingNames);
}
export const functionTypes = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
export const assertions = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion']);
export function assertedTypes(node: EsNode | undefined): EsNode[] {
  if (!node) return [];
  const inner = child(node, 'expression');
  const own = assertions.has(node.type) ? [child(node, 'typeAnnotation')!] : [];
  return [...own, ...(unwrap(node) !== node ? assertedTypes(inner) : [])];
}
