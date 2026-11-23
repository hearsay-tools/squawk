import { registerBuiltInStepKinds, sealBuiltInStepKinds } from './workflows/step-kind-registry.ts';
import './ci-wait/tools.testkit.ts';
import { registerBuiltInRunSlots, sealBuiltInRunSlots } from './built-in-run-slots.ts';

// Importing this module seals the shipped removal slots, as each process entry does. A test that
// deletes, reclaims or archives runs and checks a shipped feature's part of it imports it; a test
// that needs no feature seals only what it uses with `sealTestRunSlots()`.
registerBuiltInRunSlots();
sealBuiltInRunSlots();

registerBuiltInStepKinds();
sealBuiltInStepKinds();
