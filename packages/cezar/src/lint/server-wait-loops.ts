import { isFunction, isLoop, insideBraces, type N, type WaitTree } from './server-wait-tree.ts';
import { childrenOf, placeOf } from './server-wait-names.ts';
import {
  type Bound, type Limit, type Scope, type WaitFile, isNumber, isClock, pathOf, rawOf, literalBound, limitBound, limitOf, termsOf,
  definedBound, startsAtClock, isOutside, sizedOutside, earliest, latest,
} from './server-wait-values.ts';

/**
 * The server wait rule's poll loops (hearsay-tools/squawk#3774): which loop a sleep sits in, whether every pass
 * reaches it, and how long the loop can run by the list in `test-wait-discipline.ts`.
 */

export interface PollLoop {
  node: N;
  /** The loop's `for`, `while` or `do`: the site is the line this sits on. */
  keyword: number;
  /** The header's parentheses; for a `do`, those of its trailing `while (…)`; none for a `do` with no braces. */
  head: [number, number] | undefined;
  /** The body's first and last character; a body with no braces runs from the sleep to the `;` that ends it. */
  body: [number, number];
  braceless: boolean;
  scope: Scope;
}

/** The statement an expression starts: climb while the parent starts where the node does. */
function statementOf(tree: WaitTree, node: N): N | undefined {
  const statement = (at: N): boolean => at.type.endsWith('Statement') || at.type.endsWith('Declaration');
  let at = node;
  for (let parent = tree.parent(at); parent && parent.start === node.start && !statement(at); parent = tree.parent(at)) at = parent;
  return at.type.endsWith('Statement') ? at : undefined;
}

/** The end of a statement with no braces: its `;`, or the next one after it. */
function semicolonAfter(tree: WaitTree, statement: N): number {
  if (tree.text[statement.end - 1] === ';') return statement.end - 1;
  for (let i = statement.end; i < tree.text.length; i += 1) if (tree.text[i] === ';' && !tree.source.commentAt(i)) return i;
  return tree.text.length;
}

/** The loop a sleep is the brace-less body of, through `if (…)` heads: `while (!ready()) await sleep(10);`. */
function bracelessLoop(file: WaitFile, sleep: N): N | undefined {
  const { tree } = file;
  const statement = statementOf(tree, sleep);
  if (!statement || statement.start !== sleep.start) return undefined;
  let child = statement;
  let parent = tree.parent(child);
  if (parent?.type === 'DoWhileStatement' && parent.body === child) return parent;
  for (; parent; child = parent, parent = tree.parent(child)) {
    if (tree.text[tree.source.before(child.start)] !== ')') return undefined;
    if (isLoop(parent) && parent.type !== 'DoWhileStatement' && parent.body === child) return parent;
    if (parent.type !== 'IfStatement' || parent.consequent !== child) return undefined;
  }
  return undefined;
}

/** The innermost loop whose braced body holds the sleep, with no function between them. */
function bracedLoop(tree: WaitTree, sleep: N): N | undefined {
  for (const above of tree.ancestors(sleep)) {
    if (isFunction(above) && tree.inFrame(above, sleep.start)) return undefined;
    const loop = tree.parent(above);
    if (above.type === 'BlockStatement' && isLoop(loop) && loop!.body === above) return loop;
  }
  return undefined;
}

/** The parentheses of a loop's header: after `while`, `for` or `for await`, or the `while (…)` after a `do`'s body. */
function headOf(tree: WaitTree, loop: N, braceless: boolean): [number, number] | undefined {
  const { source, text } = tree;
  if (loop.type === 'DoWhileStatement') {
    if (braceless) return undefined;
    const end = text[loop.end - 1] === ';' ? source.before(loop.end - 1) : loop.end - 1;
    return [source.after(source.after(loop.body.end) + 'while'.length), end];
  }
  let open = source.after(loop.start + (loop.type === 'WhileStatement' ? 'while' : 'for').length);
  if (text.startsWith('await', open)) open = source.after(open + 'await'.length);
  return [open, source.before(loop.body.start)];
}

