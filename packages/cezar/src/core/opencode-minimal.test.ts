import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPENCODE_MINIMAL_ENV, opencodeMinimalEnv } from './opencode-minimal.ts';

afterEach(() => { vi.unstubAllEnvs(); });

describe('opencodeMinimalEnv', () => {
  it('returns the env unchanged when the session is not minimal', () => {
    const env = { A: '1' };
    expect(opencodeMinimalEnv(env, false)).toBe(env);
    expect(opencodeMinimalEnv(undefined, undefined)).toBeUndefined();
  });

  it('adds the disable switches and a runtime config that turns every tool off', () => {
    vi.stubEnv('OPENCODE_CONFIG_CONTENT', '');
    const env = opencodeMinimalEnv({ A: '1' }, true)!;
    expect(env).toMatchObject({ A: '1', ...OPENCODE_MINIMAL_ENV });
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({ tools: { '*': false }, permission: { '*': 'deny' } });
  });

  it('keeps the other supplied runtime entries and replaces supplied tools and permissions', () => {
    const supplied = { mcp: { squawk: { type: 'local' } }, plugin: ['p'], tools: { read: true }, permission: { bash: 'allow' } };
    const env = opencodeMinimalEnv({ OPENCODE_CONFIG_CONTENT: JSON.stringify(supplied) }, true)!;
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      mcp: { squawk: { type: 'local' } }, plugin: ['p'], tools: { '*': false }, permission: { '*': 'deny' },
    });
  });

  it('refuses a supplied runtime config it cannot read', () => {
    expect(() => opencodeMinimalEnv({ OPENCODE_CONFIG_CONTENT: '[1]' }, true)).toThrow('Minimal session unavailable');
  });
});
