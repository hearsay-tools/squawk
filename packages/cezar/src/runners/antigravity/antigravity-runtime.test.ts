import { registerRunner } from '../../core/runner-registry.ts';
import { antigravityRunner } from './definition.ts';
import { antigravityLogin } from './login-probe.ts';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { antigravityHarness } from './runtime-env.ts';
import { discoverAntigravitySkills } from './antigravity-skill-catalog.ts';
import { antigravityReadFile } from './client-files.ts';
import { ProviderAuthService } from '../../core/provider-auth.ts';
import { antigravityStderr } from './stderr.ts';
registerRunner(antigravityRunner);

it('removes library warning context while keeping real stderr diagnostics', () => {
  expect(antigravityStderr('/genai/types.py:5: SyntaxWarning: escape\n  sample = "\\\\/"\nFatal error: unavailable\n'))
    .toBe('Fatal error: unavailable');
  expect(antigravityStderr('')).toBe('');
});

it('refuses terminal sign-in and explains how to supply credentials', () => {
  const auth = new ProviderAuthService();
  expect(auth.loginCommand('antigravity')).toBeNull();
  expect(auth.loginRefusalHint('antigravity', '~/.gemini')).toContain('GEMINI_API_KEY');
});
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function workspace() { const dir = await mkdtemp(join(tmpdir(), 'antigravity-runtime-')); dirs.push(dir); return dir; }

it('finds the native harness beside the real binary behind a PATH symlink', async () => {
  const cwd = await workspace(); const archive = join(cwd, 'archive'); const bin = join(cwd, 'bin');
  await mkdir(archive); await mkdir(bin);
  const executable = join(archive, 'agy_acp_server.par');
  const harness = join(archive, 'localharness_external');
  await writeFile(executable, '', { mode: 0o755 }); await writeFile(harness, '');
  await symlink(executable, join(bin, 'agy'));
  expect(antigravityHarness('agy', { PATH: bin }, cwd)).toBe(harness);
  expect(antigravityHarness('missing-agy', { PATH: bin }, cwd)).toBeUndefined();
});

it('lists the four recorded skill roots in native order and sees later additions', async () => {
  const cwd = await workspace(); const accountHome = join(cwd, 'account');
  const roots = [join(accountHome, 'config/skills'), join(cwd, '.gemini/skills'), join(accountHome, 'antigravity-cli/skills'), join(cwd, '.agents/skills')];
  for (const [index, root] of roots.entries()) {
    const folder = join(root, `probe-${index}`); await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'SKILL.md'), `---\nname: probe-${index}\ndescription: Recorded root\n---\nRun the probe.`);
  }
  const first = await discoverAntigravitySkills({ cwd, accountHome });
  expect(first.skills.map(skill => [skill.id, skill.scope])).toEqual([
    ['probe-0', 'user'], ['probe-1', 'repo'], ['probe-2', 'user'], ['probe-3', 'repo'],
  ]);
  const late = join(roots[3]!, 'probe-late'); await mkdir(late); await writeFile(join(late, 'SKILL.md'), 'Late skill');
  expect((await discoverAntigravitySkills({ cwd, accountHome })).skills.map(skill => skill.id)).toContain('probe-late');
});

it('enforces Read admission before client file access and honors line slices', async () => {
  const cwd = await workspace(); await writeFile(join(cwd, 'notes.txt'), 'one\ntwo\nthree\n');
  await expect(antigravityReadFile({ path: 'notes.txt' }, cwd, { kind: 'explicit', tools: [] })).rejects.toThrow('Read is not granted');
  await expect(antigravityReadFile({ path: 'notes.txt', line: 2, limit: 1 }, cwd, { kind: 'explicit', tools: ['Read'] })).resolves.toEqual({ content: 'two' });
});


it('reports personal OAuth token presence without reading credential contents', async () => {
  const cwd = await workspace(); const env = { HOME: cwd, GEMINI_HOME: join(cwd, 'gemini') };
  const version = { stdout: 'antigravity_extensions/acp_server 1.5.0', stderr: '', exitCode: 0 };
  await expect(antigravityLogin.inspect!(version, env)).resolves.toBe('disconnected');
  await expect(antigravityLogin.inspect!(version, { ...env, GEMINI_API_KEY: 'fixture-present' })).resolves.toBe('connected');
  await expect(antigravityLogin.inspect!(version, { ...env, GOOGLE_API_KEY: 'fixture-present' })).resolves.toBe('connected');
  await mkdir(join(env.GEMINI_HOME, 'antigravity-acp'), { recursive: true });
  await writeFile(join(env.GEMINI_HOME, 'antigravity-acp/settings.json'), JSON.stringify({ auth: { type: 'oauth-personal' } }));
  await expect(antigravityLogin.inspect!(version, env)).resolves.toBe('disconnected');
  await mkdir(join(cwd, '.config/antigravity'), { recursive: true });
  await writeFile(join(cwd, '.config/antigravity/plugin-secrets.json'), 'credential content is not JSON and must not be parsed');
  await expect(antigravityLogin.inspect!(version, env)).resolves.toBe('disconnected');
  await writeFile(join(env.GEMINI_HOME, 'antigravity-acp/acp_token.json'), 'credential content is not JSON and must not be parsed');
  await expect(antigravityLogin.inspect!(version, env)).resolves.toBe('connected');
});
