import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { access, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSessionLeader } from '../../core/session-process.ts';
import { discoverAntigravitySkills, parseAntigravitySkills } from './antigravity-skill-catalog.ts';
import { antigravityRunner } from './definition.ts';

sealTestRunners(antigravityRunner);

const capture = JSON.parse(readFileSync(new URL('./__fixtures__/skill-list.json', import.meta.url), 'utf8'));
const cwd = '/tmp/skill-list-probe/repo';
const accountHome = '/home/probe/.gemini';
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agy-skill-catalog-'));
  dirs.push(dir);
  return dir;
}

describe('antigravity native skill metadata', () => {
  it('maps the real recorded response without skill bodies and strips plugin prefixes for ACP triggers', () => {
    const result = parseAntigravitySkills(capture, cwd, accountHome);
    expect(result.skills).toEqual([
      expect.objectContaining({ id: 'agy-customizations', name: 'agy-customizations', scope: 'system' }),
      expect.objectContaining({ id: 'code-review', name: 'code-review', scope: 'user', plugin: 'apptension-review' }),
      expect.objectContaining({ id: 'probe-project', name: 'probe-project', scope: 'repo' }),
      expect.objectContaining({ id: 'probe-user', name: 'probe-user', scope: 'user' }),
    ]);
    expect(result.skills.some(skill => 'content' in skill || 'body' in skill)).toBe(false);
    expect(result.problems).toEqual([]);
  });

  it('rewrites temporary probe paths back to accountHome and sessionHome, keeping external plugin paths intact', () => {
    const probeHome = '/tmp/squawk-antigravity-skills-123/home';
    const probeGeminiDir = `${probeHome}/.gemini`;
    const sessionHome = '/home/probe';
    const result = parseAntigravitySkills({
      event: 'command_result',
      command: {
        name: 'skills',
        data: {
          skills: [
            { name: 'squeal:squeal', path: `${probeGeminiDir}/config/plugins/squeal/skills/squeal/SKILL.md`, plugin: 'squeal', builtin: false },
            { name: 'personal-demo', path: `${probeHome}/personal-skills/personal-demo/SKILL.md`, builtin: false },
            { name: 'apptension-sdlc:dev-flow', path: '/ext/toolkit/plugins/apptension-sdlc/skills/dev-flow/SKILL.md', plugin: 'apptension-sdlc', builtin: false },
            { name: 'unprefixed', path: '/ext/plugins/custom/skills/unprefixed/SKILL.md', plugin: 'custom', builtin: false },
          ],
        },
      },
    }, cwd, accountHome, { home: probeHome, geminiDir: probeGeminiDir, sessionHome });
    expect(result.skills).toEqual([
      { id: 'squeal', name: 'squeal', path: `${accountHome}/config/plugins/squeal/skills/squeal/SKILL.md`, scope: 'user', plugin: 'squeal' },
      { id: 'personal-demo', name: 'personal-demo', path: `${sessionHome}/personal-skills/personal-demo/SKILL.md`, scope: 'other' },
      { id: 'dev-flow', name: 'dev-flow', path: '/ext/toolkit/plugins/apptension-sdlc/skills/dev-flow/SKILL.md', scope: 'other', plugin: 'apptension-sdlc' },
      { id: 'unprefixed', name: 'unprefixed', path: '/ext/plugins/custom/skills/unprefixed/SKILL.md', scope: 'other', plugin: 'custom' },
    ]);
  });

  it('rejects malformed lists', () => {
    expect(() => parseAntigravitySkills(null, cwd, accountHome)).toThrow();
    expect(() => parseAntigravitySkills({ event: 'result' }, cwd, accountHome)).toThrow();
  });
});

