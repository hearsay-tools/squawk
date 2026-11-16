import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  covers, layerImport, layerImportBaselineFile, layerImports, layerMapFile, layerMapProblems, layerOf, readLayerImportExceptions,
  readLayerMap, scanLayerImports, staleLayerImports, type LayerImportException, type LayerPath,
} from './layer-import.ts';

const MAP: LayerPath[] = [
  { layer: 'core', path: 'core/' },
  { layer: 'core', path: 'workflows/' },
  { layer: 'core', path: 'paths.ts' },
  { layer: 'runner', path: 'core/pi-*' },
  { layer: 'shell', path: 'server/' },
  { layer: 'feature:workers', path: 'delegation/' },
  { layer: 'feature:skills', path: 'skills*' },
  { layer: 'feature:forge', path: 'server/forge/' },
];
const file = 'packages/cezar/src/workflows/run/steps.ts';
const scan = (source: string, path = file, exceptions: LayerImportException[] = []) =>
  scanLayerImports(path, source, MAP, exceptions).map(({ target, reason }) => `${target}: ${reason}`);

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A repository root holding `files`, a layer map and a baseline. */
function tree(files: Record<string, string>, layers: Record<string, string[]>, entries: LayerImportException[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'cez-layer-'));
  roots.push(root);
  const all = {
    ...files,
    [layerMapFile]: JSON.stringify({ layers }),
    [layerImportBaselineFile]: JSON.stringify({ entries }),
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe('layer-import (hearsay-tools/squawk#3706)', () => {
  it('places a file by its longest matching path', () => {
    expect(layerOf('core/agent-runner.ts', MAP)).toBe('core');
    expect(layerOf('core/pi-runner.ts', MAP)).toBe('runner');
    expect(layerOf('server/forge/draft-pr.ts', MAP)).toBe('feature:forge');
    expect(layerOf('server/app.ts', MAP)).toBe('shell');
    expect(layerOf('skills-remote.ts', MAP)).toBe('feature:skills');
    expect(layerOf('git-worktree.ts', MAP)).toBeUndefined();
  });

  it('reads a prefix path inside its own directory only', () => {
    expect(covers('core/pi-*', 'core/pi-rpc-wire.ts')).toBe(true);
    expect(covers('core/pi-*', 'core/pi-x/inner.ts')).toBe(false);
    expect(covers('core/pi-*', 'core/pick.ts')).toBe(false);
    expect(covers('paths.ts', 'paths.ts')).toBe(true);
    expect(covers('paths.ts', 'project-paths.ts')).toBe(false);
  });

  it.each([
    ["import { spawn } from '../../delegation/workers.ts';", 'delegation/workers.ts'],
    ["import type { Worker } from '../../delegation/workers.js';", 'delegation/workers.ts'],
    ["import { type Worker } from '../../delegation/workers.ts';", 'delegation/workers.ts'],
    ["export { spawn } from '../../delegation/workers.ts';", 'delegation/workers.ts'],
    ["export * from '../../delegation/workers.ts';", 'delegation/workers.ts'],
    ["import '../../delegation/side-effect.ts';", 'delegation/side-effect.ts'],
    ["const m = await import('../../delegation/workers.ts');", 'delegation/workers.ts'],
    ["type W = import('../../delegation/workers.ts').Worker;", 'delegation/workers.ts'],
    ["import w = require('../../delegation/workers.ts');", 'delegation/workers.ts'],
    ["import { provision } from '../../skills.ts';", 'skills.ts'],
    ["import { draft } from '../../server/forge/draft-pr.ts';", 'server/forge/draft-pr.ts'],
  ])('refuses a core import of a feature: %s', (source, target) => {
    expect(scan(source)).toEqual([`${target}: a core file imports ${layerOf(target, MAP)} (${target})`]);
  });

  it('refuses a core import of a runner file outside the runner factory', () => {
    const source = "import { PiRunner } from './pi-runner.ts';";
    expect(scan(source, 'packages/cezar/src/core/runner-cli.ts')).toEqual([
      'core/pi-runner.ts: a core file imports the runner file core/pi-runner.ts; only core/runner-factory.ts builds runners',
    ]);
    expect(scan(source, 'packages/cezar/src/core/runner-factory.ts')).toEqual([]);
  });

  it.each([
    ["import { git } from '../../paths.ts';", file],
    ["import { app } from '../../server/app.ts';", file],
    ["import { parse } from '@babel/parser';", file],
    ["import { x } from './unmapped.ts';", 'packages/cezar/src/git-worktree.ts'],
    ["import { spawn } from '../delegation/workers.ts';", 'packages/cezar/src/server/app.ts'],
    ["import { PiRunner } from './pi-runner.ts';", 'packages/cezar/src/core/pi-wire.ts'],
    ["const name = '../../delegation/workers.ts';", file],
    ["// import { spawn } from '../../delegation/workers.ts';", file],
    ["const m = await import(`../../delegation/${name}.ts`);", file],
  ])('lets %s pass', (source, path) => {
    expect(scan(source, path)).toEqual([]);
  });

  it('lets the baseline count pass and reports the next import', () => {
    const source = "import { a } from '../../delegation/workers.ts';\nimport type { B } from '../../delegation/workers.ts';\n";
    const entry = { file, target: 'packages/cezar/src/delegation/workers.ts', count: 1, reason: 'feature:workers: wiring' };
    expect(scan(source, file, [entry])).toHaveLength(1);
    expect(scan(source, file, [{ ...entry, count: 2 }])).toEqual([]);
  });

  it('reports each finding on its import line', () => {
    const source = "import { a } from '../../paths.ts';\n\nimport { b } from '../../delegation/b.ts';\n";
    expect(layerImport.check(file, source).map(({ line }) => line)).toEqual([3]);
  });

  it('resolves a specifier against the importing file', () => {
    expect(layerImports('workflows/run/steps.ts', "import a from '../../core/x.js';\nimport b from './y.ts';\nimport c from '../../../outside.ts';")
      .map(({ target }) => target)).toEqual(['core/x.ts', 'workflows/run/y.ts']);
  });

  it('fails a source file with no layer, an unused path, a repeated path and a bad layer name', () => {
    const root = tree({
      'packages/cezar/src/core/a.ts': '',
      'packages/cezar/src/loose.ts': '',
      'packages/cezar/src/loose.test.ts': '',
      'packages/cezar/src/core/__fixtures__/f.ts': '',
      'packages/cezar/src/types.d.ts': '',
    }, { core: ['core/', 'gone/', 'core/'], misc: ['nothing.ts'] });
    expect(layerMapProblems(root)).toEqual([
      `${layerMapFile}:1 cez/layer-import: gone/ matches no source file; remove it`,
      `${layerMapFile}:1 cez/layer-import: core/ is listed twice; keep it in one layer`,
      `${layerMapFile}:1 cez/layer-import: misc is no layer name; use core, runner, shell, tooling or feature:<name>`,
      `${layerMapFile}:1 cez/layer-import: nothing.ts matches no source file; remove it`,
      `packages/cezar/src/loose.ts:1 cez/layer-import: loose.ts has no layer. Add it to ${layerMapFile} (ADR 0065)`,
    ]);
  });

  it('fails two paths of one length that place a file in two layers', () => {
    const root = tree({ 'packages/cezar/src/ab.ts': '' }, { core: ['a*'], 'feature:x': ['ab.t*'], shell: ['ab.ts'] });
    expect(layerMapProblems(root)).toEqual([
      `${layerMapFile}:1 cez/layer-import: ab.t* and ab.ts both place ab.ts; make one path longer`,
    ]);
  });

  it('fails a stale, repeated, reasonless or out-of-scope baseline entry', () => {
    const importing = 'packages/cezar/src/core/a.ts';
    const target = 'packages/cezar/src/delegation/w.ts';
    const root = tree({
      [importing]: "import { w } from '../delegation/w.ts';\nimport { v } from '../delegation/w.ts';\n",
      [target]: '',
      'packages/cezar/src/server/s.ts': "import { w } from '../delegation/w.ts';\n",
    }, { core: ['core/'], shell: ['server/'], 'feature:workers': ['delegation/'] }, [
      { file: importing, target, count: 2, reason: 'feature:workers: wiring' },
      { file: importing, target, count: 2, reason: 'feature:workers: wiring' },
      { file: importing, target: 'packages/cezar/src/delegation/gone.ts', count: 1, reason: 'gone' },
      { file: 'packages/cezar/src/server/s.ts', target, count: 1, reason: 'shell' },
    ]);
    expect(staleLayerImports(root)).toEqual([
      `${layerImportBaselineFile} cez/layer-import: stale or invalid entry ${importing} → ${target} (lists 2, the file has 2); lower the count or remove the entry`,
      `${layerImportBaselineFile} cez/layer-import: stale or invalid entry ${importing} → packages/cezar/src/delegation/gone.ts (lists 1, the file has 0); lower the count or remove the entry`,
      `${layerImportBaselineFile} cez/layer-import: stale or invalid entry packages/cezar/src/server/s.ts → ${target} (lists 1, the file has 0); lower the count or remove the entry`,
    ]);
    const exact = tree({ [importing]: "import { w } from '../delegation/w.ts';\n", [target]: '' },
      { core: ['core/'], 'feature:workers': ['delegation/'] }, [{ file: importing, target, count: 1, reason: ' ' }]);
    expect(staleLayerImports(exact)).toHaveLength(1);
  });

  it('holds the repository: a placed file for each source, and a reasoned entry for each existing import', () => {
    expect(layerMapProblems()).toEqual([]);
    expect(staleLayerImports()).toEqual([]);
    expect(readLayerMap().length).toBeGreaterThan(0);
    for (const entry of readLayerImportExceptions()) expect(entry.reason).toMatch(/^(?:feature:[a-z-]+|runner): /);
  });
});
