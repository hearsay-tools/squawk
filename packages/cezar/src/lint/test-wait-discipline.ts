/**
 * A syntax-tree scan of the server unit tests for the three ways a test waits on the wall clock instead
 * of on the product: a bare awaited sleep standing in for a condition nobody named, a wait
 * bounded under SHORT_BOUND_MS, and a poll loop with no deadline or a deadline under
 * SHORT_BOUND_MS. The last three load flakes under hearsay-tools/cezarion#902 had that one cause
 * (hearsay-tools/cezarion#1144, hearsay-tools/cezarion#1145, hearsay-tools/cezarion#1146): a
 * fixed bound on a fixture's own startup, or one bound for a whole sequence of steps, which a
 * loaded host overruns. The rule for authors is in AGENTS.md § Validation.
 *
 * It reads oxlint's syntax tree (hearsay-tools/squawk#3774), and keeps the forms the source scan it
 * replaced read: each form below is the shape that scan matched, so a site it accepted or reported
 * stays accepted or reported. Strings, template literals and comments are not code, so the sleeps
 * inside fake-CLI scripts (template literals written to disk as mock binaries) are not this rule's
 * business. A false positive costs one `// bound: <reason>` comment at the site, which is what the
 * rule asks of a real bound anyway.
 *
 * What `poll-deadline` reads as a deadline is this list and nothing else. Both scans implement it, and both test every line of it.
 * A loop is as long as its earliest exit, and only these exits count:
 *   1. The loop's own condition: the test of a `while`, a `do … while` or a `for`.
 *   2. `if (<condition>) break`, `return` or `throw`, written as a statement of the loop body itself (the branch is the leave,
 *      or a block with the leave among its own statements), before any statement that holds a `continue`. An `if` inside
 *      another `if`, an `else`, a `switch`, a `try`, a block or an inner loop may never be reached, and the `else` of an
 *      `if` is not an exit on its test.
 * A condition is read from these parts, joined by `&&` (it ends once either part does), `||` (once both do) and `!`. A counted
 * condition is a pure read: no write (`=`, `+=`, `++`, `--`) and no call in it, but the clock, or the part is no bound.
 *   - a clock comparison with `<`, `<=`, `>` or `>=`, never `==` or `!=`, and as the whole part: `now - start` against a limit,
 *     `now` against `start + limit` or a deadline, or a name the loop sets from the clock (`const elapsed = Date.now() - start`).
 *     `now` is `Date.now()`, `performance.now()` or `process.hrtime()`. A limit is a literal sum of products (`5 * 1_000`) or one
 *     name or path. A start is a read of the clock, a deadline a read of the clock plus a limit. A name set to any other
 *     expression is no start, deadline or limit. The loop never declares them again,
 *     writes them or leaves them to a closure that writes. A name it sets from the clock is set once, as a statement of the body
 *     itself before any `continue`: a write in a branch may keep an old value.
 *   - the counter of a `for (let|var i = <literal>; i < limit; i++)` header: one declarator, `<` or `<=` against a limit the loop
 *     never changes, and a step of `i++`, `++i` or `i += <positive literal>`. A count down, a step in the test (`i++ < 20`) or a
 *     write in the body is no bound. It gives the iterations times the sleeps every pass reaches.
 * Numbers are evaluated, not matched: literals with separators and other bases, unary `+` and `-`, parentheses, `as`, `satisfies`
 * and non-null wrappers, `+ - * / % **`, and, for a wait bound or a delay, `Math.max`, `min`, `abs`, `floor`, `ceil`, `round` and
 * `trunc` of those. A name is looked up in the function around its use and in every function around that one, up to the module,
 * at the use: the nearest declaration hides the ones further out, and a `const` of an outer scope counts wherever it sits, since a
 * function runs after the module has loaded. A `let` or `var` of an outer scope is read only when nothing writes it after its declaration. A wait bound
 * that is negative, zero, `NaN`, infinite or past a timer's limit is below the floor.
 * A part on the list is left alone only for a value that comes from outside the file or from the function's parameters (a
 * parameter, an import, a global, a property of an argument): the caller sizes it. A value the file declares and the scan cannot
 * evaluate (a call, a ternary, a destructured binding, a `let` written after its declaration, a name set to one of those) is never
 * left alone: as a limit, start, deadline or delay it bounds nothing, and as a wait bound it is below the floor. Any other shape
 * has no bound: a ternary, `??`, a call, arithmetic on the clock, an equality, a counter the body steps, a start the loop
 * resets, a flag set in a branch. A loop with no bound on the list is reported, unless `// bound: <reason>` accepts it. A loop
 * over a collection or a stream ends with it, and a count of passes that sleep nothing says nothing in milliseconds.
 *
 * `cez/test-wait-discipline` runs it against every `*.test.ts` and `*.testkit.ts` under
 * `packages/cezar/src` and compares the tally with two checked-in baselines that can only shrink,
 * so today's sites stay where they are and no new one lands without a reason. The poll loops have
 * a baseline of their own, so a change to one list never conflicts with a change to the other.
 */

