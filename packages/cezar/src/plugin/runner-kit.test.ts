import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { readRunnerCoreImportExceptions } from '../lint/runner-core-import.ts';
import { repoRoot } from '../lint/source-rule.ts';

// The runner kit (spec 2026-11-24-plugin-loader-and-runner-kit § 3, hearsay-tools/squawk#4201).
const SRC = 'packages/cezar/src/';
const KIT = `${SRC}plugin/runner-kit.ts`;
const program = (file: string) => parse(readFileSync(join(repoRoot, file), 'utf8'), { sourceType: 'module', plugins: ['typescript'] }).program;
const nameOf = (node: { type: string; name?: string; value?: string }) => (node.type === 'Identifier' ? node.name : node.value) ?? '';

/** Each name `file` imports or re-exports from `target`, both repository paths. */
function namesFrom(file: string, target: string): string[] {
  return program(file).body.flatMap((statement) => {
    if ((statement.type !== 'ImportDeclaration' && statement.type !== 'ExportNamedDeclaration') || !statement.source) return [];
    const resolved = posix.join(posix.dirname(file), statement.source.value).replace(/\.js$/, '.ts');
    if (resolved !== target) return [];
    return (statement.specifiers ?? []).flatMap(specifier => {
      if (specifier.type === 'ImportSpecifier') return [nameOf(specifier.imported)];
      if (specifier.type === 'ExportSpecifier') return [nameOf(specifier.local)];
      return [];
    });
  });
}

describe('the runner kit', () => {
  it('only re-exports by name from modules outside the runner folders, so it holds no state of its own', () => {
    const statements = program(KIT).body;
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement.type).toBe('ExportNamedDeclaration');
      if (statement.type !== 'ExportNamedDeclaration') continue;
      expect(statement.declaration ?? null).toBeNull();
      expect(statement.source?.value).not.toMatch(/(?:^|\/)runners\//);
    }
  });

  it('exports every name a runner still imports from a core module by a relative path', () => {
    const exported = new Set(program(KIT).body.flatMap(statement =>
      statement.type === 'ExportNamedDeclaration' ? statement.specifiers.map(specifier => nameOf(specifier.exported)) : []));
    // A runner's own model-settings strategy and the antigravity ACP files move into its folder instead.
    const moves = /^packages\/cezar\/src\/(?:agent-config\/model-settings\/(?!shared\.ts)|runners\/)/;
    const missing = readRunnerCoreImportExceptions().filter(entry => !moves.test(entry.target))
      .flatMap(entry => namesFrom(entry.file, entry.target).filter(name => !exported.has(name)).map(name => `${entry.target}: ${name} (${entry.file})`));
    expect(missing).toEqual([]);
  });
});
