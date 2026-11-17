import { child, children, nameOf, stringOf, type EsNode } from '../ast-rule.ts';

export function nodes(node: EsNode): EsNode[] {
  const found: EsNode[] = [];
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const single = child(node, key);
    if (single) found.push(single);
    else for (const item of children(node, key)) found.push(item);
  }
  return found;
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
/** Defaults and parameter properties keep the annotation on the underlying binding. */
export function bindingTarget(node: EsNode | undefined): EsNode | undefined {
  if (node?.type === 'AssignmentPattern') return bindingTarget(child(node, 'left'));
  if (node?.type === 'TSParameterProperty') return bindingTarget(child(node, 'parameter'));
  return node;
}
export function parameterOwner(node: EsNode): EsNode | undefined {
  let owner = node.parent;
  while (owner?.type === 'AssignmentPattern' || owner?.type === 'TSParameterProperty') owner = owner.parent;
  return owner ?? undefined;
}
export function annotation(node: EsNode | undefined): EsNode | undefined {
  if (!node) return undefined;
  const type = child(bindingTarget(node)!, 'typeAnnotation');
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
