// real-clock: exercises real loopback HTTP cockpit waits, heartbeats, and static fixture timestamps
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { toRunSummary } from '@open-mercato/cezar-contract/runs';
import { makeRunRecord, RUN_STATUS, STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationStore } from '../../automations/store.ts';
import { createRunner } from '../../core/runner-registry.ts';
import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { spawnCapacityRefusal } from '../../delegation/capacity.ts';
import { handoffPath } from '../../handoff.ts';
import { testHome } from '../../home/test-home.testkit.ts';
import { claudeRunner } from '../../runners/claude/definition.ts';
import { RunStore } from '../../runs/store.ts';
import { setRunStatus } from '../../runs/run-store.testkit.ts';
import { createRunManager } from '../../server/engine-run-manager.testkit.ts';
import { createFakeRunManager } from '../../server/fake-run-manager.testkit.ts';
import type { RunManagerFactory } from '../../server/project-context.ts';
import { connectedProviderAuth } from '../../server/provider-auth.testkit.ts';
import { createApp } from '../../server/server.ts';
import { registerProject, removeProject } from '../../workspace/projects.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import { createOrchestratorMcpServer, MCP_SERVER_NAME } from './tools.ts';
import '../../built-in-run-slots.testkit.ts';
import '../../delegation/worker-executions.testkit.ts';

sealTestRunners(claudeRunner);

interface ToolCallParsed {
  isError: boolean;
  data: Record<string, unknown>;
}

function parseToolResult(result: unknown): ToolCallParsed {
  const obj = (result && typeof result === 'object' ? result : {}) as { isError?: unknown; content?: unknown };
  const blocks = Array.isArray(obj.content) ? obj.content as Array<{ type: string; text?: string }> : [];
  const text = blocks.find((entry) => entry.type === 'text')?.text ?? '{}';
  return { isError: obj.isError === true, data: JSON.parse(text) as Record<string, unknown> };
}

interface RegisteredCockpit {
  origin: string;
  projectId: string;
  repoRoot: string;
  store: RunStore;
  close(): Promise<void>;
}

async function startRegisteredCockpit(createManager: RunManagerFactory = createFakeRunManager): Promise<RegisteredCockpit> {
  const savedDryRun = process.env.CEZ_DRY_RUN;
  process.env.CEZ_DRY_RUN = '1';
  const home = testHome();
  const repoRoot = mkdtempSync(join(tmpdir(), 'hsq-mcp-tools-'));
  const entry = await registerProject(repoRoot, 'local', home);
  const store = RunStore.open(join(repoRoot, '.ai/cezar'));
  const manager = createManager(store, repoRoot, {
    createRunner,
    home,
    semaphore: new WorkspaceSemaphore({ home, initial: { maxParallel: 0 } }),
  });
  const automationStore = AutomationStore.open(join(repoRoot, '.ai/cezar'));
  const app = createApp({
    home,
    repoRoot,
    bootProjectId: entry.id,
    store,
    manager,
    automationStore,
    version: '0.0.0-test',
    providerAuth: connectedProviderAuth(),
  });
  const server = await new Promise<ServerType>((resolve) => {
    const started = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(started));
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    projectId: entry.id,
    repoRoot,
    store,
    async close() {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      manager.dispose();
      store.close();
      await removeProject(entry.id, home).catch(() => {});
      rmSync(repoRoot, { recursive: true, force: true });
      if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = savedDryRun;
    },
  };
}

