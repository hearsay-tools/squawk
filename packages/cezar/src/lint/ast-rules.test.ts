import { describe, expect, it } from 'vitest';
import { ruleCases } from './ast-rule.testkit.ts';
import { childKilledRead } from './child-killed-read.ts';
import { runStoreTestkitImport } from './run-store-testkit-import.ts';

/** Each AST rule's cases, carried over from its ast-grep rule-tests file (hearsay-tools/squawk#3774). */

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
});
