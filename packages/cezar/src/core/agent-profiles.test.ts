import '../core/register-all-runners.testkit.ts';
import { registeredRunners } from './runner-registry.ts';

const PROVIDER_IDS = registeredRunners().map(({ id }) => id);
import { describe, expect, it } from 'vitest';
import {
  looksLikeProfileDir,
  profileCapableProviders,
  profileEnv,
  profileEnvVar,
  supportsProfiles,
} from './agent-profiles.ts';

// The account mappings are read from the registry; this file pins all five built-ins.

describe('profileEnvVar', () => {
  it('names one variable per provider that can carry an account', () => {
    expect(profileEnvVar('claude')).toBe('CLAUDE_CONFIG_DIR');
    expect(profileEnvVar('codex')).toBe('CODEX_HOME');
    expect(profileEnvVar('pi')).toBe('PI_CODING_AGENT_DIR');
  });

  it('leaves OpenCode and omp unsupported — no folder variable moves their login', () => {
    expect(profileEnvVar('opencode')).toBeNull();
    expect(profileEnvVar('omp')).toBeNull();
    expect(supportsProfiles('opencode')).toBe(false);
    expect(supportsProfiles('omp')).toBe(false);
    expect(profileCapableProviders()).toEqual(['claude', 'codex', 'pi', 'antigravity']);
  });

  it('answers for every provider, so adding one forces a decision here', () => {
    expect([...PROVIDER_IDS].sort()).toEqual([
      ...profileCapableProviders(),
      ...PROVIDER_IDS.filter((provider) => profileEnvVar(provider) === null),
    ].sort());
  });
});

describe('profileEnv', () => {
  it('points the agent at its profile dir', () => {
    expect(profileEnv('claude', '/home/u/.claude-klaudiusz')).toEqual({
      CLAUDE_CONFIG_DIR: '/home/u/.claude-klaudiusz',
    });
    expect(profileEnv('codex', '/home/u/.codex-klaudiusz')).toEqual({ CODEX_HOME: '/home/u/.codex-klaudiusz' });
    expect(profileEnv('pi', '/home/u/.pi-work/agent')).toEqual({ PI_CODING_AGENT_DIR: '/home/u/.pi-work/agent' });
  });

  it('adds NOTHING for the default profile — the zero-config path must stay untouched', () => {
    expect(profileEnv('claude', null)).toEqual({});
    expect(profileEnv('claude', undefined)).toEqual({});
    expect(profileEnv('claude', '   ')).toEqual({});
  });

  it('adds nothing for a provider with no home variable, even given a dir', () => {
    expect(profileEnv('opencode', '/home/u/.config/opencode-work')).toEqual({});
    expect(profileEnv('omp', '/home/u/.omp/profiles/work')).toEqual({});
  });

  it('can never emit another provider\'s variable', () => {
    // `buildChildEnv` applies extraEnv AFTER its allowlist, so this function is the only thing
    // standing between a profile and the child env. A codex step must not be handed
    // CLAUDE_CONFIG_DIR, which would point claude's sibling tooling at the wrong home.
    for (const provider of PROVIDER_IDS) {
      const emitted = Object.keys(profileEnv(provider, '/somewhere'));
      const foreign = PROVIDER_IDS.filter((other) => other !== provider).flatMap(
        (other) => (profileEnvVar(other) === null ? [] : [profileEnvVar(other) as string]),
      );
      expect(emitted.some((name) => foreign.includes(name))).toBe(false);
    }
  });
});

describe('looksLikeProfileDir', () => {
  it('recognises a real Claude config dir by any one marker', () => {
    expect(looksLikeProfileDir('claude', ['.claude.json', 'projects', 'sessions'])).toBe(true);
    expect(looksLikeProfileDir('claude', ['settings.json'])).toBe(true);
  });

  it('recognises a Codex home', () => {
    expect(looksLikeProfileDir('codex', ['auth.json', 'history.jsonl'])).toBe(true);
    expect(looksLikeProfileDir('codex', ['config.toml'])).toBe(true);
  });

  it('recognises a pi agent dir', () => {
    expect(looksLikeProfileDir('pi', ['auth.json', 'sessions'])).toBe(true);
    expect(looksLikeProfileDir('pi', ['settings.json'])).toBe(true);
  });

  it('recognises the discovered omp agent dir, not a profile folder', () => {
    expect(looksLikeProfileDir('omp', ['agent.db', 'config.yml', 'sessions'])).toBe(true);
    expect(looksLikeProfileDir('omp', ['agent', 'logs', 'run', 'cache'])).toBe(false);
  });

  it('says no for an unrelated directory — advisory, so the caller still accepts it', () => {
    expect(looksLikeProfileDir('claude', ['README.md'])).toBe(false);
    expect(looksLikeProfileDir('claude', [])).toBe(false);
  });
});
