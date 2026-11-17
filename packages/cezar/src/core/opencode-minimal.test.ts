import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { driveSeam } from './harness-parity.testkit.ts';
import { OPENCODE_MINIMAL_ENV, OPENCODE_MINIMAL_PROMPT_TOOLS, OPENCODE_MINIMAL_SESSION_PERMISSION, opencodeMinimalEnv } from './opencode-minimal.ts';

const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function recordedWire(minimal: boolean): Promise<Array<Record<string, unknown>>> {
  const dir = mkdtempSync(join(tmpdir(), 'cez-opencode-minimal-')); directories.push(dir);
  const record = join(dir, 'wire.ndjson');
  await driveSeam('opencode', 'baseline', {
    spec: { minimal, env: { CEZ_MOCK_ARGS_FILE: record } },
    sessionOptions: { autoEndAfterFirstTurn: true },
    whileOpen: async session => { await session.result; },
  });
  return readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('OpenCode minimal session on the wire', () => {
  // OpenCode 1.19.4 appends an agent's own permission rules after the global ones, so a
  // configured agent allow would beat the runtime config; the prompt's session rule comes last.
  it('denies every tool through the prompt and the runtime config', async () => {
    const wire = await recordedWire(true);
    const prompts = wire.filter(entry => String(entry.url).endsWith('/prompt_async'));
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) expect((prompt.body as Record<string, unknown>).tools).toEqual(OPENCODE_MINIMAL_PROMPT_TOOLS);
    expect(wire.find(entry => entry.type === 'runtime-config')?.config).toMatchObject({ tools: { '*': false }, permission: { '*': 'deny' } });
  });

  // A skill turn goes through /command, which takes no tools map: the rule must be on the session.
  it('creates the session with the deny rule', async () => {
    const created = (await recordedWire(true)).find(entry => entry.method === 'POST' && entry.url === '/session');
    expect(created?.body).toMatchObject({ permission: OPENCODE_MINIMAL_SESSION_PERMISSION });
  });

  it('sends no tools map and no session rule without the field', async () => {
    const wire = await recordedWire(false);
    const prompts = wire.filter(entry => String(entry.url).endsWith('/prompt_async'));
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) expect(prompt.body).not.toHaveProperty('tools');
    expect(wire.find(entry => entry.method === 'POST' && entry.url === '/session')?.body).not.toHaveProperty('permission');
  });
});

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
