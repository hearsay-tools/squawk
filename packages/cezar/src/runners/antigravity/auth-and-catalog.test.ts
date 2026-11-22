import { access, mkdtemp, readFile, rm, writeFile, mkdir, readdir, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { registerRunner } from '../../core/runner-registry.ts';
import { antigravityRunner } from './definition.ts';
import { ANTIGRAVITY_CODE_REDIRECT, antigravityLoginResponse, startAntigravitySignIn } from './browser-sign-in.ts';
import { discoverAntigravityModels, antigravityModelCatalogKey } from './antigravity-model-catalog.ts';
import { antigravityLogin } from './login-probe.ts';
import { resolveAntigravityCommand, antigravityCliOutput, antigravityInstalled, antigravityOnPath, antigravityStatusExecutable, antigravityStatusUnverified, cachedAntigravityOnPath, checkAntigravityCli, knownAntigravityCli } from './executable.ts';

registerRunner(antigravityRunner);
const bin = join(import.meta.dirname, '../../../scripts/mock-antigravity-auth.mjs');
const roots: string[] = [];
const version = { stdout: '1.5.14\n', stderr: '', exitCode: 0 };
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() {
  const dir = await mkdtemp(join(tmpdir(), 'agy-auth-')); roots.push(dir);
  const executable = join(dir, 'agy'); await copyFile(bin, executable); await chmod(executable, 0o755); vi.stubEnv('HSQ_ANTIGRAVITY_BIN', executable);
  vi.stubEnv('GEMINI_API_KEY', ''); vi.stubEnv('GOOGLE_API_KEY', '');
  return dir;
}
const consent = `https://accounts.google.com/o/oauth2/auth?redirect_uri=${encodeURIComponent(ANTIGRAVITY_CODE_REDIRECT)}&response_type=code&state=s`;

it('signs two accounts in through --login with the pasted code or landing URL, and logs neither', async () => {
  const dir = await root(); const homes = [join(dir, 'one'), join(dir, 'two')];
  const loginLog = join(dir, 'login-lines'); vi.stubEnv('AGY_MOCK_LOGIN_LOG', loginLog);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const home of homes) expect(await antigravityLogin.inspect!(version, { ...process.env, GEMINI_HOME: home })).toBe('disconnected');
  const flows = await Promise.all(homes.map(home => startAntigravitySignIn(home)));
  try {
    for (const flow of flows) expect(new URL(flow.url).searchParams.get('redirect_uri')).toBe(ANTIGRAVITY_CODE_REDIRECT);
    await expect(flows[0]!.redirect(`${ANTIGRAVITY_CODE_REDIRECT}?state=wrong&code=never-send`)).rejects.toThrow('Paste the code');
    await flows[0]!.redirect('fixture-code-only');
    await expect(flows[0]!.redirect('fixture-code-only')).rejects.toThrow('already been submitted');
    await flows[1]!.redirect(`${ANTIGRAVITY_CODE_REDIRECT}?state=fixture-state&code=fixture-url-only`);
    await Promise.all(flows.map(flow => flow.completion));
    expect(flows[0]!.url).toBe('');
    for (const home of homes) {
      expect(await antigravityLogin.inspect!(version, { ...process.env, GEMINI_HOME: home })).toBe('connected');
      expect(await readdir(join(home, 'antigravity-cli'))).toContain('mock-login.json');
    }
    expect((await readFile(loginLog, 'utf8')).trim().split('\n').sort()).toEqual(['fixture-code-only', `${ANTIGRAVITY_CODE_REDIRECT}?state=fixture-state&code=fixture-url-only`].sort());
    expect(JSON.stringify(log.mock.calls)).not.toContain('fixture-');
  } finally { await Promise.all(flows.map(flow => flow.close())); }
});

it('fails the sign-in, not the cockpit, when the CLI closes its input before the code arrives', async () => {
  const dir = await root(); const quitter = join(dir, 'quitter');
  await writeFile(quitter, `#!/bin/sh\necho '  ${consent}'\nexec 0<&-\nexit 0\n`, { mode: 0o755 });
  vi.stubEnv('HSQ_ANTIGRAVITY_BIN', quitter);
  const flow = await startAntigravitySignIn(join(dir, 'account'));
  try {
    await flow.completion;
    await expect(flow.redirect('4/fixture-code')).rejects.toThrow('The sign-in has ended');
  } finally { await flow.close(); }
});

it('resolves a bare-name override through PATH before checking it', async () => {
  const dir = await root(); const path = join(dir, 'path'); await mkdir(path);
  await copyFile(bin, join(path, 'agy')); await chmod(join(path, 'agy'), 0o755);
  expect(resolveAntigravityCommand('agy', { PATH: path })).toBe(join(path, 'agy'));
  vi.stubEnv('PATH', `${path}:${process.env.PATH ?? ''}`);
  expect(await checkAntigravityCli('agy')).toBe(true);
});

