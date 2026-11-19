import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { repoRoot } from './lint/source-rule.ts';

// Each Node entry outside index.ts that reads runner data registers the built-in runners at its
// top level, before it reads config or runs a task (spec 2026-11-18-runner-definitions). The
// scripts start real CLIs or many processes, so this reads their source.
const ENTRIES = [
  'packages/cezar/scripts/benchmark-family-reconcile.ts',
  'packages/cezar/scripts/benchmark-run-store.ts',
  'packages/cezar/scripts/benchmark-stuck-destroys.ts',
  'packages/cezar/scripts/benchmark-worker-lifecycle.ts',
  'packages/cezar/scripts/benchmark-workspace-events.ts',
  '.ai/scripts/mock-wire-evidence.ts',
  '.ai/scripts/probe-questions.ts',
  '.ai/scripts/probe-startup.ts',
  '.ai/scripts/probe-steering.ts',
];

it.each(ENTRIES)('%s registers the built-in runners at its top level', (entry) => {
  const source = readFileSync(join(repoRoot, entry), 'utf8');
  expect(source).toMatch(/^import \{ registerBuiltInRunners \} from '(?:\.\.\/)+(?:packages\/cezar\/)?src\/runners\/built-in\.ts';$/m);
  expect(source).toMatch(/^registerBuiltInRunners\(\);$/m);
});
