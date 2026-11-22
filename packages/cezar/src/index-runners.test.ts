import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';

// Cold processes prove metadata and HTTP/file commands never evaluate the service graph.
it.each([
  ['--help'], ['-h'], ['--version'], ['-v'],
  ...['job', 'artifact', 'message', 'webhook', 'automation', 'backup', 'remote-settings'].map(command => [command, '--help']),
].map(argv => ({ argv, status: 0 })).concat(
  ['list', 'inspect', 'collect', 'wait'].map(operation => ({ argv: ['worker', operation], status: 1 })),
))('keeps the service and runner modules unloaded for $argv', ({ argv, status }) => {
  const entry = new URL('./index.ts', import.meta.url).href;
  const script = `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (/(?:^|\\/)(?:serve-command|headless-run|runs\\/store|runners\\/built-in)\\.[jt]s$/.test(specifier)) {
        throw new Error('Unexpected heavy CLI import: ' + specifier);
      }
      return next(specifier, context);
    }});
    delete process.env.HSQ_DELEGATION_URL;
    delete process.env.HSQ_DELEGATION_TOKEN;
    delete process.env.CEZ_DELEGATION_URL;
    delete process.env.CEZ_DELEGATION_TOKEN;
    process.argv = [process.execPath, '/bin/hsq', ...${JSON.stringify(argv)}];
    await import(${JSON.stringify(entry)});
  `;
  // bound: a cold CLI help process must finish; no controller or service starts.
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8', timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.stdout + result.stderr).not.toContain('Unexpected heavy CLI import');
  expect(result.status, result.stderr).toBe(status);
  expect(result.stdout.length).toBeGreaterThan(0);
});

it('renders runner help after registration even when imported before it', async () => {
  vi.resetModules();
  const { taskHelp } = await import('./task-cli/cli.ts');
  const { knownRunnerIds } = await import('./core/runner-registry.ts');
  expect(knownRunnerIds()).toEqual([]);
  const { registerBuiltInRunners } = await import('./runners/built-in.ts');
  registerBuiltInRunners();
  expect(taskHelp('start')).toContain('claude | codex | opencode | pi | omp | antigravity');
});


it('migrates legacy accounts before remote-settings status in a cold process', () => {
  const root = mkdtempSync(join(tmpdir(), 'hsq-cli-migration-'));
  const script = `
    import { strict as assert } from 'node:assert';
    import { readFileSync } from 'node:fs';
    import { Home } from './packages/cezar/src/home/home.ts';
    import { prepareOperatorHome } from './packages/cezar/src/home/entry.ts';
    import { runSubcommand } from './packages/cezar/src/subcommands.ts';
    const legacy = Home.sandbox(${JSON.stringify(root)} + '/legacy', { layout: 'legacy' });
    const target = Home.sandbox(${JSON.stringify(root)} + '/target');
    const account = { id: 'work', provider: 'claude', configDir: '/external/claude-work', label: '', addedAt: '' };
    Home.seed(legacy, legacy.workspaceConfig, { agentProfiles: [account],
      projects: [{ root: '/project', agentProfile: { claude: 'work' } }] });
    const env = { HSQ_URL: 'http://127.0.0.1:1' };
    assert.equal(await runSubcommand(['remote-settings', 'status'], env,
      () => prepareOperatorHome(target, 'remote-settings', env, { legacy })), 0);
    const saved = JSON.parse(readFileSync(target.agentAccounts, 'utf8'));
    assert.deepEqual(saved.accounts, [account]);
    assert.deepEqual(saved.selections, { '/project': { claude: 'work' } });
  `;
  try {
    // bound: migration and a refused loopback probe must finish without starting a service.
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8', timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
