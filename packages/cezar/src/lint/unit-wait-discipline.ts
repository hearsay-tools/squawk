import type { AstContext, AstRule, EsNode, Visitors } from './ast-rule.ts';
import { walk, isFunction, isCall, type N } from './unit-wait-tree.ts';
import { inOxlint } from './wait-oxlint.ts';
import { compareToBaseline, tally, readBaseline } from './wait-baseline.ts';
import { WaitSource, waitComments, type ParsedComment } from './wait-source.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { BaselineEntry as Entry } from './wait-baseline.ts';
import { findQuery, sizeNumber, calleeOf, vitestBound, testingLibraryBound, contains, placeAt, readerFor } from './unit-wait-values.ts';
import { pollDeadline } from './unit-wait-deadlines.ts';

/**
 * A scan of the cockpit unit tests for the three ways a test waits on a clock instead of on the
 * product (hearsay-tools/cezarion#1203). The server's twin is `packages/cezar/src/lint/test-wait-discipline.ts`;
 * this one reads a syntax tree, since the cockpit tests are TSX and a wait can span many lines.
 *
 * - `short-bound`: Vitest's `vi.waitFor`, `vi.waitUntil` or `expect.poll` with no bound (they give up
 *   after 1 s) or a literal under the floor, and a Testing Library wait (`waitFor`, `findBy*`,
 *   `findAllBy*`, `waitForElementToBeRemoved`) with a literal `timeout` under the floor. A Testing
 *   Library wait with no `timeout` is covered: `vitest.setup.ts` configures `asyncUtilTimeout`.
 * - `sleep`: an awaited timer outside a poll loop, which stands in for a condition nobody named.
 * - `poll-deadline`: a sleep inside a `for`, `while` or `do` loop is a poll interval, so the loop is judged by its deadline,
 *   once per loop however many sleeps it holds. It is reported when the list below gives it no deadline, or when the earliest
 *   exit resolves to a literal under the floor.
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
 * resets, a flag set in a branch. A loop with no bound on the list is reported, unless `// bound: <reason>` accepts it. A count
 * of passes that sleep nothing says nothing in milliseconds.
 *
 * `// bound: <reason>` on the line of a site, or in the comment block directly above it, accepts it.
 * That is for a wait that asserts something does NOT happen within a window, which keeps a short
 * timeout on purpose (`vitest.setup.ts` says so), and for a timer that is not a wait on the product.
 *
 * `cez/unit-wait-discipline` runs it over every cockpit unit test and compares the tally with a
 * checked-in baseline that can only shrink.
 */

export type Rule = 'short-bound' | 'sleep' | 'poll-deadline'

export interface Site {
  file: string
  rule: Rule
  /** The line the site is keyed by, trimmed: a line number moves with an edit, the text does not. */
  site: string
  line: number
}

export type BaselineEntry = Entry<Rule>

/** The cockpit's own floor. Testing Library gives up after `asyncUtilTimeout` (3 s) and Vitest ends a test
 *  at 5 s, so a wait below the first is shorter than the host's own bound. A test pins this against the setup. */
export const FLOOR_MS = 3_000

/** What Vitest's own waits use when given no bound. */
export const VITEST_DEFAULT_MS = 1_000

export const srcDir = resolve(import.meta.dirname, '../../../web/src')

export const baselinePath = resolve(import.meta.dirname, '../../../web/src/test/unit-wait-discipline.baseline.json')

/** A `for`, `while` or `do` loop. */
export type Loop = N

export const isPollLoop = (node: N): node is Loop => node.type === 'ForStatement' || node.type === 'WhileStatement' || node.type === 'DoWhileStatement'

/** The names a write targets: `x = …`, `x++`, `[x, y] = …`, `({ x } = …)`. */
export function targetNames(target: N): string[] {
  switch (target.type) {
    case 'Identifier': return [target.name]
    case 'ArrayPattern': return target.elements.flatMap((element: N | null) => (element ? targetNames(element) : []))
    case 'ObjectPattern': return target.properties.flatMap((property: N) => targetNames(property.type === 'RestElement' ? property.argument : property.value))
    case 'AssignmentPattern': return targetNames(target.left)
    case 'RestElement': return targetNames(target.argument)
    case 'MemberExpression': return targetNames(target.object)
    default: return []
  }
}