import type { AstRule, AstContext, Visitors, EsNode } from './ast-rule.ts';
import { baselines } from './server-wait-baseline.ts';
import { compareToBaseline, readBaseline, tally } from './wait-baseline.ts';
import { WaitSource, waitComments, type ParsedComment } from './wait-source.ts';
import { WaitTree, type N } from './server-wait-tree.ts';
import { WaitNames } from './server-wait-names.ts';
import { type WaitFile, VITEST_DEFAULT_MS, isShort, isShortDeadline, numberOf, rawOf } from './server-wait-values.ts';
import { keyText, leadingObject, optionsBound, waitMs } from './server-wait-options.ts';
import { loopAround, pollDeadline, runsEveryPass, type LoopSleep, type PollLoop } from './server-wait-loops.ts';
import { inOxlint } from './wait-oxlint.ts';

export { SHORT_BOUND_MS } from './server-wait-values.ts';

export type Rule = 'sleep' | 'short-bound' | 'poll-deadline';

export interface Site {
  file: string;
  rule: Rule;
  /** The site's first line, trimmed: a call moves with it, a line number does not. */
  site: string;
  line: number;
}

export interface BaselineEntry {
  file: string;
  rule: Rule;
  site: string;
  count: number;
}

/** Local sleep helpers in this tree go by these names. */
export const sleepNames = new Set(['delay', 'sleep', 'wait', 'pause']);

/** Local wait helpers in this tree go by these names. */
export const helperNames = new Set(['waitFor', 'waitUntil', 'until', 'eventually', 'waitForCondition']);

/** A `//` comment that accepts a site: `// bound: <reason>`, with a reason. */
export const boundComment = /^\/\/\s*bound:\s*\S/;

/** One rule's hit: the offset of the call (or loop) it is keyed on. */
export interface Found {
  rule: Rule;
  offset: number;
}

/** The nodes a site can start from, gathered while oxlint walks the file. */
interface Starts {
  awaits: N[];
  calls: N[];
}

/** The nodes an expression's text starts with, outermost first: `sleep(5).then(f)` starts with `sleep(5)` and `sleep`. */
function leading(node: N): N[] {
  const chain: N[] = [];
  for (let at: N | undefined = node; at && at.start === node.start; at = leftOf(at)) chain.push(at);
  return chain;
}

function leftOf(node: N): N | undefined {
  switch (node.type) {
    case 'CallExpression': return node.callee;
    case 'MemberExpression': return node.object;
    case 'ChainExpression': case 'TSAsExpression': case 'TSSatisfiesExpression': case 'TSNonNullExpression': return node.expression;
    case 'BinaryExpression': case 'LogicalExpression': case 'AssignmentExpression': return node.left;
    case 'ConditionalExpression': return node.test;
    case 'SequenceExpression': return node.expressions[0];
    case 'TaggedTemplateExpression': return node.tag;
    case 'UpdateExpression': return node.prefix ? undefined : node.argument;
    default: return undefined;
  }
}

/** Whether `(` follows a callee directly: no type arguments, no optional call. */
const calledDirectly = (tree: WaitTree, call: N, callee: N): boolean =>
  !call.optional && !call.typeArguments && tree.text[tree.source.after(callee.end)] === '(';

/** A call whose callee is `name` or `object.name` written at `at`: `sleep(…)`, `timers.setTimeout(…)`. */
function namedCall(tree: WaitTree, chain: readonly N[], at: number, test: (callee: N) => boolean): N | undefined {
  return chain.find(node => node.type === 'CallExpression' && node.callee.start === at && test(node.callee) && calledDirectly(tree, node, node.callee));
}

