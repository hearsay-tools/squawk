import type { Home } from './home/home.ts';
import { resolveHome } from './home/resolve.ts';
import { cliCommand, cliCommandsSealed, commandNeedsRuntime } from './core/cli-registry.ts';
import { builtInCliCommand } from './built-in-cli-commands.ts';
import { bootRuntime } from './boot.ts';
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

/** The operator's `<config>/plugins/`. An unresolvable home loads no host plugin and warns once. */
export function hostPluginsDir(home: () => Home = () => resolveHome({ purpose: 'cli' }), warn: (line: string) => void = line => console.error(line)): string | undefined {
  try {
    return home().plugins;
  } catch (error) {
    warn(`[hsq] plugin folder unavailable (${error instanceof Error ? error.message : String(error)}) — continuing without plugins`);
    return undefined;
  }
}

/**
 * Install process services before loading commands that read runner or removal registries. CLI
 * dispatch boots first, so this is then a no-op. A caller that enters a command wrapper directly
 * reads the built-in table and loads the same host plugin folder.
 */
export async function prepareCommandRuntime(command: string, argv: readonly string[] = []): Promise<void> {
  const definition = cliCommandsSealed() ? cliCommand(command) : builtInCliCommand(command);
  if (!definition || !commandNeedsRuntime(definition, argv)) return;
  await bootRuntime({ pluginsDir: hostPluginsDir() });
}
