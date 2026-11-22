import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from './service-sources.testkit.ts';

/**
 * A feature observes the run store through `store.lifecycle`, never through an event emitter
 * (hearsay-tools/squawk#4032). `RunStore` extends no `EventEmitter`, so the type system refuses
 * `store.on('run', …)`; this guard also refuses it in a file where the receiver is untyped. It
 * fails a member call to `on`, `once`, `off`, `addListener`, `removeListener`, `prependListener`
 * or `emit` whose first argument is one of the store's old emitter events (`run`, `deleted`,
 * `event`, `closed`), in a non-test source file outside `runs/`. Tests are not checked: a test of
 * another emitter may use those names.
 */
const src = join(import.meta.dirname, '..');
const EMITTER_CALLS = new Set(['on', 'once', 'off', 'addListener', 'removeListener', 'prependListener', 'emit']);
const STORE_EVENTS = new Set(['run', 'deleted', 'event', 'closed']);

type Node = { type: string; [key: string]: unknown };

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';

/** The text of a string literal or of a template literal with no substitution; else `undefined`. */
function literalOf(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === 'StringLiteral') return node.value as string;
  const quasis = node.type === 'TemplateLiteral' && (node.expressions as unknown[]).length === 0 ? (node.quasis as Array<{ value: { cooked: string } }>) : [];
  return quasis[0]?.value.cooked;
}

/** Each member call of an emitter method with a store event name as its first argument, in `source`. */
export function emitterCalls(source: string, file: string): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!isNode(value)) return;
    if (value.type === 'CallExpression' && isNode(value.callee) && value.callee.type === 'MemberExpression') {
      const property = value.callee.property as Node;
      const eventName = literalOf((value.arguments as unknown[])[0]);
      if (!value.callee.computed && property.type === 'Identifier' && EMITTER_CALLS.has(property.name as string) &&
        eventName !== undefined && STORE_EVENTS.has(eventName)) {
        found.push(`${file}:${(value.loc as { start: { line: number } }).start.line} .${property.name as string}('${eventName}', …)`);
      }
    }
    for (const child of Object.values(value)) if (typeof child === 'object') visit(child);
  };
  visit(parse(source, { sourceType: 'module', plugins: ['typescript'] }).program.body);
  return found;
}

describe('run store emitter', () => {
  it('finds a listener, an unsubscribe and an emit of a store event', () => {
    const source = [
      "store.on('run', onRun);",
      "ctx.store.once('closed', done);",
      "other.store.off('deleted', gone);",
      "f.store.addListener('event', seen);",
      "store.emit('run', run);",
      'store.on(`run`, tagged);',
      "export const stop = () => manager.store.removeListener('run', onRun);",
    ].join('\n');
    expect(emitterCalls(source, 'any.ts')).toEqual([
      "any.ts:1 .on('run', …)", "any.ts:2 .once('closed', …)", "any.ts:3 .off('deleted', …)",
      "any.ts:4 .addListener('event', …)", "any.ts:5 .emit('run', …)", "any.ts:6 .on('run', …)", "any.ts:7 .removeListener('run', …)",
    ]);
  });

  it('accepts the lifecycle, an emitter event with another name, and a dynamic name', () => {
    const source = [
      "store.lifecycle.subscribe({ 'run.updated': onRun });",
      "child.on('message', onMessage);",
      "process.on('exit', close);",
      "child.on(name, forward);",
      'store.on(`run-${suffix}`, tagged);',
      "const run = 'run'; stream.on(run, other);",
    ].join('\n');
    expect(emitterCalls(source, 'any.ts')).toEqual([]);
  });

  it('is kept by every non-test file of the service outside runs/', () => {
    const files = sourceFiles(src).filter((path) => !relative(src, path).startsWith('runs/'));
    expect(files.length).toBeGreaterThan(400);
    const found = files.flatMap((path) => emitterCalls(readFileSync(path, 'utf8'), relative(src, path)));
    expect(found).toEqual([]);
  });
});
