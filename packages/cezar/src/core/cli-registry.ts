import { createKeyedRegistry } from './registry.ts';
import type { CliDeps } from '../cli-dispatch.ts';
import type { Home } from '../home/home.ts';

export interface RootCommandContext {
  deps: CliDeps;
  home: () => Home;
  repoRoot: string;
  task: string;
  positionals: string[];
  values: {
    port?: string; repo?: string; workflow?: string; model?: string;
    'no-open'?: boolean; 'no-workers'?: boolean; 'no-messaging'?: boolean;
    platform?: string; domain?: string; 'bind-host'?: string; 'external-proxy'?: boolean;
    yes?: boolean; reconfigure?: string; reinstall?: boolean;
  };
  portExplicit: boolean;
}
export type SubcommandRunner = (argv: string[], env: NodeJS.ProcessEnv) => Promise<number>;
interface CommandMetadata {
  name: string;
  usage: readonly string[];
  homeMode: 'none' | 'conditional' | 'unconditional';
  homeEntry?: (argv: readonly string[]) => string;
  runtimeMode: 'none' | 'always' | ((argv: readonly string[]) => boolean);
}
export type CliCommandDefinition = CommandMetadata & (
  | { parseMode: 'subcommand'; load: (home: (env: NodeJS.ProcessEnv) => Home) => Promise<SubcommandRunner> }
  | { parseMode: 'root'; load: () => Promise<(context: RootCommandContext) => Promise<void>> }
);
const commands = createKeyedRegistry<string, CliCommandDefinition>({
  name: 'CLI commands', bootHint: 'Register CLI commands, then call sealCliCommands() before dispatch.',
});
export const registerCliCommand = (command: CliCommandDefinition): void => commands.register(command.name, command);
/** Throws what `registerCliCommand` would throw for this command, without registering it. */
export const checkCliCommandRegistration = (command: CliCommandDefinition): void => commands.check(command.name, command);
export const sealCliCommands = commands.seal;
export const cliCommandsSealed = commands.isSealed;
export const cliCommand = commands.get;
export const registeredCliCommands = commands.values;
export const hasCliCommand = commands.has;
/** Whether agent-facing text may name this command: always before the registry seals (a contract
 *  test, a tool server that never boots the CLI), and after it only when the command registered. */
export const cliCommandAdvertised = (name: string): boolean => !cliCommandsSealed() || hasCliCommand(name);
/** Cold home helpers do not boot or inspect an unsealed registry. */
export const knownCliCommand = (name: string): CliCommandDefinition | undefined => commands.isSealed() ? commands.get(name) : undefined;
/** Whether this command line needs the full runtime boot: runners, stores and plugins. */
export function commandNeedsRuntime(command: CliCommandDefinition, argv: readonly string[]): boolean {
  return typeof command.runtimeMode === 'function' ? command.runtimeMode(argv) : command.runtimeMode === 'always';
}
