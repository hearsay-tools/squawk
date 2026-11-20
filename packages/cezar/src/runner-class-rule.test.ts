import { join } from 'node:path';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { RUNNER_CLASSES, concreteRunnerModule, runnerClass, runnerClassNames, runnerFolderClasses } from './lint/owner-reader-rules.ts';
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
  .flatMap((file) => runnerClassNames(readFileSync(join(srcDir, file), 'utf8')).map((name) => ({ file, name })));

it('names every class that implements AgentRunner, and no other', () => {
  expect(runnerClasses.length).toBeGreaterThan(0);
  expect([...RUNNER_CLASSES].sort()).toEqual(runnerClasses.map((entry) => entry.name).sort());
});

it('matches the module of every runner class, and not the interface module', () => {
  for (const { file, name } of runnerClasses) expect(concreteRunnerModule(`../${file}`), `${name} in ${file}`).toBe(true);
  expect(concreteRunnerModule('../core/agent-runner.ts')).toBe(false);
  expect(concreteRunnerModule('../core/runner-registry.ts')).toBe(false);
});

it('lets only a runner folder load a runner module', () => {
  for (const file of ['runners/pi/definition.ts', 'runners/pi/pi-runner.ts', 'runners/claude/claude-cli-runner.ts']) {
    expect(runnerClass.applies(`packages/cezar/src/${file}`), file).toBe(false);
  }
  for (const file of ['runners/built-in.ts', 'core/runner-registry.ts', 'core/runner-facts.ts', 'workflows/run.ts']) {
    expect(runnerClass.applies(`packages/cezar/src/${file}`), file).toBe(true);
  }
});

it('reads a runner class with a base class or beside other interfaces, and no other class', () => {
  expect(runnerClassNames([
    'export class A implements AgentRunner {}',
    'export class B extends Base implements AgentRunner {}',
    'class C<T> extends D<T> implements Other, AgentRunner {}',
    'class C2 implements Map<string, number>, AgentRunner {}',
    'export abstract class C3\n  extends Base\n  implements seam.AgentRunner {}',
    'class E implements AgentRunnerLike {}',
    'export class Factory implements Provider<AgentRunner> {}',
    'class Pair implements Map<AgentRunner, AgentRunner> {}',
    'class F extends G {}\nconst h: AgentRunner = runner;',
  ].join('\n'))).toEqual(['A', 'B', 'C', 'C2', 'C3']);
  expect(runnerClassNames('export default class implements AgentRunner {}')).toEqual(['default']);
});

it('throws for a runner module in a runner folder whose class it cannot read', () => {
  const root = mkdtempSync(join(tmpdir(), 'runner-folders-'));
  try {
    mkdirSync(join(root, 'sixth'));
    writeFileSync(join(root, 'sixth', 'sixth-runner.ts'), 'export class SixthRunner {}\n');
    expect(() => runnerFolderClasses(root)).toThrow('runners/sixth/sixth-runner.ts is a runner module, but no class in it implements AgentRunner.');
    writeFileSync(join(root, 'sixth', 'sixth-runner.ts'), 'export class SixthRunner extends BaseRunner implements AgentRunner {}\n');
    expect(runnerFolderClasses(root)).toEqual(['SixthRunner']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
