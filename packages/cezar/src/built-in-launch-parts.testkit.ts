import { registerBuiltInLaunchParts, sealBuiltInLaunchParts } from './built-in-launch-parts.ts';
import { registerLaunchPart } from './core/launch-registry.ts';
import { jobsLaunchPart } from './features/jobs/index.ts';

// Importing this module registers and seals the shipped launch parts (automations, webhooks,
// artifacts, and the bundled jobs feature's part), as each process entry does through boot. A test
// that checks the shipped launch prompt or env imports it before `core-registries.testkit.ts`, which
// seals an empty launch-parts registry.
registerBuiltInLaunchParts();
registerLaunchPart(jobsLaunchPart);
sealBuiltInLaunchParts();
