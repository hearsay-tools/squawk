import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { registerRunner } from '../../core/runner-registry.ts';
import { antigravityRunner } from './definition.ts';
import { AntigravityRunner } from './antigravity-runner.ts';
import { discoverAntigravityModels } from './antigravity-model-catalog.ts';
import { logAntigravityFailure } from './native-diagnostics.ts';
import { AntigravityProbe } from './probe-process.ts';

registerRunner(antigravityRunner);
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function workspace() { const dir = await mkdtemp(join(tmpdir(), 'agy-diagnostics-')); dirs.push(dir); return dir; }

it('logs bounded INFO/ERROR tails with native URL/token and per-run credential redaction', async () => {
  const dir = await workspace(); const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await writeFile(join(dir, 'agy.log.INFO.1'), 'refresh_token=' + 'private-cut-token'.repeat(1_500) + '\nINFO retained\nrefresh_token=private-refresh\n');
  await writeFile(join(dir, 'harness.log.ERROR.1'), 'ERROR unexpected end of JSON input\nhttps://accounts.google.com/auth?state=private-state\nBearer private-bearer\nper-run-private-key\n');
  await writeFile(join(dir, 'settings.json'), 'private-non-log');
  await logAntigravityFailure(dir, 'probe', new Error('access_token=private-access'), { GEMINI_API_KEY: 'per-run-private-key' },
    'refresh_token=' + 'private-cut-token'.repeat(1_500) + '\nRAW WS MSG native stderr trace\nBearer private-stderr\n');
  const shown = JSON.stringify(log.mock.calls);
  expect(shown).toContain('INFO retained'); expect(shown).toContain('unexpected end of JSON input');
  expect(shown).toContain('RAW WS MSG native stderr trace');
  expect(shown).not.toMatch(/private-|https:|x{100}/);
  expect(shown.length).toBeLessThan(70_000);
});

it('retains native evidence when the probe deadline starts shutdown before the catalog catch', async () => {
  const dir = await workspace(); const executable = join(dir, 'agy');
  await writeFile(executable, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.env.TMPDIR, 'agy.log.ERROR.1'), 'deadline native trace\\naccess_token=private-access\\n');
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize') console.log(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } }));
});
lines.on('close', () => process.exit(0));
`, { mode: 0o700 });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers();
  const probe = new AntigravityProbe(executable, {}, 20_000);
  try {
    await probe.acp.initialize(); // Advance only after the child has written its native log.
    const pending = probe.acp.open({ cwd: probe.cwd }).catch(error => error);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toBeInstanceOf(Error);
    await probe.close(new Error('catalog catch after deadline'));
    expect(JSON.stringify(log.mock.calls)).toContain('Probe timed out after 20000ms');
    expect(JSON.stringify(log.mock.calls)).toContain('deadline native trace');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-access');
    await expect(access(probe.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { vi.useRealTimers(); await probe.close(); }
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

it.each(['session', 'catalog'].flatMap(kind => ['file', 'stderr'].flatMap(output => [false, true].map(fails => ({ kind, output, fails })))))('retains native $output evidence only for failed $kind cleanup (failure=$fails)', async ({ kind, output, fails }) => {
  const dir = await workspace(); const receipt = join(dir, 'temp-path'); const executable = join(dir, 'agy');
  const mock = join(import.meta.dirname, '../../../scripts', kind === 'session' ? 'mock-acp.mjs' : 'mock-antigravity-auth.mjs');
  await writeFile(executable, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(${JSON.stringify(receipt)}, process.env.TMPDIR);
if (!process.argv.includes('--debug')) throw new Error('native debug flag missing');
${output === 'file' ? "writeFileSync(join(process.env.TMPDIR, 'agy.log.INFO.1'), 'native failure trace\\nrefresh_token=private-refresh\\n');" : "process.stderr.write('native failure trace\\nrefresh_token=private-refresh\\n');"}
await import(${JSON.stringify(mock)});
`, { mode: 0o700 });
  vi.stubEnv('HSQ_ANTIGRAVITY_BIN', executable); vi.stubEnv('GEMINI_API_KEY', 'fixture-key');
  vi.stubEnv('HSQ_ANTIGRAVITY_DEBUG', '1');
  vi.stubEnv('AGY_MOCK_BAD_MODELS', fails ? '1' : '');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const result = kind === 'catalog'
    ? discoverAntigravityModels({ cwd: dir, accountHome: join(dir, 'account') })
    : new AntigravityRunner({ bin: executable }).run({ cwd: dir, toolGrant: { kind: 'unset' }, userPrompt: fails ? 'mock:provider-unavailable' : 'hello' }, event => {
      expect(JSON.stringify(event)).not.toContain('private-refresh');
    });
  if (fails) {
    await expect(result).rejects.toThrow(kind === 'catalog' ? 'Antigravity returned no models' : 'Agent execution error:');
    expect(JSON.stringify(log.mock.calls)).toContain('native failure trace');
  } else { await result; expect(log).not.toHaveBeenCalled(); }
  expect(JSON.stringify(log.mock.calls)).not.toContain('private-refresh');
  await expect(access(await readFile(receipt, 'utf8'))).rejects.toMatchObject({ code: 'ENOENT' });
});
