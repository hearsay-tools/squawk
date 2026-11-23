import './core-tools.testkit.ts';
import './delegation/worker-executions.testkit.ts';
import { sealRunSlots } from './runs/removal-slots.ts';
import { sealWaitKinds } from './workflows/run/wait-kind-registry.ts';
import { registerCoreWaitKinds, registerSubagentWaitKind } from './workflows/run/wait-kinds.ts';
import { registerBuiltInStepKinds, sealBuiltInStepKinds } from './workflows/step-kind-registry.ts';

// Registers and seals only core test registries (core tools, core and subagent wait kinds,
// built-in step kinds, and minimal removal slots) without pulling feature registries
// (preview, automations, PR waits, worker waits, or delegation).
// Tests that also exercise feature registries import their feature testkit before this module;
// repeated registration of the same core entries is idempotent even after sealing.
registerCoreWaitKinds();
registerSubagentWaitKind();
sealWaitKinds();

registerBuiltInStepKinds();
sealBuiltInStepKinds();

sealRunSlots();
