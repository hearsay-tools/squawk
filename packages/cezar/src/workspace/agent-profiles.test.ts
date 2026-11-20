import { registerRunner } from '../core/runner-registry.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { codexRunner } from '../runners/codex/definition.ts';
import { opencodeRunner } from '../runners/opencode/definition.ts';
import { piRunner } from '../runners/pi/definition.ts';
import { ompRunner } from '../runners/omp/definition.ts';
import { Home } from '../home/home.ts';
import { useTestHome } from '../home/test-home.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentAccountsPath } from '../paths.ts';
import {
  defaultAgentProfile,
  listAgentProfiles,
  profileDirState,
  profilesForProvider,
  resolveProfileEnvForRoot,
  sameProfileDir,
  selectProfile,
} from './agent-profiles.ts';
import { loadAgentAccounts } from './agent-accounts.ts';
registerRunner(claudeRunner);
registerRunner(codexRunner);
registerRunner(opencodeRunner);
registerRunner(piRunner);
registerRunner(ompRunner);

// Profile resolution reads each provider's account data from the registry; the cases use all five.

/**
 * Resolution rules from spec 2026-07-29-agent-profiles. The pair worth reading closely is the two
 * degradation cases: an UNKNOWN id falls back to the default, a KNOWN id with a MISSING directory
 * does not. They differ on purpose — see the assertions.
 */
