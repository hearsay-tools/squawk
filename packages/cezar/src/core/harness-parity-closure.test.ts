import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importClosure } from '../lint/import-closure.testkit.ts';
import { HARNESS_PARITY_ROWS_FILE } from './harness-parity-rows.testkit.ts';

/**
 * Squeal reruns every test whose import closure holds an edited file. The adapter-level parity kit
 * stays free of the workflow engine, so an engine edit does not rerun the runner-adapter tests
 * (hearsay-tools/cezarion#2938). The walk follows the imports a test loads at runtime; TypeScript
 * erases type-only ones.
 */
const src = join(import.meta.dirname, '..');
const WORKFLOW_ENGINE = ['workflows/run.ts', 'delegation/workspace.ts', 'workflows/fixture-manager.testkit.ts'];
const ENGINE = ['workflows/run.ts', 'delegation/provision.ts', 'delegation/workspace.ts', 'workflows/fixture-manager.testkit.ts'];
const FEATURE_CATALOGS = ['preview/tool-catalog.ts', 'automations/tool-catalog.ts', 'delegation/service.ts'];

function filesIn(entry: string, targets: readonly string[]): string[] {
  const closure = importClosure(join(src, entry)).map(path => relative(src, path));
  return targets.filter(file => closure.includes(file));
}

function engineFilesIn(entry: string): string[] {
  return filesIn(entry, ENGINE);
}

describe('the harness parity kits', () => {
  // Each kit's `-core` file imports no runner adapter; the plain name re-exports it with every
  // adapter chosen (hearsay-tools/cezarion#2939).
  it.each(['core/harness-parity.testkit.ts', 'core/harness-parity-core.testkit.ts'])('keeps the workflow engine out of the adapter-level kit %s', (kit) => {
    expect(engineFilesIn(kit)).toEqual([]);
  });

  // The startup, contract, session and seam-only pending-request parts drive only the seam tier,
  // so their runner files load no engine; `harness-parity.test.ts` pins that each runner file
  // imports only its part's kit (hearsay-tools/cezarion#3242, hearsay-tools/squawk#4177).
  it.each(['startup', 'contract', 'session', 'pending-request-seam'].map(part => `core/harness-parity-${part}.cells.testkit.ts`))('keeps the workflow engine out of the seam-tier part kit %s', (kit) => {
    expect(engineFilesIn(kit)).toEqual([]);
  });

  // A part whose bodies drive the engine registers its cells from an engine-free rows module, and the
  // inventory collects every part's rows through them, so a guard that reads which rows register
  // reruns on no engine edit (hearsay-tools/squawk#3962).
  it.each([...readdirSync(join(src, 'core')).filter(file => HARNESS_PARITY_ROWS_FILE.test(file)).map(file => `core/${file}`), 'core/harness-parity-inventory.testkit.ts'])('keeps the workflow engine out of the name-only registration %s', (kit) => {
    expect(engineFilesIn(kit)).toEqual([]);
  });

  it.each(['core/workflow-parity.testkit.ts', 'core/workflow-parity-core.testkit.ts'])('loads only the workflow engine without delegation or feature catalogs through %s', (kit) => {
    expect(engineFilesIn(kit)).toEqual(WORKFLOW_ENGINE);
    expect(filesIn(kit, FEATURE_CATALOGS)).toEqual([]);
  });

  it.each(['core/worker-parity.testkit.ts', 'core/worker-parity-core.testkit.ts'])('loads the workflow and delegation engines without feature tool catalogs through %s', (kit) => {
    expect(engineFilesIn(kit)).toEqual(ENGINE);
    expect(filesIn(kit, ['preview/tool-catalog.ts', 'automations/tool-catalog.ts'])).toEqual([]);
  });

  it.each(['core-registries.testkit.ts', 'core/register-all-runners.testkit.ts'])('keeps feature catalogs and delegation service out of %s', (kit) => {
    expect(filesIn(kit, [...FEATURE_CATALOGS, 'built-in-tools.ts', 'built-in-wait-kinds.ts'])).toEqual([]);
  });
});
