import { access, mkdtemp, readFile, rm, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { registerRunner } from '../../core/runner-registry.ts';
import { antigravityRunner } from './definition.ts';
import { startAntigravitySignIn, validateAntigravityRedirect } from './browser-sign-in.ts';
import { discoverAntigravityModels, antigravityModelCatalogKey } from './antigravity-model-catalog.ts';
import { antigravityLogin } from './login-probe.ts';

registerRunner(antigravityRunner);
const bin = join(import.meta.dirname, '../../../scripts/mock-antigravity-auth.mjs');
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() {
  const dir = await mkdtemp(join(tmpdir(), 'agy-auth-')); roots.push(dir);
  const executable = join(dir, 'agy'); await copyFile(bin, executable); vi.stubEnv('HSQ_ANTIGRAVITY_BIN', executable);
  return dir;
}

it('completes two native personal sign-ins with isolated secret and settings files', async () => {
  const dir = await root(); const homes = [join(dir, 'one'), join(dir, 'two')];
  const flows = await Promise.all(homes.map(home => startAntigravitySignIn(home)));
  try {
    await expect(flows[0]!.redirect('http://127.0.0.1:7777/?state=fixture-state&code=never-send')).rejects.toThrow();
    await Promise.all(flows.map(async flow => {
      const redirect = new URL(new URL(flow.url).searchParams.get('redirect_uri')!);
      redirect.searchParams.set('state', 'fixture-state'); redirect.searchParams.set('code', 'fixture-only');
      await flow.redirect(redirect.href); await flow.completion;
    }));
    for (const home of homes) {
      expect(JSON.parse(await readFile(join(home, 'antigravity-acp/settings.json'), 'utf8'))).toEqual({ auth: { type: 'oauth-personal' } });
      expect(await readFile(join(home, '.squawk-home/.config/antigravity/plugin-secrets.json'), 'utf8')).toContain('account-owned');
      expect(await antigravityLogin.inspect!({ stdout: 'antigravity_extensions/acp_server', stderr: '', exitCode: 0 }, { GEMINI_HOME: home })).toBe('connected');
      expect(await readdir(home)).not.toContain('fixture-only');
    }
  } finally { await Promise.all(flows.map(flow => flow.close())); }
});

it.each([0, 1])('reports an agent exit at sign-in start (code %s), excluding warnings and secrets', async code => {
  const dir = await root();
  const stderr = '/archive/types.py:42: SyntaxWarning: invalid escape sequence\n  warning source\n'
    + 'FATAL Flags parsing error: Unknown command line flag uid https://accounts.google.com/o/oauth2/auth?state=private-state token=private-token  \n';
  await writeFile(join(dir, 'agy'), `#!/usr/bin/env node\nprocess.stderr.write(${JSON.stringify(stderr)}, () => process.exit(${code}));\n`);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const failure = await startAntigravitySignIn(join(dir, 'account')).catch(error => error as Error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(`Agent exited (code ${code}): FATAL Flags parsing error: Unknown command line flag uid`);
  expect((failure as Error).message).not.toMatch(/SyntaxWarning|warning source|https:|private-state|private-token/);
  expect(log).toHaveBeenCalledWith('Antigravity personal sign-in start failed:', expect.any(Error), expect.objectContaining({ code, stderr }));
});

it.each(['initialize', 'authenticate'])('reports the %s error without exposing OAuth values', async method => {
  const dir = await root();
  await writeFile(join(dir, 'agy'), `#!/usr/bin/env node
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  const response = frame.method === ${JSON.stringify(method)}
    ? { error: { code: -32603, message: 'Native sign-in refused: https://accounts.google.com/o/oauth2/auth?state=private-state access_token=ya29.private-token' } }
    : { result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: 'oauth-personal', name: 'Personal' }] } };
  console.log(JSON.stringify({ jsonrpc: '2.0', id: frame.id, ...response }));
});\n`);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(startAntigravitySignIn(join(dir, 'account'))).rejects.toThrow(`${method}: Native sign-in refused: [URL redacted] access_token=[redacted]`);
});

it.each([
  'http://example.com:1234/?state=s&code=x', 'http://127.0.0.1:5556/?state=s&code=x',
  'http://127.0.0.1:5555/wrong?state=s&code=x', 'http://127.0.0.1:5555/?state=wrong&code=x',
  'http://127.0.0.1:5555/?state=s&state=s&code=x', 'http://127.0.0.1:5555/?state=s',
])('rejects redirects outside the captured flow: %s', value => {
  const consent = new URL('https://accounts.google.com/o/oauth2/auth');
  consent.searchParams.set('redirect_uri', 'http://127.0.0.1:5555/'); consent.searchParams.set('state', 's');
  expect(() => validateAntigravityRedirect(consent.href, value)).toThrow();
});

it('discovers native opaque IDs and model-specific thinking levels without a prompt', async () => {
  const dir = await root(); const accountHome = join(dir, 'account'); const wire = join(dir, 'wire');
  vi.stubEnv('GEMINI_API_KEY', 'fixture-key'); vi.stubEnv('AGY_MOCK_WIRE', wire);
  expect(await discoverAntigravityModels({ cwd: dir, accountHome })).toEqual([
    { id: 'opaque/flash', label: 'Flash', description: 'From Antigravity', effortLevels: ['low', 'medium', 'high'] },
    { id: 'opaque/pro', label: 'Pro', description: 'From Antigravity', effortLevels: ['low', 'high'] },
  ]);
  const frames = (await readFile(wire, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(frames.map(frame => frame.method)).not.toContain('session/prompt');
  expect(frames.find(frame => frame.method === 'session/new').params.cwd).not.toBe(dir);
  expect(frames.find(frame => frame.method === 'authenticate').params.methodId).toBe('gemini-api-key');
});

it('changes catalog identity for account auth, key and build changes', async () => {
  const dir = await root(); const accountHome = join(dir, 'account');
  vi.stubEnv('GEMINI_API_KEY', ''); vi.stubEnv('GOOGLE_API_KEY', '');
  const versionLog = join(dir, 'versions'); vi.stubEnv('AGY_MOCK_VERSION_LOG', versionLog);
  const key = () => antigravityModelCatalogKey({ accountHome });
  const [initial, concurrent] = await Promise.all([key(), key()]); expect(concurrent).toBe(initial);
  await mkdir(join(accountHome, 'antigravity-acp'), { recursive: true });
  await writeFile(join(accountHome, 'antigravity-acp/settings.json'), '{"auth":{"type":"oauth-personal"}}');
  const auth = await key(); expect(auth).not.toBe(initial);
  vi.stubEnv('GEMINI_API_KEY', 'new-fixture-key');
  const api = await key(); expect(api).not.toBe(auth); expect(api).not.toContain('new-fixture-key');
  expect((await readFile(versionLog, 'utf8')).trim().split('\n')).toHaveLength(1);
  vi.stubEnv('AGY_MOCK_VERSION', '1.5.1');
  const executable = join(dir, 'agy'); await writeFile(executable, `${await readFile(executable, 'utf8')}\n`);
  expect(await key()).not.toBe(api);
  expect(await antigravityModelCatalogKey({ accountHome: join(dir, 'other') })).not.toBe(await key());
  expect((await readFile(versionLog, 'utf8')).trim().split('\n')).toHaveLength(2);
});

it.each(['api-key', 'oauth'].flatMap(auth => [false, true].map(fails => ({ auth, fails }))))('leaves no discovery state in the $auth account (failure=$fails)', async ({ auth, fails }) => {
  const dir = await root(); const accountHome = join(dir, 'account'); const authDir = join(accountHome, 'antigravity-acp');
  await mkdir(join(authDir, 'conversations'), { recursive: true });
  await writeFile(join(authDir, 'conversations/existing.json'), 'keep');
  const settings = '{"auth":{"type":"oauth-personal"}}'; const token = '{"mock":"oauth-fixture"}';
  await writeFile(join(authDir, 'settings.json'), settings); await writeFile(join(authDir, 'acp_token.json'), token);
  vi.stubEnv('GEMINI_API_KEY', auth === 'api-key' ? 'fixture-key' : ''); vi.stubEnv('GOOGLE_API_KEY', '');
  const log = join(dir, 'homes'); vi.stubEnv('AGY_MOCK_HOME_LOG', log);
  vi.stubEnv('AGY_MOCK_BAD_MODELS', fails ? '1' : '');
  const discovery = discoverAntigravityModels({ cwd: dir, accountHome });
  if (fails) await expect(discovery).rejects.toThrow('Antigravity returned no models');
  else expect(await discovery).toHaveLength(2);
  expect(await readdir(join(authDir, 'conversations'))).toEqual(['existing.json']);
  expect(await readFile(join(authDir, 'settings.json'), 'utf8')).toBe(settings);
  expect(await readFile(join(authDir, 'acp_token.json'), 'utf8')).toBe(token);
  const probeHome = (await readFile(log, 'utf8')).trim();
  expect(probeHome).not.toBe(accountHome);
  await expect(access(probeHome)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('explains API-key presence without requiring a folder or treating business auth as supported', async () => {
  const result = { stdout: 'antigravity_extensions/acp_server', stderr: '', exitCode: 0 };
  expect(await antigravityLogin.inspect!(result, { GEMINI_API_KEY: 'fixture-key' })).toBe('connected');
  expect(antigravityLogin.requiresAccountHome!({ GEMINI_API_KEY: 'fixture-key' })).toBe(false);
  expect(antigravityLogin.hint!({ GEMINI_API_KEY: 'fixture-key' }, 'connected')).toContain('GEMINI_API_KEY');
});
