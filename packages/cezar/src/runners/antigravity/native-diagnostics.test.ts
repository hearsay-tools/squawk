import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { registerRunner } from '../../core/runner-registry.ts';
import { antigravityRunner } from './definition.ts';
import { AntigravityRunner } from './antigravity-runner.ts';
import { discoverAntigravityModels } from './antigravity-model-catalog.ts';
import { logAntigravityFailure } from './native-diagnostics.ts';

registerRunner(antigravityRunner);
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function workspace() { const dir = await mkdtemp(join(tmpdir(), 'agy-diagnostics-')); dirs.push(dir); return dir; }

it('logs bounded INFO/ERROR tails with native URL/token and per-run credential redaction', async () => {
  const dir = await workspace(); const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await writeFile(join(dir, 'agy.log.INFO.1'), 'x'.repeat(20_000) + '\nINFO retained\nrefresh_token=private-refresh\n');
  await writeFile(join(dir, 'harness.log.ERROR.1'), 'ERROR unexpected end of JSON input\nhttps://accounts.google.com/auth?state=private-state\nBearer private-bearer\nper-run-private-key\n');
  await writeFile(join(dir, 'settings.json'), 'private-non-log');
  await logAntigravityFailure(dir, 'probe', new Error('access_token=private-access'), { GEMINI_API_KEY: 'per-run-private-key' });
  const shown = JSON.stringify(log.mock.calls);
  expect(shown).toContain('INFO retained'); expect(shown).toContain('unexpected end of JSON input');
  expect(shown).not.toMatch(/private-|https:|x{100}/);
  expect(shown.length).toBeLessThan(70_000);
});

it.runIf(process.platform !== 'win32')('does not read log aliases or symlinks outside the private temp folder', async () => {
  const dir = await workspace(); const outside = await workspace();
  await writeFile(join(outside, 'secret'), 'outside-private-data');
  await symlink(join(outside, 'secret'), join(dir, 'agy.log.ERROR.1'));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await logAntigravityFailure(dir, 'session', 'native failure', {});
  expect(JSON.stringify(log.mock.calls)).not.toContain('outside-private-data');
  expect(log).toHaveBeenCalledWith('Antigravity session failed:', expect.any(String), 'No native INFO/ERROR log tail available.');
});

it.each(['session', 'catalog'].flatMap(kind => [false, true].map(fails => ({ kind, fails }))))('retains native evidence only for failed $kind cleanup (failure=$fails)', async ({ kind, fails }) => {
  const dir = await workspace(); const receipt = join(dir, 'temp-path'); const executable = join(dir, 'agy');
  const mock = join(import.meta.dirname, '../../../scripts', kind === 'session' ? 'mock-acp.mjs' : 'mock-antigravity-auth.mjs');
  await writeFile(executable, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(${JSON.stringify(receipt)}, process.env.TMPDIR);
writeFileSync(join(process.env.TMPDIR, 'agy.log.INFO.1'), 'native failure trace\\nrefresh_token=private-refresh\\n');
await import(${JSON.stringify(mock)});
`, { mode: 0o700 });
  vi.stubEnv('HSQ_ANTIGRAVITY_BIN', executable); vi.stubEnv('GEMINI_API_KEY', 'fixture-key');
  vi.stubEnv('AGY_MOCK_BAD_MODELS', fails ? '1' : '');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const result = kind === 'catalog'
    ? discoverAntigravityModels({ cwd: dir, accountHome: join(dir, 'account') })
    : new AntigravityRunner({ bin: executable }).run({ cwd: dir, toolGrant: { kind: 'unset' }, userPrompt: fails ? 'mock:provider-unavailable' : 'hello' });
  if (fails) {
    await expect(result).rejects.toThrow(kind === 'catalog' ? 'Antigravity returned no models' : 'Agent execution error:');
    expect(JSON.stringify(log.mock.calls)).toContain('native failure trace');
  } else { await result; expect(log).not.toHaveBeenCalled(); }
  expect(JSON.stringify(log.mock.calls)).not.toContain('private-refresh');
  await expect(access(await readFile(receipt, 'utf8'))).rejects.toMatchObject({ code: 'ENOENT' });
});
