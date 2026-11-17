import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNNER_CLASSES, concreteRunnerModule } from './lint/owner-reader-rules.ts';
import { expect, it } from 'vitest';
import { repoRoot } from './lint/source-rule.ts';

/**
 * The `runner-class-outside-factory` rule holds the runner class names and the runner module
 * name shape in the oxlint AST rule. A runner class added to `core/` would
 * escape the rule unseen. This test derives both from the classes that implement `AgentRunner`.
 */

const coreDir = join(repoRoot, 'packages/cezar/src/core');

/** Every class in a non-test `core/` source that implements `AgentRunner`, with its file. */
const runnerClasses = readdirSync(coreDir)
  .filter((file) => file.endsWith('.ts') && !/\.(test|testkit)\.ts$/.test(file))
  .flatMap((file) => [...readFileSync(join(coreDir, file), 'utf8').matchAll(/\bclass\s+(\w+)\s+implements\s+AgentRunner\b/g)]
    .map((match) => ({ file, name: match[1]! })));

it('names every class that implements AgentRunner, and no other', () => {
  expect(runnerClasses.length).toBeGreaterThan(0);
  expect([...RUNNER_CLASSES].sort()).toEqual(runnerClasses.map((entry) => entry.name).sort());
});

it('matches the module of every runner class, and not the interface module', () => {
  for (const { file, name } of runnerClasses) expect(concreteRunnerModule(`../core/${file}`), `${name} in core/${file}`).toBe(true);
  expect(concreteRunnerModule('../core/agent-runner.ts')).toBe(false);
  expect(concreteRunnerModule('../core/runner-factory.ts')).toBe(false);
});
