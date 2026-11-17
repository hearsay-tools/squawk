import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunnerSkill, RunnerSkillList } from '@open-mercato/cezar-contract/runner-skills';
import { createFixtureManager, drainFixtureManagers, fixtureWork } from './fixture-cleanup.testkit.ts';
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
import { testHome } from '../home/test-home.testkit.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
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
  let semaphore: WorkspaceSemaphore;
  let oneShotCalls: ReturnType<typeof vi.fn<() => Promise<AgentRunResult>>>;
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
    semaphore = new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 1 },
      load: async () => ({ maxParallel: 1, memoryLimitMb: null }) });
    manager = createFixtureManager(store, repoRoot, { semaphore });
    oneShotCalls = vi.fn(async () => ({ text: '', toolCalls: [], tokensUsed: 0 }));
    vi.spyOn(runners, 'createRunner').mockImplementation((backend) => ({
      backend: backend ?? 'claude',
      specSupport: CLAUDE_SPEC_SUPPORT,
      systemPromptOnResume: 'resent',
      interrupt: async () => undefined,
      run: oneShotCalls,
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

  const rejectedSkills = ['missing', 'ambiguous', 'stale path', 'unavailable'] as const;
  type RejectedSkill = typeof rejectedSkills[number];

  function rejectedCatalog(kind: RejectedSkill) {
    const path = join(repoRoot, 'native', TEAM_SKILL, 'SKILL.md');
    const other = join(repoRoot, 'second', TEAM_SKILL, 'SKILL.md');
    const old = join(repoRoot, 'removed', TEAM_SKILL, 'SKILL.md');
    const closeId = `${TEAM_SKILL}-near`;
    const skills: RunnerSkill[] = kind === 'missing'
      ? [{ id: closeId, name: closeId, scope: 'repo', path }]
      : [{ id: TEAM_SKILL, name: TEAM_SKILL, scope: 'repo', path },
        ...(kind === 'ambiguous' ? [{ id: TEAM_SKILL, name: TEAM_SKILL, scope: 'repo' as const, path: other }] : [])];
    const catalog = fixedSkillCatalog(skills);
    if (kind === 'unavailable') vi.spyOn(catalog, 'get').mockResolvedValue({
      runner: 'claude', skills: [], problems: [], source: 'unavailable', reason: 'probe refused sentinel',
    });
    const evidence = kind === 'missing' ? ['missing', closeId, path]
      : kind === 'ambiguous' ? ['ambiguous', path, other]
      : kind === 'stale path' ? ['selected path', old, path]
      : ['unavailable', 'probe refused sentinel', 'Selected path: (name only)', 'Listed paths: (unavailable)'];
    return { catalog, evidence, path: kind === 'stale path' ? old : undefined };
  }

  for (const queued of [false, true]) it.each(rejectedSkills)(`%s fails Continue before any model call and releases admission (queued=${queued})`, async kind => {
    const id = terminalSkillRun(TEAM_SKILL);
    const rejected = rejectedCatalog(kind);
    if (rejected.path) store.updateStep(id, 'task', { skillPath: rejected.path });
    manager.setSkillCatalog(rejected.catalog);
    const revoke = vi.fn();
    const provision = vi.fn(() => ({ env: {}, instructions: '', restrictCrossSessionMessaging: true as const, revoke }));
    manager.setDelegationProvisioner(provision);

    expect(manager.continueRun(id, { text: 'keep going' }, queued)).toEqual({ ok: true });
    // bound: failure settlement and active-slot release are the resolver's completion signal.
    await vi.waitFor(() => {
      expect(store.getRun(id)?.status).toBe('failed');
      expect(manager.isActive(id)).toBe(false);
      expect(semaphore.busy()).toBe(0);
    }, { timeout: LAUNCH_WAIT_MS });
    const failed = store.getRun(id)!;
    expect(failed.error).toContain('claude');
    expect(failed.error).toContain('account "default"');
    expect(failed.error).toContain(TEAM_SKILL);
    for (const text of rejected.evidence) expect(failed.error).toContain(text);
    expect(failed.steps.at(-1)).toMatchObject({ status: STEP_STATUS.failed, error: failed.error });
    expect(launches).toEqual([]);
    expect(oneShotCalls).not.toHaveBeenCalled();
    expect(fixtureWork(manager).liveSessions.size).toBe(0);
    // Resolution precedes the launch preamble, so it never creates delegation grants to leak.
    expect(provision).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();

    const next = manager.startRun(plannedWorkflow([{ id: 'plain', prompt: '{{task}}' }]), {
      task: 'after the failed skill', runner: 'claude', worktree: false,
    });
    // bound: the next launch proves both the capacity slot and exclusive repo lease were released.
    await vi.waitFor(() => expect(launches).toHaveLength(1), { timeout: LAUNCH_WAIT_MS });
    expect(launches[0]!.spec.userPrompt).toContain('after the failed skill');
    expect(launches[0]!.spec.skill).toBeUndefined();
    expect(provision).toHaveBeenCalledTimes(1);
    sessions[0]!.finish();
    // bound: the fake runner has returned; wait for the normal root-run release signals.
    await vi.waitFor(() => {
      expect(manager.isActive(next.id)).toBe(false);
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(semaphore.busy()).toBe(0);
    }, { timeout: LAUNCH_WAIT_MS });
  });

  it('an unknown Continue command uses only the opening snapshot and adds no next-Continue note', async () => {
    const record = store.createRun({ title: 'plain', task: 'plain', workflow: 'quick-task', runner: 'claude',
      steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] });
    setRunStatus(store, record.id, RUN_STATUS.done, { workflowDef: plannedWorkflow([{ id: 'task', prompt: '{{task}}' }]) });
    store.updateStep(record.id, 'task', { status: STEP_STATUS.done, sessionId: 'sess-plain', backend: 'claude' });
    const catalog = fixedSkillCatalog();
    const get = vi.spyOn(catalog, 'get');
    manager.setSkillCatalog(catalog);
    expect(manager.continueRun(record.id, { text: '/unknown keep the command' })).toEqual({ ok: true });
    // bound: the spec at startSession is the opening-input delivery signal.
    await vi.waitFor(() => expect(launches).toHaveLength(1), { timeout: LAUNCH_WAIT_MS });
    expect(get).toHaveBeenCalledTimes(1);
    expect(launches[0]!.spec.userPrompt).toContain('/unknown keep the command');
    expect(launches[0]!.spec.skill).toBeUndefined();
    expect(launches[0]!.spec.resumeFallbackSkill).toBeUndefined();
    expect(store.readEvents(record.id).some(event => event.type === 'note' && String(event.message).includes('after the next Continue'))).toBe(false);
    sessions[0]!.finish();
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
