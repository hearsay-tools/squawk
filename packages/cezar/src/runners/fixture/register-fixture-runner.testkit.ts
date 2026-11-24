import { registerRunner } from '../../core/runner-registry.ts';
import { fixtureRunner } from './definition.testkit.ts';

// Import before `every-runner.testkit.ts` or `register-all-runners.testkit.ts` in tests that
// combine the fixture runner with the sealed built-in registry.
registerRunner(fixtureRunner);
