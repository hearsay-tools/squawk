import { registerCoreWaitKinds, registerBuiltInWaitKind } from './workflows/run/wait-kinds.ts';

/** Shell composition until the forge and delegation modules own these registrations. */
export function registerBuiltInWaitKinds(): void {
  // Preserve the historical row order for policy lists.
  for (const kind of ['pr', 'worker', 'peer', 'subagent'] as const) registerBuiltInWaitKind(kind);
  registerCoreWaitKinds();
}
export { sealWaitKinds as sealBuiltInWaitKinds } from './workflows/run/wait-kind-registry.ts';
