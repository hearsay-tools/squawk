import { matchesGlob } from 'node:path';
import { child, children, nameOf, stringOf, type AstRule, type EsNode, type Report, type Visitors } from './ast-rule.ts';

/** Shared syntax and file scopes for the owner rules (hearsay-tools/squawk#3774). */
export interface OwnerPolicy { name: string; message: string; files: string[]; ignores: string[] }
export function ownerRule(policy: OwnerPolicy, create: (report: (node: EsNode) => void) => Visitors): AstRule {
  return {
    name: policy.name,
    description: policy.message,
    applies: file => file.endsWith('.ts') && policy.files.some(pattern => matchesGlob(file, pattern)) && !policy.ignores.some(pattern => matchesGlob(file, pattern)),
    create: (report: Report) => create(node => report(node, policy.message)),
  };
}

/** Walk syntax children only; oxlint's parent links never enter this traversal. */
export function walk(node: EsNode, visit: (node: EsNode) => void): void {
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const single = child(node, key);
    if (single) walk(single, visit);
    else for (const item of children(node, key)) walk(item, visit);
  }
}
export function inside(node: EsNode, predicate: (ancestor: EsNode) => boolean): boolean {
  for (let at = node.parent; at; at = at.parent) if (predicate(at)) return true;
  return false;
}
export function member(node: EsNode | undefined): string | undefined {
  if (node?.type !== 'MemberExpression' || node.computed) return undefined;
  return nameOf(child(node, 'property'));
}
export function callee(node: EsNode): string | undefined {
  const fn = child(node, 'callee');
  return nameOf(fn) ?? member(fn);
}
export function key(node: EsNode): string | undefined {
  return node.computed ? undefined : nameOf(child(node, 'key'));
}
export function objectProperty(node: EsNode): boolean {
  return node.type === 'Property' && node.parent?.type === 'ObjectExpression';
}
export function functionNamed(node: EsNode, names: RegExp): boolean {
  return node.type === 'FunctionDeclaration' && names.test(nameOf(child(node, 'id')) ?? '');
}
export function methodNamed(node: EsNode, name: string): boolean {
  return (node.type === 'MethodDefinition' || (node.type === 'Property' && node.method === true)) && key(node) === name;
}
/** Literal string fragments, including each fixed part of an interpolated template. */
export function fragment(node: EsNode): string | undefined {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type !== 'TemplateElement') return undefined;
  const value = node.value as { raw: string };
  return value.raw;
}
/** A dotted syntax path. Dynamic subscripts and calls have no path. */
export function dotted(node: EsNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'Identifier' || node.type === 'PrivateIdentifier') return nameOf(node);
  const prop = member(node);
  const object = child(node, 'object');
  if (prop && object) {
    const prefix = dotted(object);
    if (prefix) return `${prefix}.${prop}`;
  }
  return undefined;
}
export function unwrap(node: EsNode | undefined): EsNode | undefined {
  while (node && ['ChainExpression', 'TSNonNullExpression', 'TSAsExpression', 'TSSatisfiesExpression'].includes(node.type)) node = child(node, 'expression');
  return node;
}
export function staticMember(node: EsNode | undefined, property: string): boolean {
  node = unwrapAccess(node);
  return node?.type === 'MemberExpression' && (node.computed ? stringOf(child(node, 'property')) : nameOf(child(node, 'property'))) === property;
}

/** Optional access and non-null assertions preserve the named receiver; casts do not. */
export function unwrapAccess(node: EsNode | undefined): EsNode | undefined {
  while (node && ['ChainExpression', 'TSNonNullExpression'].includes(node.type)) node = child(node, 'expression');
  return node;
}
