/**
 * Host model discovery guard — AGENT_PROTOCOL.md §10, "Host model discovery".
 *
 * `modelDiscoveryRunnerSchema` is the open `runnerSchema`, so every runner is a discovery runner, but
 * `RunnerModelCatalog` takes a `Partial` adapter map. A runner added without its adapter
 * therefore fails nowhere — the picker just shows presets again. This suite makes that a red
 * test. A runner whose CLI has no model-listing surface at all is recorded in
 * `MODEL_DISCOVERY_EXEMPTIONS` with the wire reason, never "not implemented yet".
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelDiscoveryRunnerSchema } from '@open-mercato/cezar-contract/workspace';
import { describe, expect, it } from 'vitest';
import { RUNNER_IDS, type RunnerId } from './agent-runner.ts';
import { exemptionReasonProblem } from './exemption-reason.testkit.ts';
import { hostModelCatalogAdapters } from './host-model-catalog.ts';

interface ModelDiscoveryExemption {
  readonly runner: RunnerId;
  /** Why this runner's CLI cannot list models. Never "not implemented yet". */
  readonly reason: string;
}

/** Runners with no host-local model catalog to discover. Empty today: every runner discovers. */
export const MODEL_DISCOVERY_EXEMPTIONS: readonly ModelDiscoveryExemption[] = [];

const here = dirname(fileURLToPath(import.meta.url));
const runnersDir = join(here, '..', 'runners');
const exempt = (runner: RunnerId): boolean => MODEL_DISCOVERY_EXEMPTIONS.some((e) => e.runner === runner);
const required = RUNNER_IDS.filter((runner) => !exempt(runner));
const adapterModule = (runner: RunnerId): string => `${runner}-model-catalog.ts`;
const adapterPath = (runner: RunnerId): string => join(runnersDir, runner, adapterModule(runner));
const discoverExport = (runner: RunnerId): string =>
  `discover${runner.charAt(0).toUpperCase()}${runner.slice(1)}Models`;

describe('host model discovery guard (AGENT_PROTOCOL.md §10)', () => {
  it('covers every runner: RUNNER_IDS minus the exemptions is the set under test', () => {
    // Guards the guard: an exemption must name a real runner with a real reason, and the
    // remaining set must be non-empty so the it.each blocks below actually run.
    for (const exemption of MODEL_DISCOVERY_EXEMPTIONS) {
      expect(RUNNER_IDS).toContain(exemption.runner);
      expect(exemptionReasonProblem(exemption.reason), exemption.runner).toBeUndefined();
    }
    expect(required.length).toBeGreaterThan(0);
  });

  it.each(required)('%s is accepted by the contract schema modelDiscoveryRunnerSchema', (runner) => {
    expect(modelDiscoveryRunnerSchema.safeParse(runner).success).toBe(true);
  });

  it.each(required)('%s ships a bounded catalog adapter module exporting discover<Runner>Models', async (runner) => {
    const file = adapterModule(runner);
    const path = adapterPath(runner);
    expect(existsSync(path), `packages/cezar/src/runners/${runner}/${file} is missing`).toBe(true);
    const mod = (await import(/* @vite-ignore */ `../runners/${runner}/${file}`)) as Record<string, unknown>;
    expect(typeof mod[discoverExport(runner)], `${file} must export ${discoverExport(runner)}`).toBe('function');
  });

  it.each(required)('%s is registered on the host RunnerModelCatalog', (runner) => {
    const adapters = hostModelCatalogAdapters('/nonexistent') as Partial<Record<RunnerId, unknown>>;
    expect(adapters[runner], `hostModelCatalogAdapters() has no ${runner} entry`).toBeDefined();
  });

});
