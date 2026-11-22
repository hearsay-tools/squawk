import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from './service-sources.testkit.ts';

/**
 * A caller of the run store takes a port from `runs/ports.ts`, never a `Pick<RunStore, …>` or a
 * `Partial<RunStore>` of its own (hearsay-tools/squawk#4035). A type that narrows `RunStore`
 * member by member lets a caller name the store's methods one by one, so the store keeps no
 * topics and every caller keeps its own list. `RunStore['method']`, the same list written as an
 * indexed type, is the same bypass, `Parameters<RunStore[…]>` included: take the type from a port
 * or a named type in `runs/ports.ts`. Only `runs/ports.ts`, which declares the ports, and
 * `runs/store.ts`, which is the store, may name a member that way. `import('…').RunStore` counts
 * as `RunStore`. Tests are not checked: they exercise `RunStore` itself.
 */
const src = join(import.meta.dirname, '..');
const MAY_INDEX = new Set(['runs/store.ts', 'runs/ports.ts']);
const NARROWING = new Set(['Pick', 'Partial', 'Omit', 'Required', 'Readonly']);

type Node = { type: string; [key: string]: unknown };

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';
/** `RunStore`, or `import('…').RunStore`. */
const isRunStore = (node: unknown): boolean => isNode(node) && (
  (node.type === 'TSTypeReference' && (node.typeName as Node).name === 'RunStore') ||
  (node.type === 'TSImportType' && (node.qualifier as Node | null)?.name === 'RunStore'));

/** Each `Pick<RunStore, …>`-style type, and each `RunStore[…]` outside the files that may write one, in `source`. */
export function portBypasses(source: string, file: string): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!isNode(value)) return;
    const line = (value.loc as { start: { line: number } }).start.line;
    if (value.type === 'TSTypeReference' && (value.typeName as Node).type === 'Identifier') {
      const name = (value.typeName as Node).name as string;
      const first = ((value.typeArguments as Node | undefined)?.params as unknown[] | undefined)?.[0];
      if (NARROWING.has(name) && isRunStore(first)) found.push(`${file}:${line} ${name}<RunStore, …>`);
    }
    if (value.type === 'TSIndexedAccessType' && !MAY_INDEX.has(file) && isRunStore(value.objectType)) found.push(`${file}:${line} RunStore[…]`);
    for (const child of Object.values(value)) if (typeof child === 'object') visit(child);
  };
  visit(parse(source, { sourceType: 'module', plugins: ['typescript'] }).program.body);
  return found;
}

describe('run store ports', () => {
  it('finds a type that narrows RunStore member by member', () => {
    const source = [
      "import type { RunStore } from './store.ts';",
      "export type A = Pick<RunStore, 'getRun'>;",
      'export type B = Partial<RunStore>;',
      "export type C = Omit<RunStore, 'close'>;",
      "export type D = Parameters<RunStore['updateRun']>[1];",
      "export function f(store: Pick<RunStore, 'getRun' | 'updateRun'> & { extra: number }) { return store; }",
      "export interface G { setRepoHandle: RunStore['setRepoHandle']; }",
    ].join('\n');
    expect(portBypasses(source, 'any.ts')).toEqual([
      'any.ts:2 Pick<RunStore, …>', 'any.ts:3 Partial<RunStore, …>', 'any.ts:4 Omit<RunStore, …>',
      'any.ts:5 RunStore[…]', 'any.ts:6 Pick<RunStore, …>', 'any.ts:7 RunStore[…]',
    ]);
  });

  it("finds the same types written as import('…').RunStore", () => {
    const source = [
      "export function f(store: Pick<import('../runs/store.ts').RunStore, 'appendEvent'>) { return store; }",
      "export type A = Parameters<import('./store.ts').RunStore['updateRun']>[1];",
    ].join('\n');
    expect(portBypasses(source, 'any.ts')).toEqual(['any.ts:1 Pick<RunStore, …>', 'any.ts:2 RunStore[…]']);
  });

  it('finds the type in runs/ and lets only runs/ports.ts and runs/store.ts index RunStore', () => {
    const indexed = "export const f = (input: Parameters<RunStore['createRun']>[0]) => input;";
    expect(portBypasses("type P = Pick<RunStore, 'close'>;", 'runs/ports.ts')).toEqual(['runs/ports.ts:1 Pick<RunStore, …>']);
    expect(portBypasses("type P = Pick<RunStore, 'close'>;", 'runs/live-tasks.ts')).toHaveLength(1);
    expect(portBypasses(indexed, 'runs/store.ts')).toEqual([]);
    expect(portBypasses("type P = { close: RunStore['close'] };", 'runs/ports.ts')).toEqual([]);
    expect(portBypasses(indexed, 'runs/live-tasks.ts')).toHaveLength(1);
  });

  it('accepts a port, a Pick of a port, and a type that only names RunStore in a comment', () => {
    const source = [
      "import type { RunReads } from './ports.ts';",
      "// never Pick<RunStore, 'getRun'>",
      "export type A = Pick<RunReads, 'getRun'>;",
      "export type B = Partial<RunReads>;",
      "export type C = Parameters<RunReads['getRun']>[0];",
      'export type D = RunStore;',
    ].join('\n');
    expect(portBypasses(source, 'any.ts')).toEqual([]);
  });

  it('is kept by every non-test file of the service', () => {
    const files = sourceFiles(src);
    expect(files.length).toBeGreaterThan(500);
    const found = files.flatMap((path) => portBypasses(readFileSync(path, 'utf8'), relative(src, path)));
    expect(found).toEqual([]);
  });
});
