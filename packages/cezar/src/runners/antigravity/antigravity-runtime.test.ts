import { registerRunner } from '../../core/runner-registry.ts';
import { antigravityRunner } from './definition.ts';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { antigravityEnv } from './runtime-env.ts';
import { antigravityReadFile } from './client-files.ts';
import { ProviderAuthService } from '../../core/provider-auth.ts';
registerRunner(antigravityRunner);

it('refuses terminal sign-in and explains how to supply credentials', () => {
  const auth = new ProviderAuthService();
  expect(auth.loginCommand('antigravity')).toBeNull();
  expect(auth.loginRefusalHint('antigravity', '~/.gemini')).toContain('GEMINI_API_KEY');
});
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function workspace() { const dir = await mkdtemp(join(tmpdir(), 'antigravity-runtime-')); dirs.push(dir); return dir; }

it('passes the account by flag, drops GEMINI_HOME and keeps one token file per account', async () => {
  const cwd = await workspace(); const account = join(cwd, 'account');
  const runtime = antigravityEnv({ env: { GEMINI_HOME: account, GOOGLE_API_KEY: 'fixture-key', GOOGLE_CLOUD_PROJECT: 'other-auth' } });
  dirs.push(runtime.temp);
  expect(runtime.geminiDir).toBe(account);
  expect(runtime.env).not.toHaveProperty('GEMINI_HOME');
  expect(runtime.env).not.toHaveProperty('GOOGLE_CLOUD_PROJECT');
  expect(runtime.env).toMatchObject({ GEMINI_API_KEY: 'fixture-key', SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 0', AGY_CLI_DISABLE_AUTO_UPDATE: '1', TMPDIR: runtime.temp });
});

it('enforces Read admission before client file access and honors line slices', async () => {
  const cwd = await workspace(); await writeFile(join(cwd, 'notes.txt'), 'one\ntwo\nthree\n');
  await expect(antigravityReadFile({ path: 'notes.txt' }, cwd, { kind: 'explicit', tools: [] })).rejects.toThrow('Read is not granted');
  await expect(antigravityReadFile({ path: 'notes.txt', line: 2, limit: 1 }, cwd, { kind: 'explicit', tools: ['Read'] })).resolves.toEqual({ content: 'two' });
});
