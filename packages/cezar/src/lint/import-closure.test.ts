import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importClosure, relativeImports, runtimeImports } from './import-closure.testkit.ts';

describe('runtimeImports', () => {
  it.each([
    ["import { a } from './a.ts';", ['./a.ts']],
    ['import b from "b";', ['b']],
    ["import './side-effect.ts';", ['./side-effect.ts']],
    ["export { c } from './c.ts';", ['./c.ts']],
    ["export * from './d.ts';", ['./d.ts']],
    ["const e = await import('./e.ts');", ['./e.ts']],
    ['const f = await import(`zod`);', ['zod']],
    ["import type { G } from './g.ts';", []],
    ["export type { H } from './h.ts';", []],
    ["// import { i } from './i.ts';", []],
    ["const j = \"import('./j.ts')\";", []],
    // A property or method named `import` is not the import keyword.
    ['const k = loader.import(name);', []],
    ['const l = loader?.import(name);', []],
    ['const m = { import(name) { return name; } };', []],
    ['class N { async import(name: string) { return name; } }', []],
    ['class O {\n  import(name: string): string { return name; }\n}', []],
    ["const p = ready ? await import('./p.ts') : undefined;", ['./p.ts']],
    ["import('./q.ts');\n{ import('./r.ts'); }", ['./q.ts', './r.ts']],
    ["const s = { ...import('./s.ts') };", ['./s.ts']],
    ["import('./t.ts')\n{ }", ['./t.ts']],
    // TypeScript erases a type query (hearsay-tools/cezarion#3255).
    ["export type U = import('./u.ts').U;", []],
    ["let v: import('./v.ts').V;", []],
    ["export type * from './w.ts';", []],
    // TypeScript's import-equals and a CommonJS require load a module at runtime too.
    ["import x = require('./x.ts');\nx.run();", ['./x.ts']],
    ["export import y = require('./y.ts');", ['./y.ts']],
    ["import type z = require('./z.ts');", []],
    ["const aa = require('./aa.cjs');", ['./aa.cjs']],
  ])('reads %s', (source, expected) => {
    expect(runtimeImports(source)).toEqual(expected);
  });

  // A closure pin that skipped an import it cannot read would let that import through
  // (hearsay-tools/cezarion#3241).
  it.each([
    ['const name = "./a.ts";\nconst a = await import(name);', 'import(name)'],
    ['const b = await import(`./${name}.ts`);', 'import(`./${name}.ts`)'],
    ["const c = await import('./' + name);", "import('./' + name)"],
    ['const d = require(name);', 'require(name)'],
  ])('refuses a dynamic import it cannot read: %s', (source, site) => {
    expect(() => runtimeImports(source)).toThrow(site);
  });

  it('keeps only relative specifiers in relativeImports', () => {
    expect(relativeImports("import { a } from './a.ts';\nimport { z } from 'zod';\nconst b = await import(`../b.ts`);")).toEqual(['./a.ts', '../b.ts']);
  });
});

// Vitest compiles `import.meta.glob('<pattern>')` into one import per matched file
// (hearsay-tools/squawk#3900), so a closure holds every file the pattern matches.
describe('import.meta.glob', () => {
  let root = '';
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  function tree(files: Record<string, string>): string {
    root = mkdtempSync(join(tmpdir(), 'import-closure-'));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  }

  it('reads each file a literal pattern matches beside the importing file', () => {
    const dir = tree({ 'kit/rows.ts': '', 'runners/a/facts.ts': '', 'runners/b/facts.ts': '', 'runners/b/other.ts': '' });
    const source = "const rows = import.meta.glob<Record<string, unknown>>('../runners/*/facts.ts', { eager: true });";
    expect(runtimeImports(source, join(dir, 'kit/rows.ts'))).toEqual(['../runners/a/facts.ts', '../runners/b/facts.ts']);
    expect(runtimeImports("const here = import.meta.glob('./*.ts');", join(dir, 'runners/b/facts.ts'))).toEqual(['./facts.ts', './other.ts']);
  });

  it('refuses a pattern it cannot read', () => {
    expect(() => runtimeImports('const rows = import.meta.glob(pattern);')).toThrow('import.meta.glob(pattern)');
  });

  it('walks into what the glob loads', () => {
    const dir = tree({
      'kit/rows.ts': "export const rows = import.meta.glob('../runners/*/facts.ts', { eager: true });",
      'runners/a/facts.ts': "import './adapter.ts';",
      'runners/a/adapter.ts': '',
    });
    expect(importClosure(join(dir, 'kit/rows.ts')).map(path => path.slice(dir.length + 1)))
      .toEqual(['kit/rows.ts', 'runners/a/adapter.ts', 'runners/a/facts.ts']);
  });
});
