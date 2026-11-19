import { expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { runnerDefinition } from './runner-registry.ts';
import '../core/register-all-runners.testkit.ts';

// The test reads every runner definition.

// The definition and the adapter class read one data file, so the registry and the class cannot
// disagree about which spec fields the wire honors.
it.each(RUNNER_IDS)('the %s adapter reads the specSupport its definition holds', async (id) => {
  const definition = runnerDefinition(id);
  expect((await definition.loadAdapter()).specSupport).toBe(definition.specSupport);
});
