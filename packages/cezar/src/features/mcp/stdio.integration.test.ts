// real-clock: spawns a real stdio child process and sends MCP protocolVersion date literal
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AutomationStore } from '../../automations/store.ts';
import { createRunner } from '../../core/runner-registry.ts';
import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { testHome } from '../../home/test-home.testkit.ts';
import { claudeRunner } from '../../runners/claude/definition.ts';
import { RunStore } from '../../runs/store.ts';
import { setRunStatus } from '../../runs/run-store.testkit.ts';
import { createFakeRunManager } from '../../server/fake-run-manager.testkit.ts';
import { connectedProviderAuth } from '../../server/provider-auth.testkit.ts';
import { createApp } from '../../server/server.ts';
import { registerProject, removeProject } from '../../workspace/projects.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import '../../built-in-run-slots.testkit.ts';
import '../../delegation/worker-executions.testkit.ts';

sealTestRunners(claudeRunner);

const CLI_ENTRY = fileURLToPath(new URL('../../hsq.ts', import.meta.url));
const TSX_IMPORT = fileURLToPath(import.meta.resolve('tsx'));

function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'HSQ_TASK_ID' && key !== 'CEZ_TASK_ID') env[key] = value;
  }
  return { ...env, ...extra };
}

function parseJsonResult(result: unknown) {
  const obj = (result && typeof result === 'object' ? result : {}) as { isError?: unknown; content?: unknown };
  const blocks = Array.isArray(obj.content) ? obj.content as Array<{ type: string; text?: string }> : [];
  const text = blocks.find((entry) => entry.type === 'text')?.text ?? '{}';
  return { isError: obj.isError === true, data: JSON.parse(text) as Record<string, unknown> };
}

interface IntegrationCockpit {
  origin: string;
  projectId: string;
  store: RunStore;
  close(): Promise<void>;
}

async function startIntegrationCockpit(): Promise<IntegrationCockpit> {
  const savedDryRun = process.env.CEZ_DRY_RUN;
  process.env.CEZ_DRY_RUN = '1';
  const home = testHome();
  const repoRoot = mkdtempSync(join(tmpdir(), 'hsq-mcp-stdio-'));
  const entry = await registerProject(repoRoot, 'local', home);
  const store = RunStore.open(join(repoRoot, '.ai/cezar'));
  const manager = createFakeRunManager(store, repoRoot, {
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

describe('hsq mcp stdio integration (hearsay-tools/squawk#4401)', () => {
  let harness: IntegrationCockpit;

  beforeEach(async () => {
    harness = await startIntegrationCockpit();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('drives project_list, task_start, task_wait, task_status, task_send, task_stop, and task_list over StdioClientTransport', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', TSX_IMPORT, CLI_ENTRY, 'mcp', '--url', harness.origin],
      env: cleanEnv(),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-integration-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      const listedProjects = parseJsonResult(await client.callTool({ name: 'project_list', arguments: {} }));
      expect(listedProjects.isError).toBe(false);
      const projects = listedProjects.data.projects as Array<{ id: string }>;
      expect(projects.some((entry) => entry.id === harness.projectId)).toBe(true);
      const project = harness.projectId;

      const started = parseJsonResult(await client.callTool({
        name: 'task_start',
        arguments: { project, task: 'Verify stdio MCP integration' },
      }));
      expect(started.isError).toBe(false);
      const id = started.data.id as string;
      expect(started.data).toMatchObject({ project, created: true, status: RUN_STATUS.queued });

      setTimeout(() => setRunStatus(harness.store, id, RUN_STATUS.waiting), 100);
      const waited = parseJsonResult(await client.callTool({
        name: 'task_wait',
        arguments: { project, ids: [id], timeoutSeconds: 15 },
      }));
      expect(waited.isError).toBe(false);
      expect(waited.data).toMatchObject({
        project,
        mode: 'any',
        until: 'attention',
        timedOut: false,
        runs: [expect.objectContaining({ id, status: RUN_STATUS.waiting, attention: 'waiting' })],
      });

      const status = parseJsonResult(await client.callTool({
        name: 'task_status',
        arguments: { project, id },
      }));
      expect(status.isError).toBe(false);
      expect(status.data).toMatchObject({ id, project, status: RUN_STATUS.waiting, attention: 'waiting' });

      const sent = parseJsonResult(await client.callTool({
        name: 'task_send',
        arguments: { project, id, text: 'Proceed with verification' },
      }));
      expect(sent.isError).toBe(false);
      expect(sent.data).toMatchObject({ id, project });
      expect(['delivered', 'queued', 'deferred']).toContain(sent.data.delivery);

      const stopped = parseJsonResult(await client.callTool({
        name: 'task_stop',
        arguments: { project, id },
      }));
      expect(stopped.isError).toBe(false);
      expect(stopped.data).toMatchObject({ id, project });

      const list = parseJsonResult(await client.callTool({
        name: 'task_list',
        arguments: { project },
      }));
      expect(list.isError).toBe(false);
      expect((list.data.runs as Array<{ id: string }>).map((r) => r.id)).toContain(id);
    } finally {
      await client.close();
    }
  }, 30_000);

  it('keeps stdout strictly JSON-RPC frames with zero stray output', async () => {
    const child = spawn(process.execPath, ['--import', TSX_IMPORT, CLI_ENTRY, 'mcp', '--url', harness.origin], {
      env: cleanEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));

    const initMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'purity-test', version: '1.0.0' } },
    });
    const listMsg = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

    child.stdin.write(`${initMsg}\n${listMsg}\n`);
    await new Promise<void>((resolve, reject) => {
      // bound: wait for the two JSON-RPC responses before closing stdin.
      const timer = setTimeout(() => reject(new Error('timed out waiting for MCP stdout frames')), 15_000);
      const check = () => {
        const lines = Buffer.concat(stdoutChunks).toString('utf8').split('\n').filter((line) => line.length > 0);
        if (lines.length >= 2) {
          clearTimeout(timer);
          child.stdout.off('data', check);
          resolve();
        }
      };
      child.stdout.on('data', check);
      check();
    });
    child.stdin.end();
    const exitCode = await new Promise<number | null>((resolve) => child.once('close', resolve));
    expect(exitCode).toBe(0);

    const lines = Buffer.concat(stdoutChunks).toString('utf8').split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { jsonrpc?: unknown };
      expect(parsed.jsonrpc).toBe('2.0');
    }
  }, 20_000);

  it('refuses to start in a child process when HSQ_TASK_ID is set', async () => {
    const child = spawn(process.execPath, ['--import', TSX_IMPORT, CLI_ENTRY, 'mcp', '--url', harness.origin], {
      env: cleanEnv({ HSQ_TASK_ID: 'agent-task-1' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const exitCode = await new Promise<number | null>((resolve) => child.once('close', resolve));
    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('refuses to start inside a Squawk task');
  }, 20_000);
});
