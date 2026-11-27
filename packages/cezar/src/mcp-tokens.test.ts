// real-clock: static ISO timestamps in home-recovery request fixtures are not compared to the wall clock
import './cli-boot.testkit.ts';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareOperatorHome } from './home/entry.ts';
import { Home } from './home/home.ts';
import { resolveHome } from './home/resolve.ts'; // test-home-read: fresh home test requires an unresolved scratch path with no marker.
import { useTestHome } from './home/test-home.testkit.ts';
import {
  clearMcpTokensForPort,
  createMcpToken,
  hasConfiguredMcpTokens,
  listMcpTokens,
  MCP_TOKEN_PREFIX,
  mcpTokenFile,
  McpTokenRevokeError,
  revokeMcpToken,
  verifyMcpBearerToken,
} from './mcp-tokens.ts';
import { createHomeRecoveryRoutes } from './server/home-recovery-routes.ts';

describe('per-port hashed MCP bearer token store (hearsay-tools/squawk#4402)', () => {
  let root: string;
  let home: Home;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hsq-mcp-tokens-'));
    home = Home.sandbox(root);
    useTestHome(home);
  });

  afterEach(() => {
    useTestHome(undefined);
    rmSync(root, { recursive: true, force: true });
  });

  it('stores only SHA-256 hashes with mode 0600 and verifies per port', () => {
    expect(hasConfiguredMcpTokens({}, 4321, home)).toBe(false);

    const created = createMcpToken({ port: 4321, name: 'fleet-a', home });
    expect(created.token.startsWith(MCP_TOKEN_PREFIX)).toBe(true);
    expect(created.token.length).toBeGreaterThanOrEqual(MCP_TOKEN_PREFIX.length + 40);
    expect(created.port).toBe(4321);
    expect(created.name).toBe('fleet-a');

    const rawFile = readFileSync(mcpTokenFile(4321, home), 'utf8');
    expect(rawFile).not.toContain(created.token);
    const parsed = JSON.parse(rawFile) as { tokens: Array<{ id: string; name: string; sha256: string }> };
    expect(parsed.tokens).toHaveLength(1);
    expect(parsed.tokens[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);

    if (process.platform !== 'win32') {
      const mode = statSync(mcpTokenFile(4321, home)).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    expect(hasConfiguredMcpTokens({}, 4321, home)).toBe(true);
    expect(hasConfiguredMcpTokens({}, 4322, home)).toBe(false);
    expect(verifyMcpBearerToken(created.token, {}, 4321, home)).toEqual({
      source: 'file',
      id: created.id,
      name: 'fleet-a',
    });
    expect(verifyMcpBearerToken(created.token, {}, 4322, home)).toBeNull();
    expect(verifyMcpBearerToken(`${created.token}x`, {}, 4321, home)).toBeNull();
  });

  it('supports project-scoped tokens and live revocation without restart', () => {
    const scoped = createMcpToken({ port: 4321, name: 'ci', project: 'proj-alpha', home });
    const other = createMcpToken({ port: 4321, name: 'ops', home });

    expect(verifyMcpBearerToken(scoped.token, {}, 4321, home)).toEqual({
      source: 'file',
      id: scoped.id,
      name: 'ci',
      project: 'proj-alpha',
    });

    const listed = listMcpTokens(home, 4321);
    expect(listed.tokens).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain(scoped.token);
    expect(JSON.stringify(listed)).not.toContain('sha256');

    revokeMcpToken({ home, id: scoped.id });
    expect(verifyMcpBearerToken(scoped.token, {}, 4321, home)).toBeNull();
    expect(verifyMcpBearerToken(other.token, {}, 4321, home)).toEqual({
      source: 'file',
      id: other.id,
      name: 'ops',
    });

    revokeMcpToken({ home, id: other.id, port: 4321 });
    expect(hasConfiguredMcpTokens({}, 4321, home)).toBe(false);
  });

  it('verifies HSQ_MCP_TOKEN env var alongside per-port files and fails closed on corrupt files', () => {
    const env = { HSQ_MCP_TOKEN: 'env-static-bearer-token-0123456789' };
    expect(hasConfiguredMcpTokens(env, 4321, home)).toBe(true);
    expect(verifyMcpBearerToken(env.HSQ_MCP_TOKEN, env, 4321, home)).toEqual({ source: 'env' });
    expect(verifyMcpBearerToken('wrong-token', env, 4321, home)).toBeNull();

    mkdirSync(home.mcpTokens, { recursive: true });
    writeFileSync(mcpTokenFile(4325, home), '{ not valid json', 'utf8');
    expect(hasConfiguredMcpTokens({}, 4325, home)).toBe(false);
    expect(verifyMcpBearerToken('anything', {}, 4325, home)).toBeNull();
    expect(listMcpTokens(home, 4325).issue).toContain('not a valid MCP token store');
    expect(() => createMcpToken({ port: 4325, home })).toThrow(/corrupt MCP token store/);
  });

  it('clears a single port file without touching other ports and reports unknown token revoke errors', () => {
    const a = createMcpToken({ port: 4321, name: 'a', home });
    const b = createMcpToken({ port: 4322, name: 'b', home });
    expect(clearMcpTokensForPort(4321, home)).toBe(true);
    expect(clearMcpTokensForPort(4321, home)).toBe(false);
    expect(verifyMcpBearerToken(a.token, {}, 4321, home)).toBeNull();
    expect(verifyMcpBearerToken(b.token, {}, 4322, home)).toMatchObject({ id: b.id });

    expect(() => revokeMcpToken({ home, id: 'missing-id' })).toThrow(McpTokenRevokeError);
    expect(() => createMcpToken({ port: 4321, project: '', home })).toThrow(/must not be empty/);
    expect(() => createMcpToken({ port: 4321, project: '   ', home })).toThrow(/must not be empty/);
    expect(() => createMcpToken({ port: 4321, project: 'all', home })).toThrow(/cannot be "all"/);
  });

  it('refuses HTTP home-recovery mutations on mcp-tokens files even locally', async () => {
    const app = createHomeRecoveryRoutes({ home, localHandoff: () => true });
    for (const action of ['restore', 'import', 'accept']) {
      const res = await app.request(`/home/recovery/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'mcp-tokens/4321.json', detectedAt: '2026-11-27T00:00:00.000Z' }),
      });
      expect(res.status, action).toBe(403);
      expect(await res.json()).toEqual({ error: 'MCP bearer tokens require the host CLI.' });
    }
  });

  it('creates an MCP token on an authorized fresh home before install.json exists', () => {
    const freshRoot = mkdtempSync(join(tmpdir(), 'hsq-mcp-fresh-'));
    try {
      const env = { HSQ_HOME: freshRoot };
      const freshHome = resolveHome({ purpose: 'cli', env, layout: 'split' }); // test-home-read: scratch path without a sandbox marker.
      prepareOperatorHome(freshHome, 'mcp', env);
      expect(existsSync(join(freshHome.config, 'install.json'))).toBe(false);
      const created = createMcpToken({ port: 4321, name: 'first', home: freshHome });
      expect(existsSync(join(freshHome.config, 'install.json'))).toBe(true);
      expect(verifyMcpBearerToken(created.token, {}, 4321, freshHome)).toMatchObject({
        source: 'file',
        id: created.id,
        name: 'first',
      });
    } finally {
      rmSync(freshRoot, { recursive: true, force: true });
    }
  });
});
