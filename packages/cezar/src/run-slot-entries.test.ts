import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { moduleLoads } from './core/module-imports.testkit.ts';
import { repoRoot } from './lint/source-rule.ts';

// Each Node entry outside index.ts that opens a run store and can delete, reclaim or archive a
// run seals the built-in removal slots at its startup (spec 2026-11-21-run-lifecycle-and-store-ports,
// "Removal slots"). The scripts start real CLIs or many processes, so this reads their source.
const TOP_LEVEL = /^registerBuiltInRunSlots\(\);$/m;
const ENTRIES: ReadonlyArray<{ entry: string; call: RegExp }> = [
  { entry: 'packages/cezar/scripts/benchmark-runtime.ts', call: /^ {2}registerBuiltInRunSlots\(\);$/m },
  // Its test imports the measurement, so the entry seals in main().
  { entry: 'packages/cezar/scripts/benchmark-worktree-retention.ts', call: /^async function main\(\): Promise<void> \{\n {2}registerBuiltInRunSlots\(\);$/m },
  { entry: 'packages/cezar/scripts/measure-transcript-facts-health.mjs', call: /^ {2}registerBuiltInRunSlots\(\);$/m },
  { entry: '.ai/scripts/probe-questions.ts', call: TOP_LEVEL },
  // The browser e2e fixture servers serve the cockpit from the built package.
  { entry: 'packages/web/e2e/home-recovery-server.mjs', call: /^registerBuiltInRunSlots\(\)$/m },
  { entry: 'packages/web/scripts/tab-fixture-server.mjs', call: /^registerBuiltInRunSlots\(\)$/m },
  // The packaged delegation test admits workers in its own process from the installed tarball.
  { entry: 'packages/cezar/test/e2e/delegation.test.ts', call: /^ {4}registerBuiltInRunSlots\(\);$/m },
];

it.each(ENTRIES)('$entry seals the built-in removal slots at its startup', ({ entry, call }) => {
  const source = readFileSync(join(repoRoot, entry), 'utf8');
  const slots = moduleLoads(source).filter(load => load.names.join() === 'registerBuiltInRunSlots,sealBuiltInRunSlots');
  expect(slots.some(({ form, specifier }) => form === 'static'
    ? /^(?:\.\.\/)+(?:packages\/cezar\/)?src\/built-in-run-slots\.ts$/.test(specifier)
    : (form === 'import-url' || form === 'load') && specifier === 'built-in-run-slots.js'), 'binds both slot functions from built-in-run-slots').toBe(true);
  expect(source).toMatch(call);
  expect(source).toMatch(/^(\s*)registerBuiltInRunSlots\(\);?\n\1sealBuiltInRunSlots\(\);?$/m);
});
