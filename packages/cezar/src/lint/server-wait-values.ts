import { childrenOf, isBigIntLiteral, isNumberLiteral, pathOf, wordOf, type N, type WaitTree } from './server-wait-tree.ts';

export { pathOf, wordOf };
import { UNREAD, type Held, type Place, type WaitNames } from './server-wait-names.ts';

/**
 * The numbers the server wait rule reads (hearsay-tools/squawk#3774): literals and arithmetic of
 * them, names for them, and the forms its list names for a limit, a start and a deadline. Each
 * reader takes the shape its list names and nothing else, so a bound written another way is one
 * the rule does not read.
 */

/** A bound on how long something runs, in milliseconds: `unreadable` when one exists the rule cannot evaluate, `undefined` when there is none. */
export type Bound = number | 'unreadable' | undefined;

export const isNumber = (value: unknown): value is number => typeof value === 'number';

/** A wait bounded by a numeric literal under this is short. Vitest's own default is 1 s. */
export const SHORT_BOUND_MS = 10_000;

/** What Vitest's `vi.waitFor`, `vi.waitUntil` and `expect.poll` wait when given no `timeout`. */
export const VITEST_DEFAULT_MS = 1_000;

/** The longest delay a timer keeps: a larger one fires after 1 ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** A wait bound is short unless it is a finite number of 10 s or more that a timer keeps. */
export const isShort = (ms: number | undefined): boolean => ms !== undefined && !(ms >= SHORT_BOUND_MS && ms <= MAX_TIMER_MS);

/** A poll loop's deadline is short unless it is a finite number of 10 s or more. */
export const isShortDeadline = (ms: number): boolean => !(ms >= SHORT_BOUND_MS && Number.isFinite(ms));

/** The tree, its names and the place a question is asked from. */
export interface WaitFile {
  tree: WaitTree;
  names: WaitNames;
}

/** Where a name is read, with the span a write must fall in to change it there: the use's function, up to the loop's end or the use. */
export interface Scope extends Place {
  from: number;
  to: number;
}