export const namesWritten = (node: N): string[] => (node.type === 'AssignmentExpression' ? targetNames(node.left) : node.type === 'UpdateExpression' ? targetNames(node.argument) : [])

/** The local names of Testing Library's `waitFor` and `waitForElementToBeRemoved`, and of a namespace import of the library (`rtl` in `rtl.waitFor`). */
export function testingLibrary(program: N): { tlWaits: Set<string>; tlNamespaces: Set<string> } {
  const tlWaits = new Set<string>()
  const tlNamespaces = new Set<string>()
  for (const node of program.body as N[]) {
    if (node.type !== 'ImportDeclaration' || !node.source.value.startsWith('@testing-library/')) continue
    for (const specifier of node.specifiers as N[]) {
      if (specifier.type === 'ImportNamespaceSpecifier') tlNamespaces.add(specifier.local.name)
      const imported = specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier' ? specifier.imported.name : ''
      if (imported === 'waitFor' || imported === 'waitForElementToBeRemoved') tlWaits.add(specifier.local.name)
    }
  }
  return { tlWaits, tlNamespaces }
}

export interface Ctx {
  file: string
  lines: string[]
  lineOf: (offset: number) => number
  tlWaits: ReadonlySet<string>
  tlNamespaces: ReadonlySet<string>
  accepted: (line: number) => boolean
  sites: Site[]
  /** Each poll loop with its sleeps (the delay, and whether every pass reaches it), and where it sits. */
  loops: Map<N, { sleeps: Sleep[]; where: Where }>
}

export function report(ctx: Ctx, rule: Rule, node: N): void {
  const line = ctx.lineOf(node.start ?? 0)
  if (ctx.accepted(line)) return
  ctx.sites.push({ file: ctx.file, rule, line, site: ctx.lines[line - 1]?.trim() ?? '' })
}

/** The longest delay a timer keeps: a larger one fires after 1 ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1

/** A wait bound is short unless it is a finite number above the floor that a timer keeps: a negative, zero, `NaN`, infinite or overflowing one fires at once. */
export const isShortBound = (ms: number): boolean => !(ms > FLOOR_MS && ms <= MAX_TIMER_MS)

export function shortBound(call: N, ctx: Ctx, ancestors: readonly N[]): boolean {
  const place = placeAt(ancestors, call.start ?? 0)
  const bound = place ? vitestBound(call, place) ?? testingLibraryBound(call, ctx, place) : undefined
  return bound !== undefined && isShortBound(bound)
}

export const sleepNames = new Set(['delay', 'sleep', 'wait', 'pause'])

/** Whether a function body calls a timer on its resolver: `(resolve) => setTimeout(resolve, 50)`. Returns the delay argument. */
export function timerDelay(fn: N, resolver: string): { delay: N | undefined } | undefined {
  let found: { delay: N | undefined } | undefined
  walk(fn, [], node => {
    if (found || !isCall(node)) return
    const callee = calleeOf(node.callee)
    if (!callee || !/(?:setTimeout|SetTimeout)$/.test(callee.name)) return
    const first = node.arguments[0]
    if (first?.type === 'Identifier' && first.name === resolver) found = { delay: node.arguments[1] }
  })
  return found
}

/** The delay of an awaited timer (`undefined` inside when the delay is not an argument), or undefined for any other await. */
export function awaitedSleep(argument: N): { delay: N | undefined } | undefined {
  if (isCall(argument)) {
    const callee = calleeOf(argument.callee)
    const timers = callee?.name === 'setTimeout' && (callee.object === undefined || callee.object === 'timers')
    return callee && (timers || (callee.object === undefined && sleepNames.has(callee.name))) ? { delay: argument.arguments[0] } : undefined
  }
  if (argument.type !== 'NewExpression' || argument.callee.type !== 'Identifier' || argument.callee.name !== 'Promise') return undefined
  const executor = argument.arguments[0]
  if (executor?.type !== 'ArrowFunctionExpression' && executor?.type !== 'FunctionExpression') return undefined
  const param = executor.params[0]
  return param?.type === 'Identifier' ? timerDelay(executor, param.name) : undefined
}

/** Where a poll loop sits: the nodes above it, and the function (or program) a name in it is looked up in. */
export interface Where {
  loop: Loop
  scope: N
  /** Every node above the loop, outermost first. */
  above: readonly N[]
}

