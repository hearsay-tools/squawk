import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkRule, ruleCases } from './ast-rule.testkit.ts';
import { repoRoot } from './source-rule.ts';
import { stubbornTestChild } from './stubborn-test-child.ts';

ruleCases(stubbornTestChild, {
  file: 'packages/cezar/src/core/stop.test.ts',
  valid: [
    "spawn(process.execPath, ['-e', `${ignoreTermSource()} setInterval(() => {}, 1000)`])",
    "const command = `${ignoreTermShell()} echo $$ > pid; while true; do sleep 0.1; done`",
    "const command = `(trap '' TERM; exec sleep 60) & m=$!; ${ownerGuardShell('$m')} exec sleep 30`",
    "const script = `process.on('SIGTERM', () => {}); ${ownerGuardSource()}`",
    "process.on('SIGTERM', () => process.exit(0))",
    "const member = \"process.on('SIGTERM', () => process.exit(42)); setInterval(() => {}, 1000)\"",
    "process.on('SIGINT', () => {})",
    "const note = 'trap TERM handlers'",
    "const kept = \"process.on('SIGTERM', () => {}); setTimeout(() => {}, 20000)\"; // stubborn-child: ends itself after 20 s",
  ],
  invalid: [
    "spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"])",
    "spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\",()=>{}); setInterval(() => {}, 1000)'])",
    "const script = `process.once('SIGTERM', function () {}); ${body}`",
    "const script = \"process.on('SIGTERM', () => undefined)\"",
    "const command = `trap '' TERM; echo $$ > ${pidFile}; while true; do sleep 0.1; done`",
    "const command = `sh -c 'trap \"\" TERM; sleep 1000 &'`",
    "const command = \"trap '' 15; sleep 60\"",
    "const python = 'signal.signal(signal.SIGTERM, signal.SIG_IGN)'",
    "process.on('SIGTERM', () => {})",
    "process.once('SIGTERM', () => undefined)",
    "const kept = \"process.on('SIGTERM', () => {})\"; // stubborn-child:",
  ],
});

describe('cez/stubborn-test-child scope', () => {
  it.each([
    ['packages/cezar/src/core/stop.test.ts', true],
    ['packages/cezar/src/linux-zombie.testkit.ts', true],
    ['packages/web/src/test/fixture-server-stop.test.ts', true],
    ['packages/cezar/src/ci-wait/fixtures/gh.mjs', true],
    ['packages/cezar/src/preview/__fixtures__/fake-dev-server.mjs', true],
    ['packages/cezar/scripts/mock-omp-rpc.mjs', true],
    ['scripts/qa-fixture.test.mjs', true],
    ['packages/cezar/src/stubborn-child.testkit.ts', false],
    ['packages/web/src/test/stubborn-child.ts', false],
    ['packages/cezar/src/core/session-process.ts', false],
    ['packages/cezar/src/lint/stubborn-test-child.test.ts', false],
    ['scripts/qa-fixture.mjs', false],
  ])('reads %s: %s', (file, applies) => {
    expect(stubbornTestChild.applies(file)).toBe(applies);
  });
});

// Oxlint lints `packages/` only, so this runs the same rule over the root `scripts/*.test.mjs`.
describe('scripts/*.test.mjs', () => {
  const files = readdirSync(join(repoRoot, 'scripts')).filter(name => name.endsWith('.test.mjs')).map(name => `scripts/${name}`);
  it.each(files)('%s builds every SIGTERM-ignoring child with an owner-death check', file => {
    expect(checkRule(stubbornTestChild, file, readFileSync(join(repoRoot, file), 'utf8'))).toEqual([]);
  });
});