/** JavaScript's own numbers the evaluator reads by name. */
export const namedNumbers = new Map<string, number>([
  ['NaN', NaN], ['Infinity', Infinity], ['Number.NaN', NaN], ['Number.POSITIVE_INFINITY', Infinity], ['Number.NEGATIVE_INFINITY', -Infinity],
  ['Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER], ['Number.MIN_SAFE_INTEGER', Number.MIN_SAFE_INTEGER], ['Number.MAX_VALUE', Number.MAX_VALUE],
]);

export const mathFunctions = new Map<string, (...values: number[]) => number>([
  ['Math.max', Math.max], ['Math.min', Math.min], ['Math.abs', Math.abs], ['Math.floor', Math.floor], ['Math.ceil', Math.ceil], ['Math.round', Math.round], ['Math.trunc', Math.trunc],
]);

/** Names that stand for the same value in every file: JavaScript's own, which a bound may use without declaring. */
export const ownNames = new Set(['Math', 'Number', 'Date', 'Infinity', 'NaN', 'undefined', 'null', 'true', 'false']);

const numericLiteral =
  /^(?:0[xXoObB][\da-fA-F](?:_?[\da-fA-F])*|0[oO][0-7](?:_?[0-7])*|0[bB][01](?:_?[01])*|(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?)$/;

export const rawOf = (tree: WaitTree, node: N): string => tree.text.slice(node.start, node.end);

/** Whether a node's text is a type the text reads as one word: `number`, `const`, `Foo.Bar`. */
const wordType = (tree: WaitTree, type: N): boolean => /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(rawOf(tree, type));

/**
 * The value of a numeric expression: number literals, `NaN`, `Infinity`, unary `+` and `-`, parentheses,
 * `as` / `satisfies` / `!` / `<T>` wrappers, `+ - * / % **` of those, and `Math.max`, `min`, `abs`, `floor`,
 * `ceil`, `round` and `trunc` of those. A name or path is read through `names`. Anything else is `undefined`.
 */
export function numberOf(tree: WaitTree, node: N, names?: (path: string) => number | undefined, angled = false): number | undefined {
  if (isNumberLiteral(node)) {
    const raw = rawOf(tree, node);
    return numericLiteral.test(raw) ? Number(raw.replace(/_/g, '')) : undefined;
  }
  switch (node.type) {
    case 'UnaryExpression': return signed(tree, node, names);
    case 'BinaryExpression': return binary(tree, node, names);
    case 'TSAsExpression': case 'TSSatisfiesExpression': return wordType(tree, node.typeAnnotation) ? numberOf(tree, node.expression, names) : undefined;
    case 'TSNonNullExpression': return numberOf(tree, node.expression, names);
    case 'TSTypeAssertion': return !angled && /^<[\w$.[\]| ]+>$/.test(tree.text.slice(node.start, node.typeAnnotation.end + 1)) ? numberOf(tree, node.expression, names, true) : undefined;
    case 'CallExpression': return mathCall(tree, node, names);
    default: {
      const path = pathOf(tree, node);
      if (path === undefined) return undefined;
      return namedNumbers.has(path) ? namedNumbers.get(path) : names?.(path);
    }
  }
}

function signed(tree: WaitTree, node: N, names?: (path: string) => number | undefined): number | undefined {
  if (node.operator !== '-' && node.operator !== '+') return undefined;
  const value = numberOf(tree, node.argument, names);
  return value === undefined ? undefined : node.operator === '-' ? -value : value;
}

function binary(tree: WaitTree, node: N, names?: (path: string) => number | undefined): number | undefined {
  const left = numberOf(tree, node.left, names);
  const right = left === undefined ? undefined : numberOf(tree, node.right, names);
  if (left === undefined || right === undefined) return undefined;
  switch (node.operator) {
    case '+': return left + right;
    case '-': return left - right;
    case '*': return left * right;
    case '/': return left / right;
    case '%': return left % right;
    case '**': return left ** right;
    default: return undefined;
  }
}

function mathCall(tree: WaitTree, node: N, names?: (path: string) => number | undefined): number | undefined {
  const fn = mathFunctions.get(pathOf(tree, node.callee) ?? '');
  if (!fn || node.optional || node.arguments.length === 0 || node.typeArguments) return undefined;
  const values = node.arguments.map((argument: N) => numberOf(tree, argument, names));
  return values.every(isNumber) ? fn(...values) : undefined;
}

/** A read of the clock: `Date.now()`, `performance.now()`, `process.hrtime()` or `process.hrtime.bigint()`. */
export function isClock(node: N | undefined): boolean {
  if (node?.type !== 'CallExpression' || node.optional || node.arguments.length > 0 || node.typeArguments) return false;
  const path = memberPath(node.callee);
  return path === 'Date.now' || path === 'performance.now' || path === 'process.hrtime' || path === 'process.hrtime.bigint';
}

/** A path of names, spaces allowed between them. */
function memberPath(node: N): string | undefined {
  if (node.type === 'Identifier') return node.name;
  if (node.type !== 'MemberExpression' || node.computed || node.optional || node.property.type !== 'Identifier') return undefined;
  const object = memberPath(node.object);
  return object === undefined ? undefined : `${object}.${node.property.name}`;
}

/** Whether a value ends where the text reads it to: before `;`, `,`, `)`, a line break, or the end of what the use can see. */
export function endsValue(tree: WaitTree, node: N, limit = Infinity): boolean {
  const k = tree.source.after(node.end);
  return tree.source.breaksBetween(node.end, k) || ';,)'.includes(tree.text[k] ?? '') || k >= Math.min(limit, tree.text.length);
}

/** A held value that is a name or a path, alone: `const timeout = options.timeout;`. */
export const pathOnly = (file: WaitFile, value: N | typeof UNREAD, limit?: number): value is N =>
  value !== UNREAD && pathOf(file.tree, value) !== undefined && endsValue(file.tree, value, limit);

/** Whether a name or path comes from outside the file: a parameter, an import or a global. */
export function isOutside(file: WaitFile, place: Scope, node: N, at: number): boolean {
  const path = pathOf(file.tree, node);
  const root = path === undefined || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(path) ? undefined : path.split('.')[0];
  return root !== undefined && !file.names.declaredHere(place, root, at);
}

/** The names an expression's text reads, the way the text finds them: words not after a `.`, keywords included. */
export function namesRead(tree: WaitTree, node: N): string[] {
  const found: string[] = [];
  const visit = (at: N, parent?: N): void => {
    const word = keywordOf(at);
    if (word) found.push(word);
    if (at.type === 'Identifier' && !(parent?.type === 'MemberExpression' && parent.property === at && !parent.computed)) found.push(at.name);
    if (at.type === 'TSAsExpression' || at.type === 'TSSatisfiesExpression' || at.type === 'TSTypeAssertion') {
      if (!/^(?:<[\w$.[\]| ]+>|[\w$.]+(?:<[\w$.[\]| ]+>)?(?:\[\])*)$/.test(typeText(tree, at))) found.push('as');
      visit(at.expression, at);
      return;
    }
    for (const child of childrenOf(at)) visit(child, at);
  };
  visit(node);
  return found;
}

const typeText = (tree: WaitTree, node: N): string => (node.type === 'TSTypeAssertion' ? tree.text.slice(node.start, node.typeAnnotation.end + 1) : rawOf(tree, node.typeAnnotation));

function keywordOf(node: N): string | undefined {
  switch (node.type) {
    case 'ThisExpression': return 'this';
    case 'NewExpression': return 'new';
    case 'AwaitExpression': return 'await';
    case 'YieldExpression': return 'yield';
    case 'Super': return 'super';
    case 'UnaryExpression': return /^[a-z]+$/.test(node.operator) ? node.operator : undefined;
    case 'BinaryExpression': return node.operator === 'in' || node.operator === 'instanceof' ? node.operator : undefined;
    case 'FunctionExpression': return 'function';
    case 'ClassExpression': return 'class';
    default: return undefined;
  }
}

/** Whether the expression reads a name from outside the file: a parameter, an import or a global, so a value the caller sizes. */
export function sizedOutside(file: WaitFile, place: Scope, node: N, at: number): boolean {
  return namesRead(file.tree, node).some(name => !ownNames.has(name) && !file.names.declaredHere(place, name, at));
}

/** What a name the rule cannot follow stands for: a value the caller sizes when the file does not declare it, else no bound. */
const unfollowed = (file: WaitFile, place: Scope, name: string, at: number): Bound => (file.names.declaredHere(place, name, at) ? undefined : 'unreadable');

/** Whether the use's function writes `name` other than by a plain assignment, up to the end of the loop or the use. */
export const writtenOtherwise = (file: WaitFile, place: Scope, name: string): boolean =>
  file.names.writes(name, false, at => at >= place.from && at < place.to);

export const heldValues = (file: WaitFile, place: Scope, name: string, at: number): Held[] => file.names.held(place, name, at);

/**
 * What a name stands for where the code at `at` reads it: the smallest number it can hold. `unreadable` for a
 * value that comes from outside the file, `undefined` for one the file declares and the rule cannot evaluate.
 */
export function nameBound(file: WaitFile, place: Scope, name: string, at: number, depth = 0): Bound {
  const values = heldValues(file, place, name, at).map(each => each.value);
  if (depth > 3 || values.includes(UNREAD) || writtenOtherwise(file, place, name)) return unfollowed(file, place, name, at);
  const resolve = (inner: string): number | undefined => {
    const bound = /^[A-Za-z_$][\w$]*$/.test(inner) ? nameBound(file, place, inner, at, depth + 1) : undefined;
    return isNumber(bound) ? bound : undefined;
  };
  const read = values.map(value => (value === UNREAD ? undefined : numberOf(file.tree, value, resolve)));
  if (values.some((value, index) => read[index] === undefined && !pathOnly(file, value, at))) return undefined;
  if (values.length === 0 && file.names.declaredApart(name)) return undefined;
  if (values.some((value, index) => read[index] === undefined && !aliasOutside(file, place, value as N, at, depth))) return undefined;
  const known = read.filter(isNumber);
  return known.length > 0 ? Math.min(...known) : 'unreadable';
}

/** Whether the name or path `target`, the value of another name, comes from outside the file. */
export function aliasOutside(file: WaitFile, place: Scope, target: N, at: number, depth: number): boolean {
  if (target.type !== 'Identifier') return isOutside(file, place, target, at);
  return nameBound(file, place, target.name, at, depth + 1) !== undefined;
}

/**
 * A bound written at `at` in milliseconds: a number written out, or an expression of numbers and names for them.
 * A name or path from outside the file is `unreadable`. Any other expression, and a name the file sets to one, is
 * no bound.
 */
export function literalBound(file: WaitFile, place: Scope, node: N, at: number, tight = true): Bound {
  const word = tight ? wordOf(node) : undefined;
  if (word !== undefined && !namedNumbers.has(word)) return nameBound(file, place, word, at);
  const direct = numberOf(file.tree, node, name => {
    const bound = nameBound(file, place, name, at, 1);
    return isNumber(bound) ? bound : undefined;
  });
  if (direct !== undefined) return direct;
  const path = tight ? pathOf(file.tree, node) : undefined;
  return path !== undefined && path.includes('.') && isOutside(file, place, node, at) ? 'unreadable' : undefined;
}

/** A limit the text reads: a literal sum of products, `5 * 1_000`, or one name or path. */
export type Limit = { kind: 'name'; node: N } | { kind: 'sum'; value: number | undefined };

/** The terms and operators of a `+ - * /` expression, left to right. */
function terms(node: N, out: Array<N | string>): void {
  if (node.type === 'BinaryExpression' && ['+', '-', '*', '/'].includes(node.operator)) {
    terms(node.left, out);
    out.push(node.operator);
    terms(node.right, out);
  } else out.push(node);
}

/** Whether a node is a token the text reads as a number of a limit: one that starts with a digit. */
const digitToken = (tree: WaitTree, node: N): boolean => (isNumberLiteral(node) || isBigIntLiteral(node)) && /^\d[\w.+-]*$/.test(rawOf(tree, node));

/** Whether the text between `from` and `to` holds no parenthesis: the text's forms cannot read one. */
const unbracketed = (tree: WaitTree, from: number, to: number): boolean => !/[()]/.test(tree.text.slice(from, to));

/** A limit written from `from` to the end of `node`, or `undefined` for any other shape. */
export function limitOf(file: WaitFile, items: ReadonlyArray<N | string>, from: number, to: number): Limit | undefined {
  const { tree } = file;
  if (items.length === 1 && typeof items[0] !== 'string' && pathOf(tree, items[0]!) !== undefined) return { kind: 'name', node: items[0]! };
  if (!unbracketed(tree, from, to)) return undefined;
  if (!items.every((item, index) => (index % 2 === 0 ? typeof item !== 'string' && digitToken(tree, item) : typeof item === 'string'))) return undefined;
  return { kind: 'sum', value: numberOf(tree, sumNode(items)) };
}

/** The items rebuilt as one expression, so the evaluator reads them with the language's precedence. */
function sumNode(items: ReadonlyArray<N | string>): N {
  const values = items.filter((_, index) => index % 2 === 0) as N[];
  const operators = items.filter((_, index) => index % 2 === 1) as string[];
  const stack: N[] = [values[0]!];
  const ops: string[] = [];
  const rank = (op: string): number => (op === '*' || op === '/' ? 2 : 1);
  const fold = (): void => {
    const right = stack.pop()!;
    const left = stack.pop()!;
    stack.push({ type: 'BinaryExpression', operator: ops.pop(), left, right, start: left.start, end: right.end });
  };
  operators.forEach((op, index) => {
    while (ops.length > 0 && rank(ops.at(-1)!) >= rank(op)) fold();
    ops.push(op);
    stack.push(values[index + 1]!);
  });
  while (ops.length > 0) fold();
  return stack[0]!;
}

/** `node` split at its top-level `+ - * /`. */
export function termsOf(node: N): Array<N | string> {
  const out: Array<N | string> = [];
  terms(node, out);
  return out;
}

/** What a limit bounds, read where the code at `at` reads it. */
export function limitBound(file: WaitFile, place: Scope, limit: Limit, at: number): Bound {
  return limit.kind === 'name' ? literalBound(file, place, limit.node, at) : limit.value;
}

/** `Date.now() + <limit>` alone as a value, or `undefined`. */
export function clockPlusLimit(file: WaitFile, value: N, at: number): Limit | undefined {
  const items = termsOf(value);
  if (!isClock(items[0] as N) || items[1] !== '+' || !endsValue(file.tree, value, at)) return undefined;
  const rest = items.slice(2);
  const first = rest[0] as N | undefined;
  return first === undefined ? undefined : limitOf(file, rest, first.start, value.end);
}

/** A deadline held in a name: the smallest `name = Date.now() + <bound>` the code at `at` can see. Any other value it holds is no bound. */
export function definedBound(file: WaitFile, place: Scope, name: string, at: number): Bound {
  if (writtenOtherwise(file, place, name)) return unfollowed(file, place, name, at);
  const bounds = heldValues(file, place, name, at).map(({ value }): Bound => {
    const limit = value === UNREAD ? undefined : clockPlusLimit(file, value, at);
    if (limit) return limitBound(file, place, limit, at);
    return pathOnly(file, value, at) && aliasOutside(file, place, value, at, 0) ? 'unreadable' : undefined;
  });
  return bounds.includes(undefined) ? undefined : earliest(bounds) ?? 'unreadable';
}

/** Whether every value the start `name` can hold at `at` is a read of the clock, or a name or path of the caller's. */
export function startsAtClock(file: WaitFile, place: Scope, name: string, at: number): boolean {
  return name.includes('.') || heldValues(file, place, name, at).every(({ value }) =>
    value !== UNREAD && ((isClock(value) && endsValue(file.tree, value, at)) || pathOnly(file, value, at)));
}

/** A loop ends at the first of its exits that fires: the smallest bound, or `unreadable` when only unreadable ones exist. */
export function earliest(bounds: readonly Bound[]): Bound {
  const known = bounds.filter(isNumber);
  if (known.length > 0) return Math.min(...known);
  return bounds.includes('unreadable') ? 'unreadable' : undefined;
}

/** A condition of several parts holds once every part does: the largest of their bounds. */
export function latest(bounds: readonly Bound[]): Bound {
  if (bounds.includes(undefined)) return undefined;
  return bounds.every(isNumber) ? Math.max(...bounds) : 'unreadable';
}
