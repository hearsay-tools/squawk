import { RUNNER_IDS, type RunnerId } from './agent-runner.ts';
import { runnerDefinition } from './runner-registry.ts';
import type { RunnerSkillCatalogAdapter } from './runner-skill-catalog.ts';
import type { SkillDiscoveryOptions } from './skill-probe.ts';

/**
 * Each caller supplies its folder and account home. Each adapter loads its runner's skill list
 * through the registered definition's `loadSkillCatalog` when it first discovers.
 */
export function hostSkillCatalogAdapters(overrides: Partial<Record<RunnerId, SkillDiscoveryOptions['bin']>> = {}): Record<RunnerId, RunnerSkillCatalogAdapter> {
  const adapter = (runner: RunnerId): RunnerSkillCatalogAdapter => ({
    discover: async (query, signal) => (await runnerDefinition(runner).loadSkillCatalog())({ ...query, bin: overrides[runner], signal }),
  });
  return Object.fromEntries(RUNNER_IDS.map(runner => [runner, adapter(runner)])) as Record<RunnerId, RunnerSkillCatalogAdapter>;
}
