import type { ArrowFunctionExpression, AwaitExpression, CallExpression, Comment, File, Node } from '@babel/types';
import { babelView, originalNode } from './ast-node-view.ts';
import { child, children, nameOf, stringOf, type EsNode, type Visitors } from './ast-rule.ts';
import { acceptance, awaitedSleep, isFunction, loopAround, report, runsEveryPass, testingLibrary, type Ctx, type Site } from './unit-wait-discipline.ts';
import { calleeOf, placeAt, readerFor, sizeNumber, testingLibraryBound, vitestBound } from './unit-wait-values.ts';
import { pollDeadline } from './unit-wait-deadlines.ts';
import { serverNumber, serverRead, serverVitestBound } from './server-wait-ast-values.ts';

/** Shared AST site discovery for the two wait disciplines (hearsay-tools/squawk#3774). */
export interface WaitSource {
  file: string;
  sourceCode: { text: string; getText(node: EsNode): string; getAllComments(): readonly EsNode[] };
}

export interface AstWaitSite extends Site { node: EsNode }
export type WaitProfile = 'server' | 'unit';

const helpers = new Set(['waitFor', 'waitUntil', 'until', 'eventually', 'waitForCondition']);
const sleeps = new Set(['sleep', 'delay', 'wait', 'pause', 'setTimeout']);
const collection = new Set(['ForInStatement', 'ForOfStatement']);
const short = (value: number | undefined, floor: number): boolean => value !== undefined && !(value >= floor && value <= 2 ** 31 - 1);

function ancestorsOf(node: EsNode): Node[] {
  const ancestors: Node[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) ancestors.push(babelView(parent));
  return ancestors.reverse();
}

function firstTimer(executor: ArrowFunctionExpression): CallExpression | undefined {
  const body = executor.body.type === 'BlockStatement' ? executor.body.body[0] : executor.body;
  const call = body?.type === 'ExpressionStatement' ? body.expression : body?.type === 'ReturnStatement' ? body.argument : body;
  return call?.type === 'CallExpression' ? call : undefined;
}

function serverTimer(call: CallExpression, resolver: string): { delay: Node | undefined } | undefined {
  const callee = calleeOf(call.callee);
  if (!callee || !/(?:setTimeout|SetTimeout)$/.test(callee.name) || (callee.object !== undefined && callee.object !== 'global' && callee.object !== 'globalThis')) return undefined;
  const first = call.arguments[0];
  return first?.type === 'Identifier' && first.name === resolver && call.arguments[1] ? { delay: call.arguments[1] } : undefined;
}

/** The server's promise form deliberately reads only its first timer statement. */
function serverSleep(argument: Node): { delay: Node | undefined } | undefined {
  if (argument.type === 'CallExpression') {
    const callee = argument.callee;
    const direct = callee.type === 'Identifier' && sleeps.has(callee.name);
    const timer = callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.object.name === 'timers' && callee.property.type === 'Identifier' && callee.property.name === 'setTimeout';
    return direct || timer ? { delay: argument.arguments[0] } : undefined;
  }
  if (argument.type !== 'NewExpression') return undefined;
  if (argument.callee.type !== 'Identifier' || argument.callee.name !== 'Promise') return undefined;
  const executor = argument.arguments[0];
  if (executor?.type !== 'ArrowFunctionExpression' || executor.params.length !== 1 || executor.params[0]?.type !== 'Identifier') return undefined;
  const call = firstTimer(executor);
  return call ? serverTimer(call, executor.params[0].name) : undefined;
}

function inCollection(ancestors: readonly Node[]): boolean {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const node = ancestors[index]!;
    if (isFunction(node)) return false;
    if (collection.has(node.type)) return true;
    if (node.type === 'ForStatement' || node.type === 'WhileStatement' || node.type === 'DoWhileStatement') return false;
  }
  return false;
}

function visitSleep(node: AwaitExpression, ancestors: readonly Node[], ctx: Ctx, profile: WaitProfile): void {
  const sleep = profile === 'server' ? serverSleep(node.argument) : awaitedSleep(node.argument);
  if (!sleep || (profile === 'server' && inCollection(ancestors))) return;
  const around = loopAround(ancestors);
  if (!around) {
    const read = profile === 'server' ? () => undefined : readerFor(ancestors, node.start ?? 0);
    const delay = profile === 'server' ? serverNumber(sleep.delay, read) : sizeNumber(sleep.delay, read);
    if (delay !== 0) report(ctx, 'sleep', node);
    return;
  }
  const entry = { delay: sleep.delay, always: runsEveryPass(around.loop, node, ancestors) };
  const known = ctx.loops.get(around.loop);
  if (known) known.sleeps.push(entry);
  else ctx.loops.set(around.loop, { sleeps: [entry], where: around });
}

function visitCall(node: CallExpression, ancestors: readonly Node[], ctx: Ctx, profile: WaitProfile, floor: number, text: (node: Node) => string): void {
  if (node.type !== 'CallExpression') return;
  const place = placeAt(ancestors, node.start ?? 0);
  if (!place) return;
  if (profile === 'server') place.read = serverRead(place);
  const bound = profile === 'server' ? serverVitestBound(node, place, text) : vitestBound(node, place) ?? testingLibraryBound(node, ctx, place);
  if (short(bound, floor)) report(ctx, 'short-bound', node);
  if (profile !== 'server' || node.callee.type !== 'Identifier' || !helpers.has(node.callee.name)) return;
  if (node.arguments.slice(1).some(argument => short(serverNumber(argument, place.read), floor))) report(ctx, 'short-bound', node);
}

