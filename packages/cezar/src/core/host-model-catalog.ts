import type { ModelDiscoveryRunner } from '@open-mercato/cezar-contract';
import { RUNNER_IDS } from './agent-runner.ts';
import { runnerDefinition } from './runner-registry.ts';
import type { RunnerModelCatalogAdapter } from './runner-model-catalog.ts';

/**
 * Host model-discovery adapters, exhaustive over modelDiscoveryRunnerSchema. Keep the map and
 * RUNNER_IDS guard aligned so a missing adapter fails validation. Each adapter loads its runner's
 * catalog through the registered definition's `loadModelCatalog` when it first discovers.
 */
export function hostModelCatalogAdapters(cwd: string): Record<ModelDiscoveryRunner, RunnerModelCatalogAdapter> {
  return Object.fromEntries(RUNNER_IDS.map(runner => [runner, {
    discover: async () => (await runnerDefinition(runner).loadModelCatalog())({ cwd }),
  }])) as Record<ModelDiscoveryRunner, RunnerModelCatalogAdapter>;
}
