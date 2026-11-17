import type { Node } from '@babel/types';
import { child, stringOf, type EsNode, type Visitors } from './ast-rule.ts';

/**
 * A cached structural view for the existing typed AST engines (hearsay-tools/squawk#3774).
 * Oxlint owns parsing. This translates ESTree field shapes lazily, once per node, and never
 * reads source text. Parent links stay on the original nodes so recursive engines cannot cycle.
 */
const views = new WeakMap<EsNode, Node>();
const originals = new WeakMap<Node, EsNode>();
const isNode = (value: unknown): value is EsNode => typeof value === 'object' && value !== null
  && typeof (value as { type?: unknown }).type === 'string';

function fieldView(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? value : value.map(fieldView);
  return isNode(value) ? babelView(value) : value;
}

function needsChildView(value: unknown): boolean {
  return isNode(value) || (Array.isArray(value) && value.some(item => isNode(item) || Array.isArray(item)));
}

/** Child fields materialize only when an engine reads them; scalar arrays stay shared. */
function defineViewField(out: Record<string, unknown>, key: string, raw: unknown): void {
  if (!needsChildView(raw)) {
    out[key] = raw;
    return;
  }
  const descriptor = { enumerable: true, configurable: true, writable: true };
  Object.defineProperty(out, key, {
    enumerable: true,
    configurable: true,
    get(this: Record<string, unknown>) {
      const value = fieldView(raw);
      Object.defineProperty(this, key, { ...descriptor, value });
      return value;
    },
    set(this: Record<string, unknown>, value: unknown) {
      Object.defineProperty(this, key, { ...descriptor, value });
    },
  });
}

/** Copy lazy descriptors, so merging a method never reads its function body. */
function mergeMethodFields(out: Record<string, unknown>, value: EsNode): void {
  const descriptors = Object.getOwnPropertyDescriptors(babelView(value));
  delete descriptors.loc;
  Object.defineProperties(out, descriptors);
}

function literalType(node: EsNode): string {
  if (node.regex) return 'RegExpLiteral';
  if (node.bigint !== undefined || typeof node.value === 'bigint') return 'BigIntLiteral';
  if (node.value === null) return 'NullLiteral';
  if (typeof node.value === 'string') return 'StringLiteral';
  if (typeof node.value === 'boolean') return 'BooleanLiteral';
  return 'NumericLiteral';
}

/** Babel marks every call/member on an optional-chain spine, including optional:false tails. */
function optionalChainNode(node: EsNode): boolean {
  if (node.optional === true) return true;
  let current = node;
  for (let parent = current.parent; parent; parent = current.parent) {
    if (parent.type === 'ChainExpression') return true;
    const continues = (parent.type === 'MemberExpression' && parent.object === current)
      || (parent.type === 'CallExpression' && parent.callee === current)
      || (parent.type === 'TSNonNullExpression' && parent.expression === current);
    if (!continues) return false;
    current = parent;
  }
  return false;
}

function isMethodDefinition(node: EsNode): boolean {
  return node.type === 'MethodDefinition' || node.type === 'TSAbstractMethodDefinition';
}

function methodType(node: EsNode): string {
  if (node.type === 'TSAbstractMethodDefinition' || child(node, 'value')?.type === 'TSEmptyBodyFunctionExpression') return 'TSDeclareMethod';
  return child(node, 'key')?.type === 'PrivateIdentifier' ? 'ClassPrivateMethod' : 'ClassMethod';
}

function mapShape(out: Record<string, unknown>, node: EsNode, method: boolean): void {
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
  if ((node.type === 'CallExpression' || node.type === 'MemberExpression') && optionalChainNode(node)) out.type = `Optional${node.type}`;
  if (node.type === 'PrivateIdentifier') {
    out.type = 'PrivateName';
    out.id = { type: 'Identifier', name: node.name, start: node.start, end: node.end, loc: node.loc };
  }
}

