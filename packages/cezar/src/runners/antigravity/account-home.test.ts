import { mkdtemp, mkdir, writeFile, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { registerRunner } from '../../core/runner-registry.ts';
import { profileEnv } from '../../core/agent-profiles.ts';
import { prepareAntigravityAccount } from './account-home.ts';
import { antigravityRunner } from './definition.ts';
import { AntigravityRunner } from './antigravity-runner.ts';
registerRunner(antigravityRunner);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function workspace() { const dir = await mkdtemp(join(tmpdir(), 'agy-accounts-')); dirs.push(dir); return dir; }

it.each(['absolute', 'relative'])('shares native files from an %s source home and preserves account files', async kind => {
  const root = await workspace(); const source = join(root, 'default'); const account = join(root, 'work');
  await mkdir(source); await writeFile(join(source, 'AGENTS.md'), 'User instructions');
  const sourceHome = kind === 'relative' ? relative(process.cwd(), source) : source;
  prepareAntigravityAccount(account, sourceHome);
  for (const name of ['AGENTS.md', 'GEMINI.md', 'config/skills', 'antigravity-cli/skills']) {
    expect(await readlink(join(account, name))).toBe(join(source, name));
  }
  await writeFile(join(account, 'antigravity-acp-settings'), 'account-owned');
  prepareAntigravityAccount(account, sourceHome);
  expect(await readFile(join(account, 'antigravity-acp-settings'), 'utf8')).toBe('account-owned');
  expect(await readFile(join(account, 'AGENTS.md'), 'utf8')).toBe('User instructions');
});

it('runs two accounts side by side with separate Gemini and secret-storage homes', async () => {
  const cwd = await workspace(); const bin = join(import.meta.dirname, '../../../scripts/mock-acp.mjs');
  const homes = [join(cwd, 'personal'), join(cwd, 'work')];
  const outputs = await Promise.all(homes.map(async account => {
    const wire = join(account, 'wire');
    const env = profileEnv('antigravity', account);
    expect(env).toEqual({ GEMINI_HOME: account, HOME: join(account, '.squawk-home'), USERPROFILE: join(account, '.squawk-home'), XDG_CONFIG_HOME: join(account, '.squawk-home/.config') });
    const result = await new AntigravityRunner({ bin }).run({ cwd, toolGrant: { kind: 'unset' }, userPrompt: 'mock:account-homes',
      env: { ...env, CEZ_MOCK_STDIN_FILE: wire } });
    const record = JSON.parse(result.text);
    return record;
  }));
  expect(outputs.map(output => output.gemini)).toEqual(homes);
  expect(outputs.map(output => output.home)).toEqual(homes.map(home => join(home, '.squawk-home')));
  expect(outputs.map(output => output.config)).toEqual(homes.map(home => join(home, '.squawk-home/.config')));
});