/** The poll loop a sleep sits in, if any. */
export function loopAround(file: WaitFile, sleep: N): PollLoop | undefined {
  const { tree } = file;
  const braceless = bracelessLoop(file, sleep);
  const node = braceless ?? bracedLoop(tree, sleep);
  if (!node) return undefined;
  const body: [number, number] = braceless ? [sleep.start, semicolonAfter(tree, statementOf(tree, sleep)!)] : [node.body.start, node.body.end - 1];
  const head = headOf(tree, node, braceless !== undefined);
  const place = placeOf(tree, node, false);
  return {
    node, keyword: node.start, head, body, braceless: braceless !== undefined,
    scope: { ...place, from: place.bounds.at(-1) ?? 0, to: Math.max(body[1], head?.[1] ?? 0) + 1 },
  };
}

/** Whether a `continue`, as a statement or a word, sits between two offsets, outside the functions nested there when `own`. */
function continueBetween(file: WaitFile, from: number, to: number, own: readonly N[] | undefined): boolean {
  const { tree } = file;
  const inside = (at: number): boolean => at >= from && at < to && (own === undefined || !tree.inOtherFrame(at, own));
  return tree.identifiers('continue').some(id => inside(id.start)) || tree.continues.some(node => inside(node.start));
}

/**
 * Whether every pass of the loop reaches the sleep: nothing before it in the body skips it, not a nested `{ … }`, not
 * a short circuit or a ternary, not an `if (…)` or `else` without braces, and no `continue`.
 */
export function runsEveryPass(file: WaitFile, loop: PollLoop, sleep: N): boolean {
  if (loop.braceless) return true;
  const { tree } = file;
  let child = sleep;
  for (const above of tree.ancestors(sleep)) {
    if (above === loop.node.body) break;
    if (insideBraces(above, child)) return false;
    child = above;
  }
  if (continueBetween(file, loop.body[0] + 1, sleep.start, undefined)) return false;
  const k = tree.source.before(sleep.start);
  if (k <= loop.body[0]) return true;
  const { text } = tree;
  const ch = text[k] ?? '';
  if (';{}'.includes(ch)) return true;
  const two = text.slice(k - 1, k + 1);
  return !(ch === ')' || ch === '?' || ch === ':' || two === '&&' || two === '||' || tree.source.wordEndingAt(k) === 'else');
}

/** A sleep in a poll loop: its delay, and whether every pass reaches it. */
export interface LoopSleep {
  delay: N | undefined;
  always: boolean;
}

/** What one poll loop is judged by. */
interface Probe {
  file: WaitFile;
  loop: PollLoop;
  /** The spans that run again every pass: the body, and the header without a `for`'s first clause. */
  again: Array<[number, number]>;
  /** The `for` header's three clauses, when it has exactly three. */
  clauses?: { init: N | null; update: N | null };
  interval: Bound;
}

const within = (spans: ReadonlyArray<[number, number]>) => (at: number): boolean => spans.some(([from, to]) => at >= from && at < to);

/** The closures of the loop's function, up to the loop's end: a write there can run in any pass. */
const inClosure = (cx: Probe) => (at: number): boolean => at >= cx.loop.scope.from && at < cx.loop.scope.to && cx.file.tree.inOtherFrame(at, cx.loop.scope.chain);

/** The names and paths a node's text reads: what can move under a comparison. */
function pathsIn(tree: WaitTree, node: N | undefined, skip?: string): string[] {
  if (!node) return [];
  const found: string[] = [];
  const visit = (at: N): void => {
    const path = at.type === 'MemberExpression' || at.type === 'Identifier' ? pathOf(tree, at) : undefined;
    if (path !== undefined && at.type === 'Identifier') {
      if (path !== skip) found.push(path);
      return;
    }
    if (path !== undefined) {
      found.push(path);
      return;
    }
    for (const child of childrenOf(at)) if (!(at.type === 'MemberExpression' && child === at.property && !at.computed)) visit(child);
  };
  visit(node);
  return found;
}

