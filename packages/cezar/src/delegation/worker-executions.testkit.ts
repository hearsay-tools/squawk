import { registerWorkerExecutions } from '../runs/worker-executions-registry.ts';
import { createWorkerExecutions } from './worker-executions.ts';

// Importing this module registers the shipped worker executions for this test file, as
// `registerBuiltInRunSlots()` does at each process entry (hearsay-tools/squawk#4039). Vitest gives
// each test file its own module registry, so the registration lasts for the file. A shared testkit
// that builds stores or a RunManager imports it; a test file imports it only where no testkit applies.
registerWorkerExecutions(createWorkerExecutions);
