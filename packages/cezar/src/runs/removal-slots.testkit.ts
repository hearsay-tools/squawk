import { registerRunSlots, sealRunSlots, type RunSlots } from './removal-slots.ts';

/**
 * Seal this test file's removal slots with only the slots it needs (spec
 * 2026-11-21-run-lifecycle-and-store-ports, "Removal slots"). Vitest gives each test file its own
 * module registry, so the seal lasts for the file. A file that needs the shipped slots imports
 * `built-in-run-slots.testkit.ts` instead.
 */
export function sealTestRunSlots(slots: RunSlots = {}): void {
  registerRunSlots(slots);
  sealRunSlots();
}