/** Where `let|const|var root` is declared, as the keyword's offset, when the code at `at` can see it. */
function declarationsSeen(cx: Probe, root: string, at: number): number[] {
  const { tree } = cx.file;
  return tree.identifiers(root).flatMap(id => {
    const declarator = tree.parent(id);
    const keyword = tree.source.before(id.start);
    const word = tree.source.wordEndingAt(keyword);
    if (declarator?.type !== 'VariableDeclarator' || declarator.id !== id || !['let', 'const', 'var'].includes(word)) return [];
    const start = keyword - word.length + 1;
    if (start >= at || tree.inOtherFrame(start, cx.loop.scope.chain)) return [];
    const brace = tree.braceAround(declarator);
    return brace === undefined || (brace.start < at && brace.end > at) ? [start] : [];
  });
}

/** Whether a pass of the loop changes the name the code at `at` reads: it is declared in the body, or written in the loop or a closure. */
function movesIn(cx: Probe, name: string, at: number): boolean {
  const { names } = cx.file;
  const root = name.split('.')[0] ?? '';
  if (declarationsSeen(cx, root, at).some(keyword => keyword >= cx.loop.body[0])) return true;
  const written = (test: (at: number) => boolean): boolean => names.writes(name, true, test) || names.writes(root, true, test);
  return written(within(cx.again)) || written(inClosure(cx));
}

const movesAny = (cx: Probe, node: N | undefined, at: number, skip?: string): boolean => pathsIn(cx.file.tree, node, skip).some(name => movesIn(cx, name, at));

const IMPURE = new Set(['AssignmentExpression', 'AssignmentPattern', 'UpdateExpression', 'NewExpression', 'AwaitExpression', 'VariableDeclarator', 'ImportExpression']);

/** Whether a condition only reads: no write, no call but a read of the clock, no `new`, `await` or `delete`. */
function isPure(root: N): boolean {
  let pure = true;
  const visit = (node: N): void => {
    if (!pure || isClock(node)) return;
    if (IMPURE.has(node.type) || (node.type === 'UnaryExpression' && node.operator === 'delete')) pure = false;
    else if (node.type === 'CallExpression' && !node.typeArguments) pure = false;
    else if (node.type === 'Identifier' && (node.name === 'new' || node.name === 'await' || node.name === 'delete')) pure = false;
    for (const child of childrenOf(node)) visit(child);
  };
  visit(root);
  return pure;
}

const COMPARE = new Set(['<', '<=', '>', '>=']);

/** Whether the text of `node` holds a parenthesis outside the clock reads in it: the listed forms hold none. */
function parenthesized(tree: WaitTree, node: N): boolean {
  const clocks: N[] = [];
  const visit = (at: N): void => {
    if (isClock(at)) clocks.push(at);
    else for (const child of childrenOf(at)) visit(child);
  };
  visit(node);
  for (let i = node.start; i < node.end; i += 1) {
    if ((tree.text[i] === '(' || tree.text[i] === ')') && !clocks.some(clock => i >= clock.start && i < clock.end) && !tree.source.commentAt(i)) return true;
  }
  return false;
}

/** `Date.now() - start`: the start's path, or `undefined` for any other shape. */
function elapsedStart(tree: WaitTree, node: N): string | undefined {
  return node.type === 'BinaryExpression' && node.operator === '-' && isClock(node.left) ? pathOf(tree, node.right) : undefined;
}

/** `start + <limit>`: the start's path and the limit, or `undefined` for any other shape. */
function startPlusLimit(file: WaitFile, node: N): { start: N; limit: Limit } | undefined {
  const items = termsOf(node);
  const start = items[0] as N;
  if (items[1] !== '+' || typeof start === 'string' || pathOf(file.tree, start) === undefined) return undefined;
  const rest = items.slice(2);
  const limit = rest[0] === undefined ? undefined : limitOf(file, rest, (rest[0] as N).start, node.end);
  return limit ? { start, limit } : undefined;
}

const limitOfNode = (file: WaitFile, node: N): Limit | undefined => limitOf(file, termsOf(node), node.start, node.end);

