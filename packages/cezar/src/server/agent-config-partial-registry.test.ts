import { sealTestRunners } from '../core/runner-registry.testkit.ts';
// These tests register Codex alone: the agent-config listing reads only the registered runners.
import { codexRunner } from '../runners/codex/definition.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

sealTestRunners(codexRunner);

// hearsay-tools/squawk#3900: Claude's MCP state belongs to the Claude runner. Without it the
// listing still answers, with Codex's files and no Claude MCP state.
describe('the agent-config API without a registered Claude runner', () => {
  let repoRoot: string;
  let store: RunStore;
  const prevRemote = process.env.CEZ_REMOTE;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-agentcfg-codex-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });
  afterEach(() => {
    store.persistence.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (prevRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = prevRemote;
  });

  it.each([
    ['locally', undefined, true],
    ['in hosted mode', '1', false],
  ])('GET lists Codex\'s files and no Claude MCP state %s', async (_mode, remote, editable) => {
    if (remote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = remote;
    const app = createApp({ home: testHome(), repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', squawkPort: () => 4321 });
    const res = await apiRequest(app, '/api/v1/agent-config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { editable: boolean; userMcp: unknown; files: { id: string; runners: string[] }[] };
    expect(body.editable).toBe(editable);
    expect(body.userMcp).toBeNull();
    expect(body.files.map((file) => `${file.id} ${file.runners.join(',')}`)).toEqual([
      'codex.user.config codex', 'codex.project.config codex', 'codex.user.memory codex', 'project.agents codex',
    ]);
  });
});
