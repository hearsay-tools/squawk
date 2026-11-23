import { registerPrWaitKind } from './ci-wait/pr-wait-kind.ts';
import { registerPeerWaitKind, registerWorkerWaitKind } from './delegation/wait-kinds.ts';
import { registerCoreWaitKinds, registerSubagentWaitKind } from './workflows/run/wait-kinds.ts';

/** Shell composition: the forge, delegation, the runner's subagent wait and the core kinds, in the
 *  historical row order that policy lists keep. It only registers; the boot boundary seals. */
export function registerBuiltInWaitKinds(): void {
  registerPrWaitKind();
  registerWorkerWaitKind();
  registerPeerWaitKind();
  registerSubagentWaitKind();
  registerCoreWaitKinds();
}
export { sealWaitKinds as sealBuiltInWaitKinds } from './workflows/run/wait-kind-registry.ts';
