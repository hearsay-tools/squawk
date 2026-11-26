import { registerBuiltInLaunchParts, sealBuiltInLaunchParts } from './built-in-launch-parts.ts';

// Importing this module registers and seals the shipped launch parts (automations, webhooks,
// artifacts, jobs), as each process entry does. A test that checks the shipped launch prompt or
// env imports it before `core-registries.testkit.ts`, which seals an empty launch-parts registry.
registerBuiltInLaunchParts();
sealBuiltInLaunchParts();
