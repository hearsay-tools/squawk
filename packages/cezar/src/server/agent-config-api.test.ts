// These tests pin the five built-in runners' config files, so they register only those five.
import { registerRunner } from '../core/runner-registry.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { codexRunner } from '../runners/codex/definition.ts';
import { opencodeRunner } from '../runners/opencode/definition.ts';
import { piRunner } from '../runners/pi/definition.ts';
import { ompRunner } from '../runners/omp/definition.ts';
import { productIdentity } from '../home/identity.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { disableRemoteSettings, enableRemoteSettings } from '../remote-settings.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';
for (const runner of [claudeRunner, codexRunner, opencodeRunner, piRunner, ompRunner]) registerRunner(runner);


/**
 * `GET/PUT /api/v1/agent-config` (spec #404). The contract under test: files are
 * addressed by catalog id (unknown → 404); reads work in every mode; and the
 * load-bearing security property — EVERY write 409s in hosted mode
 * (`CEZ_REMOTE`), including a repo-LOCAL file whose hooks would otherwise be a
 * remote code-execution primitive.
 */
describe('the agent-config API', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  const prevRemote = process.env.CEZ_REMOTE;

  beforeEach(() => {
    delete process.env.CEZ_REMOTE;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-agentcfg-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ home: testHome(),
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
      squawkPort: () => 4321,
    });
  });
  afterEach(() => {
    store.persistence.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (prevRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = prevRemote;
  });

  const put = (id: string, body: unknown) =>
    apiRequest(app, `/api/v1/agent-config/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('GET lists the catalog with editable:true locally', async () => {
    const res = await apiRequest(app, '/api/v1/agent-config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      editable: boolean;
      files: unknown[];
      userMcp: unknown;
    };
    expect(body.editable).toBe(true);
    expect(body.files.length).toBeGreaterThan(10);
    expect(body.userMcp).not.toBeNull();
  });

  // hearsay-tools/squawk#3900: the listing that the runner definitions build, pinned for the five
  // built-ins with each agent home at its default and under the overrides that move it. Rows read
  // `id runners path`, with `<repo>` and `<home>` for the two roots; the digest covers the whole body.
  const listing = async (overrides: Record<string, string>) => {
    const home = process.env.HOME!;
    for (const [key, value] of Object.entries(overrides)) process.env[key] = value.replace('<home>', home);
    const text = JSON.stringify(await (await apiRequest(app, '/api/v1/agent-config')).json())
      .replaceAll(repoRoot, '<repo>').replaceAll(home, '<home>');
    const files = (JSON.parse(text) as { files: { id: string; runners: string[]; path: string }[] }).files;
    return { rows: files.map((f) => `${f.id} ${f.runners.join(',')} ${f.path}`), digest: createHash('sha256').update(text).digest('hex') };
  };

  it('GET lists the same files, readers and paths with every agent home at its default', async () => {
    expect(await listing({})).toEqual({
      digest: '5abcf0ab80b7ab51b579241ae15940815901e0ea4be8a395d47b2429dfefa6af',
      rows: [
        'claude.user.settings claude <home>/.claude/settings.json',
        'claude.project.settings claude <repo>/.claude/settings.json',
        'claude.local.settings claude <repo>/.claude/settings.local.json',
        'claude.project.mcp claude <repo>/.mcp.json',
        'claude.user.memory claude <home>/.claude/CLAUDE.md',
        'claude.project.memory claude <repo>/CLAUDE.md',
        'claude.local.memory claude <repo>/CLAUDE.local.md',
        'codex.user.config codex <home>/.codex/config.toml',
        'codex.project.config codex <repo>/.codex/config.toml',
        'codex.user.memory codex <home>/.codex/AGENTS.md',
        'opencode.user.config opencode <home>/.config/opencode/opencode.json',
        'opencode.project.config opencode <repo>/opencode.json',
        'opencode.user.memory opencode <home>/.config/opencode/AGENTS.md',
        'pi.user.settings pi <home>/.pi/agent/settings.json',
        'pi.project.settings pi <repo>/.pi/settings.json',
        'pi.user.memory pi <home>/.pi/agent/AGENTS.md',
        'omp.user.settings omp <home>/.omp/agent/config.yml',
        'omp.project.settings omp <repo>/.omp/config.yml',
        'omp.user.mcp omp <home>/.omp/agent/mcp.json',
        'omp.project.mcp omp <repo>/.omp/mcp.json',
        'omp.user.memory omp <home>/.omp/agent/AGENTS.md',
        'project.agents codex,opencode,pi,omp <repo>/AGENTS.md',
      ],
    });
  });

  it.each([
    ['CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_CONFIG_HOME and PI_CODING_AGENT_DIR', {
      CLAUDE_CONFIG_DIR: '<home>/o/claude', CODEX_HOME: '<home>/o/codex', XDG_CONFIG_HOME: '<home>/o/xdg', PI_CODING_AGENT_DIR: '<home>/o/pi',
    }, { digest: 'b048dd699596bfecc4f9eecb02ee4f4722d41b3af50955e7f82574e71d4a2d01', rows: [
      'claude.user.settings claude <home>/o/claude/settings.json',
      'claude.user.memory claude <home>/o/claude/CLAUDE.md',
      'codex.user.config codex <home>/o/codex/config.toml',
      'codex.user.memory codex <home>/o/codex/AGENTS.md',
      'opencode.user.config opencode <home>/o/xdg/opencode/opencode.json',
      'opencode.user.memory opencode <home>/o/xdg/opencode/AGENTS.md',
      'pi.user.settings pi <home>/o/pi/settings.json',
      'pi.user.memory pi <home>/o/pi/AGENTS.md',
      'omp.user.settings omp <home>/o/pi/config.yml',
      'omp.user.mcp omp <home>/o/pi/mcp.json',
      'omp.user.memory omp <home>/o/pi/AGENTS.md',
    ] }],
    ['PI_CONFIG_DIR and OMP_PROFILE', { PI_CONFIG_DIR: '.omp-alt', OMP_PROFILE: 'work' }, { digest: '9ee9cfba873c9ed4546ddb0aec79afa245f35865aa9efba3c0fc1132d94b937f', rows: [
      'claude.user.settings claude <home>/.claude/settings.json',
      'claude.user.memory claude <home>/.claude/CLAUDE.md',
      'codex.user.config codex <home>/.codex/config.toml',
      'codex.user.memory codex <home>/.codex/AGENTS.md',
      'opencode.user.config opencode <home>/.config/opencode/opencode.json',
      'opencode.user.memory opencode <home>/.config/opencode/AGENTS.md',
      'pi.user.settings pi <home>/.pi/agent/settings.json',
      'pi.user.memory pi <home>/.pi/agent/AGENTS.md',
      'omp.user.settings omp <home>/.omp-alt/profiles/work/agent/config.yml',
      'omp.user.mcp omp <home>/.omp-alt/profiles/work/agent/mcp.json',
      'omp.user.memory omp <home>/.omp-alt/profiles/work/agent/AGENTS.md',
    ] }],
  ])('GET resolves the agent homes that %s move', async (_name, overrides, expected) => {
    const { rows, digest } = await listing(overrides);
    expect({ rows: rows.filter((row) => row.includes('<home>')), digest }).toEqual(expected);
  });

  it('GET :id → 404 for an unknown id', async () => {
    expect((await apiRequest(app, '/api/v1/agent-config/nope')).status).toBe(404);
  });

  it('GET :id reads an absent file as exists:false', async () => {
    const res = await apiRequest(app, '/api/v1/agent-config/claude.project.settings');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ exists: false, version: null });
  });

  it('PUT creates a file, then a correct-version PUT updates it', async () => {
    const created = await put('claude.project.settings', {
      content: '{"a":1}',
      version: null,
    });
    expect(created.status).toBe(200);
    const { version } = (await created.json()) as { version: string };
    expect(readFileSync(join(repoRoot, '.claude', 'settings.json'), 'utf8')).toBe('{"a":1}');
    const updated = await put('claude.project.settings', {
      content: '{"a":2}',
      version,
    });
    expect(updated.status).toBe(200);
  });

  it('PUT rejects invalid JSON with 400', async () => {
    expect((await put('claude.project.settings', { content: '{bad', version: null })).status).toBe(400);
  });

  it('PUT rejects a stale version with 409', async () => {
    await put('claude.project.settings', { content: '{"a":1}', version: null });
    expect(
      (
        await put('claude.project.settings', {
          content: '{"a":2}',
          version: null,
        })
      ).status,
    ).toBe(409);
  });

  it('PUT :id → 404 for an unknown id', async () => {
    expect((await put('nope', { content: 'x', version: null })).status).toBe(404);
  });

  // The regression test for the hooks RCE hole: a repo-LOCAL file must 409 in
  // hosted mode, not just a user-scope one. settings.json defines hooks.
  it('hosted mode: EVERY write 409s — including a repo-local settings file', async () => {
    process.env.CEZ_REMOTE = '1';
    const local = await put('claude.project.settings', {
      content: '{"hooks":{}}',
      version: null,
    });
    expect(local.status).toBe(409);
    const userScope = await put('claude.user.settings', {
      content: '{}',
      version: null,
    });
    expect(userScope.status).toBe(409);
    // the Pi ids added with #322 sit behind the same gate — a repo-local one AND a home one
    expect((await put('pi.project.settings', { content: '{}', version: null })).status).toBe(409);
    expect((await put('pi.user.settings', { content: '{}', version: null })).status).toBe(409);
  });

  it('hosted mode: repo-file reads work, home-dir file reads are withheld, userMcp is null', async () => {
    process.env.CEZ_REMOTE = '1';
    const res = await apiRequest(app, '/api/v1/agent-config');
    const body = (await res.json()) as {
      editable: boolean;
      userMcp: unknown;
      files: { writable: boolean }[];
    };
    expect(body.editable).toBe(false);
    expect(body.userMcp).toBeNull();
    expect(body.files.every((f) => f.writable === false)).toBe(true);
    // a repo-local file read still works (the cockpit already serves repo contents)
    expect((await apiRequest(app, '/api/v1/agent-config/claude.project.settings')).status).toBe(200);
    // but an OUTSIDE-REPO ($HOME) file's contents are NOT served — they can hold secrets
    expect((await apiRequest(app, '/api/v1/agent-config/claude.user.settings')).status).toBe(409);
    expect((await apiRequest(app, '/api/v1/agent-config/codex.user.config')).status).toBe(409);
    expect((await apiRequest(app, '/api/v1/agent-config/pi.user.settings')).status).toBe(409);
  });

  // hearsay-tools/cezarion#2428: the host switch grants the remote cockpit settings administration.
  describe('remote settings administration', () => {
    afterEach(async () => {
      await disableRemoteSettings(undefined, undefined, testHome());
    });

    it('enabled on the host: the listing is editable, home files are served and writes land', async () => {
      process.env.CEZ_REMOTE = '1';
      await enableRemoteSettings(4321, undefined, undefined, testHome());
      const body = (await (await apiRequest(app, '/api/v1/agent-config')).json()) as { editable: boolean; userMcp: unknown };
      expect(body.editable).toBe(true);
      expect(body.userMcp).not.toBeNull();
      expect((await apiRequest(app, '/api/v1/agent-config/claude.user.settings')).status).toBe(200);
      const saved = await put('claude.project.settings', { content: '{"hooks":{}}', version: null });
      expect(saved.status).toBe(200);
      expect(readFileSync(join(repoRoot, '.claude', 'settings.json'), 'utf8')).toBe('{"hooks":{}}');
    });

    it('disabled again: the next request is refused without a restart', async () => {
      process.env.CEZ_REMOTE = '1';
      await enableRemoteSettings(4321, undefined, undefined, testHome());
      expect((await put('claude.project.settings', { content: '{}', version: null })).status).toBe(200);
      await disableRemoteSettings(undefined, undefined, testHome());
      const refused = await put('claude.project.settings', { content: '{"hooks":{}}', version: null });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: string }).error).toContain(`${productIdentity().command} remote-settings enable`);
      expect((await apiRequest(app, '/api/v1/agent-config/claude.user.settings')).status).toBe(409);
      expect(((await (await apiRequest(app, '/api/v1/agent-config')).json()) as { editable: boolean }).editable).toBe(false);
    });

    it('enabled on the host: a cross-origin browser write is still rejected', async () => {
      process.env.CEZ_REMOTE = '1';
      await enableRemoteSettings(4321, undefined, undefined, testHome());
      const res = await apiRequest(app, '/api/v1/agent-config/claude.project.settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', host: 'cezar.example.ts.net', origin: 'https://evil.example' },
        body: JSON.stringify({ content: '{"hooks":{}}', version: null }),
      });
      expect(res.status).toBe(403);
      expect(() => readFileSync(join(repoRoot, '.claude', 'settings.json'), 'utf8')).toThrow();
    });

    // The multi-domain installer runs one cockpit per domain under one user and CEZ_HOME.
    it('a grant for one cockpit leaves another cockpit sharing the home read-only', async () => {
      process.env.CEZ_REMOTE = '1';
      await enableRemoteSettings(4322, undefined, undefined, testHome());
      const body = (await (await apiRequest(app, '/api/v1/agent-config')).json()) as { editable: boolean };
      expect(body.editable).toBe(false);
      expect((await put('claude.project.settings', { content: '{"hooks":{}}', version: null })).status).toBe(409);
      expect((await apiRequest(app, '/api/v1/agent-config/claude.user.settings')).status).toBe(409);
      const granted = createApp({ home: testHome(), repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', squawkPort: () => 4322 });
      const saved = await apiRequest(granted, '/api/v1/agent-config/claude.project.settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '{}', version: null }),
      });
      expect(saved.status).toBe(200);
    });

    it('a non-loopback bind never takes the switch', async () => {
      process.env.CEZ_REMOTE = '1';
      await enableRemoteSettings(4321, undefined, undefined, testHome());
      const exposed = createApp({ home: testHome(), repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', bindHost: '172.17.0.1', squawkPort: () => 4321 });
      const res = await apiRequest(exposed, '/api/v1/agent-config/claude.project.settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '{"hooks":{}}', version: null }),
      });
      expect(res.status).toBe(409);
    });
  });
});
