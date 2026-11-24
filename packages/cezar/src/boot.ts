import { registerBuiltInCliCommands, sealBuiltInCliCommands } from './built-in-cli-commands.ts';
import { cliCommandsSealed } from './core/cli-registry.ts';
import { installPluginResolveHook } from './plugin/resolve-hook.ts';

/**
 * Cold CLI (`--help`, `--version`, and commands whose `runtimeMode` is false) seals the CLI
 * command table only. It never loads a runner, a store, or a plugin.
 */
export function bootColdCli(): void {
  registerBuiltInCliCommands();
  sealBuiltInCliCommands();
}

export interface BootRuntimeOptions {
  /**
   * The host plugin folder, `<config>/plugins/`. Its child folders load after the built-ins.
   * Absent: no host plugin loads, so a test boot never reads the operator's folder.
   */
  pluginsDir?: string | undefined;
  /** Runs once, after registration and before the first full seal. A later boot skips it. */
  beforeSeal?: () => void | Promise<void>;
}

let runtimeBoot: Promise<void> | undefined;
/** A retry after a failed hook keeps what the plugins committed and does not load them twice. */
let hostPluginsLoaded = false;

/**
 * Register every built-in extension table, load the host plugins, run the optional hook, then seal
 * all eight registries in this one place. A second call returns the same boot and does not load
 * plugins or run the hook again.
 */
export function bootRuntime(options?: BootRuntimeOptions): Promise<void> {
  if (runtimeBoot) return runtimeBoot;
  runtimeBoot = sealRuntime(options ?? {}).catch(error => {
    runtimeBoot = undefined;
    throw error;
  });
  return runtimeBoot;
}

async function sealRuntime({ pluginsDir, beforeSeal }: BootRuntimeOptions): Promise<void> {
  // Built-in runners and host plugins import `@hearsay-tools/squawk/plugin`; map it before either loads.
  installPluginResolveHook();
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
  if (pluginsDir !== undefined && !hostPluginsLoaded) {
    hostPluginsLoaded = true;
    await (await import('./plugin/loader.ts')).loadPluginFolder({ dir: pluginsDir, source: 'host' });
  }
  await beforeSeal?.();
  sealBuiltInCliCommands();
  sealBuiltInRunners();
  sealBuiltInRunSlots();
  sealBuiltInStepKinds();
  sealBuiltInTools();
  sealBuiltInWaitKinds();
  sealRunLifecycleListeners();
}
