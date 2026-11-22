import { expect, it, vi } from 'vitest';

// Runner definitions and removal/worker registries must be ready before command code executes.
const commands: Array<[string, string[]]> = [
  ...['serve', 'run', 'init', 'projects', 'server-install', 'server-deploy', 'server-uninstall',
    'migrate', 'server-migrate', 'migrate-project', 'discover', 'task'].map(command => [command, []] as [string, string[]]),
  ...[['spawn', '--runner', 'codex'], ['spawn', '--backend=codex'], ['--help'], []].map(args => ['worker', args] as [string, string[]]),
  ...['restore', 'import', 'ignore'].map(operation => ['backup', [operation, 'config.json']] as [string, string[]]),
  ['remote-settings', ['status']], ['backup', ['list']],
  ['backup', ['--at=2026-11-20T12:00:00Z', 'restore', 'config.json']],
  ['backup', ['--at', '2026-11-20T12:00:00Z', 'restore', 'agent-accounts.json']],
];
it.each(commands)('%s %j initializes process services before its handler', async (command, args) => {
  vi.resetModules();
  const slots = await import('./runs/removal-slots.ts');
  const executions = await import('./runs/worker-executions-registry.ts');
  const runners = await import('./core/runner-registry.ts');
  const { BUILT_IN_RUNNER_IDS } = await import('./runners/ids.ts');
  const check = () => {
    expect(slots.runSlotsSealed()).toBe(true);
    expect(executions.workerExecutionsRegistered()).toBe(true);
    expect(runners.registeredRunners().map(runner => runner.id)).toEqual([...BUILT_IN_RUNNER_IDS]);
  };
  if (['migrate', 'server-migrate', 'migrate-project', 'discover', 'task', 'worker', 'backup', 'remote-settings'].includes(command)) {
    const modules: Record<string, [string, string]> = {
      migrate: ['./home/migration-cli.ts', 'runMigrationCommand'],
      'server-migrate': ['./server-install/migrate-cli.ts', 'runServerMigrateCommand'],
      'migrate-project': ['./project-migration/cli.ts', 'migrateProjectRunner'],
      discover: ['./discovery/cli.ts', 'runDiscoverCommand'], task: ['./task-cli/cli.ts', 'runTaskCommand'],
      'remote-settings': ['./remote-settings-cli.ts', 'runRemoteSettingsCommand'],
      worker: ['./delegation/cli.ts', 'runWorkerCommand'], backup: ['./workspace/backup-cli.ts', 'runBackupCommand'],
    };
    const [path, name] = modules[command]!;
    const handler = async () => { check(); return 0; };
    vi.doMock(path, () => ({ [name]: name === 'migrateProjectRunner' ? () => handler : handler }));
    const { runSubcommand } = await import('./subcommands.ts');
    expect(await runSubcommand([command, ...args], {})).toBe(0);
    vi.doUnmock(path);
  } else {
    const { defaultCliDeps, main } = await import('./cli-dispatch.ts');
    const handler = async () => { check(); };
    await main({ ...defaultCliDeps,
      process: { argv: ['/bin/node', '/bin/hsq', command], env: {}, cwd: () => '/work', exitCode: undefined } as typeof defaultCliDeps.process,
      console: { log: vi.fn(), error: vi.fn() } as unknown as typeof defaultCliDeps.console, readOwnVersion: () => '0',
      resolveCliHome: () => ({}) as never, prepareOperatorHome: home => home,
      runSubcommand: async () => undefined, getRepoInfo: async () => null,
      serveCommand: handler, runCommand: handler, initCommand: handler, serverCommand: handler,
      runProjectsCommand: async () => { check(); return 0; },
    });
  }
});
