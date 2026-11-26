import { registerCliCommand, sealCliCommands, type CliCommandDefinition } from './core/cli-registry.ts';
import { resolveHome } from './home/resolve.ts';
import { readInstallMarker } from './home/install-marker.ts';
import { isValidRestore } from './home/backup-args.ts';

/** An unreadable marker still marks the split home as in use: list it, as before the fallback. */
function hasInstallMarker(root: string): boolean {
  try { return readInstallMarker(root) !== undefined; } catch { return true; }
}

/** Help must skip both runtime registration and the migrating operator Home factory. */
function operatorHelp(command: string, argv: readonly string[]): boolean {
  return ['--help', '-h', ...(command === 'remote-settings' ? ['help'] : [])].includes(argv[0] ?? '');
}

const builtIns: readonly CliCommandDefinition[] = [
  { name: 'serve', usage: ["  cez                       start the cockpit (server + GUI) for the current repo"],
    parseMode: 'root', homeMode: 'unconditional', runtimeMode: 'always',
    load: async () => async ({ deps, home, repoRoot, values }) => {
      await deps.serveCommand(home(), repoRoot, Number(values.port), !values['no-open'], values['bind-host']);
    },
  },
  { name: 'run', usage: ["  cez run \"<task>\"          run a task headless in the terminal"],
    parseMode: 'root', homeMode: 'unconditional', runtimeMode: 'always',
    homeEntry: argv => argv.slice(1).join(' ').trim() ? 'run' : 'run-usage',
    load: async () => async ({ deps, home, repoRoot, task, values }) => {
      await deps.runCommand(home(), repoRoot, task, values.workflow, values.model,
        { allowWorkers: !values['no-workers'], allowMessaging: !values['no-messaging'] });
    },
  },
  { name: 'init', usage: ["  cez init                  scaffold .ai/squawk/ (example workflow + skill)"],
    parseMode: 'root', homeMode: 'unconditional', runtimeMode: 'always',
    load: async () => async ({ deps, home, repoRoot }) => {
      home();
      await deps.initCommand(repoRoot);
    },
  },
  { name: 'projects', usage: ["  cez projects              list the projects this cockpit serves", "                            (also: projects add [<dir>] · projects remove|rm <id> ·", "                             projects tag <id> [<tag>…])"],
    parseMode: 'root', homeMode: 'conditional', runtimeMode: 'always',
    load: async () => async ({ deps, home, repoRoot, positionals }) => {
      // Registry-only (no server, no HTTP) — see workspace/projects-cli.ts.
      deps.process.exitCode = await deps.runProjectsCommand(positionals.slice(1), { defaultRoot: repoRoot, home: home() });
    },
  },
  { name: 'backup', usage: ["  cez backup list [<file>]   list rotating registry and account backups", "  cez backup restore <file> [--at <time>] restore JSON from a backup"],
    parseMode: 'subcommand', homeMode: 'unconditional', runtimeMode: argv => !operatorHelp('backup', argv),
    homeEntry: argv => isValidRestore(argv.slice(1)) ? 'backup' : 'backup-read',
    load: async (home) => async (argv, env) => {
      const selected = operatorHelp('backup', argv) ? resolveHome({ purpose: 'cli', env }) : home(env);
      const source = selected.layout === 'split' && argv[0] === 'list' && !hasInstallMarker(selected.config)
        ? resolveHome({ purpose: 'cli', env, layout: 'legacy' }) : selected;
      return (await import('./workspace/backup-cli.ts')).runBackupCommand(argv, env, source, { contained: source !== selected });
    },
  },
  { name: 'discover', usage: ["  cez discover              list host runners, models, and advertised effort levels"],
    parseMode: 'subcommand', homeMode: 'none', runtimeMode: 'always',
    load: async () => (await import('./discovery/cli.ts')).runDiscoverCommand,
  },
  { name: 'worker', usage: ["  cez worker                manage owned workers (see: worker --help)"],
    parseMode: 'subcommand', homeMode: 'none', runtimeMode: argv => argv.length === 0 || argv.some(arg => arg === '--help' || arg === '-h') || argv[0] === 'help' || argv[0] === 'spawn',
    load: async () => (await import('./delegation/cli.ts')).runWorkerCommand,
  },
  { name: 'message', usage: ["  cez message               message tasks (see: message --help)"],
    parseMode: 'subcommand', homeMode: 'none', runtimeMode: 'none',
    load: async () => (await import('./delegation/cli.ts')).runMessageCommand,
  },
  { name: 'task', usage: ["  cez task                  start/watch/steer cockpit tasks from the terminal (see: task --help)"],
    parseMode: 'subcommand', homeMode: 'none', runtimeMode: 'always',
    load: async () => (await import('./task-cli/cli.ts')).runTaskCommand,
  },
  { name: 'automation', usage: ["  cez automation            create and manage automations from a task (see: automation --help)"],
    parseMode: 'subcommand', homeMode: 'none', runtimeMode: 'none',
    load: async () => (await import('./automations/automation-cli.ts')).runAutomationCommand,
  },
  { name: 'webhook', usage: ["  cez webhook               list and send to the project webhooks open to agents (see: webhook --help)"],
    parseMode: 'subcommand', homeMode: 'none', runtimeMode: 'none',
    load: async () => (await import('./webhooks/cli.ts')).runWebhookCommand,
  },
  { name: 'artifact', usage: ["  cez artifact publish <path> publish a local task artifact (see: artifact --help)"],
    parseMode: 'subcommand', homeMode: 'none', runtimeMode: 'none',
    load: async () => (await import('./artifacts/cli.ts')).runArtifactCommand,
  },
  { name: 'plugins', usage: ["  cez plugins               list loaded and skipped plugins and what each adds"],
    parseMode: 'subcommand', homeMode: 'none', runtimeMode: 'always',
    load: async () => (await import('./plugin/cli.ts')).runPluginsCommand,
  },
  { name: 'server-install', usage: ["  cez server-install        interactive wizard to host Squawk on a server"],
    parseMode: 'root', homeMode: 'conditional', runtimeMode: 'always',
    load: async () => async ({ deps, home, repoRoot, values, portExplicit }) => {
      await deps.serverCommand('install', home(), repoRoot, values.platform, {
        yes: Boolean(values.yes),
        reconfigure: values.reconfigure,
        reinstall: Boolean(values.reinstall),
        domain: values.domain,
        port: portExplicit ? Number(values.port) : undefined,
        externalProxy: Boolean(values['external-proxy']),
        bindHost: values['bind-host'],
      });
    },
  },
  { name: 'server-deploy', usage: ["  cez server-deploy         redeploy a new version (reload the service) + verify"],
    parseMode: 'root', homeMode: 'conditional', runtimeMode: 'always',
    load: async () => async ({ deps, home, repoRoot, values }) => {
      await deps.serverCommand('deploy', home(), repoRoot, values.platform, {
        yes: Boolean(values.yes),
        domain: values.domain,
      });
    },
  },
  { name: 'server-uninstall', usage: ["  cez server-uninstall      reverse a server-install"],
    parseMode: 'root', homeMode: 'conditional', runtimeMode: 'always',
    load: async () => async ({ deps, home, repoRoot, values }) => {
      await deps.serverCommand('uninstall', home(), repoRoot, values.platform, {
        yes: Boolean(values.yes),
        domain: values.domain,
      });
    },
  },
  { name: 'migrate', usage: ["  hsq migrate [--dry-run]  migrate the legacy home into the split layout", "  hsq migrate --resolve-legacy <file> restore|accept  resolve legacy recovery first"],
    parseMode: 'subcommand', homeMode: 'none', runtimeMode: 'always',
    load: async () => (await import('./home/migration-cli.ts')).runMigrationCommand,
  },
  { name: 'migrate-project', usage: ["  hsq migrate-project [--dry-run] move this project's state from .ai/cezar/ to .ai/squawk/, offline"],
    parseMode: 'subcommand', homeMode: 'none', runtimeMode: 'always',
    load: async () => (await import('./project-migration/cli.ts')).migrateProjectRunner(env => {
      return [resolveHome({ purpose: 'cli', env, layout: 'legacy' }), resolveHome({ purpose: 'cli', env, layout: 'split' })];
    }),
  },
  { name: 'remote-settings', usage: ["  cez remote-settings       enable|status|disable remote edits of agent config and worktree setup"],
    parseMode: 'subcommand', homeMode: 'conditional', runtimeMode: argv => !operatorHelp('remote-settings', argv),
    load: async (home) => async (argv, env) => {
      return (await import('./remote-settings-cli.ts')).runRemoteSettingsCommand(argv, env, undefined, operatorHelp('remote-settings', argv)
        ? resolveHome({ purpose: 'cli', env }) : home(env));
    },
  },
  // This internal migration command has no line in the shipped root help.
  { name: 'server-migrate', usage: [],
    parseMode: 'subcommand', homeMode: 'none', runtimeMode: 'always',
    load: async () => async (argv, env) => {
      const legacy = resolveHome({ purpose: 'cli', env, layout: 'legacy' }), target = resolveHome({ purpose: 'cli', env, layout: 'split' });
      return (await import('./server-install/migrate-cli.ts')).runServerMigrateCommand(argv, env, { legacy, target });
    },
  },
];

/** A built-in command by name, read without the registry, so dispatch can choose its boot first. */
export function builtInCliCommand(name: string): CliCommandDefinition | undefined {
  return builtIns.find(command => command.name === name);
}

/** Register only. The CLI boot boundary seals after extensions register. */
export function registerBuiltInCliCommands(): void {
  for (const command of builtIns) registerCliCommand(command);
}
export const sealBuiltInCliCommands = sealCliCommands;