const isName = (node: N | undefined, names: ReadonlySet<string> | string): boolean =>
  node?.type === 'Identifier' && (typeof names === 'string' ? node.name === names : names.has(node.name));

const memberOf = (node: N, objects: ReadonlySet<string>, name: string): boolean =>
  node.type === 'MemberExpression' && !node.computed && !node.optional && isName(node.object, objects) && isName(node.property, name);

const TIMER_OBJECTS = new Set(['timers']);
const GLOBALS = new Set(['globalThis', 'global']);

/** The delay of an awaited timer (`undefined` inside when it has none), or `undefined` for any other await. */
export function awaitedSleep(wf: WaitFile, awaited: N): { delay: N | undefined } | undefined {
  const { tree } = wf;
  const argument: N = awaited.argument;
  const end = awaited.start + 'await'.length;
  if (!argument || tree.source.after(end) !== argument.start || argument.start === end) return undefined;
  const chain = leading(argument);
  const call = namedCall(tree, chain, argument.start, callee => isName(callee, sleepNames) || isName(callee, 'setTimeout') || memberOf(callee, TIMER_OBJECTS, 'setTimeout'));
  if (call) return { delay: call.arguments[0] };
  const promise = chain.find(node => node.type === 'NewExpression' && isName(node.callee, 'Promise'));
  return promise ? promisedSleep(wf, promise) : undefined;
}

/** `new Promise(r => setTimeout(r, 50))` and its block and `globalThis.` forms: the delay, when the timer resolves the promise. */
function promisedSleep(wf: WaitFile, promise: N): { delay: N | undefined } | undefined {
  const { tree } = wf;
  const typed: N | undefined = promise.typeArguments ?? undefined;
  if (typed && /[<>()]/.test(tree.text.slice(typed.start + 1, typed.end - 1))) return undefined;
  const open = tree.source.after((typed ?? promise.callee).end);
  const executor: N | undefined = promise.arguments[0];
  if (tree.text[open] !== '(' || executor?.type !== 'ArrowFunctionExpression' || executor.async || executor.returnType || executor.params.length !== 1) return undefined;
  const param: N = executor.params[0];
  if (param.type !== 'Identifier' || tree.source.before(executor.start) !== open) return undefined;
  if (param.typeAnnotation && (tree.text[executor.start] !== '(' || /[()]/.test(rawOf(tree, param.typeAnnotation)))) return undefined;
  const timer = timerCall(wf, executor);
  if (!timer) return undefined;
  const [callback, delay] = timer.arguments as N[];
  const tight = callback !== undefined && tree.source.before(callback.start) === tree.source.after(timer.callee.end) && tree.text[tree.source.after(callback.end)] === ',';
  return tight && callback.type === 'Identifier' && callback.name === param.name && delay ? { delay } : undefined;
}

/** The timer an executor calls first: its concise body, or the first statement of its block, `return` allowed. */
function timerCall(wf: WaitFile, executor: N): N | undefined {
  const { tree } = wf;
  let at = tree.source.after(tree.arrowAt(executor) + 2);
  let first: N | undefined = executor.body;
  if (executor.body.type === 'BlockStatement') {
    at = tree.source.after(executor.body.start + 1);
    if (tree.text.startsWith('return', at) && /\s/.test(tree.text[at + 6] ?? '')) at = tree.source.after(at + 6);
    const statement: N | undefined = executor.body.body[0];
    first = statement?.type === 'ExpressionStatement' ? statement.expression : statement?.type === 'ReturnStatement' ? statement.argument ?? undefined : undefined;
  }
  if (!first) return undefined;
  const timer = (callee: N): boolean => {
    const name = callee.type === 'Identifier' ? callee.name : memberOf(callee, GLOBALS, callee.property?.name) ? callee.property.name : '';
    return /(?:setTimeout|SetTimeout)$/.test(name);
  };
  return namedCall(tree, leading(first), at, timer);
}

/**
 * Rule `sleep`: an awaited timer outside a loop. Rule `poll-deadline`: a sleep in a loop is a poll interval, so the
 * loop is judged by its own deadline instead, once per loop however many sleeps it holds.
 */
