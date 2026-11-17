import type { Node, Program } from '@babel/types';
import type { EsNode } from './ast-rule.ts';

/**
 * Oxlint's ESTree program as the plain babel-shaped tree the cockpit wait rule reads
 * (hearsay-tools/squawk#3774). It maps the same shapes `babelView` maps, but copies the tree once
 * into plain objects: no getters and no `WeakMap`, which oxlint wraps and which made the lazy view
 * cost more than the rule's own work.
 */

type Out = Record<string, unknown>;

const SKIPPED = new Set(['parent', 'tokens', 'comments', 'loc', 'range']);

const isNode = (value: unknown): value is EsNode => typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';

function literalType(node: EsNode): string {
  if (node.regex) return 'RegExpLiteral';
  if (node.bigint !== undefined || typeof node.value === 'bigint') return 'BigIntLiteral';
  if (node.value === null) return 'NullLiteral';
  if (typeof node.value === 'string') return 'StringLiteral';
  if (typeof node.value === 'boolean') return 'BooleanLiteral';
  return 'NumericLiteral';
}

const isMethodDefinition = (node: EsNode): boolean => node.type === 'MethodDefinition' || node.type === 'TSAbstractMethodDefinition';

function methodType(node: EsNode): string {
  if (node.type === 'TSAbstractMethodDefinition' || (node.value as EsNode | undefined)?.type === 'TSEmptyBodyFunctionExpression') return 'TSDeclareMethod';
  return (node.key as EsNode | undefined)?.type === 'PrivateIdentifier' ? 'ClassPrivateMethod' : 'ClassMethod';
}

/** The receiver a chain continues through: a member's object, a call's callee, a non-null assertion's expression. */
function receiverOf(node: EsNode): EsNode | undefined {
  const next = node.type === 'MemberExpression' ? node.object : node.type === 'CallExpression' ? node.callee : node.type === 'TSNonNullExpression' ? node.expression : undefined;
  return isNode(next) ? next : undefined;
}

/** Babel's optional node shapes begin at the first optional link of a chain; its base stays ordinary. */
function inOptionalChain(node: EsNode): boolean {
  for (let at: EsNode | undefined = node; at; at = receiverOf(at)) if (at.optional === true) return true;
  return false;
}

function shape(out: Out, node: EsNode, method: boolean): void {
  if (node.type === 'Literal') {
    out.type = literalType(node);
    if (node.regex && typeof node.regex === 'object') Object.assign(out, node.regex);
  } else if (node.type === 'Property') out.type = method ? 'ObjectMethod' : 'ObjectProperty';
  else if (isMethodDefinition(node)) out.type = methodType(node);
  else if (node.type === 'PropertyDefinition' || node.type === 'TSAbstractPropertyDefinition') {
    out.type = (node.key as EsNode | undefined)?.type === 'PrivateIdentifier' ? 'ClassPrivateProperty' : 'ClassProperty';
    if (node.type === 'TSAbstractPropertyDefinition') out.abstract = true;
  } else if ((node.type === 'CallExpression' || node.type === 'MemberExpression') && inOptionalChain(node)) out.type = `Optional${node.type}`;
  else if (node.type === 'PrivateIdentifier') {
    out.type = 'PrivateName';
    out.id = { type: 'Identifier', name: node.name, start: node.start, end: node.end };
  }
}

function copyFields(out: Out, node: EsNode, skipValue: boolean): void {
  for (const key of Object.keys(node)) {
    if (SKIPPED.has(key) || (skipValue && key === 'value')) continue;
    const value = node[key];
    out[key] = Array.isArray(value) ? value.map(item => (isNode(item) ? convert(item) : item)) : isNode(value) ? convert(value) : value;
  }
}

function convert(node: EsNode): Out {
  if (node.type === 'ChainExpression' && isNode(node.expression)) return convert(node.expression);
  const out: Out = {};
  const method = isMethodDefinition(node) || (node.type === 'Property' && node.method === true);
  if (method && isNode(node.value)) copyFields(out, node.value, false);
  copyFields(out, node, method);
  shape(out, node, method);
  return out;
}

/** The program as plain babel-shaped nodes, offsets kept. */
export const babelTree = (program: EsNode): Program => convert(program) as unknown as Program;

/** The child nodes of a plain babel-shaped node, in source order. */
export function plainChildren(node: Node): Node[] {
  const out: Node[] = [];
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'extra' || key === 'loc' || key.endsWith('Comments')) continue;
    const value = (node as unknown as Out)[key];
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) out.push(item as unknown as Node);
    } else if (isNode(value)) out.push(value as unknown as Node);
  }
  return out;
}