it('rejects the completion when the CLI refuses the pasted code', async () => {
  const dir = await root();
  const flow = await startAntigravitySignIn(join(dir, 'account'));
  try {
    await flow.redirect('mock-refused');
    await expect(flow.completion).rejects.toThrow('Google sign-in did not complete');
    expect(await antigravityLogin.inspect!(version, { ...process.env, GEMINI_HOME: join(dir, 'account') })).toBe('disconnected');
  } finally { await flow.close(); }
});

it.each([0, 1])('reports a CLI exit before the consent link (code %s) without secrets', async code => {
  const dir = await root();
  const stderr = 'Error: flags provided but not defined: -uid https://accounts.google.com/o/oauth2/auth?state=private-state token=private-token\n';
  await writeFile(join(dir, 'agy'), `#!/usr/bin/env node\nprocess.stderr.write(${JSON.stringify(stderr)}, () => process.exit(${code}));\n`);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const failure = await startAntigravitySignIn(join(dir, 'account')).catch(error => error as Error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(`Sign-in exited (code ${code}) before it offered a Google link.`);
  expect((failure as Error).message).toContain('flags provided but not defined');
  expect(inspect(failure)).not.toMatch(/private-state|private-token/);
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-state|private-token/);
});

it.each([
  'https://example.com/oauth-callback?state=s&code=x', `${ANTIGRAVITY_CODE_REDIRECT}/wrong?state=s&code=x`,
  `${ANTIGRAVITY_CODE_REDIRECT}?state=wrong&code=x`, `${ANTIGRAVITY_CODE_REDIRECT}?state=s&state=s&code=x`,
  `${ANTIGRAVITY_CODE_REDIRECT}?state=s`, 'code with spaces', 'two\nlines',
])('refuses a pasted value that does not answer this sign-in: %s', value => {
  expect(() => antigravityLoginResponse(consent, value)).toThrow();
});

it('accepts a bare code or the landing URL of this sign-in', () => {
  expect(antigravityLoginResponse(consent, ' 4/0Abc-DEF_ghi.jk ')).toBe('4/0Abc-DEF_ghi.jk');
  expect(antigravityLoginResponse(consent, `${ANTIGRAVITY_CODE_REDIRECT}?state=s&code=x`)).toBe(`${ANTIGRAVITY_CODE_REDIRECT}?state=s&code=x`);
});