/** The innermost `for`, `while` or `do` loop around a node, within its own function. */
export function loopAround(ancestors: readonly N[]): Where | undefined {
  let loop: Loop | undefined
  let at = -1
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const ancestor = ancestors[i]!
    if (isFunction(ancestor)) return loop ? { loop, scope: ancestor, above: ancestors.slice(0, at) } : undefined
    if (!loop && isPollLoop(ancestor)) {
      loop = ancestor
      at = i
    }
  }
  return loop ? { loop, scope: ancestors[0]!, above: ancestors.slice(0, at) } : undefined
}

/** A sleep in a poll loop: its delay, and whether every pass of the loop reaches it. */
export interface Sleep {
  delay: N | undefined
  always: boolean
}

/** What can skip a statement that follows it: a branch, a short circuit, a `try`, a loop over a collection that may be empty. */
export const skippable = new Set(['IfStatement', 'ConditionalExpression', 'LogicalExpression', 'SwitchStatement', 'TryStatement', 'ForInStatement', 'ForOfStatement'])

/**
 * Whether every pass of the loop reaches the await. Nothing between them skips it (a branch, a short circuit, a `try`, a loop over
 * a collection), and no `continue` comes first. A sleep a pass may skip is not part of the time one pass takes.
 */
export function runsEveryPass(loop: Loop, sleeping: N, ancestors: readonly N[]): boolean {
  if (ancestors.slice(ancestors.indexOf(loop) + 1).some(ancestor => skippable.has(ancestor.type))) return false
  return !contains(loop.body, node => node.type === 'ContinueStatement' && (node.start ?? 0) < (sleeping.start ?? 0))
}

export function visitAwait(node: N, ancestors: readonly N[], ctx: Ctx): void {
  const sleep = awaitedSleep(node.argument)
  if (!sleep) return
  const around = loopAround(ancestors)
  if (!around) {
    // A zero delay outside a loop only yields to the event loop. In a loop it is the poll interval of a spin.
    if (sizeNumber(sleep.delay, readerFor(ancestors, node.start ?? 0)) !== 0) report(ctx, 'sleep', node)
    return
  }
  const entry = { delay: sleep.delay, always: runsEveryPass(around.loop, node, ancestors) }
  const known = ctx.loops.get(around.loop)
  if (known) known.sleeps.push(entry)
  else ctx.loops.set(around.loop, { sleeps: [entry], where: around })
}

export function visit(node: N, ancestors: readonly N[], ctx: Ctx): void {
  if (isCall(node) && shortBound(node, ctx, ancestors)) report(ctx, 'short-bound', node)
  else if (node.type === 'AwaitExpression') visitAwait(node, ancestors, ctx)
}

/** Acceptance by `// bound: <reason>`: on the site's line, or in the block of comment lines directly above it. */
export function acceptance(source: WaitSource): (line: number) => boolean {
  const { lines } = source
  const reasoned = new Set<number>()
  for (const comment of source.comments) {
    if (comment.line && /^\s*bound:\s*\S/.test(comment.value)) reasoned.add(source.lineOf(comment.start))
  }
  return line => {
    if (reasoned.has(line)) return true
    for (let above = line - 1; above >= 1 && lines[above - 1]?.trim().startsWith('//'); above -= 1) if (reasoned.has(above)) return true
    return false
  }
}


/** The sites of one file, read from oxlint's syntax tree in place. */
export function scanProgram(file: string, program: N, source: WaitSource): Site[] {
  const ctx: Ctx = {
    file, lines: source.lines, lineOf: offset => source.lineOf(offset), ...testingLibrary(program), accepted: acceptance(source),
    sites: [], loops: new Map(),
  }
  walk(program, [], (node, ancestors) => visit(node, ancestors, ctx))
  for (const [loop, { sleeps, where }] of ctx.loops) {
    const deadline = pollDeadline(where, sleeps)
    if (deadline === 'none' || (typeof deadline === 'number' && !(deadline > FLOOR_MS && Number.isFinite(deadline)))) report(ctx, 'poll-deadline', loop)
  }
  return ctx.sites.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule))
}

/** Every cockpit unit test under a directory, or those of them `only` names. */
export function scanTree(root = srcDir, dir = root, only?: ReadonlySet<string>): Site[] {
  return scanFiles(testFiles(root, dir, only)).flat()
}

