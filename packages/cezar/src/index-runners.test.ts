import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Cold processes prove metadata and HTTP/file commands never evaluate the service graph.
it.each([
  ['--help'], ['-h'], ['--version'], ['-v'],
  ...['job', 'artifact', 'message', 'worker', 'webhook', 'automation', 'backup', 'remote-settings'].map(command => [command, '--help']),
])('keeps the service and runner modules unloaded for %j', (...argv) => {
  const entry = new URL('./index.ts', import.meta.url).href;
  const script = `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (/(?:^|\\/)(?:serve-command|headless-run|runs\\/store|runners\\/built-in)\\.[jt]s$/.test(specifier)) {
        throw new Error('Unexpected heavy CLI import: ' + specifier);
      }
      return next(specifier, context);
    }});
    process.argv = [process.execPath, '/bin/hsq', ...${JSON.stringify(argv)}];
    await import(${JSON.stringify(entry)});
  `;
  // bound: a cold CLI help process must finish; no controller or service starts.
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8', timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.length).toBeGreaterThan(0);
});