/** The same shallow view is returned for every visit; child fields are memoized on first read. */
export function babelView(node: EsNode): Node {
  const cached = views.get(node);
  if (cached) return cached;
  if (node.type === 'ChainExpression' && isNode(node.expression)) {
    const expression = babelView(node.expression);
    views.set(node, expression);
    return expression;
  }
  const out: Record<string, unknown> = {};
  const view = out as unknown as Node;
  views.set(node, view);
  originals.set(view, node);
  const method = isMethodDefinition(node) || (node.type === 'Property' && node.method === true);
  if (method && isNode(node.value)) mergeMethodFields(out, node.value);
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'tokens' || key === 'comments' || key === 'loc' || (method && key === 'value')) continue;
    defineViewField(out, key, node[key]);
  }
  // Oxlint inherits a lazy loc getter. Object.keys does not include it.
  Object.defineProperty(out, 'loc', { enumerable: false, get: () => node.loc });
  mapShape(out, node, method);
  return view;
}

/** The oxlint node to use when reporting a finding from a typed AST engine. */
export function originalNode(node: Node): EsNode {
  const original = originals.get(node);
  if (!original) throw new Error('AST view has no original oxlint node');
  return original;
}

const offsetIndexes = new WeakMap<Node, Map<number, EsNode>>();
/** Locate a scanner's existing offset on the original tree, without rescanning source. */
export function originalAt(root: Node, offset: number): EsNode {
  let index = offsetIndexes.get(root);
  if (!index) {
    index = new Map();
    const walk = (node: Node) => {
      const original = originals.get(node);
      if (original && node.start != null && !index!.has(node.start)) index!.set(node.start, original);
      for (const child of astChildren(node)) walk(child);
    };
    walk(root);
    offsetIndexes.set(root, index);
  }
  return index.get(offset) ?? originalNode(root);
}

/** Static text in the key forms the typed engines already recognize. */
export function staticNodeText(node: EsNode | undefined): string | undefined {
  if (!node) return undefined;
  const literal = stringOf(node);
  if (literal !== undefined) return literal;
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticNodeText(child(node, 'left'));
    const right = staticNodeText(child(node, 'right'));
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (['ChainExpression', 'TSAsExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'ParenthesizedExpression'].includes(node.type)) return staticNodeText(child(node, 'expression'));
  return undefined;
}

/** Build the typed tree only after syntax in this file can reach the rule's checked forms. */
export function deferredAstView(relevantName: (name: string) => boolean, analyze: (root: Node) => void): Visitors {
  let relevant = false;
  const literal = (node: EsNode) => {
    if (relevant) return;
    const name = staticNodeText(node);
    if (name !== undefined && relevantName(name)) relevant = true;
  };
  const identifier = (node: EsNode) => {
    if (!relevant && typeof node.name === 'string' && relevantName(node.name)) relevant = true;
  };
  return {
    Identifier: identifier,
    PrivateIdentifier: identifier,
    Literal: literal,
    TemplateLiteral: literal,
    BinaryExpression: literal,
    'Program:exit'(node) {
      if (relevant) analyze(babelView(node));
    },
  };
}

const childLists = new WeakMap<Node, Node[]>();
const noChildren: Node[] = [];
const metadataFields = new Set(['parent', 'loc', 'start', 'end', 'range', 'tokens', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'extra']);
/** Cache structural children so multi-pass typed engines do not enumerate node metadata again. */
export function astChildren(node: Node): Node[] {
  const cached = childLists.get(node);
  if (cached) return cached;
  const found: Node[] = [];
  for (const key of Object.keys(node)) {
    if (metadataFields.has(key)) continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    for (const item of Array.isArray(value) ? value : [value]) {
      if (isNode(item)) found.push(item as unknown as Node);
    }
  }
  const result = found.length === 0 ? noChildren : found;
  childLists.set(node, result);
  return result;
}
