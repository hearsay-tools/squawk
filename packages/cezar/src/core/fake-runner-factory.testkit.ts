import type { RunnerFactory } from './agent-runner.ts';
import { registerBuiltInRunners } from '../runners/built-in.ts';

/** Keep the incomplete runner shapes of factory mocks when moving them to fixture injection.
 *  The test supplies the methods it exercises; this adapter adds no fields. A fake may claim any
 *  built-in backend, so this registers the built-in definitions, whose data the engine reads for
 *  that backend; their adapters load only through `createRunner`, which a fake replaces. */
export function fakeRunnerFactory(factory: (...args: never[]) => object): RunnerFactory {
  registerBuiltInRunners();
  return factory as RunnerFactory;
}
