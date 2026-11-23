import type { Home } from './home/home.ts';
import { resolveHome } from './home/resolve.ts';
import { cliCommand } from './core/cli-registry.ts';
export type { SubcommandRunner } from './core/cli-registry.ts';

export async function loadSubcommand(name: string | undefined, home: (env: NodeJS.ProcessEnv) => Home = env => resolveHome({ purpose: 'cli', env })) {
  const command = cliCommand(name ?? '');
  return command?.parseMode === 'subcommand' ? command.load(home) : undefined;
}

export async function runSubcommand(argv: string[], env: NodeJS.ProcessEnv, home = () => resolveHome({ purpose: 'cli', env })): Promise<number | undefined> {
  const command = cliCommand(argv[0] ?? '');
  if (command?.parseMode !== 'subcommand') return undefined;
  await prepareCommandRuntime(command.name, argv.slice(1));
  const run = await loadSubcommand(command.name, () => home());
  return run!(argv.slice(1), env);
}

/** Install process services before loading commands that read runner or removal registries. */
export async function prepareCommandRuntime(command: string, argv: readonly string[] = []): Promise<void> {
  const definition = cliCommand(command);
  if (!definition || definition.runtimeMode === 'none' || (typeof definition.runtimeMode === 'function' && !definition.runtimeMode(argv))) return;
  const { registerBuiltInRunners, sealBuiltInRunners } = await import('./runners/built-in.ts');
  registerBuiltInRunners();
  sealBuiltInRunners();
  const { registerBuiltInRunSlots, sealBuiltInRunSlots } = await import('./built-in-run-slots.ts');
  registerBuiltInRunSlots();
  sealBuiltInRunSlots();
}