function visitDefaults(node: Node, ancestors: readonly Node[], ctx: Ctx, floor: number): void {
  let fn: Node | null | undefined;
  let name: string | undefined;
  if (node.type === 'FunctionDeclaration') { fn = node; name = node.id?.name; }
  if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init?.type === 'ArrowFunctionExpression') { fn = node.init; name = node.id.name; }
  if (!name || !helpers.has(name) || !fn || !('params' in fn)) return;
  const read = readerFor(ancestors, node.start ?? 0);
  if (fn.params.some(param => param.type === 'AssignmentPattern' && param.left.type === 'Identifier' && !/interval/i.test(param.left.name) && short(serverNumber(param.right, read), floor))) {
    // The server keys an arrow definition at the declaration, including its const/let/var.
    const site = node.type === 'VariableDeclarator' && ancestors.at(-1)?.type === 'VariableDeclaration' ? ancestors.at(-1)! : node;
    report(ctx, 'short-bound', site);
  }
}

function commentsOf(source: WaitSource): Comment[] {
  return source.sourceCode.getAllComments().map(comment => ({
    type: comment.type === 'Line' ? 'CommentLine' : 'CommentBlock',
    value: comment.value,
    loc: comment.loc,
    start: comment.start,
    end: comment.end,
  })) as unknown as Comment[];
}

/** Reject unrelated calls before constructing a typed view or reading lexical scopes. */
function possibleCall(node: EsNode, ctx: Ctx, profile: WaitProfile): boolean {
  const callee = child(node, 'callee');
  const direct = nameOf(callee);
  if (direct !== undefined) return profile === 'server' ? helpers.has(direct) : ctx.tlWaits.has(direct) || /^find(?:All)?By[A-Z]/.test(direct);
  if (callee?.type !== 'MemberExpression') return false;
  const receiver = nameOf(child(callee, 'object'));
  if (receiver === 'vi' || receiver === 'expect') return true;
  if (profile !== 'unit') return false;
  const key = child(callee, 'property');
  const name = callee.computed ? stringOf(key) : nameOf(key);
  return (receiver !== undefined && ctx.tlNamespaces.has(receiver)) || /^find(?:All)?By[A-Z]/.test(name ?? '');
}

function possibleSleep(node: EsNode, profile: WaitProfile): boolean {
  const argument = child(node, 'argument');
  if (argument?.type === 'NewExpression') return nameOf(child(argument, 'callee')) === 'Promise';
  if (argument?.type !== 'CallExpression') return false;
  const callee = child(argument, 'callee');
  const name = nameOf(callee);
  if (name !== undefined) return sleeps.has(name);
  if (callee?.type !== 'MemberExpression') return false;
  const key = child(callee, 'property');
  const member = callee.computed ? stringOf(key) : nameOf(key);
  return profile === 'server' ? member === 'setTimeout' : sleeps.has(member ?? '');
}

/** Oxlint discovers sites; the existing AST evaluator reads their bounds and lexical scopes. */
export function waitVisitors(profile: WaitProfile, source: WaitSource, finish: (sites: AstWaitSite[]) => void): Visitors {
  const floor = profile === 'server' ? 10_000 : 3_000;
  const lines = source.sourceCode.text.split('\n');
  let ctx: Ctx;
  const nodes = new Map<Site, EsNode>();
  const text = (node: Node) => source.sourceCode.getText(originalNode(node));
  const remember = (node: EsNode, action: (view: Node, ancestors: Node[]) => void) => {
    const before = ctx.sites.length;
    action(babelView(node), ancestorsOf(node));
    for (const site of ctx.sites.slice(before)) nodes.set(site, node);
  };
  return {
    Program(node) {
      const imports = profile === 'unit' ? children(node, 'body').filter(statement => statement.type === 'ImportDeclaration').map(babelView) : [];
      const library = testingLibrary({ program: { body: imports } } as File);
      ctx = { file: source.file, lines, ...library, accepted: acceptance(lines, commentsOf(source)), sites: [], loops: new Map() };
    },
    CallExpression(node) { if (possibleCall(node, ctx, profile)) remember(node, (view, ancestors) => visitCall(view as CallExpression, ancestors, ctx, profile, floor, text)); },
    AwaitExpression(node) { if (possibleSleep(node, profile)) remember(node, (view, ancestors) => visitSleep(view as AwaitExpression, ancestors, ctx, profile)); },
    FunctionDeclaration(node) { if (profile === 'server' && helpers.has(nameOf(child(node, 'id')) ?? '')) remember(node, (view, ancestors) => visitDefaults(view, ancestors, ctx, floor)); },
    VariableDeclarator(node) { if (profile === 'server' && helpers.has(nameOf(child(node, 'id')) ?? '') && child(node, 'init')?.type === 'ArrowFunctionExpression') remember(node, (view, ancestors) => visitDefaults(view, ancestors, ctx, floor)); },
    'Program:exit'() {
      for (const [loop, { sleeps, where }] of ctx.loops) {
        const deadline = pollDeadline(where, sleeps);
        if (deadline !== 'none' && !(typeof deadline === 'number' && !(deadline >= floor && Number.isFinite(deadline)))) continue;
        const before = ctx.sites.length;
        report(ctx, 'poll-deadline', loop);
        for (const site of ctx.sites.slice(before)) nodes.set(site, originalNode(loop));
      }
      finish(ctx.sites.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule)).map(site => ({ ...site, node: nodes.get(site)! })));
    },
  };
}
