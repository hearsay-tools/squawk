import '../core-tools.testkit.ts';
import { registerBundledRunners } from './bundled-runners.testkit.ts';
import { sealRunners } from './runner-registry.ts';

// Importing this module registers and seals every bundled runner: it sets no runner
// factory. A test that enumerates runners (`runnersWhere`, `registeredRunners`, `BUILT_IN_RUNNER_IDS`) or
// reads each runner's data imports it, so the cells it builds from the registry cover all of them.
// `core/every-runner.testkit.ts` imports it and adds the production factory. A test that drives one
// runner registers only that runner's definition (`onlyRunner`, `registerRunner`).
await registerBundledRunners();
sealRunners();
