import { child, type EsNode } from './ast-rule.ts';

/**
 * Babel's node types for oxlint's ESTree shapes, as the cockpit wait engine's babel-shaped copy
 * reads them (`wait-babel-tree.ts`, hearsay-tools/squawk#3774).
 */

function literalType(node: EsNode): string {
  if (node.regex) return 'RegExpLiteral';
  if (node.bigint !== undefined || typeof node.value === 'bigint') return 'BigIntLiteral';
  if (node.value === null) return 'NullLiteral';
  if (typeof node.value === 'string') return 'StringLiteral';
  if (typeof node.value === 'boolean') return 'BooleanLiteral';
  return 'NumericLiteral';
}

export function isMethodDefinition(node: EsNode): boolean {
  return node.type === 'MethodDefinition' || node.type === 'TSAbstractMethodDefinition';
}

function methodType(node: EsNode): string {
  if (node.type === 'TSAbstractMethodDefinition' || child(node, 'value')?.type === 'TSEmptyBodyFunctionExpression') return 'TSDeclareMethod';
  return child(node, 'key')?.type === 'PrivateIdentifier' ? 'ClassPrivateMethod' : 'ClassMethod';
}

/** Babel's node types on a copy of `node`; `optional` says whether a call or member sits in an optional chain. */
export function mapShape(out: Record<string, unknown>, node: EsNode, method: boolean, optional: (node: EsNode) => boolean): void {
  if (node.type === 'Literal') {
    out.type = literalType(node);
    if (node.regex && typeof node.regex === 'object') Object.assign(out, node.regex);
  }
  if (node.type === 'Property') out.type = method ? 'ObjectMethod' : 'ObjectProperty';
  if (isMethodDefinition(node)) out.type = methodType(node);
  if (node.type === 'PropertyDefinition' || node.type === 'TSAbstractPropertyDefinition') {
    out.type = child(node, 'key')?.type === 'PrivateIdentifier' ? 'ClassPrivateProperty' : 'ClassProperty';
    if (node.type === 'TSAbstractPropertyDefinition') out.abstract = true;
  }
  if ((node.type === 'CallExpression' || node.type === 'MemberExpression') && optional(node)) out.type = `Optional${node.type}`;
  if (node.type === 'PrivateIdentifier') {
    out.type = 'PrivateName';
    out.id = { type: 'Identifier', name: node.name, start: node.start, end: node.end, loc: node.loc };
  }
}
