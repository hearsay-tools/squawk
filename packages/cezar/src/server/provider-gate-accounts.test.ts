import '../built-in-wait-kinds.testkit.ts';
import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAuthService } from '../core/provider-auth.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { codexRunner } from '../runners/codex/definition.ts';
import { opencodeRunner } from '../runners/opencode/definition.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { mergeWriteAgentAccounts } from '../workspace/agent-accounts.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { memoryWorkspaceConfig } from './provider-action-gating.testkit.ts';
import { createApp } from './server.ts';

sealTestRunners(claudeRunner, codexRunner, opencodeRunner);

/**
 * hearsay-tools/squawk#4116: the provider-status row speaks for the DEFAULT account only. A start
 * on another, connected account must pass the gate while the default account is signed out, and a
 * start on a signed-out account must be refused with a reason that names it.
 */
describe('the start gate checks the account the task runs on', () => {
  let repoRoot: string;
  let workDir: string;
  let store: RunStore;
  let startRun: ReturnType<typeof vi.fn>;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(async () => {
    // The real probe path: dry-run reports every account connected.
    delete process.env.CEZ_DRY_RUN;
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cez-gate-accounts-')));
    workDir = join(repoRoot, 'claude-work');
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    startRun = vi.fn((_workflow: WorkflowDef, input: StartRunInput) => store.createRun({
      title: 'Task',
      workflow: 'quick-task',
      task: input.task,
      runner: input.runner,
      steps: [],
    }));
    await mergeWriteAgentAccounts((accounts) => {
      accounts.accounts = [{ id: 'work', provider: 'claude', configDir: workDir, label: 'Work', addedAt: '' }];
      accounts.selections = {};
    }, testHome());
  });

  afterEach(async () => {
    await mergeWriteAgentAccounts((accounts) => {
      accounts.accounts = [];
      accounts.selections = {};
    }, testHome());
    store.persistence.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  /** Claude's default account is signed out; the `work` account's state is the test's to set. */
  const state = { workSignedIn: false };
  let providerAuth: ProviderAuthService;
  const setup = (workSignedIn: boolean) => {
    state.workSignedIn = workSignedIn;
    providerAuth = new ProviderAuthService({
      platform: 'linux',
      runCommand: async (executable, _args, _timeout, env) => {
        if (executable === 'claude') {
          const loggedIn = env?.CLAUDE_CONFIG_DIR === workDir && state.workSignedIn;
          return loggedIn
            ? { stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 }
            : { stdout: '{"loggedIn":false}', stderr: '', exitCode: 1 };
        }
        if (executable === 'codex') return { stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0 };
        return { stdout: '└  1 credential', stderr: '', exitCode: 0 };
      },
    });
    const app = createApp({ home: testHome(),
      repoRoot,
      store,
      manager: {
        startRun,
        sendMessage: vi.fn(() => true),
        continueRun: vi.fn(() => ({ ok: true })),
        // The planner's runner fails, so a plan that passes the gate answers its one-step fallback.
        createRunner: vi.fn(async () => ({ run: async () => { throw new Error('no model in tests'); } })),
      } as unknown as RunManager,
      version: 'test',
      providerAuth,
      workspaceConfig: memoryWorkspaceConfig([]),
    });
    return app;
  };

  const start = (app: Hono, agentProfile?: string) => apiRequest(app, '/api/v1/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      task: 'Task',
      runner: 'claude',
      ...(agentProfile === undefined ? {} : { agentProfile }),
      steps: [{ id: 'task', prompt: '{{task}}' }],
    }),
  });

  it('accepts a start on a connected named account while the default account is signed out', async () => {
    const response = await start(setup(true), 'work');
    expect(response.status).toBe(201);
    expect(startRun).toHaveBeenCalledTimes(1);
    expect(startRun.mock.calls[0]![1]).toMatchObject({ agentProfile: 'work' });
  });

  it('accepts a start that follows a project selection naming the connected account', async () => {
    await mergeWriteAgentAccounts((accounts) => {
      accounts.selections = { [repoRoot]: { claude: 'work' } };
    }, testHome());
    const response = await start(setup(true));
    expect(response.status).toBe(201);
  });

  it('still refuses a start on the signed-out default account', async () => {
    const response = await start(setup(true));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Claude Code credentials are unavailable. Authorize it in Settings → Agent defaults → Providers.',
    });
    expect(startRun).not.toHaveBeenCalled();
  });

  it('refuses a start on a signed-out named account and names it', async () => {
    const response = await start(setup(false), 'work');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Claude Code account "Work" is not signed in. Sign in in Settings → Agent defaults → Providers.',
    });
    expect(startRun).not.toHaveBeenCalled();
  });

  it('keeps a runtime incident authoritative for a named account that still probes connected', async () => {
    const app = setup(true);
    expect((await start(app, 'work')).status).toBe(201);
    providerAuth.reportRuntimeAuthFailure('claude');

    const response = await start(app, 'work');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Claude Code credentials are unavailable. Authorize it in Settings → Agent defaults → Providers.',
    });
  });

  const plan = (app: Hono, agentProfile?: string) => apiRequest(app, '/api/v1/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: 'Task', ...(agentProfile === undefined ? {} : { agentProfile }) }),
  });

  it('plans on a connected named account while the default account is signed out', async () => {
    const response = await plan(setup(true), 'work');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ fallback: true });
  });

  it('refuses a plan on the signed-out default account, and on a signed-out named account', async () => {
    expect((await plan(setup(true))).status).toBe(409);
    const response = await plan(setup(false), 'work');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Claude Code account "Work" is not signed in. Sign in in Settings → Agent defaults → Providers.',
    });
  });

  it('plans through the registered default when the stored default runner is not registered', async () => {
    // Dry-run reports every registered account connected, so the gate tests the resolved id, not sign-in.
    process.env.CEZ_DRY_RUN = '1';
    const app = setup(true);
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({ defaultRunner: 'ghost' }));
    const response = await plan(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ fallback: true });
  });
});