it('discovers native opaque IDs and model-specific thinking levels from a scratch folder without a prompt', async () => {
  const dir = await root(); const accountHome = join(dir, 'account'); const wire = join(dir, 'wire'); const homes = join(dir, 'homes');
  vi.stubEnv('GEMINI_API_KEY', 'fixture-key'); vi.stubEnv('AGY_MOCK_WIRE', wire); vi.stubEnv('AGY_MOCK_HOME_LOG', homes);
  expect(await discoverAntigravityModels({ cwd: dir, accountHome })).toEqual([
    { id: 'opaque/flash', label: 'Flash', description: 'From Antigravity', effortLevels: ['low', 'medium', 'high'] },
    { id: 'opaque/pro', label: 'Pro', description: 'From Antigravity', effortLevels: ['low', 'high'] },
  ]);
  const frames = (await readFile(wire, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(frames.map(frame => frame.method)).not.toContain('session/prompt');
  expect(frames.find(frame => frame.method === 'session/new').params.cwd).not.toBe(dir);
  expect(frames.find(frame => frame.method === 'authenticate').params.methodId).toBe('gemini-api-key');
  const scratch = (await readFile(homes, 'utf8')).trim();
  expect(scratch).not.toBe(accountHome);
  await expect(access(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(accountHome)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([false, true])('discovers models with a Google sign-in on the account (failure=%s)', async fails => {
  const dir = await root(); const accountHome = join(dir, 'account');
  vi.stubEnv('AGY_MOCK_BAD_MODELS', fails ? '1' : '');
  await expect(discoverAntigravityModels({ cwd: dir, accountHome })).rejects.toThrow('Sign in to Antigravity before discovering models');
  await mkdir(join(accountHome, 'antigravity-cli'), { recursive: true });
  await writeFile(join(accountHome, 'antigravity-cli/mock-login.json'), '{}');
  const discovery = discoverAntigravityModels({ cwd: dir, accountHome });
  if (fails) await expect(discovery).rejects.toThrow('Antigravity returned no models');
  else expect(await discovery).toHaveLength(2);
});

it('changes catalog identity for account auth, key and executable changes', async () => {
  const dir = await root(); const accountHome = join(dir, 'account');
  const key = () => antigravityModelCatalogKey({ accountHome });
  const [initial, concurrent] = await Promise.all([key(), key()]); expect(concurrent).toBe(initial);
  await mkdir(join(accountHome, 'antigravity-cli/cache'), { recursive: true });
  await writeFile(join(accountHome, 'antigravity-cli/cache/acp-auth-state.json'), '{"methodId":"oauth-personal"}');
  const auth = await key(); expect(auth).not.toBe(initial);
  vi.stubEnv('GEMINI_API_KEY', 'new-fixture-key');
  const api = await key(); expect(api).not.toBe(auth); expect(api).not.toContain('new-fixture-key');
  const executable = join(dir, 'agy'); await writeFile(executable, `${await readFile(executable, 'utf8')}\n// updated\n`);
  expect(await key()).not.toBe(api);
  expect(await antigravityModelCatalogKey({ accountHome: join(dir, 'other') })).not.toBe(await key());
});

it('explains API-key presence without requiring a folder or treating business auth as supported', async () => {
  expect(await antigravityLogin.inspect!(version, { GEMINI_API_KEY: 'fixture-key' })).toBe('connected');
  expect(await antigravityLogin.inspect!(version, { GOOGLE_API_KEY: 'fixture-key' })).toBe('connected');
  expect(await antigravityLogin.inspect!({ stdout: 'antigravity_extensions/acp_server 1.5.0', stderr: '', exitCode: 0 }, { GEMINI_API_KEY: 'fixture-key' })).toBeNull();
  expect(antigravityLogin.requiresAccountHome!({ GEMINI_API_KEY: 'fixture-key' })).toBe(false);
  expect(antigravityLogin.hint!({ GEMINI_API_KEY: 'fixture-key' }, 'connected')).toContain('GEMINI_API_KEY');
  expect(antigravityLogin.hint!({}, 'disconnected')).toContain('Business and agent-platform sign-in are not supported');
});

it('recognizes the CLI by its help and version, not by its name', async () => {
  expect(antigravityCliOutput('Usage of antigravity:\n  acp  Start the Agent Client Protocol (ACP) stdio server\n', '1.5.14\n')).toBe(true);
  expect(antigravityCliOutput('Usage: antigravity [options]\n', '1.5.14')).toBe(false);
  expect(antigravityCliOutput('Usage of antigravity:\n  acp  Start\n', 'antigravity_extensions/acp_server\nBuild label: 1.5.0')).toBe(false);
  const dir = await root();
  const first = join(dir, 'first'); const second = join(dir, 'second');
  await mkdir(first); await mkdir(second);
  // The Antigravity IDE launcher shares the name; the PATH walk goes on to the CLI.
  await writeFile(join(first, 'agy'), '#!/bin/sh\necho "Usage: antigravity [options][paths...]"\n', { mode: 0o755 });
  await copyFile(bin, join(second, 'antigravity')); await chmod(join(second, 'antigravity'), 0o755);
  // Status reads see only finished checks; they start the checks they still need.
  expect(cachedAntigravityOnPath({ PATH: `${first}:${second}` })).toBeUndefined();
  expect(await checkAntigravityCli(join(first, 'agy'))).toBe(false);
  expect(await antigravityOnPath({ PATH: `${first}:${second}` })).toBe(join(second, 'antigravity'));
  expect(knownAntigravityCli(join(second, 'antigravity'))).toBe(true);
  expect(cachedAntigravityOnPath({ PATH: `${first}:${second}` })).toBe(join(second, 'antigravity'));
  expect(await antigravityOnPath({ PATH: first })).toBeUndefined();
});

it('runs a still-unchecked PATH candidate for a cold status read and accepts it only once it is the CLI', async () => {
  const dir = await root(); const path = join(dir, 'bin'); const empty = join(dir, 'empty');
  await mkdir(path); await mkdir(empty);
  await copyFile(bin, join(path, 'agy')); await chmod(join(path, 'agy'), 0o755);
  const env = { PATH: path };
  expect(antigravityStatusExecutable(env)).toBe(join(path, 'agy'));
  expect(antigravityStatusUnverified(env)).toBe(true);
  expect(await antigravityInstalled(env)).toBe(true);
  expect(antigravityStatusUnverified(env)).toBe(false);
  expect(antigravityStatusExecutable(env)).toBe(join(path, 'agy'));
  expect(antigravityStatusExecutable({ PATH: empty })).toBe('antigravity-cli-not-installed');
});

it('reports a later CLI on PATH as installed when an IDE launcher comes first on a cold read', async () => {
  const dir = await root(); vi.stubEnv('HSQ_ANTIGRAVITY_BIN', ''); vi.stubEnv('GEMINI_API_KEY', 'fixture-key');
  const first = join(dir, 'ide'); const second = join(dir, 'cli'); await mkdir(first); await mkdir(second);
  await writeFile(join(first, 'agy'), '#!/bin/sh\necho "Antigravity IDE 2.0"\n', { mode: 0o755 });
  await copyFile(bin, join(second, 'antigravity')); await chmod(join(second, 'antigravity'), 0o755);
  const env = { ...process.env, PATH: `${first}:${second}` };
  const ide = { stdout: 'Antigravity IDE 2.0\n', stderr: '', exitCode: 0 };
  expect(await antigravityLogin.inspect!(ide, env)).toBe('connected');
});

it('rejects a CLI look-alike whose --version fails', async () => {
  const dir = await root(); const fake = join(dir, 'antigravity');
  await writeFile(fake, '#!/bin/sh\nif [ "$1" = --help ]; then printf "Usage of antigravity:\\n  acp  Start\\n"; exit 2; fi\necho 1.5.14; exit 1\n', { mode: 0o755 });
  expect(await checkAntigravityCli(fake)).toBe(false);
});
