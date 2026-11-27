// real-clock: drives a real loopback HTTP server with StreamableHTTPClientTransport and restart recovery
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AutomationStore } from '../../automations/store.ts';
import { createRunner } from '../../core/runner-registry.ts';
import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { testHome } from '../../home/test-home.testkit.ts';
import { createMcpToken, revokeMcpToken } from '../../mcp-tokens.ts';
import { claudeRunner } from '../../runners/claude/definition.ts';
import { RunStore } from '../../runs/store.ts';
import { setRunStatus } from '../../runs/run-store.testkit.ts';
import { createFakeRunManager } from '../../server/fake-run-manager.testkit.ts';
import { connectedProviderAuth } from '../../server/provider-auth.testkit.ts';
import { createApp } from '../../server/server.ts';
import { registerProject, removeProject } from '../../workspace/projects.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import { createMcpHttpRoute, MCP_MAX_BODY_BYTES } from './http.ts';
import '../../built-in-run-slots.testkit.ts';
import '../../delegation/worker-executions.testkit.ts';

sealTestRunners(claudeRunner);

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'http-test', version: '1.0.0' } },
});

function parseToolResult(result: unknown) {
  const obj = (result && typeof result === 'object' ? result : {}) as { isError?: unknown; content?: unknown };
  const blocks = Array.isArray(obj.content) ? obj.content as Array<{ type: string; text?: string }> : [];
  const text = blocks.find((entry) => entry.type === 'text')?.text ?? '{}';
  return { isError: obj.isError === true, data: JSON.parse(text) as Record<string, unknown> };
}

interface HttpCockpit {
  origin: string;
  port: number;
  projectA: string;
  projectB: string;
  storeA: RunStore;
  restart(): Promise<void>;
  close(): Promise<void>;
}

async function startHttpCockpit(): Promise<HttpCockpit> {
  const savedDryRun = process.env.CEZ_DRY_RUN;
  process.env.CEZ_DRY_RUN = '1';
  const home = testHome();
  const repoA = mkdtempSync(join(tmpdir(), 'hsq-mcp-http-a-'));
  const repoB = mkdtempSync(join(tmpdir(), 'hsq-mcp-http-b-'));
  const entryA = await registerProject(repoA, 'local', home);
  const entryB = await registerProject(repoB, 'local', home);

  let storeA = RunStore.open(join(repoA, '.ai/cezar'));
  let managerA = createFakeRunManager(storeA, repoA, {
    createRunner,
    home,
    semaphore: new WorkspaceSemaphore({ home, initial: { maxParallel: 0 } }),
  });
  let automationStoreA = AutomationStore.open(join(repoA, '.ai/cezar'));
  let boundPort = 0;

  const listenOn = async (requestedPort: number): Promise<ServerType> => {
    const app = createApp({
      home,
      repoRoot: repoA,
      bootProjectId: entryA.id,
      store: storeA,
      manager: managerA,
      automationStore: automationStoreA,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
      squawkPort: () => boundPort || undefined,
      httpRoutes: [createMcpHttpRoute({ pollMs: 25, heartbeatMs: 1_000 })],
    });
    const started = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: app.fetch, port: requestedPort, hostname: '127.0.0.1' }, () => resolve(s));
    });
    boundPort = (started.address() as AddressInfo).port;
    return started;
  };

  let server = await listenOn(0);

  const stopListener = async () => {
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    managerA.dispose();
    storeA.close();
  };

  return {
    get origin() { return `http://127.0.0.1:${boundPort}`; },
    get port() { return boundPort; },
    projectA: entryA.id,
    projectB: entryB.id,
    get storeA() { return storeA; },
    async restart() {
      const samePort = boundPort;
      await stopListener();
      storeA = RunStore.open(join(repoA, '.ai/cezar'));
      managerA = createFakeRunManager(storeA, repoA, {
        createRunner,
        home,
        semaphore: new WorkspaceSemaphore({ home, initial: { maxParallel: 0 } }),
      });
      automationStoreA = AutomationStore.open(join(repoA, '.ai/cezar'));
      server = await listenOn(samePort);
    },
    async close() {
      await stopListener();
      await removeProject(entryA.id, home).catch(() => {});
      await removeProject(entryB.id, home).catch(() => {});
      rmSync(repoA, { recursive: true, force: true });
      rmSync(repoB, { recursive: true, force: true });
      if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = savedDryRun;
    },
  };
}

