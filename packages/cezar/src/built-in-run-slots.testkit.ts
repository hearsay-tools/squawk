import './core-tools.testkit.ts';
import { registerBuiltInStepKinds, sealBuiltInStepKinds } from './workflows/step-kind-registry.ts';
import './built-in-wait-kinds.testkit.ts';
import './built-in-launch-parts.testkit.ts';
import { registerBuiltInRunSlots, sealBuiltInRunSlots } from './built-in-run-slots.ts';

// Importing this module seals the shipped removal slots and worker executions, as each process
// entry does, along with built-in wait kinds, launch parts, core tools and built-in step kinds. A test that
// also exercises preview or automation tools imports `ci-wait/tools.testkit.ts` before this module;
// a test that needs no feature imports `core-registries.testkit.ts` or calls `sealTestRunSlots()`.
registerBuiltInRunSlots();
sealBuiltInRunSlots();

registerBuiltInStepKinds();
sealBuiltInStepKinds();
