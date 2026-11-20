import { createRunner } from './runner-registry.ts';
import { useRunners } from './runners-under-test.testkit.ts';

// Importing this module makes `createRunner` the test file's runner factory, and registers nothing:
// the test registers the runners it drives with `registerRunner`. `createRunner` is read at call
// time, so a test's `vi.mock` or `vi.spyOn` of `runner-registry.ts` still reaches it. A plain kit
// (`harness-parity.testkit.ts`, `fixture-cleanup.testkit.ts`, ...) imports `every-runner.testkit.ts`,
// which is this module plus every runner's registration. A test that drives some runners imports
// this module where it would import the plain kit, so the factory is chosen at the same point of
// the import order (hearsay-tools/squawk#3899).
useRunners(backend => createRunner(backend));
