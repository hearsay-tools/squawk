import type { RunnerDefinition } from './runner-definition.ts';
import { registerRunner, sealRunners } from './runner-registry.ts';

/** Register every runner this test needs, then finish its boot boundary. Shared default
 * testkits only register; the test file seals after adding its own definitions. Dynamic
 * registration tests use vi.resetModules() for a fresh registry. */
export function sealTestRunners(...definitions: RunnerDefinition[]): void {
  for (const definition of definitions) registerRunner(definition);
  sealRunners();
}