/** The bound of one listed clock form, unless a name it reads moves or its start is not a read of the clock. */
function fixed(cx: Probe, at: number, moving: Array<N | undefined>, start: N | undefined, bound: () => Bound): Bound {
  if (moving.some(node => movesAny(cx, node, at))) return undefined;
  if (start && !startsAtClock(cx.file, cx.loop.scope, pathOf(cx.file.tree, start) ?? '', at)) return undefined;
  return bound();
}

/**
 * What a comparison against the clock says, in the listed forms and as the whole condition: `now - start` against
 * a limit, `now` against `start + limit` or a deadline. Any other comparison is read as a name the loop sets from the clock.
 */
function clockLeaf(cx: Probe, node: N, at: number): Bound {
  const { file } = cx;
  const { tree } = file;
  if (node.type !== 'BinaryExpression' || !COMPARE.has(node.operator) || parenthesized(tree, node)) return aliasLeaf(cx, node, at);
  for (const [measured, other] of [[node.left, node.right], [node.right, node.left]] as const) {
    const start = elapsedStart(tree, measured);
    const limit = start === undefined ? undefined : limitOfNode(file, other);
    if (limit) return fixed(cx, at, [measured.right, limit.kind === 'name' ? limit.node : undefined], measured.right, () => limitBound(file, cx.loop.scope, limit, at));
    if (!isClock(measured)) continue;
    const sum = startPlusLimit(file, other);
    if (sum) return fixed(cx, at, [sum.start, sum.limit.kind === 'name' ? sum.limit.node : undefined], sum.start, () => limitBound(file, cx.loop.scope, sum.limit, at));
    if (other.type === 'Identifier') return fixed(cx, at, [other], undefined, () => definedBound(file, cx.loop.scope, other.name, at));
  }
  return aliasLeaf(cx, node, at);
}

/** A name the loop sets on every pass, with the value it sets and where. `cut` when the value runs past its line or holds a `;`. */
interface PerPass {
  value: N;
  at: number;
  cut: boolean;
}

/** The statements of the loop body that run as its own: the block's, or the one statement of a body with no braces. */
const bodyStatements = (loop: PollLoop): N[] => (loop.braceless ? [] : loop.node.body.type === 'BlockStatement' ? loop.node.body.body : [loop.node.body]);

/**
 * What the loop sets `name` to on every pass: its only write, a plain assignment or a declaration with a value, as a
 * statement of the loop body itself before any statement that holds a `continue`.
 */
function perPass(cx: Probe, name: string): PerPass | undefined {
  const { names, tree } = cx.file;
  const written = names.assignments(name).filter(each => within(cx.again)(each.at));
  if (written.length !== 1 || names.writes(name, false, within(cx.again)) || names.writes(name, true, inClosure(cx))) return undefined;
  for (const statement of bodyStatements(cx.loop)) {
    if (continueBetween(cx.file, cx.loop.body[0], statement.start, cx.loop.scope.chain)) return undefined;
    const value = passValue(statement, name);
    if (value) {
      const text = tree.text.slice(value.start, value.end);
      return { value, at: statement.start, cut: /[;\n]/.test(text) };
    }
  }
  return undefined;
}

function passValue(statement: N, name: string): N | undefined {
  if (statement.type === 'VariableDeclaration') {
    const first = statement.declarations[0];
    return first?.id.type === 'Identifier' && first.id.name === name ? first.init ?? undefined : undefined;
  }
  const expression = statement.type === 'ExpressionStatement' ? statement.expression : undefined;
  const assigns = expression?.type === 'AssignmentExpression' && expression.operator === '=' && expression.left.type === 'Identifier' && expression.left.name === name;
  return assigns && expression.start === statement.start ? expression.right : undefined;
}

/** A read of the clock, or one minus a start, as one line: what a name the loop samples the clock into holds. */
function sampleStart(tree: WaitTree, pass: PerPass): { start?: N } | undefined {
  if (pass.cut || parenthesized(tree, pass.value)) return undefined;
  if (isClock(pass.value)) return {};
  const value = pass.value;
  const startText = value.type === 'BinaryExpression' && value.operator === '-' && isClock(value.left) ? rawOf(tree, value.right) : undefined;
  return startText !== undefined && /^[\w$.]+$/.test(startText) ? { start: value.right } : undefined;
}

