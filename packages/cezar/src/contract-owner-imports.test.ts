import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

/**
 * `delegation.ts` and `waits.ts` are large contract modules with contract imports of their own.
 * They re-export names that live in small modules, such as `agentInputSchema` and the wait bounds,
 * so outside readers keep working. A Squawk module that takes such a name from them loads the
 * whole module for one name, and so does every test that loads it (hearsay-tools/squawk#3245).
 * Squawk and contract modules import a re-exported value from the module that defines it. Type-only imports
 * load nothing, so they are not checked.
 */
const repo = join(import.meta.dirname, '../../..');
const CONTRACT = '@open-mercato/cezar-contract';
const CHECKED = ['delegation', 'waits'];

type Node = { type: string; [key: string]: unknown };

const parseSource = (path: string, text: string) =>
  parse(text, { sourceType: 'module', plugins: ['typescript', ...(path.endsWith('.tsx') ? ['jsx' as const] : [])] }).program.body as unknown as Node[];

const parseFile = (path: string) => parseSource(path, readFileSync(path, 'utf8'));

const name = (node: Node) => (node.type === 'StringLiteral' ? node.value : node.name) as string;

/** Each value the contract module re-exports, mapped to the module it comes from. */
function reExports(module: string): Map<string, string> {
  const imported = new Map<string, string>();
  const owners = new Map<string, string>();
  for (const node of parseFile(join(repo, 'packages/contract/src', `${module}.ts`))) {
    const source = (node.source as Node | null | undefined)?.value as string | undefined;
    const specifiers = (node.specifiers ?? []) as Node[];
    if (node.type === 'ImportDeclaration' && node.importKind !== 'type') {
      for (const s of specifiers) if (s.type === 'ImportSpecifier' && s.importKind !== 'type') imported.set(name(s.local as Node), source!);
    }
    if (node.type !== 'ExportNamedDeclaration' || node.exportKind === 'type') continue;
    for (const s of specifiers) {
      if (s.exportKind === 'type') continue;
      const owner = source ?? imported.get(name(s.local as Node));
      if (owner) owners.set(name(s.exported as Node), owner.replace(/^\.\//, '').replace(/\.ts$/, ''));
    }
  }
  return owners;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

type Owners = Map<string, Map<string, string>>;

/** Each `<file>: <name> from <module>, owned by <owner>` one source file takes the long way. */
function fileIndirectImports(path: string, text: string, owners: Owners, inContract: boolean): string[] {
  const found: string[] = [];
  for (const node of parseSource(path, text)) {
    const isImport = node.type === 'ImportDeclaration' && node.importKind !== 'type';
    const isReExport = node.type === 'ExportNamedDeclaration' && node.exportKind !== 'type';
    const source = (node.source as Node | null | undefined)?.value as string | undefined;
    const relativeSource = source?.startsWith('./') && !inContract;
    const moduleOwners = source && !relativeSource ? owners.get(source) : undefined;
    if (!(isImport || isReExport) || !moduleOwners) continue;
    for (const s of (node.specifiers ?? []) as Node[]) {
      if (s.importKind === 'type' || s.exportKind === 'type') continue;
      const taken = name(((isImport ? s.imported : undefined) ?? s.local) as Node);
      const owner = moduleOwners.get(taken);
      if (owner) found.push(`${relative(repo, path)}: ${taken} from ${source}, owned by ${owner}`);
    }
  }
  return found;
}

/**
 * A file can take a name from a checked module only through one of the specifiers, so only such files are parsed.
 * A specifier written with an escape, such as `'./deleg\u0061tion.ts'`, does not match the text, so a file with a backslash in a `from` string is parsed too.
 */
const mayTakeFrom = (text: string, specifiers: string[]) =>
  specifiers.some((specifier) => text.includes(specifier)) || /\bfrom\s*(['"])[^'"\n]*\\/.test(text);

/** Each `<file>: <name> from <module>, owned by <owner>` the Squawk and contract sources take the long way. */
function indirectImports(): string[] {
  const owners: Owners = new Map(CHECKED.flatMap((module) => {
    const moduleOwners = reExports(module);
    return [[`${CONTRACT}/${module}`, moduleOwners], [`./${module}.ts`, moduleOwners]];
  }));
  const specifiers = [...owners.keys()].flatMap((source) => [`'${source}'`, `"${source}"`]);
  const contract = join(repo, 'packages/contract/src');
  const checkedHere = new Set([...CHECKED, 'index'].map((module) => join(contract, `${module}.ts`)));
  return [...sourceFiles(join(repo, 'packages/cezar/src')), ...sourceFiles(contract).filter((path) => !checkedHere.has(path))].flatMap((path) => {
    const text = readFileSync(path, 'utf8');
    if (!mayTakeFrom(text, specifiers)) return [];
    return fileIndirectImports(path, text, owners, path.startsWith(contract));
  });
}

describe('imports from delegation.ts and waits.ts', () => {
  it('finds the re-exported names', () => {
    expect(reExports('delegation').get('agentInputSchema')).toBe('agent-input');
    expect(reExports('waits').get('isUsageLimitHold')).toBe('usage-limit-hold');
    expect(reExports('waits').get('WAIT_LIMIT')).toBe('wait-limits');
    expect(reExports('waits').get('computeWaitingOn')).toBe('waiting-on');
  });

  it('parses a file whose specifier holds an escape', () => {
    const owners: Owners = new Map([['./delegation.ts', reExports('delegation')]]);
    const text = "import { agentInputSchema } from './deleg\\u0061tion.ts';\n";
    expect(mayTakeFrom(text, ["'./delegation.ts'"])).toBe(true);
    expect(fileIndirectImports(join(repo, 'packages/contract/src/escaped.ts'), text, owners, true)).toEqual([
      'packages/contract/src/escaped.ts: agentInputSchema from ./delegation.ts, owned by agent-input',
    ]);
    expect(mayTakeFrom("import { x } from './other.ts';\n", ["'./delegation.ts'"])).toBe(false);
  });

  it('take no re-exported value from them', () => {
    expect(indirectImports()).toEqual([]);
  });
});
