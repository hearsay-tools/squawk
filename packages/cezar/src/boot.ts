import { registerBuiltInCliCommands, sealBuiltInCliCommands } from './built-in-cli-commands.ts';
import { cliCommandsSealed } from './core/cli-registry.ts';
import { installPluginResolveHook } from './plugin/resolve-hook.ts';
import type { Home } from './home/home.ts';

/**
 * Cold CLI (`--help`, `--version`, and commands whose `runtimeMode` is false) seals the CLI
 * command table only. It never loads a runner, a store, or a plugin.
 */
export function bootColdCli(): void {
  registerBuiltInCliCommands();
  sealBuiltInCliCommands();
}

/** The operator's `<config>/plugins/`. An unresolvable home loads no host plugin and warns once. */
export function hostPluginsDir(home: () => Home, warn: (line: string) => void = line => console.error(line)): string | undefined {
  try {
    return home().plugins;
  } catch (error) {
    warn(`[hsq] plugin folder unavailable (${error instanceof Error ? error.message : String(error)}) — continuing without plugins`);
    return undefined;
  }
}

export interface BootRuntimeOptions {
  /**
   * The host plugin folder, `<config>/plugins/`. Its child folders load after the built-ins and
   * the bundled runners.
   * Absent: no host plugin loads, so a test boot never reads the operator's folder.
   */
  pluginsDir?: string | undefined;
  /**
   * Test-only override for the bundled runners folder.
   * Absent: reads this Squawk copy's `runners/` folder and fails closed when it is empty.
   * Present: reads that folder instead and allows it to be empty so tests can boot with host
   * plugins only.
   */
  bundledRunnersDir?: string | undefined;
  /** Runs once, after registration and before the first full seal. A later boot skips it. */
  beforeSeal?: () => void | Promise<void>;
}

let runtimeBoot: Promise<void> | undefined;
/** One load per process: a retry after a failed hook reuses it, and a failed bundled runner fails every retry. */
let bundledRunnersLoad: Promise<unknown> | undefined;
/** A retry after a failed hook keeps what the plugins committed and does not load them twice. */
let hostPluginsLoaded = false;

/**
 * Register every built-in extension table, load the bundled runners and then the host plugins
 * through the plugin loader, run the optional hook, then seal
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

async function sealRuntime({ pluginsDir, bundledRunnersDir, beforeSeal }: BootRuntimeOptions): Promise<void> {
  // Built-in runners and host plugins import `@hearsay-tools/squawk/plugin`; map it before either loads.
  installPluginResolveHook();
  // A test may seal a custom command table before dispatch asks for a full boot.
  if (!cliCommandsSealed()) registerBuiltInCliCommands();
  const { registerBuiltInRunSlots, sealBuiltInRunSlots } = await import('./built-in-run-slots.ts');
  const { registerBuiltInStepKinds, sealBuiltInStepKinds } = await import('./workflows/step-kind-registry.ts');
  const { registerBuiltInTools, sealBuiltInTools } = await import('./built-in-tools.ts');
  const { registerBuiltInWaitKinds, sealBuiltInWaitKinds } = await import('./built-in-wait-kinds.ts');
  const { sealRunLifecycleListeners } = await import('./runs/lifecycle-registry.ts');
  const { sealRunners } = await import('./core/runner-registry.ts');
  const loader = await import('./plugin/loader.ts');
  registerBuiltInRunSlots();
  registerBuiltInStepKinds();
  registerBuiltInTools();
  registerBuiltInWaitKinds();
  await (bundledRunnersLoad ??= bundledRunnersDir === undefined
    ? loader.loadBundledRunners()
    : loader.loadBundledRunners(bundledRunnersDir, { allowEmpty: true }));
  if (pluginsDir !== undefined && !hostPluginsLoaded) {
    hostPluginsLoaded = true;
    await loader.loadPluginFolder({ dir: pluginsDir, source: 'host' });
  }
  await beforeSeal?.();
  sealBuiltInCliCommands();
  sealRunners();
  sealBuiltInRunSlots();
  sealBuiltInStepKinds();
  sealBuiltInTools();
  sealBuiltInWaitKinds();
  sealRunLifecycleListeners();
}