describe('orchestrator MCP tools (hearsay-tools/squawk#4401)', () => {
  let harness: RegisteredCockpit;
  let client: Client;

  beforeEach(async () => {
    harness = await startRegisteredCockpit();
    const server = createOrchestratorMcpServer({
      origin: harness.origin,
      version: '0.0.0-test',
      pollMs: 20,
      heartbeatMs: 40,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-orchestrator', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await harness.close();
  });

  const call = async (name: string, args: Record<string, unknown> = {}) =>
    parseToolResult(await client.callTool({ name, arguments: args }));

  it('advertises server metadata, instructions, project_list, and all 10 task_* tools', async () => {
    expect(client.getServerVersion()?.name).toBe(MCP_SERVER_NAME);
    expect(client.getInstructions()).toContain('project_list');
    expect(client.getInstructions()).toContain('attention');
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      'project_list',
      'task_start',
      'task_send',
      'task_status',
      'task_log',
      'task_diff',
      'task_wait',
      'task_stop',
      'task_finish',
      'task_archive',
      'task_list',
    ]);
  });

  it('project_list returns only id, name, status, branch, repoUrl, and tags (no root, bootProject, or webhooks)', async () => {
    const res = await call('project_list');
    expect(res.isError).toBe(false);
    const projects = res.data.projects as Array<Record<string, unknown>>;
    expect(projects.length).toBeGreaterThanOrEqual(1);
    expect(projects.some((entry) => entry.id === harness.projectId)).toBe(true);
    const allowedKeys = new Set(['id', 'name', 'status', 'branch', 'repoUrl', 'tags']);
    for (const entry of projects) {
      expect(entry.id).toBeTypeOf('string');
      expect(entry.name).toBeTypeOf('string');
      expect(entry.status).toBeTypeOf('string');
      for (const key of Object.keys(entry)) {
        expect(allowedKeys.has(key), `unexpected project_list key: ${key}`).toBe(true);
      }
      expect(entry).not.toHaveProperty('root');
      expect(entry).not.toHaveProperty('projectsDir');
      expect(entry).not.toHaveProperty('bootProject');
      expect(entry).not.toHaveProperty('webhooks');
    }
    expect(res.data).not.toHaveProperty('bootProject');
    expect(res.data).not.toHaveProperty('projectsDir');
  });

  it.each([
    ['task_start', { task: 'do work' }],
    ['task_send', { id: 'run-1', text: 'hi' }],
    ['task_status', { id: 'run-1' }],
    ['task_log', { id: 'run-1' }],
    ['task_diff', { id: 'run-1' }],
    ['task_wait', { ids: ['run-1'] }],
    ['task_stop', { id: 'run-1' }],
    ['task_finish', { id: 'run-1' }],
    ['task_archive', { id: 'run-1' }],
    ['task_list', {}],
  ] as const)('%s requires project and refuses unknown project IDs without falling back to bootProject', async (toolName, baseArgs) => {
    const missing = await call(toolName, { ...baseArgs });
    expect(missing.isError).toBe(true);
    expect(missing.data.code).toBe('invalid_input');

    const unknown = await call(toolName, { ...baseArgs, project: 'nonexistent-project-id' });
    expect(unknown.isError).toBe(true);
    expect(unknown.data.code).toBe('unknown_project');
    expect(String(unknown.data.error)).toContain('nonexistent-project-id');
  });

  it('starts a task idempotently, inspects status with bounded handoff, sends/resumes, stops, finishes, and archives', async () => {
    const project = harness.projectId;
    const requestId = '11111111-1111-4111-8111-111111111111';
    const started = await call('task_start', { project, task: 'Implement feature', requestId, autonomous: true });
    expect(started.isError).toBe(false);
    expect(started.data).toMatchObject({ project, status: RUN_STATUS.queued, created: true, requestId });
    const id = started.data.id as string;

    const retry = await call('task_start', { project, task: 'Implement feature', requestId, autonomous: true });
    expect(retry.isError).toBe(false);
    expect(retry.data).toMatchObject({ id, project, created: false, requestId });

    const hPath = handoffPath(join(harness.repoRoot, '.ai/cezar'), id);
    mkdirSync(dirname(hPath), { recursive: true });
    writeFileSync(hPath, `# Handoff\n${'A'.repeat(200)}`);
    const statusRes = await call('task_status', { project, id, includeHandoff: true, maxChars: 50 });
    expect(statusRes.isError).toBe(false);
    expect(statusRes.data).toMatchObject({ id, project, status: RUN_STATUS.queued, handoffTruncated: true });
    expect((statusRes.data.handoff as string).length).toBe(50);

    const queuedSend = await call('task_send', { project, id, text: 'Extra context' });
    expect(queuedSend.isError).toBe(false);
    expect(queuedSend.data).toMatchObject({ id, project, delivery: 'queued' });

    const stopped = await call('task_stop', { project, id });
    expect(stopped.isError).toBe(false);
    expect(stopped.data).toMatchObject({ id, project, cancelled: true });

    const closedSend = await call('task_send', { project, id, text: 'Follow up' });
    expect(closedSend.isError).toBe(false);
    expect(closedSend.data).toMatchObject({ id, project, delivery: 'not-delivered', reason: 'session closed' });
    expect(String(closedSend.data.hint)).toContain('resume: true');

    const archived = await call('task_archive', { project, id });
    expect(archived.isError).toBe(false);
    expect(archived.data).toMatchObject({ id, project, archived: true });

    const reviewId = harness.store.createRun({ title: 'ready', workflow: 'quick-task', task: 'ready', steps: [] }).id;
    const refusedFinish = await call('task_finish', { project, id: reviewId });
    expect(refusedFinish.isError).toBe(true);
    expect(refusedFinish.data.code).toBe('refused');

    setRunStatus(harness.store, reviewId, RUN_STATUS.review);
    const finished = await call('task_finish', { project, id: reviewId });
    expect(finished.isError).toBe(false);
    expect(finished.data).toMatchObject({ id: reviewId, project, finished: true });
  });

  it('task_send with resume: true reopens a closed session through the engine', async () => {
    const engineHarness = await startRegisteredCockpit(createRunManager);
    const engineServer = createOrchestratorMcpServer({ origin: engineHarness.origin, version: '0.0.0-test' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const engineClient = new Client({ name: 'resume-test', version: '1.0.0' });
    await Promise.all([engineServer.connect(serverTransport), engineClient.connect(clientTransport)]);
    try {
      const project = engineHarness.projectId;
      const started = parseToolResult(await engineClient.callTool({ name: 'task_start', arguments: { project, task: 'Resume me' } }));
      expect(started.isError).toBe(false);
      const id = started.data.id as string;
      const stopped = parseToolResult(await engineClient.callTool({ name: 'task_stop', arguments: { project, id } }));
      expect(stopped.isError).toBe(false);
      const resumed = parseToolResult(await engineClient.callTool({ name: 'task_send', arguments: { project, id, text: 'Continue now', resume: true } }));
      expect(resumed.isError).toBe(false);
      expect(resumed.data).toMatchObject({ id, project, delivery: 'resumed' });
    } finally {
      await engineClient.close();
      await engineHarness.close();
    }
  });

  it('task_log returns bounded snapshots with lastSeq and truncated flag', async () => {
    const project = harness.projectId;
    const id = harness.store.createRun({ title: 'log-test', workflow: 'quick-task', task: 'log', steps: [] }).id;
    harness.store.eventLog.appendEvent(id, { type: 'text', text: 'first '.repeat(20) });
    harness.store.eventLog.appendEvent(id, { type: 'text', text: 'second '.repeat(20) });

    const full = await call('task_log', { project, id, since: 0, maxChars: 8_000 });
    expect(full.isError).toBe(false);
    expect(full.data).toMatchObject({ id, project, truncated: false });
    expect((full.data.events as unknown[]).length).toBe(2);
    expect(full.data.lastSeq).toBe(2);

    const capped = await call('task_log', { project, id, since: 0, maxChars: 220 });
    expect(capped.isError).toBe(false);
    expect(capped.data).toMatchObject({ id, project, truncated: true, lastSeq: 2 });
    expect((capped.data.events as unknown[]).length).toBe(1);
  });

  it('task_diff supports stat mode and bounded patch truncation', async () => {
    execFileSync('git', ['init', '-q', '-b', 'main', harness.repoRoot]);
    writeFileSync(join(harness.repoRoot, 'file.txt'), 'line1\n');
    execFileSync('git', ['-C', harness.repoRoot, 'add', '-A']);
    execFileSync('git', ['-C', harness.repoRoot, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
    writeFileSync(join(harness.repoRoot, 'file.txt'), `line1\n${'changed line\n'.repeat(20)}`);

    const project = harness.projectId;
    const run = harness.store.createRun({ title: 'diff-test', workflow: 'quick-task', task: 'diff', steps: [] });
    harness.store.updateRun(run.id, { worktreePath: harness.repoRoot, baseBranch: 'main' });

    const statRes = await call('task_diff', { project, id: run.id, stat: true });
    expect(statRes.isError).toBe(false);
    expect(statRes.data).toMatchObject({ id: run.id, project });
    expect(Array.isArray(statRes.data.files)).toBe(true);

    const patchRes = await call('task_diff', { project, id: run.id, maxChars: 60 });
    expect(patchRes.isError).toBe(false);
    expect(patchRes.data).toMatchObject({ id: run.id, project, truncated: true });
    expect((patchRes.data.diff as string).length).toBe(60);
  });

  it('task_wait defaults to mode: any and until: attention, emits progress heartbeats, and honours AbortSignal', async () => {
    const project = harness.projectId;
    const first = harness.store.createRun({ title: 'a', workflow: 'quick-task', task: 'a', steps: [] }).id;
    const second = harness.store.createRun({ title: 'b', workflow: 'quick-task', task: 'b', steps: [] }).id;

    const progressEvents: Array<{ progress: number; total?: number | undefined; message?: string | undefined }> = [];
    setTimeout(() => setRunStatus(harness.store, first, RUN_STATUS.waiting), 120);

    const waited = parseToolResult(await client.callTool(
      { name: 'task_wait', arguments: { project, ids: [first, second], timeoutSeconds: 10 } },
      undefined,
      { onprogress: (p) => { progressEvents.push(p); } },
    ));
    expect(waited.isError).toBe(false);
    expect(waited.data).toMatchObject({
      project,
      mode: 'any',
      until: 'attention',
      timedOut: false,
    });
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);
    await expect(
      client.callTool(
        { name: 'task_wait', arguments: { project, ids: [second], timeoutSeconds: 30 } },
        undefined,
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
  });

  it('task_list supports project-scoped and project: all listing while excluding workers', async () => {
    const project = harness.projectId;
    const rootId = harness.store.createRun({ title: 'root task', workflow: 'quick-task', task: 'root', steps: [] }).id;
    const workerId = randomUUID();
    harness.store.updateRun(rootId, { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    harness.store.createOwnedRun(
      { title: 'worker task', workflow: 'quick-task', task: 'worker', runner: 'claude', steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] },
      rootId,
      randomUUID(),
      {
        role: 'worker',
        permissions: [],
        parentRunId: rootId,
        workspace: {
          ownerRunId: workerId,
          resourceId: randomUUID(),
          kind: 'owned-isolated',
          path: `/managed/${workerId}`,
          branch: `cez/${workerId.slice(0, 8)}`,
          baselineSha: 'a'.repeat(40),
        },
      },
      'a'.repeat(64),
      spawnCapacityRefusal,
    );

    const single = await call('task_list', { project });
    expect(single.isError).toBe(false);
    expect(single.data).toMatchObject({ project, total: 1 });
    expect((single.data.runs as Array<{ id: string }>).map((r) => r.id)).toEqual([rootId]);

    const all = await call('task_list', { project: 'all', status: RUN_STATUS.queued });
    expect(all.isError).toBe(false);
    expect(all.data).toMatchObject({ project: 'all', total: 1 });
    expect((all.data.runs as Array<{ id: string; project: string }>)).toEqual([
      expect.objectContaining({ id: rootId, project }),
    ]);

    const fullAll = await call('task_list', { project: 'all', full: true });
    expect(fullAll.isError).toBe(false);
    expect(fullAll.data).toMatchObject({ project: 'all', total: 1 });
    expect((fullAll.data.runs as Array<Record<string, unknown>>)).toEqual([
      expect.objectContaining({ id: rootId, project, task: 'root', steps: [] }),
    ]);
  });

  it('task_list with project: all and all: true expands truncated projects from /workspace/runs-index', async () => {
    const olderArchived = toRunSummary(makeRunRecord({
      id: 'older-failed',
      title: 'older failed',
      status: RUN_STATUS.failed,
      archived: true,
      createdAt: '2026-01-01T00:00:00Z',
    }));
    const recentQueued = toRunSummary(makeRunRecord({
      id: 'recent-queued',
      title: 'recent queued',
      status: RUN_STATUS.queued,
      archived: false,
      createdAt: '2026-01-02T00:00:00Z',
    }));
    const customFetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/api/v1/workspace/runs-index')) {
        return new Response(JSON.stringify({
          runs: [{ projectId: 'proj-a', ...recentQueued }],
          referenceStatuses: {},
          perProjectLimit: 1,
          truncated: ['proj-a'],
          generation: 'gen-1',
          eventSeq: 1,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/api/v1/p/proj-a/run-summaries')) {
        return new Response(JSON.stringify([recentQueued, olderArchived]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 404, headers: { 'content-type': 'application/json' } });
    });

    const server = createOrchestratorMcpServer({ origin: 'http://127.0.0.1:4321', fetch: customFetch });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const customClient = new Client({ name: 'truncated-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), customClient.connect(clientTransport)]);
    try {
      const res = parseToolResult(await customClient.callTool({
        name: 'task_list',
        arguments: { project: 'all', all: true, status: RUN_STATUS.failed },
      }));
      expect(res.isError).toBe(false);
      expect(res.data).toMatchObject({
        project: 'all',
        total: 1,
        runs: [expect.objectContaining({ id: 'older-failed', project: 'proj-a', status: RUN_STATUS.failed })],
      });
    } finally {
      await customClient.close();
    }
  });

  it('routes requests through an injectable fetch transport when provided', async () => {
    const customFetch = vi.fn(async () => new Response(JSON.stringify({
      projects: [{ id: 'custom', name: 'Custom', root: '/tmp/custom', addedAt: '2026-01-01T00:00:00Z', lastOpenedAt: '2026-01-01T00:00:00Z', source: 'local', status: 'ok', branch: 'main' }],
      bootProject: 'custom',
      projectsDir: '/tmp',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const server = createOrchestratorMcpServer({ origin: 'http://127.0.0.1:4321', fetch: customFetch });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const customClient = new Client({ name: 'fetch-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), customClient.connect(clientTransport)]);
    try {
      const res = parseToolResult(await customClient.callTool({ name: 'project_list', arguments: {} }));
      expect(res.isError).toBe(false);
      expect(res.data).toEqual({ projects: [{ id: 'custom', name: 'Custom', status: 'ok', branch: 'main' }] });
      expect(customFetch).toHaveBeenCalledTimes(1);
    } finally {
      await customClient.close();
    }
  });
});