/** What a comparison of a name with the clock says when the loop sets the name from the clock on every pass. */
function aliasLeaf(cx: Probe, node: N, at: number): Bound {
  const { file } = cx;
  const { tree } = file;
  if (node.type !== 'BinaryExpression' || !COMPARE.has(node.operator)) return undefined;
  const sides = [
    ...(node.left.type === 'Identifier' && !parenAround(tree, node.left) ? [{ name: node.left.name, other: node.right }] : []),
    ...(node.right.type === 'Identifier' && !parenAround(tree, node.right) ? [{ name: node.right.name, other: node.left }] : []),
  ];
  for (const { name, other } of sides) {
    const pass = perPass(cx, name);
    const sample = pass ? sampleStart(tree, pass) : undefined;
    if (!sample || !pass) continue;
    if (parenAround(tree, other) || !limitOfNode(file, other) || movesAny(cx, other, at)) return undefined;
    if (sample.start) {
      const start = pathOf(tree, sample.start) ?? rawOf(tree, sample.start);
      return movesIn(cx, start, pass.at) || !startsAtClock(file, cx.loop.scope, start, pass.at) ? undefined : literalBound(file, cx.loop.scope, other, at);
    }
    return other.type === 'Identifier' ? definedBound(file, cx.loop.scope, other.name, at) : undefined;
  }
  return undefined;
}

/** Whether parentheses wrap a node: the text before it is `(`. */
const parenAround = (tree: WaitTree, node: N): boolean => tree.text[tree.source.before(node.start)] === '(' && tree.text[tree.source.after(node.end)] === ')';

/** How long `count` passes take when one pass sleeps `interval`. */
function timeOf(count: number, interval: Bound): Bound {
  if (interval === undefined) return undefined;
  return isNumber(interval) && interval > 0 ? count * interval : 'unreadable';
}

/** The counter declared by the `for` header, read as `let|var name = <start>`, or `undefined`. */
function counterInit(cx: Probe, name: string): N | null | undefined {
  const init = cx.clauses?.init;
  if (init?.type !== 'VariableDeclaration' || init.kind === 'const') return undefined;
  const first = init.declarations[0];
  if (first?.id.type !== 'Identifier' || first.id.name !== name || !first.init) return undefined;
  if (first.id.typeAnnotation && /[=,]/.test(rawOf(cx.file.tree, first.id.typeAnnotation))) return undefined;
  return init.declarations.length === 1 && !rawOf(cx.file.tree, first.init).includes(',') ? first.init : null;
}

/** What the header's update adds to the counter: `name++`, `++name` or `name += <positive literal>`. */
function stepOf(cx: Probe, name: string): number | 'unreadable' | undefined {
  const update = cx.clauses?.update;
  if (update?.type === 'UpdateExpression') return update.operator === '++' && update.argument.type === 'Identifier' && update.argument.name === name ? 1 : undefined;
  if (update?.type !== 'AssignmentExpression' || update.operator !== '+=' || update.left.type !== 'Identifier' || update.left.name !== name) return undefined;
  if (rawOf(cx.file.tree, update.right).includes(',')) return undefined;
  const size = read(cx, update.right);
  if (size === undefined) return isOutside(cx.file, cx.loop.scope, update.right, cx.loop.keyword) ? 'unreadable' : undefined;
  return size > 0 ? size : undefined;
}

const read = (cx: Probe, node: N): number | undefined => {
  const bound = literalBound(cx.file, cx.loop.scope, node, cx.loop.keyword);
  return isNumber(bound) ? bound : undefined;
};

/** `i < limit` or `i <= limit` with the counter alone on the left and no `&` or `|` in the limit's text. */
function counterCompared(tree: WaitTree, node: N): boolean {
  if (node.type !== 'BinaryExpression' || (node.operator !== '<' && node.operator !== '<=') || node.left.type !== 'Identifier' || parenAround(tree, node.left)) return false;
  return !/[&|]/.test(tree.text.slice(tree.source.after(node.left.end) + node.operator.length, node.end));
}

