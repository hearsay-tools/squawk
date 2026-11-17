import type { Program } from '@babel/types';
import type { EsNode } from './ast-rule.ts';
import { isMethodDefinition, mapShape } from './ast-node-view.ts';

/**
 * Oxlint's ESTree program as the plain babel-shaped tree the cockpit wait rule reads
 * (hearsay-tools/squawk#3774). It maps the same shapes `babelView` maps, but copies the tree once
 * into plain objects: no getters and no `WeakMap`, which oxlint wraps and which made the lazy view
 * cost more than the rule's own work.
 */

type Out = Record<string, unknown>;

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