export function sleepSites(wf: WaitFile, awaits: readonly N[]): Found[] {
  const found: Found[] = [];
  const loops = new Map<number, { loop: PollLoop; sleeps: LoopSleep[] }>();
  for (const awaited of awaits) {
    const sleep = awaitedSleep(wf, awaited);
    if (!sleep) continue;
    const loop = loopAround(wf, awaited);
    // A zero delay outside a loop only yields to the event loop. In a loop it is the poll interval of a spin.
    if (!loop) {
      if (!sleep.delay || numberOf(wf.tree, sleep.delay) !== 0) found.push({ rule: 'sleep', offset: awaited.start });
      continue;
    }
    const entry = { delay: sleep.delay, always: runsEveryPass(wf, loop, awaited) };
    loops.set(loop.keyword, { loop, sleeps: [...(loops.get(loop.keyword)?.sleeps ?? []), entry] });
  }
  for (const { loop, sleeps } of loops.values()) {
    const deadline = pollDeadline(wf, loop, sleeps);
    if (deadline === 'none' || (typeof deadline === 'number' && isShortDeadline(deadline))) found.push({ rule: 'poll-deadline', offset: loop.keyword });
  }
  return found;
}

const vitestNames: Record<string, ReadonlySet<string>> = { vi: new Set(['waitFor', 'waitUntil']), expect: new Set(['poll']) };

/** The `vi` or `expect` a call is made on: `vi.waitFor`, or `x.vi.waitFor`, whose text holds `vi.waitFor` too. */
function receiverOf(callee: N): N | undefined {
  if (callee.type !== 'MemberExpression' || callee.optional) return undefined;
  const object: N = callee.object;
  const receiver = object.type === 'Identifier' ? object : object.type === 'MemberExpression' && !object.computed ? object.property : undefined;
  return receiver?.type === 'Identifier' && vitestNames[receiver.name] ? receiver : undefined;
}

/** A Vitest wait: `vi.waitFor`, `vi.waitUntil` or `expect.poll`, dotted or bracketed. The offset is the receiver's. */
function vitestWait(wf: WaitFile, call: N): number | undefined {
  const { tree } = wf;
  const callee: N = call.callee;
  const receiver = receiverOf(callee);
  if (!receiver || !calledDirectly(tree, call, callee)) return undefined;
  const names = vitestNames[receiver.name]!;
  if (!callee.computed) return isName(callee.property, names) ? receiver.start : undefined;
  const bracket = tree.source.after(receiver.end);
  const name = tree.text[bracket] === '[' ? keyText(wf, callee.property, bracket) : undefined;
  return name !== undefined && names.has(name) ? receiver.start : undefined;
}

/** What a Vitest wait is given as its bound: its default, its options object's, or its second argument's. */
function vitestBound(wf: WaitFile, call: N): number | undefined {
  const bound: N | undefined = call.arguments[1];
  if (!bound) return VITEST_DEFAULT_MS;
  const object = leadingObject(wf, bound);
  if (object) return object === bound ? optionsBound(wf, object) : undefined;
  return waitMs(wf, bound, bound, true);
}

const METHODS = new Set(['MethodDefinition', 'TSAbstractMethodDefinition', 'Property']);

/** A call of a local wait helper, or a method of one: its arguments after the condition, and where its name is. */
function helperArguments(wf: WaitFile, node: N): { args: N[]; offset: number } | undefined {
  const { tree } = wf;
  if ((node.type === 'CallExpression' || node.type === 'NewExpression') && isName(node.callee, helperNames) && calledDirectly(tree, node, node.callee)) {
    return { args: node.arguments.slice(1), offset: node.callee.start };
  }
  const method = METHODS.has(node.type) && (node.type !== 'Property' || node.method || node.kind !== 'init');
  if (method && !node.computed && isName(node.key, helperNames) && !node.value?.typeParameters && tree.text[tree.source.after(node.key.end)] === '(') {
    return { args: (node.value?.params ?? []).slice(1), offset: node.key.start };
  }
  return undefined;
}

/** A parameter like `timeoutMs = 5_000` whose default is short. A poll interval is not a bound, so `intervalMs = 25` is not one. */
function shortDefault(wf: WaitFile, param: N): boolean {
  if (param.type !== 'AssignmentPattern' || param.left.type !== 'Identifier' || /interval/i.test(param.left.name)) return false;
  if (param.left.typeAnnotation && /=/.test(rawOf(wf.tree, param.left.typeAnnotation))) return false;
  return isShort(waitMs(wf, param, param.right, false));
}

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'TSDeclareFunction']);

