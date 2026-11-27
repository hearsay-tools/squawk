import { registerBuiltInWaitKinds, sealBuiltInWaitKinds } from '../src/built-in-wait-kinds.ts';
import { registerBuiltInStepKinds, sealBuiltInStepKinds } from '../src/workflows/step-kind-registry.ts';
import { registerBuiltInTools, sealBuiltInTools } from '../src/built-in-tools.ts';
import { installWindowsIdentityStore } from '../src/delegation/windows-identity-store.ts';
import { installPluginResolveHook } from '../src/plugin/resolve-hook.ts';
import { registerBuiltInRunSlots, sealBuiltInRunSlots } from '../src/built-in-run-slots.ts';
import { registerBuiltInLaunchParts, sealBuiltInLaunchParts } from '../src/built-in-launch-parts.ts';

installPluginResolveHook();
const { loadBundledRunners } = await import('../src/plugin/loader.ts');
const { sealRunners } = await import('../src/core/runner-registry.ts');
// The bundled runners load at import, so prepareBenchmarkRuntime stays synchronous.
await loadBundledRunners();

/** Boot the process services used by benchmarks that open a run store. */
export function prepareBenchmarkRuntime(): void {
  // Workspace receipts and markers use the host's identity store (ADR 0032).
  installWindowsIdentityStore();
  sealRunners();
  registerBuiltInRunSlots();
  sealBuiltInRunSlots();
  registerBuiltInLaunchParts();
  sealBuiltInLaunchParts();
  registerBuiltInStepKinds();
  sealBuiltInStepKinds();
  registerBuiltInWaitKinds();
  sealBuiltInWaitKinds();
  registerBuiltInTools();
  sealBuiltInTools();
}
