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

/** A function a `const` or a declaration names, with the block whose scope holds the name. */
interface NamedFunction { name: string; fn: Node; scope: Node; hoisted: boolean }

function namedFunctions(nodes: readonly Node[]): NamedFunction[] {
  const blocks = nodes.filter((node) => node.type === 'BlockStatement' || node.type === 'Program');
  const scopeOf = (node: Node): Node => blocks
    .filter((block) => startOf(block) <= startOf(node) && endOf(node) <= endOf(block))
    .reduce((inner, block) => (endOf(block) - startOf(block) < endOf(inner) - startOf(inner) ? block : inner));
  const named: NamedFunction[] = [];
  for (const node of nodes) {
    if (node.type === 'VariableDeclarator' && isListenerFunction(node.init)) named.push({ name: nameOf(node.id as Node) ?? '', fn: node.init, scope: scopeOf(node), hoisted: false });
    if (node.type === 'FunctionDeclaration' && node.id) named.push({ name: nameOf(node.id as Node) ?? '', fn: node, scope: scopeOf(node), hoisted: true });
  }
  return named;
}

/** The function `reference` names where it stands: the nearest declaration before it in a block around it, or a function declaration anywhere in one. */
function resolve(named: readonly NamedFunction[], reference: Node): Node | undefined {
  return named
    .filter((entry) => entry.name === nameOf(reference) && startOf(entry.scope) <= startOf(reference) && endOf(reference) <= endOf(entry.scope) && (entry.hoisted || startOf(entry.fn) < startOf(reference)))
    .reduce<NamedFunction | undefined>((nearest, entry) => (!nearest || startOf(entry.fn) > startOf(nearest.fn) ? entry : nearest), undefined)?.fn;
}

/** The functions a file hands to `onRunWrite` or to `subscribe({ … })` as listeners. */
function listenersOf(nodes: readonly Node[], named: readonly NamedFunction[]): Set<Node> {
  const listeners = new Set<Node>();
  const take = (arg: unknown): void => {
    const target = isListenerFunction(arg) ? arg : isNode(arg) && arg.type === 'Identifier' ? resolve(named, arg) : undefined;
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
  for (const listener of listenersOf(nodes, namedFunctions(nodes))) {
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
