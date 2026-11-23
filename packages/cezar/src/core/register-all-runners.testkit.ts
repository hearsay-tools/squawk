import '../ci-wait/tools.testkit.ts';
import { registerBuiltInRunners, sealBuiltInRunners } from '../runners/built-in.ts';

// Importing this module registers and seals every built-in runner: it sets no runner
// factory. A test that enumerates runners (`runnersWhere`, `registeredRunners`, `BUILT_IN_RUNNER_IDS`) or
// reads each runner's data imports it, so the cells it builds from the registry cover all of them.
// `core/every-runner.testkit.ts` imports it and adds the production factory. A test that drives one
// runner registers only that runner's definition (`onlyRunner`, `registerRunner`).
registerBuiltInRunners();
sealBuiltInRunners();
