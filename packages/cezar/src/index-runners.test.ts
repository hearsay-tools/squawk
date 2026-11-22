import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';

// Cold processes prove metadata and HTTP/file commands never evaluate the service graph.
it.each([
  ['--help'], ['-h'], ['--version'], ['-v'],
  ['backup', 'list'],
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
