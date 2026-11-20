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

// A testkit loads each runner folder's data file through a template whose substitution fills one
// folder segment (hearsay-tools/squawk#3900). esbuild bundles every file it matches, so a closure
// holds them too. Vite's `import.meta.glob` breaks plain Node scripts, so the walk refuses it.
describe('folder templates', () => {
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

  it('reads each file a folder template matches beside the importing file, at any depth', () => {
    const dir = tree({ 'kit/rows.ts': '', 'runners/a/facts.ts': '', 'runners/b/facts.ts': '', 'runners/b/other.ts': '', 'runners/a/nested/facts.ts': '' });
    const source = 'const rows = await Promise.all(ids.map(id => import(`../runners/${id}/facts.ts`)));';
    expect(runtimeImports(source, join(dir, 'kit/rows.ts'))).toEqual(['../runners/a/facts.ts', '../runners/a/nested/facts.ts', '../runners/b/facts.ts']);
  });

  it('keeps a match under a dot folder relative', () => {
    const dir = tree({ 'kit/rows.ts': '', 'kit/.cache/a/facts.ts': '' });
    const source = 'const rows = await Promise.all(ids.map(id => import(`./.cache/${id}/facts.ts`)));';
    expect(runtimeImports(source, join(dir, 'kit/rows.ts'))).toEqual(['./.cache/a/facts.ts']);
    expect(relativeImports(source, join(dir, 'kit/rows.ts'))).toEqual(['./.cache/a/facts.ts']);
  });

  it.each([
    ['const a = await import(`./${name}.ts`);', 'import(`./${name}.ts`)'],
    ['const b = await import(`../runners/${id}-facts.ts`);', 'import(`../runners/${id}-facts.ts`)'],
    ['const c = await import(`${root}/runners/facts.ts`);', 'import(`${root}/runners/facts.ts`)'],
  ])('refuses a template whose substitution is not one whole folder: %s', (source, site) => {
    expect(() => runtimeImports(source)).toThrow(site);
  });

  it('refuses import.meta.glob, which plain Node scripts cannot run', () => {
    expect(() => runtimeImports("const rows = import.meta.glob('../runners/*/facts.ts', { eager: true });"))
      .toThrow("import.meta.glob runs only under Vite; plain Node scripts that load this module fail: import.meta.glob('../runners/*/facts.ts', { eager: true })");
  });

  it('walks into what a folder template loads', () => {
    const dir = tree({
      'kit/rows.ts': 'export const rows = await Promise.all(ids.map(id => import(`../runners/${id}/facts.ts`)));',
      'runners/a/facts.ts': "import './adapter.ts';",
      'runners/a/adapter.ts': '',
    });
    expect(importClosure(join(dir, 'kit/rows.ts')).map(path => path.slice(dir.length + 1)))
      .toEqual(['kit/rows.ts', 'runners/a/adapter.ts', 'runners/a/facts.ts']);
  });
});
