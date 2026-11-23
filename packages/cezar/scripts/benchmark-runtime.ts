import { registerBuiltInStepKinds, sealBuiltInStepKinds } from '../src/workflows/step-kind-registry.ts';
import { registerBuiltInTools, sealBuiltInTools } from '../src/built-in-tools.ts';
import { installWindowsIdentityStore } from '../src/delegation/windows-identity-store.ts';
import { registerBuiltInRunners, sealBuiltInRunners } from '../src/runners/built-in.ts';
import { registerBuiltInRunSlots, sealBuiltInRunSlots } from '../src/built-in-run-slots.ts';

/** Boot the process services used by benchmarks that open a run store. */
export function prepareBenchmarkRuntime(): void {
  // Workspace receipts and markers use the host's identity store (ADR 0032).
  installWindowsIdentityStore();
  registerBuiltInRunners();
  sealBuiltInRunners();
  registerBuiltInRunSlots();
  sealBuiltInRunSlots();
  registerBuiltInStepKinds();
  sealBuiltInStepKinds();
  registerBuiltInTools();
  sealBuiltInTools();
}
