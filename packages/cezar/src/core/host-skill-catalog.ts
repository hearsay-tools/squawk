import { registeredRunners, runnerDefinition } from './runner-registry.ts';
import type { RunnerSkillCatalogAdapter } from './runner-skill-catalog.ts';
import type { SkillDiscoveryOptions } from './skill-probe.ts';

/**
 * Each caller supplies its folder and account home. Each adapter loads its runner's skill list
 * through the registered definition's `loadSkillCatalog` when it first discovers.
 */
export function hostSkillCatalogAdapters(overrides: Partial<Record<string, SkillDiscoveryOptions['bin']>> = {}): Record<string, RunnerSkillCatalogAdapter> {
  const adapter = (runner: string): RunnerSkillCatalogAdapter => ({
    discover: async (query, signal) => (await runnerDefinition(runner).loadSkillCatalog())({ ...query, bin: overrides[runner], signal }),
  });
  return Object.fromEntries(registeredRunners().map(({ id }) => [id, adapter(id)]));
}