function testFiles(root: string, dir: string, only?: ReadonlySet<string>): Array<{ file: string; code: string }> {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testFiles(root, path, only)
    const file = relative(root, path).replaceAll('\\', '/')
    if (!/\.test\.tsx?$/.test(entry.name) || (only && !only.has(file))) return []
    return [{ file, code: readFileSync(path, 'utf8') }]
  })
}

/** A local `npm run lint` shrinks the baseline (`lint/baseline-mode.ts`): a site it does not
 *  cover stays a failure. The first shrink writes the baseline from the sites the tests carry the day the ratchet lands. */
export const unitBaseline = {
  path: baselinePath,
  comment:
    'Bare sleeps, short wait bounds and unbounded poll loops the cockpit unit tests carried when the ratchet landed (hearsay-tools/cezarion#1203). ' +
    'Keyed by file, rule and the line text so a moved line does not churn it. ' +
    'This list only shrinks: fix a site, and npm run lint shrinks it; commit this file then. ' +
    'Rules: AGENTS.md § Validation.',
};

/** The cockpit scanner's original traversal scope, expressed for oxlint paths. */
export const scannedUnitFile = (file: string): boolean => file.startsWith('packages/web/src/')
  && /\.test\.tsx?$/.test(file) && !file.split('/').includes('node_modules');

/**
 * Whether a call can be a wait the rule reads, so a file with none, no `await` and no Testing Library import costs no
 * scan: a wait's name, or a bracketed member whose key the scan may resolve to one (`vi['waitFor']`). A renamed or
 * namespaced Testing Library wait is caught by its import.
 */
const waitCallee = (callee: { type: string; name?: unknown; computed?: unknown; property?: { name?: unknown } }): boolean => {
  if (callee.type === 'MemberExpression' && callee.computed === true) return true
  const name = callee.type === 'Identifier' ? callee.name : callee.property?.name
  return typeof name === 'string' && (/^(?:waitFor|waitUntil|poll|waitForElementToBeRemoved)$/.test(name) || findQuery.test(name))
}

/** The visitors that note whether a file can hold a site as oxlint walks it, then give its sites. */
export function unitVisitors(file: string, sourceCode: AstContext['sourceCode'], done: (sites: Site[], program: EsNode) => void): Visitors {
  let relevant = false
  return {
    AwaitExpression() {
      relevant = true
    },
    CallExpression(node) {
      relevant ||= waitCallee(node.callee as Parameters<typeof waitCallee>[0])
    },
    ImportDeclaration(node) {
      relevant ||= String((node.source as { value?: unknown } | undefined)?.value ?? '').startsWith('@testing-library/')
    },
    'Program:exit'(node) {
      if (!relevant) return
      const source = new WaitSource(sourceCode.text, waitComments(sourceCode.getAllComments() as unknown as ParsedComment[]))
      done(scanProgram(file, node as N, source), node)
    },
  }
}

/** The cockpit sites of files under `packages/web/src`, as oxlint parses them: the baseline runner and the rule's tests read this. */
export function scanFiles(files: ReadonlyArray<{ file: string; code: string }>): Site[][] {
  const found = new Map<string, Site[]>()
  inOxlint(files.map(each => ({ file: `packages/web/src/${each.file}`, code: each.code })), context => unitVisitors(
    context.file.slice('packages/web/src/'.length), context.sourceCode, sites => found.set(`${context.file}\0${context.sourceCode.text}`, sites)))
  return files.map(each => found.get(`packages/web/src/${each.file}\0${each.code}`) ?? [])
}

/** One file's cockpit sites; see `scanFiles`. */
export const scanSource = (file: string, code: string): Site[] => scanFiles([{ file, code }])[0] ?? []

export const unitWaitDiscipline: AstRule = {
  name: 'unit-wait-discipline',
  description: 'Wait on the cockpit product signal, with a reason for a wall-clock bound.',
  applies: scannedUnitFile,
  create: (report, { file, sourceCode }) => unitVisitors(file.slice('packages/web/src/'.length), sourceCode, (sites, program) => {
    const { added } = compareToBaseline(tally(sites), readBaseline(baselinePath))
    for (const entry of added) {
      for (const site of sites.filter(each => each.rule === entry.rule && each.site === entry.site)) {
        report(program, `[${site.rule}] ${site.site}. New wait-discipline sites. Give each a product signal, a bound of at least ${FLOOR_MS} ms, or a "// bound: <reason>" comment, rather than adding it to ${baselinePath} (AGENTS.md § Validation)`, { line: site.line, column: 0 })
      }
    }
  }),
};
