import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunnerSkillList } from '@open-mercato/cezar-contract/runner-skills';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunResult, AgentRunSpec, AgentSession } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import * as runners from '../core/runner-factory.ts';
import { fixedSkillCatalog } from '../core/runner-skill-fixture.testkit.ts';
import { scopeFixtureProcesses } from '../delegation/process-scope.testkit.ts';
import { planOwnedWorkspace } from '../delegation/workspace.ts';
import { workerWorkflowHash } from '../delegation/execution-identity.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { plannedWorkflow, skillTaskSteps } from './types.ts';

const LAUNCH_WAIT_MS = 15_000;
const execFileAsync = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const EXTRA_PROMPT = 'EXTRA-PROMPT-790';
const WORKER_SKILL = 'worker-skill';
const WORKER_SKILL_BODY = 'WORKER-SKILL-BODY-790';
const TEAM_SKILL = 'team-playbook';

describe('skill resume continuation follow-ups (#790 review)', { timeout: 20_000 }, () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let restoreProcesses: () => void;
  let launches: Array<{ spec: AgentRunSpec }>;
  let sessions: Array<{ spec: AgentRunSpec; finish: (text?: string) => void }>;

  beforeEach(async () => {
    restoreProcesses = scopeFixtureProcesses();
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.stubEnv('CEZ_AUTONAME', '0');

    launches = [];
    sessions = [];
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-skill-resume-cont-'));
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
    await execFileAsync('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    manager = createFixtureManager(store, repoRoot);
    vi.spyOn(runners, 'createRunner').mockImplementation((backend) => ({
      backend: backend ?? 'claude',
      specSupport: CLAUDE_SPEC_SUPPORT,
      systemPromptOnResume: 'resent',
      interrupt: async () => undefined,
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
      startSession: (spec: AgentRunSpec, onEvent) => {
        launches.push({ spec });
        let resolveResult!: (value: AgentRunResult) => void;
        let open = true;
        const result = new Promise<AgentRunResult>((resolve) => { resolveResult = resolve; });
        const finish = (text = 'ok') => {
          open = false;
          resolveResult({ text, toolCalls: [], tokensUsed: 0 });
        };
        const session: AgentSession = {
          result,
          get open() { return open; },
          sendMessage: () => open,
          sendAgentMessage: () => open ? Promise.resolve() : false,
          discardQueuedMessages: () => undefined,
          holdsHumanInput: () => false,
          interrupt: () => finish(''),
          end: () => finish(''),
        };
        sessions.push({ spec, finish });
        queueMicrotask(() => onEvent?.({ type: 'session', sessionId: `sess-${launches.length}`, resumed: false }));
        return session;
      },
    }));
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const session of sessions) session.finish();
    await drainFixtureManagers(repoRoot);
    manager.dispose();
    store.flush();
    restoreProcesses();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** Give a run its own task worktree, so Continue rematerializes into it (#1024). */
  async function attachWorktree(runId: string): Promise<string> {
    const path = join(repoRoot, '.ai/cezar/worktrees', runId);
    const branch = `cez/${runId.slice(0, 8)}`;
    await execFileAsync('git', ['worktree', 'add', '-q', '-b', branch, path], { cwd: repoRoot });
    store.updateRun(runId, { worktreePath: path, branch });
    return path;
  }

  function terminalSkillRun(skillName: string, extra = EXTRA_PROMPT): string {
    const def = plannedWorkflow(skillTaskSteps(skillName));
    const record = store.createRun({
      title: 't',
      workflow: def.name,
      task: 'do the thing',
      runner: 'claude',
      systemPrompt: extra,
      steps: [{ id: 'task', name: skillName, kind: STEP_KIND.agent }],
    });
    setRunStatus(store, record.id, RUN_STATUS.done, { finishedAt: new Date().toISOString(), workflowDef: def });
    store.updateStep(record.id, 'task', {
      status: STEP_STATUS.done,
      sessionId: 'sess-skill',
      backend: 'claude',
    });
    return record.id;
  }

  it.each([true, false])('Stop during a native list read never opens Continue (worktree=%s)', async (worktree) => {
    const id = terminalSkillRun(TEAM_SKILL);
    if (worktree) await attachWorktree(id);
    const catalog = fixedSkillCatalog();
    let release!: (value: RunnerSkillList) => void;
    let read!: () => void;
    const reading = new Promise<void>(resolve => { read = resolve; });
    const held = new Promise<RunnerSkillList>(resolve => { release = resolve; });
    vi.spyOn(catalog, 'get').mockImplementation(() => { read(); return held; });
    manager.setSkillCatalog(catalog);
    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    await reading;
    expect(launches).toEqual([]);
    expect(manager.cancel(id)).toBe(true);
    release({ runner: 'claude', skills: [{ id: TEAM_SKILL, name: TEAM_SKILL, scope: 'user' }], problems: [], source: 'live' });
    // bound: cancellation must settle the operation held at the runner-list read.
    await vi.waitFor(() => expect(manager.isActive(id)).toBe(false), { timeout: LAUNCH_WAIT_MS });
    expect(launches).toEqual([]);
    expect(store.getRun(id)?.status).toBe('cancelled');
  });

  it('a selected skill missing from the native list fails Continue before opening a session', async () => {
    const id = terminalSkillRun(TEAM_SKILL);
    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    // bound: the failed list resolution ends Continue without a runner process.
    await vi.waitFor(() => expect(manager.isActive(id)).toBe(false), { timeout: LAUNCH_WAIT_MS });
    expect(launches).toEqual([]);
    expect(store.getRun(id)?.status).toBe('failed');
    expect(store.getRun(id)?.error).toContain(TEAM_SKILL);
  });

  it('Continue of a --skill worker carries a native fallback and keeps extra-only delegationSettings', async () => {
    manager.setSkillCatalog(fixedSkillCatalog([{ id: WORKER_SKILL, name: WORKER_SKILL, scope: 'user',
      path: join(repoRoot, 'account-skills', WORKER_SKILL, 'SKILL.md') }]));
    const workflowDef = plannedWorkflow(skillTaskSteps(WORKER_SKILL));
    const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
    setRunStatus(store, parent.id, RUN_STATUS.waiting, { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    const workerId = randomUUID();
    const sha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
    const workspace = await planOwnedWorkspace(repoRoot, workerId, sha);
    store.createOwnedRun({
      title: 'worker',
      task: 'do the thing',
      workflow: workflowDef.name,
      runner: 'claude',
      systemPrompt: EXTRA_PROMPT,
      workflowDef,
      steps: [{ id: 'task', name: WORKER_SKILL, kind: STEP_KIND.agent }],
    }, parent.id, randomUUID(), {
      role: 'worker', permissions: [], parentRunId: parent.id, workspace,
    }, 'a'.repeat(64), { kind: 'internal', workflowHash: workerWorkflowHash(workflowDef) });

    manager.enqueueOwnedRun(workerId);
    await vi.waitFor(() => expect(launches.length).toBe(1), { timeout: LAUNCH_WAIT_MS });
    expect(launches[0]!.spec.skill).toMatchObject({ id: WORKER_SKILL, args: 'do the thing' });
    expect(launches[0]!.spec.systemPrompt).not.toContain(WORKER_SKILL_BODY);
    expect(launches[0]!.spec.systemPrompt).toContain(EXTRA_PROMPT);
    expect(manager.delegationExecutionSettings(workerId).systemPrompt).toBe(EXTRA_PROMPT);
    expect(manager.delegationExecutionSettings(workerId).systemPrompt).not.toContain(WORKER_SKILL_BODY);
    sessions[0]!.finish();
    expect(await manager.awaitRunTermination(workerId, 15_000)).toBe(true);
    expect(['done', 'review']).toContain(store.getRun(workerId)?.status);

    expect(manager.continueRun(workerId, { text: 'keep going' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(launches.length).toBe(2), { timeout: LAUNCH_WAIT_MS });
    expect(launches[1]!.spec.skill).toBeUndefined();
    expect(launches[1]!.spec.resumeFallbackSkill).toMatchObject({ id: WORKER_SKILL, args: '' });
    expect(launches[1]!.spec.systemPrompt).not.toContain(WORKER_SKILL_BODY);
    expect(launches[1]!.spec.systemPrompt).toContain(EXTRA_PROMPT);
    expect(manager.delegationExecutionSettings(workerId).systemPrompt).toBe(EXTRA_PROMPT);
    expect(manager.delegationExecutionSettings(workerId).systemPrompt).not.toContain(`Selected skill: /${WORKER_SKILL}`);
    expect(manager.delegationExecutionSettings(workerId).systemPrompt).not.toContain(WORKER_SKILL_BODY);
    sessions[1]!.finish();
  });
});