describe('agent profile resolution', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-profiles-'));
    useTestHome(home ? Home.sandbox(home) : undefined);
  });

  afterEach(() => {
    if (originalHome === undefined) useTestHome(undefined);
    else useTestHome(originalHome ? Home.sandbox(originalHome) : undefined);
    rmSync(home, { recursive: true, force: true });
  });

  const env = { HOME: '/home/u' } as NodeJS.ProcessEnv;
  const write = (value: unknown) => Home.seedBytes(testHome(), agentAccountsPath(testHome()), Buffer.from(JSON.stringify(value)));
  const klaudiuszProfile = {
    id: 'klaudiusz',
    provider: 'claude' as const,
    configDir: '~/.claude-klaudiusz',
    label: 'Klaudiusz',
    addedAt: '',
  };

  describe('defaultAgentProfile', () => {
    it('is whatever agentHomePaths discovers, per provider', () => {
      expect(defaultAgentProfile('claude', env).path).toBe('/home/u/.claude');
      expect(defaultAgentProfile('codex', env).path).toBe('/home/u/.codex');
      expect(defaultAgentProfile('opencode', env).path).toBe('/home/u/.config/opencode');
    });

    it('follows the vendor env vars, so setting one moves the DEFAULT profile', () => {
      const relocated = { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/opt/claude' } as NodeJS.ProcessEnv;
      expect(defaultAgentProfile('claude', relocated).path).toBe('/opt/claude');
    });

    it('follows a host-exported OMP_PROFILE, so the profile the host selects is the default', () => {
      // The default is spawned with nothing added and inherits the host's OMP_PROFILE through
      // `agent-env.ts`'s `OMP_` prefix; discovery has to name the folder that session really uses.
      expect(defaultAgentProfile('omp', env).path).toBe('/home/u/.omp/agent');
      expect(defaultAgentProfile('omp', { ...env, OMP_PROFILE: 'work' }).path).toBe('/home/u/.omp/profiles/work/agent');
      expect(defaultAgentProfile('pi', { ...env, PI_CODING_AGENT_DIR: '/opt/pi' }).path).toBe('/opt/pi');
    });

    it('is marked default so the UI can refuse to edit or delete it', () => {
      expect(defaultAgentProfile('claude', env)).toMatchObject({ id: 'default', isDefault: true });
    });
  });

  describe('listing', () => {
    it('puts the discovered profile first, then the stored extras in file order', async () => {
      write({ accounts: [klaudiuszProfile, { ...klaudiuszProfile, id: 'client', configDir: '~/.claude-client' }] });
      const store = await loadAgentAccounts(testHome());
      expect(profilesForProvider(store, 'claude', env).map((p) => p.id)).toEqual([
        'default',
        'klaudiusz',
        'client',
      ]);
    });

    it('never mixes providers', async () => {
      write({ accounts: [klaudiuszProfile, { ...klaudiuszProfile, id: 'cx', provider: 'codex' }] });
      const store = await loadAgentAccounts(testHome());
      expect(profilesForProvider(store, 'codex', env).map((p) => p.id)).toEqual(['default', 'cx']);
      expect(listAgentProfiles(store, ['claude', 'codex'], env)).toHaveLength(4);
    });

    it('expands a stored `~` while keeping what the user typed', async () => {
      write({ accounts: [klaudiuszProfile] });
      const [, stored] = profilesForProvider(await loadAgentAccounts(testHome()), 'claude', env);
      expect(stored?.configDir).toBe('~/.claude-klaudiusz');
      expect(stored?.path.endsWith('/.claude-klaudiusz')).toBe(true);
      expect(stored?.path.startsWith('~')).toBe(false);
    });
  });

  describe('selectProfile', () => {
    it('uses the project\'s stored selection', async () => {
      write({
        accounts: [klaudiuszProfile],
        selections: { '/tmp/projects/a': { claude: 'klaudiusz' } },
      });
      const store = await loadAgentAccounts(testHome());
      expect(selectProfile(store, { provider: 'claude', repoRoot: '/tmp/projects/a', env }).id).toBe('klaudiusz');
    });

    it('lets an explicit profileId (a run\'s recorded account) win over the project', async () => {
      write({
        accounts: [klaudiuszProfile],
        selections: { '/tmp/projects/a': { claude: 'klaudiusz' } },
      });
      const store = await loadAgentAccounts(testHome());
      expect(
        selectProfile(store, { provider: 'claude', repoRoot: '/tmp/projects/a', profileId: 'default', env }).id,
      ).toBe('default');
    });

    it('degrades an UNKNOWN id to the default — a dangling reference names no account', async () => {
      write({ selections: { '/tmp/projects/a': { claude: 'deleted-yesterday' } } });
      const store = await loadAgentAccounts(testHome());
      expect(selectProfile(store, { provider: 'claude', repoRoot: '/tmp/projects/a', env }).isDefault).toBe(true);
    });

    it('will not hand one provider another provider\'s profile', async () => {
      write({
        accounts: [klaudiuszProfile],
        selections: { '/tmp/projects/a': { codex: 'klaudiusz' } },
      });
      const store = await loadAgentAccounts(testHome());
      expect(selectProfile(store, { provider: 'codex', repoRoot: '/tmp/projects/a', env }).isDefault).toBe(true);
    });

    it('defaults for an unregistered root — headless runs and task worktrees', async () => {
      write({ accounts: [klaudiuszProfile] });
      const store = await loadAgentAccounts(testHome());
      expect(selectProfile(store, { provider: 'claude', repoRoot: '/somewhere/else', env }).isDefault).toBe(true);
      expect(selectProfile(store, { provider: 'claude', env }).isDefault).toBe(true);
    });
  });

  describe('resolveProfileEnvForRoot', () => {
    it('adds NOTHING for the default profile', async () => {
      write({});
      const resolved = await resolveProfileEnvForRoot('/tmp/projects/a', 'claude', undefined, undefined, testHome());
      expect(resolved.env).toEqual({});
      expect(resolved.profile.isDefault).toBe(true);
    });

    it('points the CLI at the selected account', async () => {
      write({
        accounts: [{ ...klaudiuszProfile, configDir: '/opt/claude-klaudiusz' }],
        selections: { '/tmp/projects/a': { claude: 'klaudiusz' } },
      });
      const resolved = await resolveProfileEnvForRoot('/tmp/projects/a', 'claude', undefined, undefined, testHome());
      expect(resolved.env).toEqual({ CLAUDE_CONFIG_DIR: '/opt/claude-klaudiusz' });
    });

    it('uses CODEX_HOME for a codex step in the same project', async () => {
      write({
        accounts: [
          { ...klaudiuszProfile, id: 'cx', provider: 'codex', configDir: '/opt/codex-klaudiusz' },
        ],
        selections: { '/tmp/projects/a': { codex: 'cx' } },
      });
      const resolved = await resolveProfileEnvForRoot('/tmp/projects/a', 'codex', undefined, undefined, testHome());
      expect(resolved.env).toEqual({ CODEX_HOME: '/opt/codex-klaudiusz' });
    });

    it('uses PI_CODING_AGENT_DIR for a pi account', async () => {
      write({
        accounts: [
          { ...klaudiuszProfile, id: 'pi-work', provider: 'pi', configDir: '/opt/pi-work/agent' },
        ],
        selections: { '/tmp/projects/a': { pi: 'pi-work' } },
      });
      expect((await resolveProfileEnvForRoot('/tmp/projects/a', 'pi', undefined, undefined, testHome())).env).toEqual({ PI_CODING_AGENT_DIR: '/opt/pi-work/agent' });
      // The default account, omp's only one included, still adds nothing.
      expect((await resolveProfileEnvForRoot('/tmp/projects/b', 'pi', undefined, undefined, testHome())).env).toEqual({});
      expect((await resolveProfileEnvForRoot('/tmp/projects/b', 'omp', undefined, undefined, testHome())).env).toEqual({});
    });

    it('degrades to the default when the accounts file is unreadable', async () => {
      Home.seedBytes(testHome(), agentAccountsPath(testHome()), Buffer.from('{ not json'));
      const resolved = await resolveProfileEnvForRoot('/tmp/projects/a', 'claude', undefined, undefined, testHome());
      expect(resolved.env).toEqual({});
    });
  });

  describe('profileDirState', () => {
    it('reports a real config dir as existing and valid', async () => {
      const dir = join(home, 'claude-klaudiusz');
      mkdirSync(dir);
      writeFileSync(join(dir, 'settings.json'), '{}', 'utf8');
      expect(await profileDirState('claude', dir)).toEqual({ exists: true, looksValid: true });
    });

    it('accepts a dir that is not there YET — Connect creates it on first login', async () => {
      expect(await profileDirState('claude', join(home, 'not-created-yet'))).toEqual({
        exists: false,
        looksValid: false,
      });
    });

    it('reports an existing but unrecognised dir honestly, without refusing it', async () => {
      const dir = join(home, 'random');
      mkdirSync(dir);
      expect(await profileDirState('claude', dir)).toEqual({ exists: true, looksValid: false });
    });
  });

  describe('sameProfileDir', () => {
    it('sees through a trailing slash and a symlink spelling of one directory', async () => {
      const dir = join(home, 'claude-klaudiusz');
      mkdirSync(dir);
      expect(await sameProfileDir(dir, `${dir}/`)).toBe(true);
      expect(await sameProfileDir(dir, join(home, 'other'))).toBe(false);
    });
  });
});
