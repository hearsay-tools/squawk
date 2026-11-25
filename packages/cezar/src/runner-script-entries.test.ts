import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { repoRoot } from './lint/source-rule.ts';

// Each Node entry outside index.ts that reads runner data loads the bundled runners at its
// top level, before it reads config or runs a task (spec 2026-11-18-runner-definitions). The
// scripts start real CLIs or many processes, so this reads their source.
const ENTRIES = [
  'packages/cezar/scripts/benchmark-runtime.ts',
  'packages/cezar/scripts/measure-transcript-facts-health.mjs',
  'packages/web/e2e/home-recovery-server.mjs',
  'packages/web/scripts/tab-fixture-server.mjs',
  '.ai/scripts/mock-wire-evidence.ts',
  '.ai/scripts/probe-approvals.ts',
  '.ai/scripts/probe-questions.ts',
  '.ai/scripts/probe-startup.ts',
  '.ai/scripts/probe-steering.ts',
];

it.each(ENTRIES)('%s loads the bundled runners through the plugin loader, then seals them, at startup', (entry) => {
  const source = readFileSync(join(repoRoot, entry), 'utf8');
  expect(source).toMatch(/\{ loadBundledRunners \} =[^\n]*(?:import|load)\([^\n]*plugin\/loader\.[jt]s/);
  expect(source).toMatch(/\{ sealRunners \} =[^\n]*(?:import|load)\([^\n]*core\/runner-registry\.[jt]s/);
  const load = source.search(/^\s*await loadBundledRunners\(\);?$/m);
  const seal = source.search(/^\s*sealRunners\(\);?$/m);
  expect(load).toBeGreaterThan(-1);
  expect(seal).toBeGreaterThan(load);
});

// Each benchmark reaches the same reviewed process boot before opening its store.
it.each(['family-reconcile', 'run-store', 'stuck-destroys', 'worker-lifecycle', 'workspace-events'])(
  'benchmark-%s boots its process registries', name => {
    const source = readFileSync(join(repoRoot, `packages/cezar/scripts/benchmark-${name}.ts`), 'utf8');
    expect(source).toContain("import { prepareBenchmarkRuntime } from './benchmark-runtime.ts';");
    expect(source).toMatch(/^prepareBenchmarkRuntime\(\);$/m);
  },
);
