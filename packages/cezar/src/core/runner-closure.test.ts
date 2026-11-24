import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { runnerClassNames } from '../lint/owner-reader-rules.ts';
// A test that drives one runner loads that runner's adapter and none of the other five, so an
// edit to one adapter reruns only its own per-runner tests (hearsay-tools/cezarion#2939). The
// closure is every module the file reaches through static and dynamic imports; esbuild reads a
// folder template such as `../runners/${id}/facts.ts` as every file it matches. The wait parity
// kit runs its workers on the Claude wire whatever the parent's runner is, so a `waits-*` file
// also loads the Claude adapter; hearsay-tools/cezarion#2959 can replace those workers. R14 runs a
// mixed-runner chain, so a `harness-<runner>-owned-workflows` file also loads one other runner.
const src = join(import.meta.dirname, '..');

/** A runner folder's adapter module: its `<name>-runner.ts` file with the class that implements
 *  `AgentRunner`. A built-in runner without one throws, so the guard never checks a missing path. */
function adapterModule(id: string): string {
  const adapter = readdirSync(join(src, 'runners', id)).filter(file => /^[a-z0-9-]+-runner\.ts$/.test(file)).map(file => `runners/${id}/${file}`)
    .find(file => runnerClassNames(readFileSync(join(src, file), 'utf8')).length > 0);
  if (!adapter) throw new Error(`Built-in runner ${id} has no runners/${id}/<name>-runner.ts with a class that implements AgentRunner.`);
  return adapter;
}
const ADAPTERS: Record<string, string> = Object.fromEntries(BUILT_IN_RUNNER_IDS.map(id => [id, adapterModule(id)]));
const PER_RUNNER = new RegExp(`^(?:harness|waits|runner-skill-trigger|automation-tools)-(${BUILT_IN_RUNNER_IDS.join('|')})(?:-.*)?-parity\\.test\\.ts$`);

function perRunnerFiles(): Array<{ file: string; runner: string }> {
  return ['core', 'workflows', 'runners'].flatMap(dir => readdirSync(join(src, dir), { recursive: true, encoding: 'utf8' }).flatMap(name => {
    const runner = PER_RUNNER.exec(name.split('/').at(-1) ?? '')?.[1] as string | undefined;
    return runner ? [{ file: `${dir}/${name}`, runner }] : [];
  }));
}

/** Each entry's closure, as `src`-relative paths. */
async function closures(files: readonly string[]): Promise<Map<string, Set<string>>> {
  const result = await build({
    entryPoints: files.map(file => join(src, file)), absWorkingDir: src, bundle: true, write: false, metafile: true,
    platform: 'node', format: 'esm', packages: 'external', outdir: join(src, '.closure'), logLevel: 'silent',
  });
  const byEntry = new Map<string, Set<string>>();
  for (const output of Object.values(result.metafile.outputs)) {
    if (!output.entryPoint) continue;
    byEntry.set(relative(src, join(src, output.entryPoint)), new Set(Object.keys(output.inputs).map(input => relative(src, join(src, input)))));
  }
  return byEntry;
}

/** Shared runner support (such as runners/acp/) is allowed. Adapters, definitions, per-runner
 * data modules (`facts.ts`, `extra-tools.ts`, `mock.ts`) and the built-in roster remain private
 * to each allowed runner, including transitive imports (hearsay-tools/squawk#4175). */
function foreignRunnerModules(closure: Set<string>, allowed: ReadonlySet<string>): string[] {
  const others = BUILT_IN_RUNNER_IDS.filter(id => !allowed.has(id));
  return [
    ...others.filter(id => closure.has(ADAPTERS[id]!)),
    ...others.filter(id => closure.has(`runners/${id}/definition.ts`)).map(id => `${id} definition`),
    ...others.filter(id => closure.has(`runners/${id}/facts.ts`)).map(id => `${id} facts`),
    ...others.filter(id => closure.has(`runners/${id}/extra-tools.ts`)).map(id => `${id} extra-tools`),
    ...others.filter(id => closure.has(`runners/${id}/mock.ts`)).map(id => `${id} mock`),
    ...(closure.has('runners/built-in.ts') ? ['built-in'] : []),
  ];
}