/** The counter's start node (`null` when the header holds more than its one declarator), or `undefined` when it is not a counter the loop keeps. */
function fixedCounter(cx: Probe, node: N, at: number): N | null | undefined {
  const name = node.left.name;
  const declared = counterInit(cx, name);
  if (declared === undefined || cx.file.names.writes(name, true, offset => offset >= cx.loop.body[0] && offset <= cx.loop.body[1])) return undefined;
  return movesAny(cx, node.right, at, name) || movesAny(cx, cx.clauses?.update ?? undefined, at, name) ? undefined : declared;
}

/** What a comparison with the counter of a `for (let i = <literal>; i < limit; i++)` header says about how long the loop runs. */
function counterLeaf(cx: Probe, node: N, at: number): Bound {
  const { file } = cx;
  if (!counterCompared(file.tree, node)) return undefined;
  const name = node.left.name;
  const declared = fixedCounter(cx, node, at);
  if (declared === undefined) return undefined;
  const limit = node.right;
  const value = read(cx, limit);
  const sized = value ?? (isOutside(file, cx.loop.scope, limit, cx.loop.keyword) ? 'name' : undefined);
  const start = declared === null ? undefined : read(cx, declared);
  const step = stepOf(cx, name);
  if (start === undefined || step === undefined || sized === undefined) return undefined;
  if (sized === 'name' || step === 'unreadable') return 'unreadable';
  const span = sized - start;
  const count = Math.max(0, node.operator === '<=' ? Math.floor(span / step) + 1 : Math.ceil(span / step));
  return timeOf(count, cx.interval);
}

/**
 * The time by which a condition is certain to be `want`, as the loop's clock or counter sees it. For the loop head,
 * `want` is false; for the test of an `if` that leaves the loop, it is true.
 */
function endsWhen(cx: Probe, node: N, want: boolean, at: number, depth = 0): Bound {
  if (node.type === 'ConditionalExpression' || (node.type === 'LogicalExpression' && node.operator === '??')) return undefined;
  if (node.type === 'LogicalExpression') {
    const parts = [endsWhen(cx, node.left, want, at, depth), endsWhen(cx, node.right, want, at, depth)];
    return (node.operator === '||') === want ? earliest(parts) : latest(parts);
  }
  if (node.type === 'UnaryExpression' && node.operator === '!') return endsWhen(cx, node.argument, !want, at, depth);
  if (node.type === 'Identifier') {
    const pass = depth < 3 ? perPass(cx, node.name) : undefined;
    return pass && !pass.cut ? endsWhen(cx, pass.value, want, pass.at, depth + 1) : undefined;
  }
  const leaf = asTheTextReads(node);
  return isPure(leaf) ? clockLeaf(cx, leaf, at) ?? counterLeaf(cx, leaf, at) : undefined;
}

/**
 * `i < 20 as number` parses as `(i < 20) as number`; its text reads as `i < (20 as number)`, a comparison with a
 * wrapped limit. The comparison is rebuilt that way, so the limit is read as the text reads it.
 */
function asTheTextReads(node: N): N {
  const inner = node.expression;
  if ((node.type !== 'TSAsExpression' && node.type !== 'TSSatisfiesExpression') || inner?.type !== 'BinaryExpression' || !COMPARE.has(inner.operator)) return node;
  const right = { type: node.type, expression: inner.right, typeAnnotation: node.typeAnnotation, start: inner.right.start, end: node.end };
  return { type: 'BinaryExpression', operator: inner.operator, left: inner.left, right: asTheTextReads(right), start: node.start, end: node.end };
}

/** Whether a statement leaves the loop by itself: a `break`, `return` or `throw`, or a block with one that no `continue` comes before. */
function leavesDirectly(cx: Probe, statement: N): boolean {
  const exits = (node: N): boolean => node.type === 'BreakStatement' || node.type === 'ReturnStatement' || node.type === 'ThrowStatement';
  if (statement.type !== 'BlockStatement') return exits(statement);
  const leave = statement.body.find(exits);
  return leave !== undefined && !continueBetween(cx.file, statement.start, leave.start, cx.loop.scope.chain);
}

