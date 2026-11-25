import { registerRunSlots, sealRunSlots, type RunSlots } from './runs/removal-slots.ts';
import { autosaveDeletionGate, autosaveRemovalCleanup } from './autosave-removal-slots.ts';
import { artifactsRemovalCleanup } from './artifacts/removal-slot.ts';
import { jobsDeletionGate } from './jobs/removal-slot.ts';
import { workerEvidencePreparation } from './delegation/removal-slot.ts';
import { registerWorkerExecutions, sealWorkerExecutions } from './runs/worker-executions-registry.ts';
import { createWorkerExecutions } from './delegation/worker-executions.ts';

/** The removal slots that ship with Squawk, in the order each path asks them. */
export const BUILT_IN_RUN_SLOTS: RunSlots = {
  gates: [autosaveDeletionGate, jobsDeletionGate],
  preparations: [workerEvidencePreparation],
  cleanups: [artifactsRemovalCleanup, autosaveRemovalCleanup],
};

/**
 * Register the built-in removal slots and the worker executions
 * (`runs/worker-executions-registry.ts`). Each process entry calls it once, beside
 * the bundled runner load, before it can delete, reclaim or archive a run or start a worker. A
 * second call registers the same objects again, which the registries ignore.
 */
export function registerBuiltInRunSlots(): void {
  registerWorkerExecutions(createWorkerExecutions);
  registerRunSlots(BUILT_IN_RUN_SLOTS);
}

/** Seal after every built-in and extension registration at the boot boundary. */
export function sealBuiltInRunSlots(): void {
  sealRunSlots();
  sealWorkerExecutions();
}
