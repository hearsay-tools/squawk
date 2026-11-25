import { BUILT_IN_RUNNER_IDS } from './built-in-runner-ids.testkit.ts';
import { installPluginResolveHook } from '../plugin/resolve-hook.ts';

/**
 * The one value each built-in runner's data module `runners/<id>/<file>` exports, by runner id,
 * in `BUILT_IN_RUNNER_IDS` order. `load` imports one runner's module through a template literal
 * whose only substitution is the runner folder, written where the call is:
 * `id => import(`../runners/${id}/facts.ts`)`. Plain Node (the `packages/cezar/scripts/*.ts`
 * tools) and Vitest both run it; esbuild and `lint/import-closure.testkit.ts` read it as every
 * `facts.ts` one folder below `../runners/`, so the closure guards see every file it loads. It
 * loads no adapter. A runner file imports core code from `@hearsay-tools/squawk/plugin`, so plain
 * Node needs the resolve hook first.
 */
export async function runnerDataRows<T>(file: string, load: (id: string) => Promise<Readonly<Record<string, T>>>): Promise<Readonly<Record<string, T>>> {
  installPluginResolveHook();
  const modules = await Promise.all(BUILT_IN_RUNNER_IDS.map(load));
  return Object.fromEntries(BUILT_IN_RUNNER_IDS.map((id, index) => {
    const values = Object.values(modules[index]!);
    if (values.length !== 1) throw new Error(`runners/${id}/${file} must export one value; it exports ${values.length}.`);
    return [id, values[0]!];
  }));
}
