import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { build, type Plugin } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { runtimeImports } from '../lint/import-closure.testkit.ts';
// A test that drives one runner loads that runner's adapter and none of the other five, so an
// edit to one adapter reruns only its own per-runner tests (hearsay-tools/cezarion#2939). The
// closure is every module the file reaches through static and dynamic imports and through
// `import.meta.glob`. The wait parity kit runs its workers on the Claude wire whatever the
// parent's runner is, so a `waits-*` file also loads the Claude adapter;
// hearsay-tools/cezarion#2959 can replace those workers. R14 runs a mixed-runner chain, so a
// `harness-<runner>-owned-workflows` file also loads one other runner.
const src = join(import.meta.dirname, '..');

/** A runner folder's adapter module: its `<name>-runner.ts` file with the class that implements `AgentRunner`. */
function adapterModule(id: string): string | undefined {
  return readdirSync(join(src, 'runners', id)).filter(file => /^[a-z0-9-]+-runner\.ts$/.test(file)).map(file => `runners/${id}/${file}`)
    .find(file => /\bclass\s+\w+\s+implements\s+AgentRunner\b/.test(readFileSync(join(src, file), 'utf8')));
}
const ADAPTERS: Record<string, string | undefined> = Object.fromEntries(BUILT_IN_RUNNER_IDS.map(id => [id, adapterModule(id)]));
const PER_RUNNER = new RegExp(`^(?:harness|waits)-(${BUILT_IN_RUNNER_IDS.join('|')})-.*-parity\\.test\\.ts$`);

function perRunnerFiles(): Array<{ file: string; runner: string }> {
  return ['core', 'workflows', 'runners'].flatMap(dir => readdirSync(join(src, dir), { recursive: true, encoding: 'utf8' }).flatMap(name => {
    const runner = PER_RUNNER.exec(name.split('/').at(-1) ?? '')?.[1] as string | undefined;
    return runner ? [{ file: `${dir}/${name}`, runner }] : [];
  }));
}

/**
 * esbuild leaves Vite's `import.meta.glob` as it is, while Vitest compiles it into one import per
 * matched file. This plugin adds an import for each file a glob matches, so a closure holds what
 * a testkit loads through a glob (hearsay-tools/squawk#3900).
 */
const viteGlob: Plugin = {
  name: 'vite-glob',
  setup(plugin) {
    plugin.onLoad({ filter: /\.ts$/ }, ({ path }) => {
      const source = readFileSync(path, 'utf8');
      if (!source.includes('import.meta.glob')) return undefined;
      return { contents: `${source}\n${runtimeImports(source, path).map(specifier => `import ${JSON.stringify(specifier)};`).join('\n')}\n`, loader: 'ts' };
    });
  },
};

/** Each entry's closure, as `src`-relative paths. */
async function closures(files: readonly string[]): Promise<Map<string, Set<string>>> {
  const result = await build({
    entryPoints: files.map(file => join(src, file)), absWorkingDir: src, bundle: true, write: false, metafile: true,
    platform: 'node', format: 'esm', packages: 'external', outdir: join(src, '.closure'), logLevel: 'silent', plugins: [viteGlob],
  });
  const byEntry = new Map<string, Set<string>>();
  for (const output of Object.values(result.metafile.outputs)) {
    if (!output.entryPoint) continue;
    byEntry.set(relative(src, join(src, output.entryPoint)), new Set(Object.keys(output.inputs).map(input => relative(src, join(src, input)))));
  }
  return byEntry;
}

describe('per-runner test closures', () => {
  it('hold their own adapter, no other runner adapter or definition but the wait kit\'s Claude workers and R14\'s second runner, and not the built-in runner list', async () => {
    const files = perRunnerFiles();
    expect(new Set(files.map(entry => entry.runner))).toEqual(new Set(BUILT_IN_RUNNER_IDS));
    const byEntry = await closures(files.map(entry => entry.file));
    const loaded = files.map(({ file, runner }) => {
      const closure = byEntry.get(file) ?? new Set();
      const loads = (id: string) => closure.has(ADAPTERS[id]!) || closure.has(`runners/${id}/definition.ts`);
      const base = new Set<string>([runner, ...(file.split('/').at(-1)?.startsWith('waits-') ? ['claude' as const] : [])]);
      const partner = file.endsWith('-owned-workflows-parity.test.ts') ? BUILT_IN_RUNNER_IDS.find(id => !base.has(id) && loads(id)) : undefined;
      const allowed = new Set<string>([...base, ...(partner ? [partner] : [])]);
      const others = BUILT_IN_RUNNER_IDS.filter(id => !allowed.has(id));
      return { file, own: closure.has(ADAPTERS[runner]!), others: [...others.filter(id => closure.has(ADAPTERS[id]!)),
        ...others.filter(id => closure.has(`runners/${id}/definition.ts`)).map(id => `${id} definition`),
        ...(closure.has('runners/built-in.ts') ? ['built-in'] : [])] };
    });
    expect(loaded.filter(entry => !entry.own || entry.others.length)).toEqual([]);
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
});
