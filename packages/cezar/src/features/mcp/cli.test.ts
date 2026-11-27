// real-clock: static registry timestamps in loopback discovery fixtures are not compared to current time
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverCockpitOrigin } from '../../task-cli/discovery.ts';
import { TaskCliError } from '../../task-cli/http.ts';
import { MCP_HELP, runMcpCommand } from './cli.ts';

function fakeHealth(repoRoot: string) {
  return {
    version: '0.0.0-test',
    repoRoot,
    repo: null,
    checks: [],
    defaultRunner: 'claude',
    forge: null,
    capabilities: {
      localHandoff: true,
      settingsAdmin: true,
      remoteSettingsAdmin: false,
      automations: false,
      preview: false,
      tokenMetrics: true,
      tokenUsageMetrics: true,
      costMetrics: true,
    },
    projects: [],
    bootProject: 'boot',
  };
}

function fakeProject(id: string, root: string) {
  return { id, name: id, root, addedAt: '2026-01-01T00:00:00Z', lastOpenedAt: '2026-01-01T00:00:00Z', source: 'local', status: 'ok' };
}

describe('hsq mcp CLI and cockpit origin discovery (hearsay-tools/squawk#4401)', () => {
  const servers: Server[] = [];
  const dirs: string[] = [];

  const tmp = (prefix: string) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };

  const gitRepo = () => {
    const dir = tmp('hsq-mcp-repo-');
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    return dir;
  };

  const startFakeCockpit = async (projects: Array<ReturnType<typeof fakeProject>>) => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/v1/health') res.end(JSON.stringify(fakeHealth(projects[0]?.root ?? '/')));
      else if (req.url === '/api/v1/projects') res.end(JSON.stringify({ projects, bootProject: projects[0]?.id ?? 'boot', projectsDir: '/tmp' }));
      else { res.statusCode = 404; res.end('{"error":"not found"}'); }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  };

  beforeEach(() => { servers.length = 0; dirs.length = 0; });
  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('prints help on --help without starting discovery or stdio', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const discover = vi.fn();
    const serve = vi.fn();
    const code = await runMcpCommand(['--help'], {}, { stdout: (l) => out.push(l), stderr: (l) => err.push(l), discover, serve });
    expect(code).toBe(0);
    expect(out.join('\n')).toBe(MCP_HELP);
    expect(err).toEqual([]);
    expect(discover).not.toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'HSQ_TASK_ID', env: { HSQ_TASK_ID: 'task-123' } },
    { label: 'CEZ_TASK_ID', env: { CEZ_TASK_ID: 'task-456' } },
  ])('refuses startup on stderr without touching stdout when $label is set', async ({ env }) => {
    const out: string[] = [];
    const err: string[] = [];
    const discover = vi.fn();
    const serve = vi.fn();
    const code = await runMcpCommand([], env, { stdout: (l) => out.push(l), stderr: (l) => err.push(l), discover, serve });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('refuses to start inside a Squawk task');
    expect(discover).not.toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
  });

  it('rejects unexpected positional arguments with exit 64 on stderr', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMcpCommand(['extra'], {}, { stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
    expect(code).toBe(64);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain("unexpected argument 'extra'");
  });

  it('falls back to the single running local cockpit when launched outside any registered repo', async () => {
    const unrelatedDir = tmp('hsq-mcp-home-');
    const port = await startFakeCockpit([fakeProject('proj-a', '/srv/proj-a')]);
    const found = await discoverCockpitOrigin({ repoDir: unrelatedDir, explicitRepo: false, ports: [port] });
    expect(found).toEqual({ origin: `http://127.0.0.1:${port}` });
  });

  it('refuses when multiple local cockpits are running and cwd matches none', async () => {
    const unrelatedDir = tmp('hsq-mcp-home-');
    const portA = await startFakeCockpit([fakeProject('proj-a', '/srv/proj-a')]);
    const portB = await startFakeCockpit([fakeProject('proj-b', '/srv/proj-b')]);
    const error = await discoverCockpitOrigin({ repoDir: unrelatedDir, explicitRepo: false, ports: [portA, portB] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TaskCliError);
    expect((error as TaskCliError).exitCode).toBe(2);
    expect((error as TaskCliError).body).toMatchObject({
      code: 'ambiguous-cockpit',
      origins: [`http://127.0.0.1:${portA}`, `http://127.0.0.1:${portB}`],
    });
    expect(String((error as TaskCliError).body.error)).toContain(`http://127.0.0.1:${portA}`);
    expect(String((error as TaskCliError).body.error)).toContain(`http://127.0.0.1:${portB}`);
  });

  it('refuses instead of falling back when --repo is explicitly given and no cockpit serves it', async () => {
    const repo = gitRepo();
    const port = await startFakeCockpit([fakeProject('other', '/srv/other')]);
    const error = await discoverCockpitOrigin({ repoDir: repo, explicitRepo: true, ports: [port] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TaskCliError);
    expect((error as TaskCliError).exitCode).toBe(2);
    expect((error as TaskCliError).body).toMatchObject({ code: 'no-cockpit' });
  });

  it('matches the cockpit serving repoDir even when multiple cockpits run locally', async () => {
    const repo = gitRepo();
    const portOther = await startFakeCockpit([fakeProject('other', '/srv/other')]);
    const portMine = await startFakeCockpit([fakeProject('mine', repo)]);
    const found = await discoverCockpitOrigin({ repoDir: repo, explicitRepo: false, ports: [portOther, portMine] });
    expect(found).toEqual({ origin: `http://127.0.0.1:${portMine}` });
  });
});
