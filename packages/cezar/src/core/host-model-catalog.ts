import type { ModelDiscoveryRunner } from '@open-mercato/cezar-contract';
import { knownRunnerIds, runnerDefinition } from './runner-registry.ts';
import type { RunnerModelCatalogAdapter } from './runner-model-catalog.ts';

/**
 * Host model-discovery adapters, one per registered runner. Each adapter loads its runner's
 * catalog through the registered definition's `loadModelCatalog` when it first discovers.
 */
export function hostModelCatalogAdapters(cwd: string): Record<ModelDiscoveryRunner, RunnerModelCatalogAdapter> {
  return Object.fromEntries(knownRunnerIds().map(id => [id, {
    discover: async (options = {}) => (await runnerDefinition(id).loadModelCatalog())({ cwd, ...options }),
    ...(runnerDefinition(id).loadModelCatalogKey ? { cacheKey: async (options) => (await runnerDefinition(id).loadModelCatalogKey!())(options) } : {}),
  }])) as Record<ModelDiscoveryRunner, RunnerModelCatalogAdapter>;
}