describe('per-runner test closures', () => {
  it.each([false, true])('allows a runner-shaped ACP consumer and refuses a foreign adapter: %s', async foreign => {
    const result = await build({
      stdin: { contents: `import { AcpSession } from './runners/acp/session.ts';
        ${foreign ? "import { PiRunner } from './runners/pi/pi-runner.ts';" : ''}
        export class FixtureRunner { session = AcpSession; ${foreign ? 'foreign = PiRunner;' : ''} }`, resolveDir: src },
      absWorkingDir: src, bundle: true, write: false, metafile: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
    });
    const closure = new Set(Object.keys(result.metafile.inputs));
    expect(closure.has('runners/acp/session.ts')).toBe(true);
    expect(foreignRunnerModules(closure, new Set(['fixture']))).toEqual(foreign ? ['pi', 'pi facts'] : []);
  });

  it('hold their own adapter, no other runner adapter or definition but the wait kit\'s Claude workers and R14\'s second runner, and not the built-in runner list', async () => {
    const files = perRunnerFiles();
    expect(new Set(files.map(entry => entry.runner))).toEqual(new Set(BUILT_IN_RUNNER_IDS));
    const byEntry = await closures(files.map(entry => entry.file));
    const loaded = files.map(({ file, runner }) => {
      const closure = byEntry.get(file) ?? new Set();
      const loads = (id: string) => closure.has(ADAPTERS[id]!) || closure.has(`runners/${id}/definition.ts`);
      const fileName = file.split('/').at(-1) ?? '';
      const base = new Set<string>([runner, ...(fileName.startsWith('automation-tools-') ? ['claude' as const] : [])]);
      const partner = file.endsWith('-owned-workflows-parity.test.ts') ? BUILT_IN_RUNNER_IDS.find(id => !base.has(id) && loads(id)) : undefined;
      const allowed = new Set<string>([...base, ...(partner ? [partner] : [])]);
      return { file, own: closure.has(ADAPTERS[runner]!), others: foreignRunnerModules(closure, allowed) };
    });
    expect(loaded.filter(entry => !entry.own || entry.others.length)).toEqual([]);
  }, 60_000);

  it('keeps fixture parity files off every built-in runner adapter and definition (hearsay-tools/squawk#4177)', async () => {
    const files = readdirSync(join(src, 'runners/fixture'), { encoding: 'utf8' })
      .filter(file => file.endsWith('-parity.test.ts'))
      .map(file => `runners/fixture/${file}`);
    expect(files.length).toBeGreaterThan(0);
    const byEntry = await closures(files);
    const violations = files.map(file => {
      const closure = byEntry.get(file) ?? new Set();
      return { file, own: closure.has('runners/fixture/fixture-adapter.testkit.ts'), others: foreignRunnerModules(closure, new Set()) };
    }).filter(entry => !entry.own || entry.others.length);
    expect(violations).toEqual([]);
  }, 60_000);

  it('keep the global test setup off every runner definition and adapter (hearsay-tools/squawk#3936 review E1)', async () => {
    // The setup file rides along with EVERY server test, so a runner definition in its closure
    // would put that runner's adapter in every test's environment: any adapter edit would then
    // invalidate every server test. The setup reads the id list from `runners/ids.ts`, a data-only
    // module, never from `runners/built-in.ts`.
    const closure = (await closures(['../vitest.setup.ts'])).get('../vitest.setup.ts') ?? new Set();
    const banned = [
      ...BUILT_IN_RUNNER_IDS.flatMap(id => [`runners/${id}/definition.ts`, ADAPTERS[id]!]),
      'runners/built-in.ts',
    ].filter(path => closure.has(path));
    expect(banned).toEqual([]);
  }, 60_000);

  it('keep the oxlint plugin off every runner module but runners/ids.ts', async () => {
    // Squeal relints the whole project when a file in the plugin's import closure changes. A
    // runner module in that closure would make every runner edit a full-project lint.
    const closure = (await closures(['lint/plugin.ts'])).get('lint/plugin.ts') ?? new Set();
    expect(closure.has('lint/plugin.ts')).toBe(true);
    expect([...closure].filter(path => path.startsWith('runners/') && path !== 'runners/ids.ts')).toEqual([]);
  }, 60_000);
});
