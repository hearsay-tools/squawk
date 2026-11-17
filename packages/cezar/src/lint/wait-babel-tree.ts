import type { Program } from '@babel/types';
import { child, type EsNode } from './ast-rule.ts';

/**
 * Oxlint's ESTree program as the plain babel-shaped tree the cockpit wait rule reads
 * (hearsay-tools/squawk#3774). It copies the tree once into plain objects: no getters and no
 * `WeakMap`, which oxlint wraps and which made a lazy view cost more than the rule's own work.
 */

type Out = Record<string, unknown>;

function literalType(node: EsNode): string {
  if (node.regex) return 'RegExpLiteral';
  if (node.bigint !== undefined || typeof node.value === 'bigint') return 'BigIntLiteral';
  if (node.value === null) return 'NullLiteral';
  if (typeof node.value === 'string') return 'StringLiteral';
  if (typeof node.value === 'boolean') return 'BooleanLiteral';
  return 'NumericLiteral';
}

function isMethodDefinition(node: EsNode): boolean {
  return node.type === 'MethodDefinition' || node.type === 'TSAbstractMethodDefinition';
}

function methodType(node: EsNode): string {
  if (node.type === 'TSAbstractMethodDefinition' || child(node, 'value')?.type === 'TSEmptyBodyFunctionExpression') return 'TSDeclareMethod';
  return child(node, 'key')?.type === 'PrivateIdentifier' ? 'ClassPrivateMethod' : 'ClassMethod';
}

/** Babel's node types on a copy of `node`; `optional` says whether a call or member sits in an optional chain. */
function mapShape(out: Record<string, unknown>, node: EsNode, method: boolean, optional: (node: EsNode) => boolean): void {
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


const SKIPPED = new Set(['parent', 'tokens', 'comments', 'loc', 'range']);

const isNode = (value: unknown): value is EsNode => typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';

/** The receiver a chain continues through: a member's object, a call's callee, a non-null assertion's expression. */
function receiverOf(node: EsNode): EsNode | undefined {
  const next = node.type === 'MemberExpression' ? node.object : node.type === 'CallExpression' ? node.callee : node.type === 'TSNonNullExpression' ? node.expression : undefined;
  return isNode(next) ? next : undefined;
}

/** Each chain link's answer for the program being copied, so a long chain is walked once, not once per link. */
let chains = new Map<EsNode, boolean>();

/** Babel's optional node shapes begin at the first optional link of a chain; its base stays ordinary. */
function inOptionalChain(node: EsNode): boolean {
  const known = chains.get(node);
  if (known !== undefined) return known;
  const receiver = receiverOf(node);
  const optional = node.optional === true || (receiver !== undefined && inOptionalChain(receiver));
  chains.set(node, optional);
  return optional;
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
  mapShape(out, node, method, inOptionalChain);
  return out;
}

/** The program as plain babel-shaped nodes, offsets kept. */
export function babelTree(program: EsNode): Program {
  chains = new Map();
  try {
    return convert(program) as unknown as Program;
  } finally {
    chains = new Map();
  }
}
