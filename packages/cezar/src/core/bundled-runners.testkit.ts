import type { SquawkPluginApi } from '../plugin/api.ts';
import { installPluginResolveHook } from '../plugin/resolve-hook.ts';
import { registerRunner } from './runner-registry.ts';
import type { RunnerDefinition } from './runner-definition.ts';
import { BUILT_IN_RUNNER_IDS } from './built-in-runner-ids.testkit.ts';

let definitions: Promise<readonly RunnerDefinition[]> | undefined;

/**
 * The definitions each bundled runner's plugin entry `runners/<id>/index.ts` registers, in display
 * order. The template literal's only substitution is the runner folder, so esbuild and the closure
 * guards read it as every `index.ts` one folder below `../runners/`.
 */
export function bundledRunnerDefinitions(): Promise<readonly RunnerDefinition[]> {
  return definitions ??= (async () => {
    installPluginResolveHook();
    const entries = await Promise.all(BUILT_IN_RUNNER_IDS.map(id => import(`../runners/${id}/index.ts`) as Promise<{ default: (api: SquawkPluginApi) => unknown }>));
    const collected: RunnerDefinition[] = [];
    const api = { registerRunner: (definition: RunnerDefinition) => { collected.push(definition); } } as unknown as SquawkPluginApi;
    for (const entry of entries) await entry.default(api);
    return Object.freeze(collected);
  })();
}

/**
 * Register every bundled runner without sealing, as boot does but without the plugin report. A
 * second call registers the same objects again, which the registry ignores.
 */
export async function registerBundledRunners(): Promise<void> {
  for (const definition of await bundledRunnerDefinitions()) registerRunner(definition);
}
