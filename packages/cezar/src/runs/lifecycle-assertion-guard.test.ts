import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { sourceFiles, testFiles } from './service-sources.testkit.ts';

/**
 * A lifecycle listener that throws is logged and the delivery goes on (`runs/lifecycle.ts`), so an
 * `expect` inside a listener cannot fail its test: the failure never reaches the writer. A test or
 * testkit records inside the listener and asserts after the write. This guard fails an `expect`
 * call inside a function passed to `onRunWrite`, or as a handler of `subscribe({ … })`, or a
 * `const` arrow function or function declaration of the same file passed by name. Code a listener
 * calls is not followed: a helper that asserts for a listener catches its own failures.
 */
const src = join(import.meta.dirname, '..');

type Node = { type: string; [key: string]: unknown };
const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';

function* walk(value: unknown): Generator<Node> {
  if (Array.isArray(value)) { for (const child of value) yield* walk(child); return; }
  if (!isNode(value)) return;
  yield value;
  for (const [key, child] of Object.entries(value)) if (key !== 'loc' && typeof child === 'object') yield* walk(child);
}

const isListenerFunction = (node: unknown): node is Node => isNode(node) && (/Function/.test(node.type) || node.type === 'ObjectMethod');
const nameOf = (node: Node): string | undefined => node.type === 'Identifier' ? node.name as string : undefined;

const startOf = (node: Node): number => node.start as number;
const endOf = (node: Node): number => node.end as number;
const sizeOf = (node: Node): number => endOf(node) - startOf(node);
const contains = (outer: Node, inner: Node): boolean => startOf(outer) <= startOf(inner) && endOf(inner) <= endOf(outer);

/** One place a name is bound: `fn` is the function it holds, if any; `scope` is the node whose body sees it. */
interface Binding { name: string; fn: Node | undefined; scope: Node; at: number }

/** The names a file binds: `const`s, function declarations and simple parameters. */
function bindingsOf(nodes: readonly Node[]): Binding[] {
  const blocks = nodes.filter((node) => node.type === 'BlockStatement' || node.type === 'Program');
  const blockOf = (node: Node): Node => blocks.filter((block) => contains(block, node)).reduce((inner, block) => (sizeOf(block) < sizeOf(inner) ? block : inner));
  const bindings: Binding[] = [];
  for (const node of nodes) {
    if (node.type === 'VariableDeclarator' && nameOf(node.id as Node)) {
      bindings.push({ name: nameOf(node.id as Node)!, fn: isListenerFunction(node.init) ? node.init : undefined, scope: blockOf(node), at: startOf(node) });
    }
    if (node.type === 'FunctionDeclaration' && node.id) bindings.push({ name: nameOf(node.id as Node)!, fn: node, scope: blockOf(node), at: startOf(node) });
    for (const param of isListenerFunction(node) ? (node.params as Node[] | undefined) ?? [] : []) {
      const id = param.type === 'AssignmentPattern' ? (param.left as Node) : param;
      if (nameOf(id)) bindings.push({ name: nameOf(id)!, fn: undefined, scope: node, at: startOf(node) });
    }
  }
  return bindings;
}

/** The function `reference` names where it stands: its innermost binding, and only a function counts. A binding declared after the reference counts: a closure that holds the reference runs after the declaration. */
function resolve(bindings: readonly Binding[], reference: Node): Node | undefined {
  const visible = bindings.filter((binding) => binding.name === nameOf(reference) && contains(binding.scope, reference));
  const innermost = visible.reduce<Binding | undefined>((best, binding) => {
    if (!best || sizeOf(binding.scope) < sizeOf(best.scope)) return binding;
    return sizeOf(binding.scope) === sizeOf(best.scope) && binding.at > best.at ? binding : best;
  }, undefined);
  return innermost?.fn;
}

/** The functions a file hands to `onRunWrite` or to `subscribe({ … })` as listeners. */
function listenersOf(nodes: readonly Node[], bindings: readonly Binding[]): Set<Node> {
  const listeners = new Set<Node>();
  const take = (arg: unknown): void => {
    const target = isListenerFunction(arg) ? arg : isNode(arg) && arg.type === 'Identifier' ? resolve(bindings, arg) : undefined;
    if (target) listeners.add(target);
  };
  for (const node of nodes) {
    if (node.type !== 'CallExpression') continue;
    const callee = node.callee as Node;
    const name = callee.type === 'MemberExpression' ? nameOf(callee.property as Node) : nameOf(callee);
    const args = node.arguments as Node[];
    if (name === 'onRunWrite') take(args[1]);
    if (name === 'subscribe' && args[0]?.type === 'ObjectExpression') {
      for (const property of args[0].properties as Node[]) take(property.type === 'ObjectMethod' ? property : property.value);
    }
  }
  return listeners;
}

