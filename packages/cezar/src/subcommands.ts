/**
 * The CLI subcommands that take flags of their own, so `index.ts` runs them before its global
 * parseArgs: their flags are not cockpit flags (#504, #774, #1576). Each module loads only when
 * its command runs.
 */

import type { Home } from './home/home.ts';
import { resolveHome } from './home/resolve.ts';
import { readInstallMarker } from './home/install-marker.ts';
export type SubcommandRunner = (argv: string[], env: NodeJS.ProcessEnv) => Promise<number>;

export const SUBCOMMAND_NAMES = ['backup', 'discover', 'artifact', 'job', 'task', 'automation', 'webhook', 'worker', 'message', 'remote-settings', 'migrate', 'server-migrate', 'migrate-project'] as const;

/** An unreadable marker still marks the split home as in use: list it, as before the fallback. */
function hasInstallMarker(root: string): boolean {
  try { return readInstallMarker(root) !== undefined; } catch { return true; }
}

/** The runner for `name`, or nothing when `name` is not a subcommand. */
export async function loadSubcommand(name: string | undefined, home: (env: NodeJS.ProcessEnv) => Home = env => resolveHome({ purpose: 'cli', env })): Promise<SubcommandRunner | undefined> {
  switch (name) {
    case 'migrate': return (await import('./home/migration-cli.ts')).runMigrationCommand;
    case 'migrate-project': return (await import('./project-migration/cli.ts')).migrateProjectRunner(env => {
      return [resolveHome({ purpose: 'cli', env, layout: 'legacy' }), resolveHome({ purpose: 'cli', env, layout: 'split' })];
    });
    case 'server-migrate': return async (argv, env) => {
      const legacy = resolveHome({ purpose: 'cli', env, layout: 'legacy' }), target = resolveHome({ purpose: 'cli', env, layout: 'split' });
      return (await import('./server-install/migrate-cli.ts')).runServerMigrateCommand(argv, env, { legacy, target });
    };
    case 'backup': return async (argv, env) => {
      const selected = home(env);
      const source = selected.layout === 'split' && argv[0] === 'list' && !hasInstallMarker(selected.config)
        ? resolveHome({ purpose: 'cli', env, layout: 'legacy' }) : selected;
      return (await import('./workspace/backup-cli.ts')).runBackupCommand(argv, env, source, { contained: source !== selected });
    };
    case 'discover': return (await import('./discovery/cli.ts')).runDiscoverCommand;
    case 'artifact': return (await import('./artifacts/cli.ts')).runArtifactCommand;
    case 'job': return (await import('./jobs/cli.ts')).runJobCommand;
    case 'task': return (await import('./task-cli/cli.ts')).runTaskCommand;
    case 'automation': return (await import('./automations/automation-cli.ts')).runAutomationCommand;
    case 'webhook': return (await import('./webhooks/cli.ts')).runWebhookCommand;
    case 'message': return (await import('./delegation/cli.ts')).runMessageCommand;
    case 'worker': return (await import('./delegation/cli.ts')).runWorkerCommand;
    case 'remote-settings': return async (argv, env) => {
      return (await import('./remote-settings-cli.ts')).runRemoteSettingsCommand(argv, env, undefined, home(env));
    };
    default: return undefined;
  }
}

/** Run `argv[0]` when it names a subcommand and answer its exit code; anything else is not ours. */
export async function runSubcommand(argv: string[], env: NodeJS.ProcessEnv, home = () => resolveHome({ purpose: 'cli', env })): Promise<number | undefined> {
  if (SUBCOMMAND_NAMES.some(name => name === argv[0])) await prepareCommandRuntime(argv[0]!, argv.slice(1));
  // Only operator runners call the lazy Home factory. Task runners keep two arguments.
  const run = await loadSubcommand(argv[0], () => home());
  return run ? run(argv.slice(1), env) : undefined;
}

/** Install process services before loading commands that read runner or removal registries. */
export async function prepareCommandRuntime(command: string, argv: readonly string[] = []): Promise<void> {
  const help = argv.some(arg => arg === '--help' || arg === '-h');
  const worker = command === 'worker' && (argv.length === 0 || help || argv[0] === 'help' || argv[0] === 'spawn');
  const backup = command === 'backup' && await backupNeedsRunners(argv);
  if (!worker && !backup && !['serve', 'run', 'init', 'projects', 'server-install', 'server-deploy', 'server-uninstall',
    'migrate', 'server-migrate', 'migrate-project', 'discover', 'task'].includes(command)) return;
  const { registerBuiltInRunners } = await import('./runners/built-in.ts');
  registerBuiltInRunners();
  const { registerBuiltInRunSlots } = await import('./built-in-run-slots.ts');
  registerBuiltInRunSlots();
}

/** Match the command's parser, including options before the operation and literal option values. */
async function backupNeedsRunners(argv: readonly string[]): Promise<boolean> {
  const { parseBackupArgs } = await import('./workspace/backups.ts');
  try {
    const { values, positionals } = parseBackupArgs(argv);
    return !values.help && ['restore', 'import', 'ignore'].includes(positionals[0] ?? '');
  } catch { return false; } // The command reports its own usage errors.
}
