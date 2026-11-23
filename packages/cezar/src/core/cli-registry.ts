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
export const sealCliCommands = commands.seal;
export const cliCommandsSealed = commands.isSealed;
export const cliCommand = commands.get;
export const registeredCliCommands = commands.values;
export const hasCliCommand = commands.has;
/** Cold home helpers do not boot or inspect an unsealed registry. */
export const knownCliCommand = (name: string): CliCommandDefinition | undefined => commands.isSealed() ? commands.get(name) : undefined;
