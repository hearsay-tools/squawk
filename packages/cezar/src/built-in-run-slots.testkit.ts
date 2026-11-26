import './core-tools.testkit.ts';
import { registerBuiltInStepKinds, sealBuiltInStepKinds } from './workflows/step-kind-registry.ts';
import './built-in-wait-kinds.testkit.ts';
import './built-in-launch-parts.testkit.ts';
import { registerBuiltInRunSlots, sealBuiltInRunSlots } from './built-in-run-slots.ts';
import { registerRunSlots } from './runs/removal-slots.ts';
import { jobsDeletionGate } from './features/jobs/removal-slot.ts';

// Importing this module seals the shipped removal slots (with the bundled jobs feature's gate) and
// worker executions, as each process entry does, along with built-in wait kinds, launch parts, core
// tools and built-in step kinds. A test that also exercises preview or automation tools imports `ci-wait/tools.testkit.ts` before this module;
// a test that needs no feature imports `core-registries.testkit.ts` or calls `sealTestRunSlots()`.
registerBuiltInRunSlots();
registerRunSlots({ gates: [jobsDeletionGate] });
sealBuiltInRunSlots();

registerBuiltInStepKinds();
sealBuiltInStepKinds();