describe('antigravity skill probe staging', () => {
  it('stages read-only links and a copied config.json in a disposable HOME, then cleans it up', async () => {
    const root = await workspace();
    const repo = join(root, 'repo');
    const acct = join(root, 'account');
    await mkdir(repo, { recursive: true });
    await mkdir(join(acct, 'config', 'plugins'), { recursive: true });
    await writeFile(join(acct, 'config', 'plugins.json'), '{"entries":[]}');
    await writeFile(join(acct, 'config', 'config.json'), '{"plugins":{}}');
    let observedHome = '';
    const result = await discoverAntigravitySkills({
      cwd: repo,
      accountHome: acct,
      spawn: (_bin, args, spawnCwd, env) => {
        observedHome = env.HOME ?? '';
        expect(args).toContain('--print=/skills');
        expect(args).toContain('{"modelProvider":"gemini"}');
        expect(env.GOOGLE_GEMINI_BASE_URL).toBe('http://127.0.0.1:1');
        expect(env.GEMINI_API_KEY).toBe('squawk-skill-probe');
        const payload = JSON.stringify({
          event: 'command_result',
          command: {
            name: 'skills',
            data: {
              skills: [{ name: 'plug:demo', path: `${observedHome}/.gemini/config/plugins/plug/skills/demo/SKILL.md`, plugin: 'plug', builtin: false }],
            },
          },
        });
        const script = `
          const fs = require('node:fs');
          fs.writeFileSync(${JSON.stringify(join(root, 'seen-link'))}, fs.readlinkSync(${JSON.stringify(join(observedHome, '.gemini/config/plugins.json'))}));
          fs.writeFileSync(${JSON.stringify(join(observedHome, '.gemini/config/config.json'))}, '{"mutated":true}');
          console.log(${JSON.stringify(payload)});
        `;
        return spawnSessionLeader(process.execPath, ['-e', script], { cwd: spawnCwd, env });
      },
    });
    expect(await readFile(join(root, 'seen-link'), 'utf8')).toBe(join(acct, 'config', 'plugins.json'));
    expect(await readFile(join(acct, 'config', 'config.json'), 'utf8')).toBe('{"plugins":{}}');
    expect(result.skills).toEqual([
      { id: 'demo', name: 'demo', path: join(acct, 'config/plugins/plug/skills/demo/SKILL.md'), scope: 'user', plugin: 'plug' },
    ]);
    await expect(access(observedHome)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not create a missing accountHome during discovery and removes the disposable HOME on failure', async () => {
    const root = await workspace();
    const repo = join(root, 'repo');
    const missing = join(root, 'missing-account');
    await mkdir(repo, { recursive: true });
    let observedHome = '';
    await expect(discoverAntigravitySkills({
      cwd: repo,
      accountHome: missing,
      spawn: (_bin, _args, spawnCwd, env) => {
        observedHome = env.HOME ?? '';
        return spawnSessionLeader(process.execPath, ['-e', 'process.exit(1)'], { cwd: spawnCwd, env });
      },
    })).rejects.toThrow();
    await expect(access(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(observedHome)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves existing named-account links when accountHome exists', async () => {
    const root = await workspace();
    const repo = join(root, 'repo');
    const acct = join(root, 'named');
    await mkdir(repo, { recursive: true });
    await mkdir(join(acct, 'config'), { recursive: true });
    await writeFile(join(acct, 'config', 'plugins.json'), '{"entries":[]}');
    const mockBin = join(import.meta.dirname, '../../../scripts/mock-acp.mjs');
    const result = await discoverAntigravitySkills({ cwd: repo, accountHome: acct, bin: mockBin });
    expect(result.skills.some(skill => skill.id === 'probe-project' && skill.scope === 'repo')).toBe(true);
    expect(result.skills.some(skill => skill.id === 'code-review' && skill.plugin === 'apptension-review')).toBe(true);
    expect(await readFile(join(acct, 'config', 'plugins.json'), 'utf8')).toBe('{"entries":[]}');
    await expect(readlink(join(acct, 'config', 'plugins.json'))).rejects.toThrow();
  });

  async function withTempHome<T>(fakeHome: string, run: () => Promise<T>): Promise<T> {
    const prevHome = process.env.HOME;
    const prevGemini = process.env.GEMINI_HOME;
    process.env.HOME = fakeHome;
    delete process.env.GEMINI_HOME;
    try { return await run(); } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevGemini === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = prevGemini;
    }
  }

  it('links sessionHome entries including .config so ~/ manifest paths resolve natively and rewrites reported paths back', async () => {
    const root = await workspace();
    const repo = join(root, 'repo');
    const fakeHome = join(root, 'user-home');
    await mkdir(repo, { recursive: true });
    await mkdir(join(fakeHome, 'personal-skills', 'demo'), { recursive: true });
    await mkdir(join(fakeHome, '.config', 'agent-skills', 'cfg-demo'), { recursive: true });
    await mkdir(join(fakeHome, '.gemini', 'config'), { recursive: true });
    await writeFile(join(fakeHome, '.gemini', 'config', 'skills.json'), '{"entries":[{"path":"~/personal-skills"},{"path":"~/.config/agent-skills"}]}');
    await withTempHome(fakeHome, async () => {
      const result = await discoverAntigravitySkills({
        cwd: repo,
        spawn: (_bin, _args, spawnCwd, env) => {
          const observedHome = env.HOME ?? '';
          expect(env.XDG_CONFIG_HOME).not.toBe(join(observedHome, '.config'));
          const payload = JSON.stringify({
            event: 'command_result',
            command: {
              name: 'skills',
              data: {
                skills: [
                  { name: 'demo', path: `${observedHome}/personal-skills/demo/SKILL.md`, builtin: false },
                  { name: 'cfg-demo', path: `${observedHome}/.config/agent-skills/cfg-demo/SKILL.md`, builtin: false },
                ],
              },
            },
          });
          const script = `const fs = require('node:fs');
            fs.writeFileSync(${JSON.stringify(join(root, 'home-link'))}, fs.readlinkSync(${JSON.stringify(join(observedHome, 'personal-skills'))}));
            fs.writeFileSync(${JSON.stringify(join(root, 'cfg-link'))}, fs.readlinkSync(${JSON.stringify(join(observedHome, '.config'))}));
            console.log(${JSON.stringify(payload)});`;
          return spawnSessionLeader(process.execPath, ['-e', script], { cwd: spawnCwd, env });
        },
      });
      expect(await readFile(join(root, 'home-link'), 'utf8')).toBe(join(fakeHome, 'personal-skills'));
      expect(await readFile(join(root, 'cfg-link'), 'utf8')).toBe(join(fakeHome, '.config'));
      expect(result.skills).toEqual([
        { id: 'demo', name: 'demo', path: join(fakeHome, 'personal-skills', 'demo', 'SKILL.md'), scope: 'other' },
        { id: 'cfg-demo', name: 'cfg-demo', path: join(fakeHome, '.config', 'agent-skills', 'cfg-demo', 'SKILL.md'), scope: 'other' },
      ]);
    });
  });

  it('inherits shared default-home entries for a missing named account without creating its directory', async () => {
    const root = await workspace();
    const repo = join(root, 'repo');
    const fakeHome = join(root, 'user-home');
    const missingAccount = join(root, 'named-not-created');
    await mkdir(repo, { recursive: true });
    await mkdir(join(fakeHome, '.gemini', 'config', 'plugins'), { recursive: true });
    await writeFile(join(fakeHome, '.gemini', 'config', 'plugins.json'), '{"entries":[]}');
    await withTempHome(fakeHome, async () => {
      const result = await discoverAntigravitySkills({
        cwd: repo,
        accountHome: missingAccount,
        spawn: (_bin, _args, spawnCwd, env) => {
          const observedHome = env.HOME ?? '';
          const payload = JSON.stringify({
            event: 'command_result',
            command: { name: 'skills', data: { skills: [{ name: 'shared:tool', path: `${observedHome}/.gemini/config/plugins/shared/skills/tool/SKILL.md`, plugin: 'shared', builtin: false }] } },
          });
          const script = `const fs = require('node:fs');
            fs.writeFileSync(${JSON.stringify(join(root, 'shared-link'))}, fs.readlinkSync(${JSON.stringify(join(observedHome, '.gemini/config/plugins.json'))}));
            console.log(${JSON.stringify(payload)});`;
          return spawnSessionLeader(process.execPath, ['-e', script], { cwd: spawnCwd, env });
        },
      });
      expect(await readFile(join(root, 'shared-link'), 'utf8')).toBe(join(fakeHome, '.gemini', 'config', 'plugins.json'));
      await expect(access(missingAccount)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(result.skills).toEqual([
        { id: 'tool', name: 'tool', path: join(missingAccount, 'config/plugins/shared/skills/tool/SKILL.md'), scope: 'user', plugin: 'shared' },
      ]);
    });
  });
});
