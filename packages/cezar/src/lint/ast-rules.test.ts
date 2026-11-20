import { describe, expect, it } from 'vitest';
import { ruleCases } from './ast-rule.testkit.ts';
import { childKilledRead } from './child-killed-read.ts';
import { runStoreTestkitImport } from './run-store-testkit-import.ts';
import { runnerIdsImport } from './runner-ids-import.ts';

/** Each AST rule's cases, carried over from its former YAML rule-tests file (hearsay-tools/squawk#3774). */

ruleCases(childKilledRead, {
  file: 'packages/cezar/src/core/watchdog.ts',
  valid: [
    "const hasExited = trackChildExit(child); if (!hasExited()) child.kill('SIGKILL')",
    'if (error.killed) retry()',
    "const timedOut = commandError?.killed === true && commandError.signal === 'SIGTERM'",
    'const ordinary = error.code === 1 && !error.killed',
    'if (failure.err.killed) retry()',
    "if (failure.killed === true || typeof failure.signal === 'string') return late",
    'const killed = hasExited()',
    'const row = { killed: true }',
    "child.kill('SIGTERM')",
    'counts.killedWorkers += 1',
    '// child.killed',
    "const gone = child['killed']",
    'class Guard { #killed = false; stop() { return this.#killed } }',
  ],
  invalid: [
    "if (!child.killed) child.kill('SIGKILL')",
    'if (child?.killed) return',
    'const gone = this.child.killed',
    'const gone = state.server!.killed',
    "if (proc.killed === false) proc.kill('SIGKILL')",
    'const { killed } = child',
    'const { killed: gone } = child',
    'function done({ killed }: ChildProcess) { return killed }',
  ],
});

ruleCases(runStoreTestkitImport, {
  file: 'packages/cezar/src/runs/mover.ts',
  valid: [
    "import { RunStore } from './runs/store.ts'",
    "import { move } from './run-exits.ts'",
    "import { open } from './run-store-opener.ts'",
    "const kit = await import(`./run-store.testkit.ts`)",
    "const note = './run-store.testkit.ts'",
  ],
  invalid: [
    "import { setRunStatus } from './run-store.testkit.ts'",
    "import { setRunStatus as seed } from '../runs/run-store.testkit.js'",
    "export { setRunStatus } from './run-store.testkit.ts'",
    "const kit = await import('./run-store.testkit.ts')",
    "const kit = require('./run-store.testkit.ts')",
    "import { openTestRunStore } from './run-store-open.testkit.ts'",
    "const kit = await import('../runs/run-store-open.testkit.js')",
    "export * from './run-store.testkit'",
    "export default './run-store.testkit.ts'",
  ],
});

ruleCases(runnerIdsImport, {
  file: 'packages/cezar/src/core/runner-registry.ts',
  valid: [
    "import { registeredRunners } from './runner-registry.ts'",
    "import { BUILT_IN_RUNNERS } from '../runners/built-in.ts'",
    "import { LEGACY_RUNNER_IDS } from './runner-ids.ts'",
    "import { ids } from './ids.ts'",
    "import { ids } from '../runners/claude/ids.ts'",
    "const note = '../runners/ids.ts'",
    "const note = `../runners/ids.ts`",
    "const kit = await import(`../runners/${'ids'}.ts`)",
  ],
  invalid: [
    "import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts'",
    "import { BUILT_IN_RUNNER_IDS } from '../runners/ids.js'",
    "import { BUILT_IN_RUNNER_IDS } from '../runners/ids'",
    "import type { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts'",
    "export { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts'",
    "export * from '../runners/ids.ts'",
    "const kit = await import('../runners/ids.ts')",
    "const kit = await import(`../runners/ids.ts`)",
    "const kit = require(`../runners/ids`)",
    "type Ids = typeof import('../runners/ids.ts')",
    "type Ids = import('../runners/ids.ts').BuiltInIds",
    "const kit = require('../runners/ids.ts')",
    "import ids = require('../runners/ids.ts')",
    "import { BUILT_IN_RUNNER_IDS } from '../../src/runners/ids.ts'",
  ],
});

ruleCases(runnerIdsImport, {
  file: 'packages/cezar/src/runners/claude/definition.ts',
  valid: ["import { claudeDisplay } from './display.ts'", "import { ids } from './ids.ts'"],
  invalid: ["import { BUILT_IN_RUNNER_IDS } from '../ids.ts'"],
});

ruleCases(runnerIdsImport, {
  file: 'packages/cezar/src/runners/built-in.ts',
  valid: ["import { claudeRunner } from './claude/definition.ts'"],
  invalid: ["import { BUILT_IN_RUNNER_IDS } from './ids.ts'"],
});

describe('AST rule scopes', () => {
  it.each([
    ['packages/cezar/src/core/watchdog.ts', true],
    ['packages/cezar/src/core/watchdog.test.ts', false],
    ['packages/cezar/src/core/watchdog.testkit.ts', false],
    ['packages/web/src/watchdog.ts', false],
    ['packages/cezar/src/core/watchdog.tsx', false],
  ])('child-killed-read and run-store-testkit-import read %s: %s', (file, applies) => {
    expect(childKilledRead.applies(file)).toBe(applies);
    expect(runStoreTestkitImport.applies(file)).toBe(applies);
  });
  it.each([
    ['packages/cezar/src/core/runner-registry.ts', true],
    ['packages/cezar/src/server/server.ts', true],
    ['packages/cezar/src/runners/claude/definition.ts', true],
    ['packages/cezar/src/runners/built-in.ts', true],
    ['packages/cezar/src/lint/runner-ids-import.ts', true],
    ['packages/cezar/src/lint/runner-roster-literal.ts', false],
    ['packages/cezar/src/lint/runner-id-branch.ts', false],
    ['packages/cezar/src/core/runner-registry.test.ts', false],
    ['packages/cezar/src/core/register-all-runners.testkit.ts', false],
    ['packages/cezar/vitest.setup.ts', false],
    ['packages/web/src/runner.ts', false],
  ])('runner-ids-import reads %s: %s', (file, applies) => {
    expect(runnerIdsImport.applies(file)).toBe(applies);
  });
});
