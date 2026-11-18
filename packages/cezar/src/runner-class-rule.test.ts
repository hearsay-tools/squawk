import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNNER_CLASSES, concreteRunnerModule, runnerClass } from './lint/owner-reader-rules.ts';
import { expect, it } from 'vitest';
import { repoRoot } from './lint/source-rule.ts';

/**
 * The `runner-class-outside-factory` rule holds the runner class names and the runner module
 * name shape in the oxlint AST rule. A runner class added to `core/` or to a runner folder under
 * `runners/` would escape the rule unseen. This test derives both from the classes that implement
 * `AgentRunner`.
 */

const srcDir = join(repoRoot, 'packages/cezar/src');

/** Every non-test `.ts` source under `dir`, relative to `src`. */
function sources(dir: string): string[] {
  return readdirSync(join(srcDir, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !/\.(test|testkit)\.ts$/.test(file))
    .map((file) => `${dir}/${file}`);
}

/** Every class in a non-test `core/` or `runners/` source that implements `AgentRunner`, with its file. */
const runnerClasses = [...sources('core'), ...sources('runners')]
  .flatMap((file) => [...readFileSync(join(srcDir, file), 'utf8').matchAll(/\bclass\s+(\w+)\s+implements\s+AgentRunner\b/g)]
    .map((match) => ({ file, name: match[1]! })));

it('names every class that implements AgentRunner, and no other', () => {
  expect(runnerClasses.length).toBeGreaterThan(0);
  expect([...RUNNER_CLASSES].sort()).toEqual(runnerClasses.map((entry) => entry.name).sort());
});

it('matches the module of every runner class, and not the interface module', () => {
  for (const { file, name } of runnerClasses) expect(concreteRunnerModule(`../${file}`), `${name} in ${file}`).toBe(true);
  expect(concreteRunnerModule('../core/agent-runner.ts')).toBe(false);
  expect(concreteRunnerModule('../core/runner-registry.ts')).toBe(false);
});

it('lets only a runner folder and the adapters\' current core/ home load a runner module', () => {
  for (const file of ['runners/pi/definition.ts', 'core/pi-runner.ts', 'core/claude-cli-runner.ts']) {
    expect(runnerClass.applies(`packages/cezar/src/${file}`), file).toBe(false);
  }
  for (const file of ['runners/built-in.ts', 'core/runner-registry.ts', 'core/runner-facts.ts', 'workflows/run.ts']) {
    expect(runnerClass.applies(`packages/cezar/src/${file}`), file).toBe(true);
  }
});
