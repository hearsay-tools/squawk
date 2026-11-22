import { registerRunner } from '../../core/runner-registry.ts';
import { antigravityRunner } from './definition.ts';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { antigravityEnv } from './runtime-env.ts';
import { discoverAntigravitySkills } from './antigravity-skill-catalog.ts';
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

it('lists the five skill roots the CLI reads and sees later additions', async () => {
  const cwd = await workspace(); const accountHome = join(cwd, 'account');
  const roots = [join(accountHome, 'config/skills'), join(accountHome, 'antigravity-cli/skills'), join(accountHome, 'skills'), join(cwd, '.agents/skills'), join(cwd, '.agent/skills')];
  const ignored = join(cwd, '.gemini/skills/not-read'); await mkdir(ignored, { recursive: true }); await writeFile(join(ignored, 'SKILL.md'), 'The CLI no longer reads .gemini/skills');
  for (const [index, root] of roots.entries()) {
    const folder = join(root, `probe-${index}`); await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'SKILL.md'), `---\nname: probe-${index}\ndescription: Recorded root\n---\nRun the probe.`);
  }
  const first = await discoverAntigravitySkills({ cwd, accountHome });
  expect(first.skills.map(skill => [skill.id, skill.scope])).toEqual([
    ['probe-0', 'user'], ['probe-1', 'user'], ['probe-2', 'user'], ['probe-3', 'repo'], ['probe-4', 'repo'],
  ]);
  const late = join(roots[3]!, 'probe-late'); await mkdir(late); await writeFile(join(late, 'SKILL.md'), 'Late skill');
  expect((await discoverAntigravitySkills({ cwd, accountHome })).skills.map(skill => skill.id)).toContain('probe-late');
});

it('enforces Read admission before client file access and honors line slices', async () => {
  const cwd = await workspace(); await writeFile(join(cwd, 'notes.txt'), 'one\ntwo\nthree\n');
  await expect(antigravityReadFile({ path: 'notes.txt' }, cwd, { kind: 'explicit', tools: [] })).rejects.toThrow('Read is not granted');
  await expect(antigravityReadFile({ path: 'notes.txt', line: 2, limit: 1 }, cwd, { kind: 'explicit', tools: ['Read'] })).resolves.toEqual({ content: 'two' });
});
