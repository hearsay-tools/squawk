import { expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { runnerDefinition } from './runner-registry.ts';
import { registerBuiltInRunners } from '../runners/built-in.ts';

registerBuiltInRunners();

// The definition and the adapter class read one data file, so the registry and the class cannot
// disagree about which spec fields the wire honors.
it.each(RUNNER_IDS)('the %s adapter reads the specSupport its definition holds', async (id) => {
  const definition = runnerDefinition(id);
  expect((await definition.loadAdapter()).specSupport).toBe(definition.specSupport);
});
