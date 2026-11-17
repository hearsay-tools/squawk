import type { Node } from '@babel/types';
import { child, stringOf, type EsNode, type Visitors } from './ast-rule.ts';

/**
 * A cached structural view for the existing typed AST engines (hearsay-tools/squawk#3774).
 * Oxlint owns parsing. This translates ESTree field shapes once per node and never reads source
 * text. Parent links stay on the original nodes so recursive engines cannot cycle.
 */
const views = new WeakMap<EsNode, Node>();
/** A view's own oxlint node and its structural children. Symbol keys stay out of `Object.keys`. */
const ORIGINAL = Symbol('original');
const CHILDREN = Symbol('children');
type ViewFields = Record<string | symbol, unknown>;
const originalOf = (node: Node): EsNode | undefined => (node as unknown as ViewFields)[ORIGINAL] as EsNode | undefined;
const isNode = (value: unknown): value is EsNode => typeof value === 'object' && value !== null
  && typeof (value as { type?: unknown }).type === 'string';

function fieldView(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? value : value.map(fieldView);
  return isNode(value) ? babelView(value) : value;
}

function needsChildView(value: unknown): boolean {
  return isNode(value) || (Array.isArray(value) && value.some(item => isNode(item) || Array.isArray(item)));
}

/**
 * Every view inherits `loc` from here, so it stays out of `Object.keys` and costs no own property.
 * Each typed engine walks the whole view, so views copy their fields once as plain data.
 */
const VIEW_PROTOTYPE = Object.create(Object.prototype, {
  loc: { enumerable: false, get(this: Node) { return originalOf(this)?.loc; } },
}) as object;

/** Copy plain fields, so merging a method keeps the function's fields before its own. */
function mergeMethodFields(out: ViewFields, value: EsNode): void {
  const fn = babelView(value) as unknown as Record<string, unknown>;
  for (const key of Object.keys(fn)) out[key] = fn[key];
}

function literalType(node: EsNode): string {
  if (node.regex) return 'RegExpLiteral';
  if (node.bigint !== undefined || typeof node.value === 'bigint') return 'BigIntLiteral';
  if (node.value === null) return 'NullLiteral';
  if (typeof node.value === 'string') return 'StringLiteral';
  if (typeof node.value === 'boolean') return 'BooleanLiteral';
  return 'NumericLiteral';
}

const chainMembership = new WeakMap<EsNode, boolean>();

/** Only receiver/callee edges continue a chain; a nested ChainExpression starts a new one. */
function chainReceiver(node: EsNode): EsNode | undefined {
  if (node.type === 'MemberExpression') return child(node, 'object');
  if (node.type === 'CallExpression') return child(node, 'callee');
  if (node.type === 'TSNonNullExpression') return child(node, 'expression');
  return undefined;
}

/** Babel's optional node shapes begin at the first optional segment, leaving its base ordinary. */
function optionalChainNode(node: EsNode): boolean {
  const known = chainMembership.get(node);
  if (known !== undefined) return known;
  if (node.optional === true) { chainMembership.set(node, true); return true; }
  const pending: EsNode[] = [node];
  let current = chainReceiver(node);
  let optional = false;
  while (current) {
    const cached = chainMembership.get(current);
    if (cached !== undefined) { optional = cached; break; }
    pending.push(current);
    if (current.optional === true) { optional = true; break; }
    current = chainReceiver(current);
  }
  for (const member of pending) chainMembership.set(member, optional);
  return optional;
}

export function isMethodDefinition(node: EsNode): boolean {
  return node.type === 'MethodDefinition' || node.type === 'TSAbstractMethodDefinition';
}

function methodType(node: EsNode): string {
  if (node.type === 'TSAbstractMethodDefinition' || child(node, 'value')?.type === 'TSEmptyBodyFunctionExpression') return 'TSDeclareMethod';
  return child(node, 'key')?.type === 'PrivateIdentifier' ? 'ClassPrivateMethod' : 'ClassMethod';
}

/** Babel's node types on a view or a copy of `node`; `optional` says whether a call or member sits in an optional chain. */
export function mapShape(out: Record<string, unknown>, node: EsNode, method: boolean, optional: (node: EsNode) => boolean = optionalChainNode): void {
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

/** The same view is returned for every visit; its child views are built with it. */
export function babelView(node: EsNode): Node {
  const cached = views.get(node);
  if (cached) return cached;
  if (node.type === 'ChainExpression' && isNode(node.expression)) {
    const expression = babelView(node.expression);
    views.set(node, expression);
    return expression;
  }
  const out = Object.create(VIEW_PROTOTYPE) as ViewFields;
  const view = out as unknown as Node;
  views.set(node, view);
  out[ORIGINAL] = node;
  const method = isMethodDefinition(node) || (node.type === 'Property' && node.method === true);
  if (method && isNode(node.value)) mergeMethodFields(out, node.value);
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'tokens' || key === 'comments' || key === 'loc' || (method && key === 'value')) continue;
    const raw = node[key];
    out[key] = needsChildView(raw) ? fieldView(raw) : raw;
  }
  mapShape(out, node, method);
  out[CHILDREN] = structuralChildren(view);
  return view;
}

/** The oxlint node to use when reporting a finding from a typed AST engine. */
export function originalNode(node: Node): EsNode {
  const original = originalOf(node);
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
      const original = originalOf(node);
      if (original && node.start != null && !index!.has(node.start)) index!.set(node.start, original);
      for (const child of astChildren(node)) walk(child);
    };
    walk(root);
    offsetIndexes.set(root, index);
  }
  return index.get(offset) ?? originalNode(root);
}

const staticTexts = new WeakMap<EsNode, string | undefined>();

/** Static text is evaluated once per immutable node, including an unknown result. */
export function staticNodeText(node: EsNode | undefined): string | undefined {
  if (!node) return undefined;
  if (staticTexts.has(node)) return staticTexts.get(node);
  const text = evaluateStaticNodeText(node);
  staticTexts.set(node, text);
  return text;
}

/** Static text in the key forms the typed engines already recognize. */
function evaluateStaticNodeText(node: EsNode): string | undefined {
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
  const own = (node as unknown as ViewFields)[CHILDREN] as Node[] | undefined;
  if (own) return own;
  const cached = childLists.get(node);
  if (cached) return cached;
  const result = structuralChildren(node);
  childLists.set(node, result);
  return result;
}

function structuralChildren(node: Node): Node[] {
  const found: Node[] = [];
  for (const key of Object.keys(node)) {
    if (metadataFields.has(key)) continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    for (const item of Array.isArray(value) ? value : [value]) {
      if (isNode(item)) found.push(item as unknown as Node);
    }
  }
  return found.length === 0 ? noChildren : found;
}
