import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkRule, ruleCases } from './ast-rule.testkit.ts';
import {
  outsideTarget, runnerCoreImport, runnerCoreImportBaselineFile, runnerCoreImports, runnerCoreImportVisitors, runnerFolder,
  scanRunnerCoreImports, staleRunnerCoreImports, type RunnerCoreImportException,
} from './runner-core-import.ts';

const file = 'packages/cezar/src/runners/pi/pi-runner-probe.ts';
const core = 'packages/cezar/src/core/product-env.ts';

/** The rule's findings under oxlint, checked against the Babel scan that the stale check uses. */
const scan = (source: string, path = file, exceptions: RunnerCoreImportException[] = []): string[] => {
  const expected = scanRunnerCoreImports(path, source, exceptions);
  const findings = checkRule({ ...runnerCoreImport, create: report => runnerCoreImportVisitors(report, path, exceptions) }, path, source);
  expect(findings.map(finding => /not (\S+), or keep/.exec(finding.message)?.[1])).toEqual(expected);
  return expected;
};

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tree(files: Record<string, string>, entries: RunnerCoreImportException[]): string {
  const root = mkdtempSync(join(tmpdir(), 'cez-runner-core-'));
  roots.push(root);
  for (const [path, text] of Object.entries({ ...files, [runnerCoreImportBaselineFile]: JSON.stringify({ entries }) })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe('runner-core-import (hearsay-tools/squawk#4201)', () => {
  it('finds the runner folder of a file, but not of the shared fixture folder or a file beside the folders', () => {
    expect(runnerFolder('packages/cezar/src/runners/pi/pi-runner.ts')).toBe('packages/cezar/src/runners/pi/');
    expect(runnerFolder('packages/cezar/src/runners/antigravity/acp/session.ts')).toBe('packages/cezar/src/runners/antigravity/');
    expect(runnerFolder('packages/cezar/src/runners/fixture/fixture-adapter.ts')).toBeUndefined();
    expect(runnerFolder('packages/cezar/src/runners/built-in.ts')).toBeUndefined();
    expect(runnerFolder('packages/cezar/src/core/agent-runner.ts')).toBeUndefined();
  });

  it('maps a specifier to the file it leaves the folder for', () => {
    expect(outsideTarget(file, '../../core/product-env.js')).toBe(core);
    expect(outsideTarget(file, '../omp/omp-runner.ts')).toBe('packages/cezar/src/runners/omp/omp-runner.ts');
    expect(outsideTarget(file, './pi-ui-mapper.ts')).toBeUndefined();
    expect(outsideTarget(file, './rpc/../pi-ui-mapper.ts')).toBeUndefined();
    expect(outsideTarget(file, '@hearsay-tools/squawk/plugin')).toBeUndefined();
    expect(outsideTarget(file, undefined)).toBeUndefined();
  });

  ruleCases(runnerCoreImport, {
    file,
    valid: [
      "import { PiUiMapper } from './pi-ui-mapper.ts';",
      "export { facts } from './facts.ts';",
      "const load = () => import('./pi-runner.ts');",
      "import { productEnv, type UiEvent } from '@hearsay-tools/squawk/plugin';",
      "import { spawn } from 'node:child_process';",
      'const load = (name: string) => import(`../../core/${name}.ts`);',
    ],
    invalid: [
      "import { productEnv } from '../../core/product-env.ts';",
      "import type { UiEvent } from '../../core/ui-events.js';",
      "import { type UiEvent } from '../../core/ui-events.ts';",
      "export { productEnv } from '../../core/product-env.ts';",
      "export * from '../../core/product-env.ts';",
      "import '../../core/product-env.ts';",
      "const strategy = () => import('../../agent-config/model-settings/pi.ts');",
      "type Env = import('../../core/product-env.ts').ProductEnv;",
      "import env = require('../../core/product-env.ts');",
      "import { OmpRunner } from '../omp/omp-runner.ts';",
      "import { normalizedLines } from '../login-output.ts';",
    ],
  });

  it('stays out of tests, testkits, fixtures, the shared fixture runner and files outside runners/', () => {
    expect(runnerCoreImport.applies(file)).toBe(true);
    for (const path of [
      'packages/cezar/src/runners/pi/pi-runner.test.ts',
      'packages/cezar/src/runners/pi/pi-runner.testkit.ts',
      'packages/cezar/src/runners/pi/__fixtures__/rpc.ts',
      'packages/cezar/src/runners/pi/types.d.ts',
      'packages/cezar/src/runners/fixture/fixture-adapter.ts',
      'packages/cezar/src/runners/built-in.ts',
      'packages/cezar/src/core/agent-runner.ts',
    ]) expect(runnerCoreImport.applies(path)).toBe(false);
  });

  it('lets the baseline count pass, and reports each import of a target beyond it', () => {
    const source = "import { productEnv } from '../../core/product-env.ts';\nexport { productEnv as env } from '../../core/product-env.js';\nimport { x } from './x.ts';\n";
    expect(scan(source)).toEqual([core, core]);
    expect(scan(source, file, [{ file, target: core, count: 1 }])).toEqual([core]);
    expect(scan(source, file, [{ file, target: core, count: 2 }])).toEqual([]);
    expect(scan(source, 'packages/cezar/src/runners/omp/omp-runner.ts', [{ file, target: core, count: 2 }])).toEqual([core, core]);
  });

  it('names a baseline entry whose count no longer matches, repeats another or leaves the scope', () => {
    const omp = 'packages/cezar/src/runners/omp/omp-runner.ts';
    const root = tree({
      [file]: "import { productEnv } from '../../core/product-env.ts';\n",
      [omp]: "import { productEnv } from '@hearsay-tools/squawk/plugin';\n",
    }, [
      { file, target: core, count: 1 },
      { file, target: core, count: 1 },
      { file: omp, target: core, count: 1 },
      { file: 'packages/cezar/src/runners/pi/pi-runner.test.ts', target: core, count: 1 },
    ]);
    expect(staleRunnerCoreImports(root)).toEqual([
      `${runnerCoreImportBaselineFile} cez/runner-core-import: stale or invalid entry ${file} → ${core} (lists 1, the file has 1); lower the count or remove the entry`,
      `${runnerCoreImportBaselineFile} cez/runner-core-import: stale or invalid entry ${omp} → ${core} (lists 1, the file has 0); lower the count or remove the entry`,
      `${runnerCoreImportBaselineFile} cez/runner-core-import: stale or invalid entry packages/cezar/src/runners/pi/pi-runner.test.ts → ${core} (lists 1, the file has 0); lower the count or remove the entry`,
    ]);
    expect(staleRunnerCoreImports(tree({ [file]: "import { productEnv } from '../../core/product-env.ts';\n" }, [{ file, target: core, count: 1 }]))).toEqual([]);
  });

  it('keeps the checked-in baseline current: every entry matches its file', () => {
    expect(staleRunnerCoreImports()).toEqual([]);
    expect(runnerCoreImports(file, "import { x } from '../../core/x.ts';")).toEqual(['packages/cezar/src/core/x.ts']);
  });
});
