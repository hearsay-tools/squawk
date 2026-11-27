// real-clock: static ISO timestamps passed to runInstall/runUninstall are explicit fixture inputs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Home } from '../../home/home.ts';
import { useTestHome } from '../../home/test-home.testkit.ts';
import { createMcpToken, hasConfiguredMcpTokens, listMcpTokens, verifyMcpBearerToken } from '../../mcp-tokens.ts';
import { runInstall, runUninstall } from '../../server-install/engine.ts';
import { createAutoUi } from '../../server-install/ui.ts';
import type { PlatformStrategy } from '../../server-install/types.ts';
import { runMcpCommand } from './cli.ts';
import { MCP_TOKEN_USAGE, runMcpTokenCommand } from './token-cli.ts';

function fakeStrategy(): PlatformStrategy {
  return {
    id: 'ubuntu-vps',
    label: 'Fake VPS',
    preflight: async () => {},
    steps: () => [{
      id: 'stub',
      title: 'Stub step',
      check: async () => false,
      run: async () => ({ artifacts: [] }),
      undo: async () => {},
    }],
  };
}

describe('hsq mcp token CLI and installer lifecycle (hearsay-tools/squawk#4402)', () => {
  let root: string;
  let home: Home;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hsq-mcp-token-cli-'));
    home = Home.sandbox(root);
    useTestHome(home);
  });

  afterEach(() => {
    useTestHome(undefined);
    rmSync(root, { recursive: true, force: true });
  });

  const execToken = async (argv: string[], runningPorts: number[] = []) => {
    const out: string[] = [];
    const code = await runMcpTokenCommand(argv, home, {
      stdout: (line) => out.push(line),
      runningPorts: async () => runningPorts,
    });
    return { code, raw: out.join('\n'), json: () => JSON.parse(out.join('\n')) as Record<string, unknown> };
  };

  it('prints usage on --help', async () => {
    const res = await execToken(['--help']);
    expect(res.code).toBe(0);
    expect(res.raw).toBe(MCP_TOKEN_USAGE);
  });

  it('auto-detects a single running cockpit port on create and refuses when 0 or multiple run', async () => {
    const none = await execToken(['create'], []);
    expect(none.code).toBe(2);
    expect(none.json()).toMatchObject({ ok: false, code: 'choose_cockpit', ports: [] });

    const many = await execToken(['create'], [4321, 4322]);
    expect(many.code).toBe(2);
    expect(many.json()).toMatchObject({ ok: false, code: 'choose_cockpit', ports: [4321, 4322] });

    const one = await execToken(['create', '--name', 'darkhorse', '--project', 'proj-1'], [4329]);
    expect(one.code).toBe(0);
    const created = one.json();
    expect(created).toMatchObject({ ok: true, port: 4329, name: 'darkhorse', project: 'proj-1' });
    expect(typeof created.token).toBe('string');
    expect(verifyMcpBearerToken(String(created.token), {}, 4329, home)).toMatchObject({
      source: 'file',
      id: created.id,
      project: 'proj-1',
    });
  });

  it('lists across all ports or one port and revokes by id or --all --port', async () => {
    const c1 = (await execToken(['create', '--port', '4321', '--name', 'first'])).json();
    const c2 = (await execToken(['create', '--port', '4322', '--name', 'second'])).json();

    const allList = await execToken(['list']);
    expect(allList.code).toBe(0);
    expect((allList.json().tokens as Array<{ id: string }>).map((t) => t.id)).toEqual([c1.id, c2.id]);
    expect(allList.raw).not.toContain(String(c1.token));

    const onePort = await execToken(['list', '--port', '4322']);
    expect((onePort.json().tokens as Array<{ id: string }>).map((t) => t.id)).toEqual([c2.id]);

    const revoked = await execToken(['revoke', String(c1.id)]);
    expect(revoked.code).toBe(0);
    expect(hasConfiguredMcpTokens({}, 4321, home)).toBe(false);
    expect(hasConfiguredMcpTokens({}, 4322, home)).toBe(true);

    const revokeMissing = await execToken(['revoke', String(c1.id)]);
    expect(revokeMissing.code).toBe(2);
    expect(revokeMissing.json()).toMatchObject({ ok: false, code: 'not_found' });

    const revokeAllNoPort = await execToken(['revoke', '--all']);
    expect(revokeAllNoPort.code).toBe(64);

    const revokeAll = await execToken(['revoke', '--all', '--port', '4322']);
    expect(revokeAll.code).toBe(0);
    expect(hasConfiguredMcpTokens({}, 4322, home)).toBe(false);

    for (const badProject of ['', '   ', 'all']) {
      const rejected = await execToken(['create', '--port', '4323', '--project', badProject]);
      expect(rejected.code).toBe(64);
      expect(rejected.json()).toMatchObject({ ok: false, code: 'invalid_input' });
    }
    expect(hasConfiguredMcpTokens({}, 4323, home)).toBe(false);
  });

  it('refuses `hsq mcp token` inside a Squawk task', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMcpCommand(['token', 'list'], { HSQ_TASK_ID: 'task-1' }, {
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      home: () => home,
    });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('refuses to run inside a Squawk task');
  });

  it('withdraws per-port MCP tokens on fresh server-install and server-uninstall, preserving them on resumed install', async () => {
    const stale = createMcpToken({ port: 4321, name: 'stale', home });
    expect(verifyMcpBearerToken(stale.token, {}, 4321, home)).not.toBeNull();

    const strategy = fakeStrategy();
    const ui = createAutoUi({}, () => {});
    const installed = await runInstall(strategy, {
      home,
      dryRun: false,
      assumeYes: true,
      reconfigure: new Set(),
      repoRoot: root,
      now: '2026-11-27T00:00:00.000Z',
      ui,
      port: 4321,
    });
    expect(installed.status).toBe('complete');
    expect(listMcpTokens(home, 4321).tokens).toEqual([]);

    const active = createMcpToken({ port: 4321, name: 'active', home });
    const resumed = await runInstall(strategy, {
      home,
      dryRun: false,
      assumeYes: true,
      reconfigure: new Set(),
      repoRoot: root,
      now: '2026-11-27T00:01:00.000Z',
      ui,
      port: 4321,
    });
    expect(resumed.status).toBe('complete');
    expect(verifyMcpBearerToken(active.token, {}, 4321, home)).toMatchObject({ id: active.id });

    const uninstalled = await runUninstall(strategy, {
      home,
      dryRun: false,
      assumeYes: true,
      reconfigure: new Set(),
      repoRoot: root,
      now: '2026-11-27T00:02:00.000Z',
      ui,
      port: 4321,
    });
    expect(uninstalled.status).toBe('complete');
    expect(listMcpTokens(home, 4321).tokens).toEqual([]);
  });
});