describe('Streamable HTTP /api/v1/mcp auth matrix and lifecycle (hearsay-tools/squawk#4402)', () => {
  let cockpit: HttpCockpit;

  beforeEach(async () => {
    delete process.env.HSQ_MCP_TOKEN;
    delete process.env.CEZ_MCP_TOKEN;
    cockpit = await startHttpCockpit();
  });

  afterEach(async () => {
    delete process.env.HSQ_MCP_TOKEN;
    delete process.env.CEZ_MCP_TOKEN;
    await cockpit.close();
  });

  it('enforces 404 default, 401 Bearer, 403 Origin, 413 body limit, 405 non-POST, and live revocation', async () => {
    const endpoint = `${cockpit.origin}/api/v1/mcp`;

    // 1. Default fail-closed 404 when no token is configured.
    const disabled = await fetch(endpoint, { method: 'POST', headers: MCP_HEADERS, body: INIT_BODY });
    expect(disabled.status).toBe(404);

    // 2. Create per-port token — takes effect immediately without restart.
    const created = createMcpToken({ port: cockpit.port, name: 'ops', home: testHome() });

    // 3. Missing, Basic, and invalid Bearer headers return 401 + WWW-Authenticate: Bearer.
    for (const auth of [undefined, 'Basic dXNlcjpwYXNz', 'Bearer wrong-token', 'Bearer']) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { ...MCP_HEADERS, ...(auth !== undefined ? { authorization: auth } : {}) },
        body: INIT_BODY,
      });
      expect(res.status, String(auth)).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
    }

    // 4. Any Origin header (foreign or same-origin) returns 403.
    for (const origin of ['https://evil.example', cockpit.origin]) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { ...MCP_HEADERS, authorization: `Bearer ${created.token}`, origin },
        body: INIT_BODY,
      });
      expect(res.status, origin).toBe(403);
    }

    // 5. Oversized body (> 1 MiB) returns 413 (use Connection: close so Node does not reset a pooled socket).
    const oversized = await fetch(endpoint, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: `Bearer ${created.token}`, connection: 'close' },
      body: 'x'.repeat(MCP_MAX_BODY_BYTES + 1),
    });
    expect(oversized.status).toBe(413);

    // 6. GET and DELETE return 405 with Allow: POST when authorized.
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(endpoint, {
        method,
        headers: { authorization: `Bearer ${created.token}`, accept: 'text/event-stream' },
      });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }

    // 7. Valid POST succeeds (200) and live revocation takes effect on the next request.
    const ok = await fetch(endpoint, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: `Bearer ${created.token}` },
      body: INIT_BODY,
    });
    expect(ok.status).toBe(200);
    await ok.text();

    // Create a second token so revocation of the first produces 401 (still enabled), then revoke both -> 404.
    const second = createMcpToken({ port: cockpit.port, name: 'backup', home: testHome() });
    revokeMcpToken({ home: testHome(), id: created.id, port: cockpit.port });

    const revokedRes = await fetch(endpoint, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: `Bearer ${created.token}` },
      body: INIT_BODY,
    });
    expect(revokedRes.status).toBe(401);

    revokeMcpToken({ home: testHome(), id: second.id, port: cockpit.port });
    const allGone = await fetch(endpoint, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: `Bearer ${second.token}` },
      body: INIT_BODY,
    });
    expect(allGone.status).toBe(404);
  });

  it('enforces project-scoped token isolation across project_list and task_* tools', async () => {
    const scoped = createMcpToken({ port: cockpit.port, name: 'scoped-a', project: cockpit.projectA, home: testHome() });
    const transport = new StreamableHTTPClientTransport(new URL(`${cockpit.origin}/api/v1/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${scoped.token}` } },
    });
    const client = new Client({ name: 'scoped-test', version: '1.0.0' });
    await client.connect(transport as unknown as Transport);
    try {
      const projects = parseToolResult(await client.callTool({ name: 'project_list', arguments: {} }));
      expect(projects.isError).toBe(false);
      expect((projects.data.projects as Array<{ id: string }>).map((p) => p.id)).toEqual([cockpit.projectA]);

      const okList = parseToolResult(await client.callTool({ name: 'task_list', arguments: { project: cockpit.projectA } }));
      expect(okList.isError).toBe(false);

      const otherStart = parseToolResult(await client.callTool({
        name: 'task_start',
        arguments: { project: cockpit.projectB, task: 'Should be rejected' },
      }));
      expect(otherStart.isError).toBe(true);
      expect(otherStart.data).toMatchObject({ code: 'forbidden' });

      const allList = parseToolResult(await client.callTool({
        name: 'task_list',
        arguments: { project: 'all' },
      }));
      expect(allList.isError).toBe(true);
      expect(allList.data).toMatchObject({ code: 'forbidden' });
    } finally {
      await client.close();
    }
  });

  it('completes a full StreamableHTTPClientTransport lifecycle and survives a cockpit restart statelessly', async () => {
    const created = createMcpToken({ port: cockpit.port, name: 'fleet', home: testHome() });
    const transport = new StreamableHTTPClientTransport(new URL(`${cockpit.origin}/api/v1/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${created.token}` } },
    });
    const client = new Client({ name: 'http-lifecycle-test', version: '1.0.0' });
    await client.connect(transport as unknown as Transport);
    try {
      const listedProjects = parseToolResult(await client.callTool({ name: 'project_list', arguments: {} }));
      expect(listedProjects.isError).toBe(false);
      expect((listedProjects.data.projects as Array<{ id: string }>).map((p) => p.id)).toEqual(
        expect.arrayContaining([cockpit.projectA, cockpit.projectB]),
      );

      const started = parseToolResult(await client.callTool({
        name: 'task_start',
        arguments: { project: cockpit.projectA, task: 'Verify Streamable HTTP MCP lifecycle' },
      }));
      expect(started.isError).toBe(false);
      const id = started.data.id as string;

      setTimeout(() => setRunStatus(cockpit.storeA, id, RUN_STATUS.waiting), 80);
      const waited = parseToolResult(await client.callTool({
        name: 'task_wait',
        arguments: { project: cockpit.projectA, ids: [id], timeoutSeconds: 10 },
      }));
      expect(waited.isError).toBe(false);
      expect(waited.data).toMatchObject({
        project: cockpit.projectA,
        timedOut: false,
        runs: [expect.objectContaining({ id, status: RUN_STATUS.waiting, attention: 'waiting' })],
      });

      const sent = parseToolResult(await client.callTool({
        name: 'task_send',
        arguments: { project: cockpit.projectA, id, text: 'Continue via HTTP MCP' },
      }));
      expect(sent.isError).toBe(false);

      const log = parseToolResult(await client.callTool({
        name: 'task_log',
        arguments: { project: cockpit.projectA, id },
      }));
      expect(log.isError).toBe(false);

    // Restart cockpit on the same port — stateless client keeps working without session errors.
    const created2Transport = new StreamableHTTPClientTransport(new URL(`${cockpit.origin}/api/v1/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${created.token}`, connection: 'close' } },
    });
    const restartClient = new Client({ name: 'http-restart-test', version: '1.0.0' });
    await restartClient.connect(created2Transport as unknown as Transport);
    try {
      expect(created2Transport.sessionId).toBeUndefined();
      const before = parseToolResult(await restartClient.callTool({
        name: 'task_status',
        arguments: { project: cockpit.projectA, id },
      }));
      expect(before.isError).toBe(false);

      await cockpit.restart();

      const statusAfterRestart = parseToolResult(await restartClient.callTool({
        name: 'task_status',
        arguments: { project: cockpit.projectA, id },
      }));
      expect(statusAfterRestart.isError).toBe(false);
      expect(statusAfterRestart.data).toMatchObject({ id, project: cockpit.projectA });
    } finally {
      await restartClient.close();
    }

    const stopped = parseToolResult(await client.callTool({
        name: 'task_stop',
        arguments: { project: cockpit.projectA, id },
      }));
      expect(stopped.isError).toBe(false);

      const listed = parseToolResult(await client.callTool({
        name: 'task_list',
        arguments: { project: cockpit.projectA },
      }));
      expect(listed.isError).toBe(false);
      expect((listed.data.runs as Array<{ id: string }>).map((r) => r.id)).toContain(id);
    } finally {
      await client.close();
    }
  }, 30_000);

  it('aborts an in-flight HTTP task_wait cleanly when the client disconnects', async () => {
    const created = createMcpToken({ port: cockpit.port, name: 'abort-test', home: testHome() });
    const transport = new StreamableHTTPClientTransport(new URL(`${cockpit.origin}/api/v1/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${created.token}` } },
    });
    const client = new Client({ name: 'abort-client', version: '1.0.0' });
    await client.connect(transport as unknown as Transport);
    try {
      const started = parseToolResult(await client.callTool({
        name: 'task_start',
        arguments: { project: cockpit.projectA, task: 'Wait to be aborted' },
      }));
      const id = started.data.id as string;

      const ac = new AbortController();
      const response = await fetch(`${cockpit.origin}/api/v1/mcp`, {
        method: 'POST',
        headers: { ...MCP_HEADERS, authorization: `Bearer ${created.token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 42,
          method: 'tools/call',
          params: { name: 'task_wait', arguments: { project: cockpit.projectA, ids: [id], timeoutSeconds: 60 } },
        }),
        signal: ac.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      setTimeout(() => ac.abort(new Error('client disconnected')), 80);
      await expect(response.text()).rejects.toThrow();

      // Server remains healthy and responsive immediately after client abort.
      const followUp = parseToolResult(await client.callTool({
        name: 'task_status',
        arguments: { project: cockpit.projectA, id },
      }));
      expect(followUp.isError).toBe(false);
      expect(followUp.data).toMatchObject({ id });
    } finally {
      await client.close();
    }
  }, 20_000);
});
