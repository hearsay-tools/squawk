import { registerBuiltInCliCommands, sealBuiltInCliCommands } from './built-in-cli-commands.ts';
import { cliCommandsSealed } from './core/cli-registry.ts';

/**
 * Cold CLI (`--help`, `--version`, and commands whose `runtimeMode` is false) seals the CLI
 * command table only. It never loads a runner, a store, or a plugin.
 */
export function bootColdCli(): void {
  registerBuiltInCliCommands();
  sealBuiltInCliCommands();
}

export interface BootRuntimeOptions {
  /** Runs once, after registration and before the first full seal. A later boot skips it. */
  beforeSeal?: () => void | Promise<void>;
}

let runtimeBoot: Promise<void> | undefined;

/**
 * Register every built-in extension table, run the optional hook, then seal all eight registries
 * in this one place. A second call returns the same boot and does not run the hook again.
 */
export function bootRuntime(options?: BootRuntimeOptions): Promise<void> {
  if (runtimeBoot) return runtimeBoot;
  runtimeBoot = sealRuntime(options?.beforeSeal).catch(error => {
    runtimeBoot = undefined;
    throw error;
  });
  return runtimeBoot;
}

async function sealRuntime(beforeSeal: BootRuntimeOptions['beforeSeal']): Promise<void> {
  // A test may seal a custom command table before dispatch asks for a full boot.
  if (!cliCommandsSealed()) registerBuiltInCliCommands();
  const { registerBuiltInRunners, sealBuiltInRunners } = await import('./runners/built-in.ts');
  const { registerBuiltInRunSlots, sealBuiltInRunSlots } = await import('./built-in-run-slots.ts');
  const { registerBuiltInStepKinds, sealBuiltInStepKinds } = await import('./workflows/step-kind-registry.ts');
  const { registerBuiltInTools, sealBuiltInTools } = await import('./built-in-tools.ts');
  const { registerBuiltInWaitKinds, sealBuiltInWaitKinds } = await import('./built-in-wait-kinds.ts');
  const { sealRunLifecycleListeners } = await import('./runs/lifecycle-registry.ts');
  registerBuiltInRunners();
  registerBuiltInRunSlots();
  registerBuiltInStepKinds();
  registerBuiltInTools();
  registerBuiltInWaitKinds();
  await beforeSeal?.();
  sealBuiltInCliCommands();
  sealBuiltInRunners();
  sealBuiltInRunSlots();
  sealBuiltInStepKinds();
  sealBuiltInTools();
  sealBuiltInWaitKinds();
  sealRunLifecycleListeners();
}