/** The bounds of the exits in the loop's own body: `if (<condition>) break`, `return` or `throw`, before any `continue`. */
function exitBounds(cx: Probe): Bound[] {
  const found: Bound[] = [];
  for (const statement of bodyStatements(cx.loop)) {
    if (statement.type !== 'IfStatement') continue;
    if (continueBetween(cx.file, cx.loop.body[0], statement.start, cx.loop.scope.chain)) break;
    if (leavesDirectly(cx, statement.consequent)) found.push(endsWhen(cx, statement.test, true, statement.start));
  }
  return found;
}

/** Whether a header reads a collection or a stream: ` of ` or ` in ` with white space around it, and no `;`. */
function overCollection(tree: WaitTree, loop: PollLoop): boolean {
  if (!loop.head || loop.node.type === 'ForStatement') return false;
  if (loop.node.type === 'ForOfStatement' || loop.node.type === 'ForInStatement') return /\s(?:of|in)\s/.test(tree.text.slice(loop.node.left.end, loop.node.right.start + 1));
  let found = false;
  const visit = (node: N): void => {
    if (node.type === 'BinaryExpression' && node.operator === 'in' && /\s/.test(tree.text[node.left.end] ?? '') && /\s/.test(tree.text[node.right.start - 1] ?? '')) found = true;
    for (const child of childrenOf(node)) visit(child);
  };
  visit(loop.node.test);
  return found;
}

/** The one-pass time of the sleeps every pass reaches. */
function intervalOf(file: WaitFile, loop: PollLoop, sleeps: readonly LoopSleep[]): Bound {
  const delays = sleeps.filter(sleep => sleep.always).map((sleep): Bound => {
    if (!sleep.delay) return undefined;
    const bound = literalBound(file, loop.scope, sleep.delay, loop.keyword);
    return bound === undefined && sizedOutside(file, loop.scope, sleep.delay, loop.keyword) ? 'unreadable' : bound;
  });
  return delays.includes(undefined) ? undefined : delays.every(isNumber) ? delays.reduce((sum, each) => sum + each, 0) : 'unreadable';
}

/** Whether a `for` header holds more than its two own `;`: a function or block in it, which the text splits wrongly. */
const extraClauses = (tree: WaitTree, loop: N): boolean => {
  let found = false;
  const visit = (node: N): void => {
    if (node.type === 'BlockStatement' || node.type === 'ClassBody') found ||= /;/.test(rawOf(tree, node));
    for (const child of childrenOf(node)) visit(child);
  };
  for (const part of [loop.init, loop.test, loop.update]) if (part) visit(part);
  return found;
};

/**
 * How long a poll loop can run, as the first of its exits to fire: the smallest bound among its head and every `if`
 * in its body that leaves it. `none` when no exit reads the clock or counts attempts.
 */
export function pollDeadline(file: WaitFile, loop: PollLoop, sleeps: readonly LoopSleep[]): 'none' | 'unreadable' | number {
  const { tree } = file;
  if (overCollection(tree, loop)) return 'unreadable';
  const node = loop.node;
  const counted = node.type === 'ForStatement' && !extraClauses(tree, node);
  const header: [number, number] | undefined = loop.head ? [loop.head[0] + 1, loop.head[1]] : undefined;
  const again: Array<[number, number]> = [[loop.body[0], loop.body[1] + 1]];
  if (counted) for (const part of [node.test, node.update]) if (part) again.push([part.start, part.end]);
  if (!counted && header) again.push(header);
  const cx: Probe = { file, loop, again, interval: intervalOf(file, loop, sleeps), ...(counted ? { clauses: { init: node.init, update: node.update } } : {}) };
  const test = node.type === 'ForStatement' ? (counted ? node.test : null) : node.test;
  const head = loop.head && test ? endsWhen(cx, test, false, loop.head[1]) : undefined;
  const found = earliest([head, ...exitBounds(cx)]);
  return found ?? 'none';
}

