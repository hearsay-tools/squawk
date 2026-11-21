import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

/**
 * A caller of the run store takes a port from `runs/ports.ts`, never a `Pick<RunStore, …>` or a
 * `Partial<RunStore>` of its own (hearsay-tools/squawk#4035). A type that narrows `RunStore`
 * member by member lets a caller name the store's methods one by one, so the store keeps no
 * topics and every caller keeps its own list. `Parameters<RunStore[…]>` is the same bypass: take
 * the parameter type from a port or a named type in `runs/ports.ts`. Only `runs/store.ts` may
 * read its own method types that way. Tests are not checked: they exercise `RunStore` itself.
 */
const src = join(import.meta.dirname, '..');
const STORE_FILE = 'runs/store.ts';
const NARROWING = new Set(['Pick', 'Partial', 'Omit', 'Required', 'Readonly']);

type Node = { type: string; [key: string]: unknown };

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';
const isRunStore = (node: unknown): boolean => isNode(node) && node.type === 'TSTypeReference' && (node.typeName as Node).name === 'RunStore';

/** Each `Pick<RunStore, …>`-style type, and each `Parameters<RunStore[…]>` outside the store, in `source`. */
export function portBypasses(source: string, file: string): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!isNode(value)) return;
    if (value.type === 'TSTypeReference' && (value.typeName as Node).type === 'Identifier') {
      const name = (value.typeName as Node).name as string;
      const first = ((value.typeArguments as Node | undefined)?.params as unknown[] | undefined)?.[0];
      const line = (value.loc as { start: { line: number } }).start.line;
      if (NARROWING.has(name) && isRunStore(first)) found.push(`${file}:${line} ${name}<RunStore, …>`);
      if (name === 'Parameters' && file !== STORE_FILE && isNode(first) && first.type === 'TSIndexedAccessType' && isRunStore(first.objectType)) {
        found.push(`${file}:${line} Parameters<RunStore[…]>`);
      }
    }
    for (const child of Object.values(value)) if (typeof child === 'object') visit(child);
  };
  visit(parse(source, { sourceType: 'module', plugins: ['typescript'] }).program.body);
  return found;
}

/** Every non-test source file of the service, testkits included. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
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
    ].join('\n');
    expect(portBypasses(source, 'any.ts')).toEqual([
      'any.ts:2 Pick<RunStore, …>', 'any.ts:3 Partial<RunStore, …>', 'any.ts:4 Omit<RunStore, …>',
      'any.ts:5 Parameters<RunStore[…]>', 'any.ts:6 Pick<RunStore, …>',
    ]);
  });

  it('finds the type in runs/ports.ts and the rest of runs/, but lets runs/store.ts read its own method types', () => {
    const own = "export const f = (input: Parameters<RunStore['createRun']>[0]) => input;";
    expect(portBypasses("type P = Pick<RunStore, 'close'>;", 'runs/ports.ts')).toEqual(['runs/ports.ts:1 Pick<RunStore, …>']);
    expect(portBypasses("type P = Pick<RunStore, 'close'>;", 'runs/live-tasks.ts')).toHaveLength(1);
    expect(portBypasses(own, 'runs/store.ts')).toEqual([]);
    expect(portBypasses(own, 'runs/ports.ts')).toHaveLength(1);
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