/** A local wait helper's definition: `function until(…)` or `const until = (…) =>`, keyed on its `function` or `const`. */
function helperDefinition(wf: WaitFile, node: N): { params: N[]; offset: number } | undefined {
  const { tree } = wf;
  const simpleTypes = (typed: N | null | undefined): boolean => !typed || !/[<>()]/.test(tree.text.slice(typed.start + 1, typed.end - 1));
  if (FUNCTIONS.has(node.type) && isName(node.id, helperNames)) {
    const keyword = node.async ? tree.source.after(node.start + 'async'.length) : node.start;
    return simpleTypes(node.typeParameters) && tree.text.startsWith('function', keyword) ? { params: node.params, offset: keyword } : undefined;
  }
  const declarator: N | undefined = node.type === 'VariableDeclaration' ? node.declarations[0] : undefined;
  const init: N | undefined = declarator?.init ?? undefined;
  if (!declarator || !isName(declarator.id, helperNames) || init?.type !== 'ArrowFunctionExpression' || !simpleTypes(init.typeParameters)) return undefined;
  if (declarator.id.typeAnnotation && /[=;]/.test(rawOf(tree, declarator.id.typeAnnotation))) return undefined;
  let open = init.async ? tree.source.after(init.start + 'async'.length) : init.start;
  if (init.typeParameters) open = tree.source.after(init.typeParameters.end);
  if (tree.text[tree.source.before(init.start)] !== '=' || tree.text[open] !== '(') return undefined;
  if (init.returnType && /[;{]/.test(rawOf(tree, init.returnType))) return undefined;
  return { params: init.params, offset: node.start };
}

/** Rule `short-bound`: a Vitest wait with no bound (1 s) or one under 10 s, and the local helpers alike. */
export function boundSites(wf: WaitFile, calls: readonly N[]): Found[] {
  const found: Found[] = [];
  for (const node of calls) {
    const vitest = node.type === 'CallExpression' ? vitestWait(wf, node) : undefined;
    if (vitest !== undefined && isShort(vitestBound(wf, node))) found.push({ rule: 'short-bound', offset: vitest });
    const helper = helperArguments(wf, node);
    if (helper?.args.some(arg => arg.type !== 'SpreadElement' && isShort(waitMs(wf, arg, arg, false)))) found.push({ rule: 'short-bound', offset: helper.offset });
    const definition = helperDefinition(wf, node);
    if (definition?.params.some(param => shortDefault(wf, param))) found.push({ rule: 'short-bound', offset: definition.offset });
  }
  return found;
}

/**
 * Whether a line holds a `// bound: <reason>`, or sits under a block of `//` comment lines that does. A
 * `// bound:` written inside a string or a template accepts nothing.
 */
export function boundAccepted(source: WaitSource): (line: number) => boolean {
  const commentOn = new Map<number, string>();
  const commentOnly = new Set<number>();
  for (const comment of source.comments) {
    if (!comment.line) continue;
    const line = source.lineOf(comment.start);
    commentOn.set(line, `//${comment.value}`);
    if (source.text.slice(source.text.lastIndexOf('\n', comment.start - 1) + 1, comment.start).trim() === '') commentOnly.add(line);
  }
  return line => {
    if (boundComment.test(commentOn.get(line) ?? '')) return true;
    for (let above = line - 1; above >= 1 && commentOnly.has(above); above -= 1) if (boundComment.test(commentOn.get(above) ?? '')) return true;
    return false;
  };
}

/** The sites of one file, from the nodes oxlint's walk gathered. */
export function sitesOf(file: string, root: N, source: WaitSource, starts: Starts): Site[] {
  const tree = new WaitTree(root, source);
  const wf: WaitFile = { tree, names: new WaitNames(tree) };
  const accepted = boundAccepted(source);
  const sites: Site[] = [];
  for (const { rule, offset } of [...sleepSites(wf, starts.awaits), ...boundSites(wf, starts.calls)]) {
    const line = source.lineOf(offset);
    if (!accepted(line)) sites.push({ file, rule, line, site: source.lines[line - 1]?.trim() ?? '' });
  }
  return sites.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/** Whether a node can start a short-bound site: a call of a Vitest wait or a helper, or a helper's definition. */
function callStart(node: N): boolean {
  switch (node.type) {
    case 'CallExpression': case 'NewExpression': return isName(node.callee, helperNames) || receiverOf(node.callee) !== undefined;
    case 'VariableDeclaration': return isName(node.declarations[0]?.id, helperNames);
    case 'Property': return (node.method || node.kind !== 'init') && isName(node.key, helperNames);
    default: return FUNCTIONS.has(node.type) ? isName(node.id, helperNames) : METHODS.has(node.type) && isName(node.key, helperNames);
  }
}

/** The visitors that gather a file's starts as oxlint walks it, then give its sites. */
export function waitVisitors(file: string, sourceCode: AstContext['sourceCode'], done: (sites: Site[], program: EsNode) => void): Visitors {
  const starts: Starts = { awaits: [], calls: [] };
  const call = (node: EsNode): void => {
    if (callStart(node as unknown as N)) starts.calls.push(node as unknown as N);
  };
  return {
    AwaitExpression: node => {
      starts.awaits.push(node as unknown as N);
    },
    CallExpression: call, NewExpression: call, VariableDeclaration: call, Property: call,
    FunctionDeclaration: call, FunctionExpression: call, TSDeclareFunction: call, MethodDefinition: call, TSAbstractMethodDefinition: call,
    'Program:exit': program => {
      if (starts.awaits.length === 0 && starts.calls.length === 0) return;
      const source = new WaitSource(sourceCode.text, waitComments(sourceCode.getAllComments() as unknown as ParsedComment[]));
      done(sitesOf(file, program as unknown as N, source, starts), program);
    },
  };
}

/** The server sites of files under `packages/cezar/src`, as oxlint parses them: the baseline runner and the rule's tests read this. */
export function scanFiles(files: ReadonlyArray<{ file: string; code: string }>): Site[][] {
  const found = new Map<string, Site[]>();
  inOxlint(files.map(each => ({ file: `packages/cezar/src/${each.file}`, code: each.code })), context => waitVisitors(
    context.file.slice('packages/cezar/src/'.length), context.sourceCode, sites => found.set(`${context.file}\0${context.sourceCode.text}`, sites)));
  return files.map(each => found.get(`packages/cezar/src/${each.file}\0${each.code}`) ?? []);
}

/** One file's server sites; see `scanFiles`. */
export const scanSource = (file: string, code: string): Site[] => scanFiles([{ file, code }])[0] ?? [];

/** The server scanner's original traversal scope, expressed for oxlint paths. */
export const scannedServerFile = (file: string): boolean => file.startsWith('packages/cezar/src/')
  && /\.(?:test|testkit)\.ts$/.test(file)
  && !file.split('/').some(part => part === '__fixtures__' || part === 'node_modules')
  && !['test-wait-discipline.test.ts', 'test-wait-discipline.testkit.ts'].includes(file.slice('packages/cezar/src/'.length));

export const waitRemedy = (rule: Rule): string => rule === 'poll-deadline'
  ? 'A poll loop needs a deadline of 10 s or more, read from the clock in the loop or its function (or attempts x interval with literals). Add one, or state why the loop ends as a `// bound: <reason>` comment on its first line (AGENTS.md § Validation)'
  : "Wait on the product's own signal, or state the bound's reason at the site as a `// bound: <reason>` comment (AGENTS.md § Validation)";

export const testWaitDiscipline: AstRule = {
  name: 'test-wait-discipline',
  description: 'Wait on the product signal, with a reason for a wall-clock bound.',
  applies: scannedServerFile,
  create: (report, { file, sourceCode }) => waitVisitors(file.slice('packages/cezar/src/'.length), sourceCode, (sites, program) => {
    for (const baseline of baselines) {
      const mine = sites.filter(site => baseline.rules.includes(site.rule));
      const { added } = compareToBaseline(tally(mine), readBaseline(baseline.path));
      for (const entry of added) {
        for (const site of mine.filter(each => each.rule === entry.rule && each.site === entry.site)) {
          report(program, `[${site.rule}] ${site.site}. ${waitRemedy(site.rule)}. Never add a site to ${baseline.path}`, { line: site.line, column: 0 });
        }
      }
    }
  }),
};