/** Each `expect(…)` call inside a lifecycle listener, in `source`. */
export function assertionsInListeners(source: string, file: string): string[] {
  const nodes = [...walk(parse(source, { sourceType: 'module', plugins: ['typescript'] }).program)];
  const lines = new Set<number>();
  for (const listener of listenersOf(nodes, bindingsOf(nodes))) {
    for (const node of walk(listener.body)) {
      if (node.type === 'CallExpression' && nameOf(node.callee as Node) === 'expect') {
        lines.add((node.loc as { start: { line: number } }).start.line);
      }
    }
  }
  return [...lines].sort((a, b) => a - b).map((line) => `${file}:${line} expect inside a lifecycle listener`);
}

describe('assertions in lifecycle listeners', () => {
  it('finds an expect inside each form of listener', () => {
    const source = [
      'onRunWrite(store.lifecycle, (run) => { expect(run.id).toBe(id); });',
      "store.lifecycle.subscribe({ 'run.event': ({ event }) => { expect(event.type).toBe('x'); } });",
      "const onRun = (run) => { expect(run).toBeDefined(); };",
      'onRunWrite(store.lifecycle, onRun);',
      "source.subscribe({ 'run.deleted'({ runId }) { expect(runId).toBe(id); } });",
    ].join('\n');
    expect(assertionsInListeners(source, 'any.ts')).toEqual([
      'any.ts:1 expect inside a lifecycle listener', 'any.ts:2 expect inside a lifecycle listener',
      'any.ts:3 expect inside a lifecycle listener', 'any.ts:5 expect inside a lifecycle listener',
    ]);
  });

  it('resolves a named listener where it is registered: the same name in two tests', () => {
    const source = [
      "it('first', () => {",
      '  const onRun = (run) => { expect(run.id).toBe(id); };',
      '  onRunWrite(store.lifecycle, onRun);',
      '});',
      "it('second', () => {",
      '  const onRun = (run) => { seen.push(run.id); };',
      '  onRunWrite(store.lifecycle, onRun);',
      '});',
      "it('third', () => {",
      '  onRunWrite(store.lifecycle, hoisted);',
      '  function hoisted(run) { expect(run).toBeDefined(); }',
      '});',
    ].join('\n');
    expect(assertionsInListeners(source, 'any.ts')).toEqual([
      'any.ts:2 expect inside a lifecycle listener', 'any.ts:11 expect inside a lifecycle listener',
    ]);
  });

  it('resolves a name to its innermost binding: a later outer function or an inner shadow', () => {
    const source = [
      "it('inner listener, outer recorder', () => {",
      '  const onRun = (run) => { expect(run.id).toBe(id); };',
      '  onRunWrite(store.lifecycle, onRun);',
      '});',
      'function onRun(run) { seen.push(run); }',
      "it('outer listener, inner mock', () => {",
      '  const onRun = vi.fn();',
      '  onRunWrite(store.lifecycle, onRun);',
      '});',
      "it('a parameter shadows', (onRun) => {",
      '  onRunWrite(store.lifecycle, onRun);',
      '});',
    ].join('\n');
    expect(assertionsInListeners(source, 'any.ts')).toEqual(['any.ts:2 expect inside a lifecycle listener']);
    const outer = "function onRun(run) { expect(run).toBeDefined(); }\nit('x', () => { const onRun = vi.fn(); onRunWrite(store.lifecycle, onRun); });";
    expect(assertionsInListeners(outer, 'any.ts')).toEqual([]);
  });

  it('resolves a binding declared after a closure that registers it', () => {
    const source = [
      'function register() { onRunWrite(source, onRun); }',
      'const onRun = run => { expect(run).toBeDefined(); };',
      'register();',
    ].join('\n');
    expect(assertionsInListeners(source, 'any.ts')).toEqual(['any.ts:2 expect inside a lifecycle listener']);
  });

  it('accepts a listener that records, and an expect outside every listener', () => {
    const source = [
      'const seen = [];',
      'onRunWrite(store.lifecycle, (run) => { seen.push(run.id); });',
      "store.lifecycle.subscribe({ 'run.deleted': ({ runId }) => { seen.push(runId); } });",
      'expect(seen).toEqual([id]);',
      "const check = () => { expect(seen).toEqual([]); };",
      'const timer = setTimeout(check, 1);',
    ].join('\n');
    expect(assertionsInListeners(source, 'any.ts')).toEqual([]);
  });

  it('is kept by every test and testkit of the service', () => {
    const files = [...testFiles(src), ...sourceFiles(src)].filter((path) => /\.(test|testkit)\.ts$/.test(path));
    expect(files.length).toBeGreaterThan(1000);
    const found = files.flatMap((path) => assertionsInListeners(readFileSync(path, 'utf8'), relative(src, path)));
    expect(found).toEqual([]);
  });
});
