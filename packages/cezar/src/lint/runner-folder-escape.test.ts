import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkRule, ruleCases } from './ast-rule.testkit.ts';
import {
  applies,
  classifySpecifier,
  hasRunnerFolderEscapeBaselineEntries,
  isAllowedPackageSpecifier,
  readRunnerFolderEscapeExceptions,
  runnerFolderEscape,
  runnerFolderEscapeBaselineDir,
  runnerFolderEscapeBaselineFile,
  runnerFolderEscapes,
  runnerFolderEscapeVisitors,
  runnerFolderOf,
  runnerIdOf,
  scanRunnerFolderEscapes,
  staleRunnerFolderEscapes,
  type RunnerFolderEscapeException,
  type RunnerFolderEscapeFinding,
} from './runner-folder-escape.ts';

const piFile = 'packages/cezar/src/runners/pi/pi-probe.ts';
const nestedFile = 'packages/cezar/src/runners/antigravity/acp/probe.ts';
const mjsFile = 'packages/cezar/src/runners/pi/extensions/probe.mjs';

/** Findings from `scanRunnerFolderEscapes` cross-checked against oxlint's `checkRule`. */
function scan(source: string, path = piFile, exceptions: RunnerFolderEscapeException[] = []): RunnerFolderEscapeFinding[] {
  const expected = scanRunnerFolderEscapes(path, source, exceptions);
  const findings = checkRule({ ...runnerFolderEscape, create: report => runnerFolderEscapeVisitors(report, path, exceptions) }, path, source);
  expect(findings).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    expect(findings[i]?.message).toContain(expected[i]!.target);
  }
  return expected;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'cez-runner-escape-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe('runner-folder-escape (hearsay-tools/squawk#4255)', () => {
  it('identifies runner ids and folders while excluding fixture/ and non-runner files', () => {
    expect(runnerIdOf('packages/cezar/src/runners/pi/pi-runner.ts')).toBe('pi');
    expect(runnerFolderOf('packages/cezar/src/runners/pi/pi-runner.ts')).toBe('packages/cezar/src/runners/pi/');
    expect(runnerIdOf('packages/cezar/src/runners/antigravity/acp/session.ts')).toBe('antigravity');
    expect(runnerIdOf('packages/cezar/src/runners/fixture/fixture-adapter.ts')).toBeUndefined();
    expect(runnerIdOf('packages/cezar/src/runners/beside.ts')).toBeUndefined();
    expect(runnerIdOf('packages/cezar/src/core/agent-runner.ts')).toBeUndefined();
  });

  it('applies to non-test JS/TS/MJS runner files and skips tests, testkits, declarations, fixtures, and non-code files', () => {
    for (const included of [
      piFile,
      nestedFile,
      mjsFile,
      'packages/cezar/src/runners/opencode/opencode-task-scope.mjs',
      'packages/cezar/src/runners/omp/helper.js',
      'packages/cezar/src/runners/claude/helper.mts',
    ]) expect(applies(included)).toBe(true);

    for (const excluded of [
      'packages/cezar/src/runners/pi/pi-runner.test.ts',
      'packages/cezar/src/runners/pi/extensions/pi-ci-wait.test.mjs',
      'packages/cezar/src/runners/pi/pi-runner.testkit.ts',
      'packages/cezar/src/runners/pi/types.d.ts',
      'packages/cezar/src/runners/pi/extensions/pi-ci-wait.d.mts',
      'packages/cezar/src/runners/pi/__fixtures__/rpc.ts',
      'packages/cezar/src/runners/fixture/fixture-adapter.ts',
      'packages/cezar/src/runners/beside.ts',
      'packages/cezar/src/core/agent-runner.ts',
      'packages/cezar/src/runners/pi/README.md',
    ]) expect(applies(excluded)).toBe(false);
  });

  it('allows only node:* and @hearsay-tools/squawk/plugin* package specifiers', () => {
    for (const ok of [
      'node:fs',
      'node:path/posix',
      'node:url',
      '@hearsay-tools/squawk/plugin',
      '@hearsay-tools/squawk/plugin/runtime',
      '@hearsay-tools/squawk/plugin/pi-rpc',
    ]) expect(isAllowedPackageSpecifier(ok)).toBe(true);

    for (const bad of [
      'zod',
      'fs',
      'node:',
      'node:../fs',
      '@hearsay-tools/squawk',
      '@hearsay-tools/squawk/core',
      '@hearsay-tools/squawk/plugin-extra',
      '@hearsay-tools/squawk/plugin/../core',
      '@open-mercato/cezar-contract/effort',
    ]) expect(isAllowedPackageSpecifier(bad)).toBe(false);
  });

  it('classifies relative and package specifiers cleanly', () => {
    expect(classifySpecifier(piFile, './pi-args.ts')).toBeUndefined();
    expect(classifySpecifier(piFile, './sub/../pi-args.ts')).toBeUndefined();
    expect(classifySpecifier(nestedFile, '../antigravity-runner.ts')).toBeUndefined();
    expect(classifySpecifier(piFile, '../omp/omp-runner.ts')).toEqual({ kind: 'import', target: 'packages/cezar/src/runners/omp/omp-runner.ts' });
    expect(classifySpecifier(piFile, '../pi/pi-args.ts')).toEqual({ kind: 'import', target: '../pi/pi-args.ts' });
    expect(classifySpecifier(piFile, 'zod')).toEqual({ kind: 'package', target: 'zod' });
    expect(classifySpecifier(piFile, 'node:fs')).toBeUndefined();
    expect(classifySpecifier(piFile, '@hearsay-tools/squawk/plugin')).toBeUndefined();
  });

  ruleCases(runnerFolderEscape, {
    file: piFile,
    valid: [
      "import { readFileSync } from 'node:fs';",
      "import { join, posix, resolve } from 'node:path';",
      "import { productEnv, type UiEvent } from '@hearsay-tools/squawk/plugin';",
      "import { createRuntime } from '@hearsay-tools/squawk/plugin/runtime';",
      "import { buildPiArgs } from './pi-args.ts';",
      "export { facts } from './facts.ts';",
      "const load = () => import('./pi-runner.ts');",
      "const loadNode = () => import('node:crypto');",
      "const loadKit = () => import('@hearsay-tools/squawk/plugin/pi-rpc');",
      'const loadDyn = (href: string) => import(href);',
      'const loadDynTpl = (url: string) => import(`${url}`);',
      "const ext = new URL('./extensions/pi-ci-wait.mjs', import.meta.url);",
      'const extTpl = (name: string) => new URL(`./extensions/${name}.mjs`, import.meta.url);',
      "const sameDir = new URL('.', import.meta.url);",
      "const normalized = new URL('./sub/../pi-args.ts', import.meta.url);",
      "const externalUrl = new URL('https://example.com/../foo', import.meta.url);",
      "const clientBuilt = new URL('../../dist/ci-wait/client.js', clientUrl);",
      "const singleArg = new URL('https://example.com');",
      "const inside = join(here, 'extensions', 'pi-ci-wait.mjs');",
      "const insideBack = join(here, 'extensions', '..', 'pi-args.ts');",
      "const abs = resolve('/tmp', '..', 'x');",
      "const resetAbs = resolve(here, '/tmp', '..');",
      "const listJoin = items.join('..');",
      "const resolvedPromise = Promise.resolve('..');",
      "const plainJoin = join(cwd, '.agents', 'skills');",
    ],
    invalid: [
      // new URL escapes
      "const a = new URL('../omp/omp-runner.ts', import.meta.url);",
      "const b = new URL('../../../scripts/mock-pi-rpc.mjs', import.meta.url);",
      "const c = new globalThis.URL('../outside.mjs', import.meta.url);",
      'const d = (name: string) => new URL(`../../../scripts/${name}`, import.meta.url);',
      "const e = (name: string) => new URL('../../../scripts/' + name, import.meta.url);",
      "const f = new URL('/scripts/mock-pi-rpc.mjs', import.meta.url);",
      "const g = new URL('../pi/pi-args.ts', import.meta.url);",
      // join / resolve escapes
      "const h = join(here, '..', '..', 'scripts');",
      "const i = resolve(here, '..', '..', '..', 'scripts', 'mock-claude.mjs');",
      "import { resolve as resolvePath } from 'node:path';\nconst j = resolvePath(here, '..', '..', '..', 'scripts', 'mock-claude.mjs');",
      "import { join as joinPath } from 'node:path/posix';\nconst k = joinPath(here, '../..', 'scripts');",
      "const l = path.join(here, '..', 'other');",
      "const m = path.resolve(here, '..', 'other');",
      "const n = posix.join(here, '..', 'other');",
      "const o = posix.resolve(here, '..', 'other');",
      "const p = path.posix.join(here, '..', 'other');",
      "import nodePath from 'node:path';\nconst q = nodePath.resolve(here, '..', 'other');",
      "import * as pNs from 'node:path';\nconst r = pNs.posix.join(here, '..', 'other');",
      "const s = join(here, 'sub', '..', '..', 'outside');",
      "const t = join(here, '..\\\\..\\\\scripts\\\\mock.mjs');",
      "const u = resolve('..', 'outside');",
      // relative import/export/require escapes
      "import { productEnv } from '../../core/product-env.ts';",
      "import type { UiEvent } from '../../core/ui-events.ts';",
      "import '../omp/omp-runner.ts';",
      "import '../pi/pi-args.ts';",
      "export { productEnv } from '../../core/product-env.ts';",
      "export * from '../omp/omp-runner.ts';",
      "const v = () => import('../../core/product-env.ts');",
      'const w = (name: string) => import(`../../../scripts/${name}`);',
      "type Env = import('../../core/product-env.ts').ProductEnv;",
      "import env = require('../../core/product-env.ts');",
      "const cjs = require('../outside.cjs');",
      // disallowed package imports
      "import { z } from 'zod';",
      "import type { ZodType } from 'zod';",
      "export { z } from 'zod';",
      "const dz = () => import('zod');",
      "type Z = import('zod').ZodType;",
      "import z = require('zod');",
      "const rz = require('zod');",
      "import { parseEffort } from '@open-mercato/cezar-contract/effort';",
      "import fs from 'fs';",
      "import x from '@hearsay-tools/squawk';",
      "import x from '@hearsay-tools/squawk/plugin/../core';",
    ],
  });

  ruleCases(runnerFolderEscape, {
    file: nestedFile,
    valid: [
      "import { helper } from '../helper.ts';",
      "const localUrl = new URL('../helper.mjs', import.meta.url);",
      "const localJoin = join(here, '..', 'helper.mjs');",
    ],
    invalid: [
      "import { other } from '../../claude/claude-runner.ts';",
      "const escapeUrl = new URL('../../claude/x.mjs', import.meta.url);",
      "const escapeJoin = join(here, '..', '..', 'claude', 'x.mjs');",
    ],
  });

  ruleCases(runnerFolderEscape, {
    file: mjsFile,
    valid: [
      "import { existsSync } from 'node:fs';\nconst local = new URL('../pi-args.ts', import.meta.url);\nconst built = new URL('../../dist/ci-wait/client.js', clientUrl);\nexport default { existsSync, local, built };",
    ],
    invalid: [
      "const escape = new URL('../../../scripts/x.mjs', import.meta.url);",
      "import { z } from 'zod';",
      "import { x } from '../../omp/x.mjs';",
    ],
  });

  it('respects baseline counts per (file, kind, target) and reports any extra site', () => {
    const source = [
      "import { z } from 'zod';",
      "const dz = () => import('zod');",
      "const u = new URL('../../../scripts/mock.mjs', import.meta.url);",
      "const p = resolve(here, '..', '..', '..', 'scripts', 'mock.mjs');",
    ].join('\n');

    expect(scan(source)).toEqual([
      { kind: 'package', target: 'zod' },
      { kind: 'package', target: 'zod' },
      { kind: 'url', target: 'packages/cezar/scripts/mock.mjs' },
      { kind: 'path', target: 'packages/cezar/scripts/mock.mjs' },
    ]);

    // Allowing url does NOT allow path to the same target; count 1 of zod leaves the 2nd zod reported.
    expect(scan(source, piFile, [
      { file: piFile, kind: 'package', target: 'zod', count: 1 },
      { file: piFile, kind: 'url', target: 'packages/cezar/scripts/mock.mjs', count: 1 },
    ])).toEqual([
      { kind: 'package', target: 'zod' },
      { kind: 'path', target: 'packages/cezar/scripts/mock.mjs' },
    ]);

    expect(scan(source, piFile, [
      { file: piFile, kind: 'package', target: 'zod', count: 2 },
      { file: piFile, kind: 'url', target: 'packages/cezar/scripts/mock.mjs', count: 1 },
      { file: piFile, kind: 'path', target: 'packages/cezar/scripts/mock.mjs', count: 1 },
    ])).toEqual([]);
  });

  it('reads per-runner baseline entries and reports whether any remain', () => {
    const root = makeTree({
      [runnerFolderEscapeBaselineFile('pi')]: JSON.stringify({
        entries: [{ file: piFile, kind: 'package', target: 'zod', count: 1 }],
      }),
      [runnerFolderEscapeBaselineFile('omp')]: JSON.stringify({ entries: [] }),
    });
    expect(readRunnerFolderEscapeExceptions('pi', root)).toEqual([
      { file: piFile, kind: 'package', target: 'zod', count: 1 },
    ]);
    expect(hasRunnerFolderEscapeBaselineEntries('pi', root)).toBe(true);
    expect(hasRunnerFolderEscapeBaselineEntries('omp', root)).toBe(false);
    expect(readRunnerFolderEscapeExceptions('unknown', root)).toEqual([]);
    expect(hasRunnerFolderEscapeBaselineEntries('unknown', root)).toBe(false);
  });

  it('detects stale, duplicate, misfiled, out-of-scope, invalid, and missing baseline entries', () => {
    const ompFile = 'packages/cezar/src/runners/omp/omp-probe.ts';
    const root = makeTree({
      [piFile]: "import { z } from 'zod';\n",
      [ompFile]: "import { z } from 'zod';\n",
      [runnerFolderEscapeBaselineFile('pi')]: JSON.stringify({
        entries: [
          { file: piFile, kind: 'package', target: 'zod', count: 1 },
          { file: piFile, kind: 'package', target: 'zod', count: 1 },
          { file: ompFile, kind: 'package', target: 'zod', count: 1 },
          { file: 'packages/cezar/src/runners/pi/pi-probe.test.ts', kind: 'package', target: 'zod', count: 1 },
          { file: piFile, kind: 'url', target: 'packages/cezar/scripts/x.mjs', count: 1 },
          { file: piFile, kind: 'package', target: 'zod', count: 0 },
        ],
      }),
    });

    const piBaseline = runnerFolderEscapeBaselineFile('pi');
    expect(staleRunnerFolderEscapes(root)).toEqual([
      `${piBaseline} cez/runner-folder-escape: stale or invalid entry ${piFile} [package] → zod (lists 1, the file has 1); lower the count or remove the entry`,
      `${piBaseline} cez/runner-folder-escape: stale or invalid entry ${ompFile} [package] → zod (lists 1, the file has 1); lower the count or remove the entry`,
      `${piBaseline} cez/runner-folder-escape: stale or invalid entry packages/cezar/src/runners/pi/pi-probe.test.ts [package] → zod (lists 1, the file has 0); lower the count or remove the entry`,
      `${piBaseline} cez/runner-folder-escape: stale or invalid entry ${piFile} [url] → packages/cezar/scripts/x.mjs (lists 1, the file has 0); lower the count or remove the entry`,
      `${piBaseline} cez/runner-folder-escape: stale or invalid entry ${piFile} [package] → zod (lists 0, the file has 1); lower the count or remove the entry`,
    ]);

    const missingDirRoot = makeTree({ [piFile]: "import { z } from 'zod';\n" });
    expect(staleRunnerFolderEscapes(missingDirRoot)).toEqual([
      `${runnerFolderEscapeBaselineDir} cez/runner-folder-escape: baseline directory is missing`,
    ]);

    const missingRunnerBaselineRoot = makeTree({
      'packages/cezar/src/runners/pi/index.ts': 'export const displayOrder = 1;\n',
      [runnerFolderEscapeBaselineFile('omp')]: JSON.stringify({ entries: [] }),
    });
    expect(staleRunnerFolderEscapes(missingRunnerBaselineRoot)).toEqual([
      `${runnerFolderEscapeBaselineFile('pi')} cez/runner-folder-escape: missing baseline file for bundled runner pi`,
    ]);

    const invalidJsonRoot = makeTree({
      [runnerFolderEscapeBaselineFile('pi')]: '{"entries": "not-an-array"}',
    });
    expect(staleRunnerFolderEscapes(invalidJsonRoot)).toEqual([
      expect.stringContaining(`${piBaseline} cez/runner-folder-escape: invalid baseline file`),
    ]);

    const cleanRoot = makeTree({
      [piFile]: "import { z } from 'zod';\n",
      [runnerFolderEscapeBaselineFile('pi')]: JSON.stringify({
        entries: [{ file: piFile, kind: 'package', target: 'zod', count: 1 }],
      }),
    });
    expect(staleRunnerFolderEscapes(cleanRoot)).toEqual([]);
  });

  it('keeps all checked-in per-runner baselines current with the repository', () => {
    expect(staleRunnerFolderEscapes()).toEqual([]);
    expect(runnerFolderEscapes(piFile, "import { z } from 'zod';\n")).toEqual([{ kind: 'package', target: 'zod' }]);
  });
});
