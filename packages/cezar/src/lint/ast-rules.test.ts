import { describe, expect, it } from 'vitest';
import { ruleCases } from './ast-rule.testkit.ts';
import { childKilledRead } from './child-killed-read.ts';
import { regexModuleSyntax } from './regex-module-syntax.ts';
import { runStoreTestkitImport } from './run-store-testkit-import.ts';

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

ruleCases(regexModuleSyntax, {
  file: 'packages/cezar/src/lint/import-scan.testkit.ts',
  valid: [
    'const prose = /264 test files import the changed files/',
    'const prose = /from CI run 3: 2 changed functions/',
    'const prose = /^(\\S+) (?:is exempt from )?(I\\d+)/',
    "const flag = /--import (?:\\.\\/)scripts\\/env\\.mjs/",
    "const css = /@import\\s+(['\"])([^'\"]+)\\1/",
    'const script = /require-e2e-passed\\.cjs/',
    'const time = /import-time activation/',
    "const made = new RegExp(prefix + 'import\\\\s+')",
    "const imports = runtimeImports(source, file)",
    'const merge = /^Merge pull request #(\\d+) from [^/\\s]+\\/(\\S+)/',
    'const word = /superbfrom\\s/',
    'const prose = /^from the start/',
    'const prose = /^Remove demo-project from the workspace/',
  ],
  invalid: [
    'const named = /^import\\s+\\{/',
    "const side = /^import ['\"]/",
    'const star = /^import \\* as\\b/',
    'const typed = /^\\s*import\\s+type\\b/',
    'const either = /^(?:import|export) type\\b/',
    'const word = /\\b(?:import|export)\\b/',
    "const source = /from ['\"]\\.\\/([^'\"]+)['\"]/",
    "const spaced = /from\\s+['\"]@open-mercato/",
    "const loaded = /require\\('([^']+)'\\)/",
    'const dynamic = /import\\(\\s*/',
    'const meta = /process\\.argv\\[1\\][^\\n]*import\\.meta/',
    'const declared = /^export const displayOrder = (\\d+);$/',
    'const fn = /^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+seal/',
    "const built = new RegExp('from\\\\s+[\\'\"]')",
    'const called = RegExp(`^import\\\\s+${name}`)',
    'const raw = new RegExp(String.raw`^export\\s+\\*`)',
    'const either = /(?:\\bfrom|^import)[ \\t]+/',
    "const quoted = /\\bfrom\\s*$/",
    'const line = /^import /',
    'const line = /^export /m',
    'const line = /^\\s*import$/',
    'const line = /^import \\w+ from/',
    'const line = /^import \\S+/',
    'const line = /^export \\w+/m',
    'const line = /^\\s*import .+ from .+$/',
    'const line = /(?:^|\\n)import /',
    'const line = /\\nexport \\{/',
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
