import type { RunnerFactory } from './agent-runner.ts';
import type { RunnerDefinition } from './runner-definition.ts';
import { registerRunner } from './runner-registry.ts';
import { claudeRunner } from '../runners/claude/definition.ts';

/** Keep the incomplete runner shapes of factory mocks when moving them to fixture injection.
 *  The test supplies the methods it exercises; this adapter adds no fields. A fake may claim a
 *  built-in backend, and the engine reads that backend's data from the registry, so this registers
 *  Claude, the default runner, and the definitions the test names. Their adapters load only
 *  through `createRunner`, which a fake replaces. */
export function fakeRunnerFactory(factory: (...args: never[]) => object, ...runners: RunnerDefinition[]): RunnerFactory {
  for (const definition of [claudeRunner, ...runners]) registerRunner(definition);
  return factory as RunnerFactory;
}
