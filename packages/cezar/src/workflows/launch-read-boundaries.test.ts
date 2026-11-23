import '../built-in-run-slots.testkit.ts';
import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { spawnCapacityRefusal } from '../delegation/capacity.ts';
import '../core/created-runners.testkit.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { codexRunner } from '../runners/codex/definition.ts';
import { piRunner } from '../runners/pi/definition.ts';
import { Home } from '../home/home.ts';
import { useTestHome } from '../home/test-home.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { request } from 'node:http';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { acceptedWorkerIdentitySchema, workerWorkflowHash } from '../delegation/execution-identity.ts';
import { planOwnedWorkspace } from '../delegation/workspace.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { mergeWriteAgentAccounts } from '../workspace/agent-accounts.ts';
import { registerProject } from '../workspace/projects.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec, AgentSession, ContentBlock } from '../core/agent-runner.ts';
import * as modelPolicy from '../core/agent-model-policy.ts';
import * as modelProviders from '../agent-config/models.ts';
import * as workflows from './load.ts';
import * as configuration from '../config.ts';
import * as profiles from '../workspace/agent-profiles.ts';
import { fixedSkillCatalog } from '../core/runner-skill-fixture.testkit.ts';
import { CLAUDE_SPEC_SUPPORT } from '../runners/claude/spec-support.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { runnerHook, waitForProduct } from './run-fixture.testkit.ts';
import * as runnerFactories from '../core/runners-under-test.testkit.ts';
import { createFixtureManager, drainFixtureManagers, fixtureWork } from './fixture-manager.testkit.ts';
import type { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
// Its runs are deleted, reclaimed or archived, or start worker executions: the shipped removal slots.
import '../built-in-run-slots.testkit.ts';

sealTestRunners(claudeRunner, codexRunner, piRunner);

let root: string;
let store: RunStore;
let manager: RunManager;
let semaphore: WorkspaceSemaphore;
const opened: AgentRunSpec[] = [];
const sessions: AgentSession[] = [];
const events: Array<((event: AgentEvent) => void) | undefined> = [];
const delivered: Array<string | ContentBlock[]> = [];
const agentDelivered: ContentBlock[][] = [];
const transportTrace: Array<'agent' | 'human'> = [];
const acceptedWorkflow: WorkflowDef = { name: 'accepted', source: 'built-in', steps: [{ id: 'work', prompt: 'ACCEPTED {{task}}' }] };
const config = (values: object) => writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify(values));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-launch-boundary-'));
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  useTestHome(join(root, 'home') ? Home.sandbox(join(root, 'home')) : undefined);
  vi.stubEnv('CEZ_AUTONAME', '0');
  vi.stubEnv('CEZ_DRY_RUN', '1');
  opened.length = 0;
  sessions.length = 0;
  events.length = 0;
  delivered.length = 0;
  agentDelivered.length = 0;
  transportTrace.length = 0;
  runnerHook.runner = {
    backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {},
    startSession(spec, onEvent) {
      let open = true;
      let finish!: (result: AgentRunResult) => void;
      const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
      const end = () => { open = false; finish({ text: '', toolCalls: [], tokensUsed: 0 }); };
      const session: AgentSession = { get open() { return open; }, result, end, interrupt: end, sendMessage: content => { transportTrace.push('human'); delivered.push(content); return true; }, sendAgentMessage: async content => { transportTrace.push('agent'); agentDelivered.push(content); }, discardQueuedMessages() {}, holdsHumanInput: () => false };
      opened.push(spec);
      sessions.push(session);
      events.push(onEvent);
      queueMicrotask(() => onEvent?.({ type: 'session', sessionId: `launch-${opened.length}`, resumed: false }));
      return session;
    },
  };
  store = RunStore.open(join(root, '.ai/cezar'));
  semaphore = new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 1 } });
  manager = createFixtureManager(store, root, { home: testHome(), semaphore });
});
afterEach(async () => {
  await drainFixtureManagers(root);
  runnerHook.runner = undefined;
  store.persistence.flush();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
async function heldHead(): Promise<string> {
  const head = manager.startRun(acceptedWorkflow, { task: 'head', worktree: false });
  // bound: a real fixture session must publish its open event before the target is queued.
  await waitForProduct(manager, store, () => opened.length === 1 || store.getRun(head.id)?.status === 'failed');
  expect(store.getRun(head.id)?.error).toBeUndefined();
  expect(opened).toHaveLength(1);
  return head.id;
}
async function releaseHead(head: string): Promise<AgentRunSpec> {
  manager.cancel(head);
  // bound: the target must reach its real runner after the held task releases capacity.
  await waitForProduct(manager, store, () => opened.length === 2 || store.queries.listRuns().some(run => run.status === 'failed'));
  expect(opened).toHaveLength(2);
  return opened[1]!;
}

it.each(['edit', 'remove'] as const)('P6-01 task head keeps the accepted ad-hoc workflow after catalog %s', async change => {
  const head = await heldHead();
  manager.startRun(acceptedWorkflow, { task: 'target', worktree: false });
  const dir = join(root, '.ai/cezar/workflows');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'accepted.yaml'), 'name: accepted\nsteps:\n  - id: replacement\n    prompt: REPLACEMENT\n');
  if (change === 'remove') rmSync(join(dir, 'accepted.yaml'));
  const launched = await releaseHead(head);
  expect(launched.userPrompt).toContain('ACCEPTED target');
  expect(launched.userPrompt).not.toContain('REPLACEMENT');
});

it('P6-05 P6-09 task head reads edits and removals while retaining accepted recipe pins', async () => {
  const head = await heldHead();
  const target = manager.startRun(acceptedWorkflow, { task: 'old task', runner: 'codex', model: 'openai/gpt-5', effort: 'low', systemPrompt: 'accepted prompt', worktree: false, autonomous: true });
  const kept = manager.enqueueMessage(target.id, [{ type: 'text', text: 'old message' }]);
  const dropped = manager.enqueueMessage(target.id, [{ type: 'text', text: 'remove me' }]);
  expect(kept).not.toBeNull();
  expect(dropped).not.toBeNull();
  manager.editTask(target.id, 'edited task');
  manager.editQueuedMessage(target.id, kept!.id, { text: 'edited message' });
  manager.removeQueuedMessage(target.id, dropped!.id);
  config({ defaultRunner: 'claude', systemPrompt: 'changed default' });
  const launched = await releaseHead(head);
  expect(launched.userPrompt).toContain('ACCEPTED edited task\n\nedited message');
  expect(launched.userPrompt).not.toContain('remove me');
  expect(launched.systemPrompt).toContain('accepted prompt');
  expect(store.getRun(target.id)?.runner).toBe('codex');
  expect(launched.model).toBe('gpt-5');
  expect(launched.effort).toBe('low');
  expect(store.getRun(target.id)?.autonomous).toBe(true);
  expect(store.getRun(target.id)?.task).toBe('edited task');
  expect(store.getRun(target.id)?.queuedMessages?.map(entry => entry.text)).toEqual(['edited message']);
});

it('P6-17 P6-21 task head reads current default runner and system prompt', async () => {
  config({ defaultRunner: 'claude', systemPrompt: 'old default' });
  const head = await heldHead();
  const target = manager.startRun(acceptedWorkflow, { task: 'target', worktree: false });
  config({ defaultRunner: 'codex', systemPrompt: 'current default' });
  const launched = await releaseHead(head);
  expect(store.getRun(target.id)?.runner).toBe('codex');
  expect(launched.systemPrompt).toContain('current default');
  expect(launched.systemPrompt).not.toContain('old default');
});

it('P6-04 P6-12 P6-20 P6-24 P6-28 P6-32 P6-36 live input keeps the open session without new launch selection', async () => {
  const reads = { workflow: 0, policy: 0, provider: 0, profile: 0, runner: 0, config: 0 };
  const inFlight: Promise<unknown>[] = [];
  const load = workflows.loadWorkflows;
  vi.spyOn(workflows, 'loadWorkflows').mockImplementation((...args) => {
    const observed = load(...args).then(value => { reads.workflow++; return value; });
    inFlight.push(observed);
    return observed;
  });
  const runnerFactory = runnerFactories.runnersUnderTest();
  vi.spyOn(runnerFactories, 'runnersUnderTest').mockReturnValue((...args) => {
    const value = runnerFactory(...args); reads.runner++; return value;
  });
  const loadConfig = configuration.loadConfig;
  vi.spyOn(configuration, 'loadConfig').mockImplementation((...args) => {
    const observed = loadConfig(...args).then(value => { reads.config++; return value; });
    inFlight.push(observed);
    return observed;
  });
  const locked = modelPolicy.agentModelsLocked;
  vi.spyOn(modelPolicy, 'agentModelsLocked').mockImplementation((...args) => {
    const value = locked(...args); reads.policy++; return value;
  });
  const provider = modelProviders.readAgentModelProvider;
  vi.spyOn(modelProviders, 'readAgentModelProvider').mockImplementation((...args) => {
    const observed = provider(...args).then(value => { reads.provider++; return value; });
    inFlight.push(observed);
    return observed;
  });
  const profile = profiles.resolveProfileEnvForRoot;
  vi.spyOn(profiles, 'resolveProfileEnvForRoot').mockImplementation((...args) => {
    const observed = profile(...args).then(value => { reads.profile++; return value; });
    inFlight.push(observed);
    return observed;
  });
  const target = manager.startRun(acceptedWorkflow, { task: 'accepted task', worktree: false, systemPrompt: 'accepted prompt' });
  // bound: the source baseline is taken only after the actual session opens.
  await waitForProduct(manager, store, () => opened.length === 1 || store.getRun(target.id)?.status === 'failed');
  expect(store.getRun(target.id)?.error).toBeUndefined();
  expect(opened).toHaveLength(1);
  await Promise.all(inFlight);
  const before = { ...reads };
  for (const key of ['policy', 'provider', 'profile', 'runner', 'config'] as const) expect(before[key]).toBeGreaterThan(0);
  const originalSession = sessions[0];
  config({ defaultRunner: 'codex', systemPrompt: 'changed default' });
  expect(manager.sendMessage(target.id, [{ type: 'text', text: 'current input' }])).toBe(true);
  await Promise.all(inFlight);
  expect(delivered).toEqual([[{ type: 'text', text: 'current input' }]]);
  expect(sessions).toEqual([originalSession]);
  expect(opened).toHaveLength(1);
  expect(reads).toEqual(before);
  expect(store.getRun(target.id)?.task).toBe('accepted task');
  expect(store.getRun(target.id)?.runner).toBe('claude');
  expect(opened[0]?.systemPrompt).toContain('accepted prompt');
});

/** Use the same private tool transport as the fixture's agent. No owner or constructor spy. */
async function completeStep(index: number): Promise<void> {
  const env = opened[index]!.env!;
  const answer = await new Promise<{ ok: boolean }>((resolve, reject) => {
    const call = request({ socketPath: env.CEZ_TOOL_SOCKET, path: '/api/v1/tools/cezar_done', method: 'POST',
      headers: { authorization: `Bearer ${env.CEZ_TOOL_TOKEN}`, 'content-type': 'application/json' } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', part => { body += part; });
      response.on('end', () => { resolve(JSON.parse(body) as { ok: boolean }); });
      response.on('error', reject);
    });
    call.on('error', reject);
    call.end('{}');
  });
  expect(answer.ok).toBe(true);
  events[index]?.({ type: 'turn-end' });
}

it('P6-02 P6-06 P6-10 P6-18 P6-22 later step keeps accepted recipe after the first turn', async () => {
  const workflow: WorkflowDef = { name: 'chain', source: 'built-in', steps: [
    { id: 'first', prompt: 'FIRST {{task}}' },
    { id: 'second', prompt: 'SECOND {{task}}', runner: 'codex' },
  ] };
  const target = manager.startRun(workflow, { task: 'accepted task', systemPrompt: 'accepted prompt', worktree: false });
  // bound: the first real runner session gates amendments before the later step selects its input.
  await waitForProduct(manager, store, () => opened.length === 1 || store.getRun(target.id)?.status === 'failed');
  expect(store.getRun(target.id)?.error).toBeUndefined();
  expect(opened).toHaveLength(1);
  store.updateRun(target.id, { task: 'later amendment' });
  const catalog = join(root, '.ai/cezar/workflows');
  mkdirSync(catalog, { recursive: true });
  writeFileSync(join(catalog, 'chain.yaml'), 'name: chain\nsteps:\n  - id: first\n    prompt: FIRST {{task}}\n  - id: second\n    prompt: REPLACED {{task}}\n');
  config({ defaultRunner: 'pi', systemPrompt: 'later default' });
  await completeStep(0);
  // bound: step-end and session-open events drive the real workflow transition.
  await waitForProduct(manager, store, () => opened.length === 2 || store.getRun(target.id)?.status === 'failed');
  expect(store.getRun(target.id)?.error).toBeUndefined();
  expect(opened).toHaveLength(2);
  expect(opened[1]?.userPrompt).toContain('SECOND accepted task');
  expect(opened[1]?.userPrompt).not.toContain('later amendment');
  expect(opened[1]?.systemPrompt).toContain('accepted prompt');
  expect(opened[1]?.systemPrompt).not.toContain('later default');
  expect(store.getRun(target.id)?.steps.find(step => step.id === 'second')?.backend).toBe('codex');
});

it('P6-29 P6-30 later step reads amended effort after the first session', async () => {
  const workflow: WorkflowDef = { name: 'chain', source: 'built-in', steps: [
    { id: 'first', prompt: 'FIRST {{task}}' }, { id: 'second', prompt: 'SECOND {{task}}' },
  ] };
  const target = manager.startRun(workflow, { task: 'target', effort: 'low', worktree: false });
  // bound: effort changes only after the first step has selected and launched its own effort.
  await waitForProduct(manager, store, () => opened.length === 1 || store.getRun(target.id)?.status === 'failed');
  expect(store.getRun(target.id)?.error).toBeUndefined();
  expect(opened[0]?.effort).toBe('low');
  store.updateRun(target.id, { effort: 'high' });
  await completeStep(0);
  // bound: the later runner open is the signal that the later effort selection completed.
  await waitForProduct(manager, store, () => opened.length === 2 || store.getRun(target.id)?.status === 'failed');
  expect(store.getRun(target.id)?.error).toBeUndefined();
  expect(opened).toHaveLength(2);
  expect(opened[1]?.effort).toBe('high');
});

it('P6-26 later step reads a model lock changed after the first session', async () => {
  const workflow: WorkflowDef = { name: 'chain', source: 'built-in', steps: [
    { id: 'first', prompt: 'FIRST {{task}}' }, { id: 'second', prompt: 'SECOND {{task}}' },
  ] };
  const target = manager.startRun(workflow, { task: 'target', model: 'anthropic/claude-sonnet-4-6', effort: 'low', worktree: false });
  // bound: the first runner open proves model selection finished before the project lock changes.
  await waitForProduct(manager, store, () => opened.length === 1 || store.getRun(target.id)?.status === 'failed');
  expect(store.getRun(target.id)?.error).toBeUndefined();
  expect(opened[0]?.model).toBe('claude-sonnet-4-6');
  config({ modelsLocked: true });
  await completeStep(0);
  // bound: the later runner open proves model and effort selection ran under the new policy.
  await waitForProduct(manager, store, () => opened.length === 2 || store.getRun(target.id)?.status === 'failed');
  expect(store.getRun(target.id)?.error).toBeUndefined();
  expect(opened).toHaveLength(2);
  expect(opened[1]?.model).toBeUndefined();
  expect(opened[1]?.effort).toBeUndefined();
});

async function waitForOpen(id: string, count: number): Promise<AgentRunSpec> {
  // bound: runner-open or durable failure ends the phase; time guards only a missing product signal.
  await waitForProduct(manager, store, () => opened.length === count || store.getRun(id)?.status === 'failed');
  expect(store.getRun(id)?.error).toBeUndefined();
  expect(opened).toHaveLength(count);
  return opened[count - 1]!;
}
async function finishInitial(id: string): Promise<void> {
  await completeStep(0);
  // bound: Continue admission starts only after the completed task releases its real execution owner.
  await waitForProduct(manager, store, () => !manager.isActive(id));
  expect(store.getRun(id)?.status).toBe('done');
}
function offerNativeSkill(id: string, path = join(root, '.claude/skills', id, 'SKILL.md')): void {
  manager.setSkillCatalog(fixedSkillCatalog([{ id, name: id, scope: 'repo', path }]));
}
async function waitForSkillFailure(id: string, openedCount: number): Promise<void> {
  // bound: the durable failure proves the selected native reference was refused before spawn.
  await waitForProduct(manager, store, () => store.getRun(id)?.status === 'failed');
  expect(store.getRun(id)?.error).toContain('claude account "default" skill');
  expect(opened).toHaveLength(openedCount);
}

it('P6-03 P6-07 P6-11 P6-19 P6-23 P6-31 queued Continue keeps owning recipe and reads amended text and effort', async () => {
  const factories = vi.fn(runnerFactories.runnersUnderTest());
  vi.spyOn(runnerFactories, 'runnersUnderTest').mockReturnValue(factories);
  const target = manager.startRun(acceptedWorkflow, { task: 'accepted task', effort: 'low', systemPrompt: 'accepted prompt', worktree: false });
  await waitForOpen(target.id, 1);
  await finishInitial(target.id);
  const blocker = manager.startRun(acceptedWorkflow, { task: 'blocker', worktree: false });
  await waitForOpen(blocker.id, 2);
  expect(manager.continueRun(target.id, { text: 'old opening' }, true)).toEqual({ ok: true });
  const checkpoint = store.getRun(target.id)!.continuationMessage!;
  store.updateRun(target.id, { task: 'amended task', effort: 'high', continuationMessage: { ...checkpoint, text: 'amended opening' } });
  config({ defaultRunner: 'codex', systemPrompt: 'changed default' });
  manager.cancel(blocker.id);
  const launched = await waitForOpen(target.id, 3);
  expect(launched.resume).toBe(true);
  expect(launched.sessionId).toBe('launch-1');
  expect(launched.userPrompt).toContain('amended opening');
  expect(launched.userPrompt).toContain('amended task');
  expect(launched.systemPrompt).toContain('accepted prompt');
  expect(launched.systemPrompt).not.toContain('changed default');
  expect(launched.effort).toBe('high');
  expect(factories.mock.calls.at(-1)?.[0]).toBe('claude');
});

it('P6-13 P6-14 held queued attachments use replacement bytes and reach only the first step', async () => {
  const head = await heldHead();
  const workflow: WorkflowDef = { name: 'images', source: 'built-in', steps: [
    { id: 'first', prompt: '{{task}}' }, { id: 'second', prompt: '{{task}}' },
  ] };
  const target = manager.startRun(workflow, { task: 'target', worktree: false });
  const queued = manager.enqueueMessage(target.id, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('old bytes').toString('base64') } }]);
  expect(queued?.images).toHaveLength(1);
  const name = queued!.images![0]!.split('/').pop()!;
  writeFileSync(join(root, '.ai/cezar/runs', `${target.id}-images`, name), 'current bytes');
  const first = await releaseHead(head);
  expect(first.images).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('current bytes').toString('base64') } }]);
  await completeStep(1);
  const second = await waitForOpen(target.id, 3);
  expect(second.images).toBeUndefined();
  expect(second.userPrompt).not.toContain('Pasted attachments');
});

it('P6-08 P6-12 P6-16 live input delivers the current image blocks without changing the task', async () => {
  const target = manager.startRun(acceptedWorkflow, { task: 'accepted task', worktree: false });
  await waitForOpen(target.id, 1);
  const content: ContentBlock[] = [{ type: 'text', text: 'current message' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('current image').toString('base64') } }];
  expect(manager.sendMessage(target.id, content)).toBe(true);
  expect(delivered[0]?.slice(0, content.length)).toEqual(content);
  expect(delivered[0]?.[content.length]).toMatchObject({ type: 'text', text: expect.stringContaining('also saved on disk at:') });
  expect(store.getRun(target.id)?.task).toBe('accepted task');
  expect(opened).toHaveLength(1);
});

it('P6-25 held task retains its explicit model while honoring a lock enabled before launch', async () => {
  const head = await heldHead();
  const target = manager.startRun(acceptedWorkflow, { task: 'target', model: 'anthropic/claude-sonnet-4-6', effort: 'low', worktree: false });
  config({ modelsLocked: true });
  const launched = await releaseHead(head);
  expect(launched.model).toBeUndefined();
  expect(launched.effort).toBeUndefined();
  expect(store.getRun(target.id)?.model).toBe('anthropic/claude-sonnet-4-6');
});

it('P6-27 Continue keeps its authored model while honoring a lock enabled before reopening', async () => {
  const workflow: WorkflowDef = { name: 'authored', source: 'built-in', steps: [{ id: 'work', prompt: '{{task}}', model: 'anthropic/claude-sonnet-4-6' }] };
  const target = manager.startRun(workflow, { task: 'target', model: 'anthropic/claude-opus-4-6', worktree: false });
  const first = await waitForOpen(target.id, 1);
  expect(first.model).toBe('claude-sonnet-4-6');
  await finishInitial(target.id);
  const blocker = manager.startRun(acceptedWorkflow, { task: 'blocker', worktree: false });
  await waitForOpen(blocker.id, 2);
  expect(manager.continueRun(target.id, { text: 'Continue' }, true)).toEqual({ ok: true });
  config({ modelsLocked: true });
  manager.cancel(blocker.id);
  const continued = await waitForOpen(target.id, 3);
  expect(continued.model).toBeUndefined();
});

it('P6-25 held task reads the native provider changed after enqueue', async () => {
  const provider = vi.spyOn(modelProviders, 'readAgentModelProvider').mockResolvedValue('anthropic');
  const head = await heldHead();
  const target = manager.startRun(acceptedWorkflow, { task: 'target', model: 'claude-sonnet-4-6', worktree: false });
  provider.mockResolvedValue('gateway');
  const launched = await releaseHead(head);
  expect(launched.model).toBe('gateway/claude-sonnet-4-6');
  expect(store.getRun(target.id)?.modelIdentity).toBe('gateway/claude-sonnet-4-6');
});

it('P6-26 later step reads the native provider changed after the first session', async () => {
  const provider = vi.spyOn(modelProviders, 'readAgentModelProvider').mockResolvedValue('anthropic');
  const workflow: WorkflowDef = { name: 'providers', source: 'built-in', steps: [
    { id: 'first', prompt: '{{task}}' }, { id: 'second', prompt: '{{task}}' },
  ] };
  const target = manager.startRun(workflow, { task: 'target', model: 'claude-sonnet-4-6', worktree: false });
  const first = await waitForOpen(target.id, 1);
  expect(first.model).toBe('claude-sonnet-4-6');
  provider.mockResolvedValue('gateway');
  await completeStep(0);
  const second = await waitForOpen(target.id, 2);
  expect(second.model).toBe('gateway/claude-sonnet-4-6');
  expect(store.getRun(target.id)?.modelIdentity).toBe('gateway/claude-sonnet-4-6');
});

it('P6-27 queued Continue reads the native provider changed before reopening', async () => {
  const provider = vi.spyOn(modelProviders, 'readAgentModelProvider').mockResolvedValue('anthropic');
  const target = manager.startRun(acceptedWorkflow, { task: 'target', model: 'claude-sonnet-4-6', worktree: false });
  const first = await waitForOpen(target.id, 1);
  expect(first.model).toBe('claude-sonnet-4-6');
  await finishInitial(target.id);
  const blocker = manager.startRun(acceptedWorkflow, { task: 'blocker', worktree: false });
  await waitForOpen(blocker.id, 2);
  expect(manager.continueRun(target.id, { text: 'Continue' }, true)).toEqual({ ok: true });
  provider.mockResolvedValue('gateway');
  manager.cancel(blocker.id);
  const continued = await waitForOpen(target.id, 3);
  expect(continued.model).toBe('gateway/claude-sonnet-4-6');
  expect(store.getRun(target.id)?.modelIdentity).toBe('gateway/claude-sonnet-4-6');
});

it('P6-37 held task resolves the native skill list after admission', async () => {
  const head = await heldHead();
  const workflow: WorkflowDef = { name: 'skill', source: 'built-in', steps: [{ id: 'work', prompt: '{{task}}', skill: 'playbook' }] };
  manager.startRun(workflow, { task: 'target', worktree: false });
  const path = join(root, '.claude/skills/current-playbook/SKILL.md');
  offerNativeSkill('playbook', path);
  const launched = await releaseHead(head);
  expect(launched.skill).toEqual({ id: 'playbook', path, args: 'target' });
  expect(launched.systemPrompt).not.toContain('Selected skill:');
});

async function account(id: string): Promise<void> {
  const configDir = join(root, 'accounts', id);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'settings.json'), '{}');
  await mergeWriteAgentAccounts(state => { state.accounts.push({ id, provider: 'claude', configDir, label: id, addedAt: '' }); }, testHome());
}
async function selectAccount(id: string): Promise<void> {
  await mergeWriteAgentAccounts(state => { state.selections[root] = { ...state.selections[root], claude: id }; }, testHome());
}

it('P6-33 held task retains its account pin when the project account changes', async () => {
  await registerProject(root, undefined, testHome());
  await account('accepted');
  await account('changed');
  const head = await heldHead();
  const target = manager.startRun(acceptedWorkflow, { task: 'target', agentProfile: 'accepted', worktree: false });
  await selectAccount('changed');
  const launched = await releaseHead(head);
  expect(launched.env?.CLAUDE_CONFIG_DIR).toBe(join(root, 'accounts/accepted'));
  expect(store.getRun(target.id)?.steps[0]?.profileId).toBe('accepted');
});

it('P6-34 later fresh step reads the current project account instead of reusing the first step account', async () => {
  await registerProject(root, undefined, testHome());
  await account('first');
  await account('later');
  await selectAccount('first');
  const workflow: WorkflowDef = { name: 'accounts', source: 'built-in', steps: [{ id: 'first', prompt: '{{task}}' }, { id: 'second', prompt: '{{task}}' }] };
  const target = manager.startRun(workflow, { task: 'target', worktree: false });
  const first = await waitForOpen(target.id, 1);
  expect(first.env?.CLAUDE_CONFIG_DIR).toBe(join(root, 'accounts/first'));
  await selectAccount('later');
  await completeStep(0);
  const second = await waitForOpen(target.id, 2);
  expect(second.env?.CLAUDE_CONFIG_DIR).toBe(join(root, 'accounts/later'));
});

it.each(['changed', 'deleted'] as const)('P6-35 Continue retains recorded-account policy when the account is %s', async change => {
  await registerProject(root, undefined, testHome());
  await account('recorded');
  await account('later');
  await selectAccount('recorded');
  const target = manager.startRun(acceptedWorkflow, { task: 'target', worktree: false });
  await waitForOpen(target.id, 1);
  await finishInitial(target.id);
  await selectAccount('later');
  if (change === 'deleted') await mergeWriteAgentAccounts(state => { state.accounts = state.accounts.filter(account => account.id !== 'recorded'); }, testHome());
  expect(manager.continueRun(target.id, { text: 'Continue' })).toEqual({ ok: true });
  const continued = await waitForOpen(target.id, 2);
  expect(continued.env?.CLAUDE_CONFIG_DIR).toBe(change === 'deleted' ? undefined : join(root, 'accounts/recorded'));
  expect(store.getRun(target.id)?.steps.at(-1)?.profileId).toBe(change === 'deleted' ? 'default' : 'recorded');
});

function disableTeamSkill(kind: 'skill' | 'source'): void {
  if (kind === 'skill') writeFileSync(join(root, '.ai/cezar/ui-state.json'), JSON.stringify({ disabledTeamSkills: [{ repo: 'fixture/launch-skills', name: 'team-playbook' }] }));
  else config({ skillsRepos: [{ repo: 'fixture/launch-skills', ref: 'main', enabled: false }] });
}

it('P6-38 later step reads a replaced native skill list', async () => {
  const firstPath = join(root, '.claude/skills/first-copy/SKILL.md');
  const secondPath = join(root, '.claude/skills/second-copy/SKILL.md');
  offerNativeSkill('playbook', firstPath);
  const workflow: WorkflowDef = { name: 'skills', source: 'built-in', steps: [
    { id: 'first', prompt: '{{task}}', skill: 'playbook' }, { id: 'second', prompt: '{{task}}', skill: 'playbook' },
  ] };
  const target = manager.startRun(workflow, { task: 'target', worktree: false });
  expect((await waitForOpen(target.id, 1)).skill?.path).toBe(firstPath);
  offerNativeSkill('playbook', secondPath);
  await completeStep(0);
  expect((await waitForOpen(target.id, 2)).skill?.path).toBe(secondPath);
});

it.each(['skill', 'source'] as const)('P6-38 later step still selects a native copy after the team %s is disabled', async kind => {
  offerNativeSkill('team-playbook');
  const workflow: WorkflowDef = { name: 'skills', source: 'built-in', steps: [
    { id: 'first', prompt: '{{task}}', skill: 'team-playbook' }, { id: 'second', prompt: '{{task}}', skill: 'team-playbook' },
  ] };
  const target = manager.startRun(workflow, { task: 'target', worktree: false });
  const first = await waitForOpen(target.id, 1);
  expect(first.skill?.id).toBe('team-playbook');
  expect(first.systemPrompt).not.toContain('TEAM-LIVE-BODY');
  disableTeamSkill(kind);
  await completeStep(0);
  const second = await waitForOpen(target.id, 2);
  expect(second.skill?.id).toBe('team-playbook');
  expect(second.systemPrompt).not.toContain('TEAM-LIVE-BODY');
});

it.each(['skill', 'source'] as const)('P6-39 Continue retains the native fallback after the team %s is disabled', async kind => {
  offerNativeSkill('team-playbook');
  const workflow: WorkflowDef = { name: 'skill', source: 'built-in', steps: [{ id: 'work', prompt: '{{task}}', skill: 'team-playbook' }] };
  const target = manager.startRun(workflow, { task: 'target', worktree: false });
  const first = await waitForOpen(target.id, 1);
  expect(first.skill?.id).toBe('team-playbook');
  expect(first.systemPrompt).not.toContain('TEAM-LIVE-BODY');
  await finishInitial(target.id);
  disableTeamSkill(kind);
  expect(manager.continueRun(target.id, { text: 'Continue' })).toEqual({ ok: true });
  const continued = await waitForOpen(target.id, 2);
  expect(continued.skill).toBeUndefined();
  expect(continued.resumeFallbackSkill?.id).toBe('team-playbook');
  expect(continued.systemPrompt).not.toContain('TEAM-LIVE-BODY');
});

it.each(['skill', 'source'] as const)('P6-40 live slash keeps the native session list after the team %s is disabled', async kind => {
  await liveSlashAtBoundary(kind, 'after');
});
it.each(['skill', 'source'] as const)('P6-40 live slash accepted before turn-end keeps priority after the team %s is disabled', async kind => {
  await liveSlashAtBoundary(kind, 'before');
});
async function liveSlashAtBoundary(kind: 'skill' | 'source', order: 'before' | 'after'): Promise<void> {
  offerNativeSkill('team-playbook');
  const target = manager.startRun(acceptedWorkflow, { task: 'target', worktree: false });
  await waitForOpen(target.id, 1);
  disableTeamSkill(kind);
  if (order === 'after') {
    events[0]!({ type: 'turn-end' });
    await new Promise<void>(resolve => setImmediate(resolve)); // A human HTTP message arrives in a later task.
    expect(transportTrace).toEqual(['agent']); // Main also sends its no-wait nudge before this human message exists.
  }
  expect(manager.sendMessage(target.id, [{ type: 'text', text: '/team-playbook current input' }])).toBe(true);
  expect(delivered).toEqual([]); // Claude holds this trigger behind the running turn (D6).
  expect(transportTrace).toEqual(order === 'after' ? ['agent'] : []);
  events[0]!({ type: 'turn-end' }); // The original turn, or the nudge's turn, now releases the trigger.
  // bound: native reference resolution completes asynchronously before transport delivery.
  await waitForProduct(manager, store, () => delivered.length === 1 &&
    ![...fixtureWork(manager).pending.values()].some(label => label === 'nativeSkillInput'));
  expect(delivered).toEqual([[{ type: 'skill', id: 'team-playbook', path: join(root, '.claude/skills/team-playbook/SKILL.md'), args: 'current input' }]]);
  expect(opened).toHaveLength(1);
  expect(transportTrace).toEqual(order === 'after' ? ['agent', 'human'] : ['human']);
  expect(agentDelivered).toHaveLength(order === 'after' ? 1 : 0); // No Squawk input between human acceptance and delivery.
}

const pastedImage = (body: string) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: Buffer.from(body).toString('base64') } });
function removeImage(id: string, url: string): void {
  rmSync(join(root, '.ai/cezar/runs', `${id}-images`, url.split('/').pop()!));
}

it('P6-15 queued Continue omits an image deleted before task-head hydration', async () => {
  const target = manager.startRun(acceptedWorkflow, { task: 'target', worktree: false });
  await waitForOpen(target.id, 1);
  await finishInitial(target.id);
  const blocker = manager.startRun(acceptedWorkflow, { task: 'blocker', worktree: false });
  await waitForOpen(blocker.id, 2);
  expect(manager.continueRun(target.id, { text: 'Continue' }, true)).toEqual({ ok: true });
  const queued = manager.enqueueMessage(target.id, [pastedImage('queued bytes')]);
  expect(queued?.images).toHaveLength(1);
  removeImage(target.id, queued!.images![0]!);
  manager.cancel(blocker.id);
  const continued = await waitForOpen(target.id, 3);
  expect(continued.images).toBeUndefined();
  expect(store.eventLog.readEvents(target.id).some(event => event.type === 'note' && String(event.message).startsWith('queued attachment ') && String(event.message).endsWith(' could not be read — starting without it'))).toBe(true);
});

it('P6-ATT-C-OPEN Continue reads checkpoint files after native list discovery and retains live image precedence', async () => {
  const target = manager.startRun(acceptedWorkflow, { task: 'target', worktree: false });
  await waitForOpen(target.id, 1);
  await finishInitial(target.id);
  const blocker = manager.startRun(acceptedWorkflow, { task: 'blocker', worktree: false });
  await waitForOpen(blocker.id, 2);
  let entered!: () => void;
  let release!: () => void;
  const discovered = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const catalog = fixedSkillCatalog();
  manager.setSkillCatalog(catalog);
  const discover = catalog.get.bind(catalog);
  vi.spyOn(catalog, 'get').mockImplementation(async query => {
    const result = await discover(query);
    entered();
    await gate;
    return result;
  });
  expect(manager.continueRun(target.id, { text: 'Continue', images: [pastedImage('live checkpoint')] }, true)).toEqual({ ok: true });
  const checkpoint = store.getRun(target.id)!.continuationMessage!;
  expect(checkpoint.images).toHaveLength(1);
  expect(manager.enqueueMessage(target.id, [pastedImage('queued image')])?.images).toHaveLength(1);
  manager.cancel(blocker.id);
  try {
    await discovered;
    removeImage(target.id, checkpoint.images![0]!);
  } finally { release(); }
  const continued = await waitForOpen(target.id, 3);
  expect(continued.images).toEqual([pastedImage('live checkpoint'), pastedImage('queued image')]);
  expect(continued.userPrompt).not.toContain(checkpoint.images![0]!.split('/').pop()!);
  expect(store.eventLog.readEvents(target.id).some(event => event.type === 'note' && String(event.message).startsWith('continuation attachment ') && String(event.message).endsWith(' could not be read — starting without it'))).toBe(true);
});

it('P6-03 P6-27 Continue keeps the stored authored model after the catalog definition is removed', async () => {
  const workflow: WorkflowDef = { name: 'authored', source: 'built-in', steps: [{ id: 'work', prompt: '{{task}}', model: 'anthropic/claude-sonnet-4-6' }] };
  const target = manager.startRun(workflow, { task: 'target', model: 'anthropic/claude-opus-4-6', worktree: false });
  const first = await waitForOpen(target.id, 1);
  expect(first.model).toBe('claude-sonnet-4-6');
  await finishInitial(target.id);
  const dir = join(root, '.ai/cezar/workflows');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'authored.yaml');
  writeFileSync(file, 'name: authored\nsteps:\n  - id: work\n    prompt: REPLACED\n');
  rmSync(file);
  expect(manager.continueRun(target.id, { text: 'Continue' })).toEqual({ ok: true });
  const continued = await waitForOpen(target.id, 2);
  expect(continued.model).toBe('claude-sonnet-4-6');
});

it.each([true, false])('P6-01 restart uses persisted definition=%s and retains legacy catalog fallback', async persisted => {
  const dir = join(root, '.ai/cezar/workflows');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'accepted.yaml'), 'name: accepted\nsteps:\n  - id: work\n    prompt: CATALOG {{task}}\n');
  const target = store.createRun({ title: 'recovery', task: 'recovered', workflow: 'accepted', worktree: false,
    ...(persisted ? { workflowDef: acceptedWorkflow } : {}), steps: [{ id: 'work', name: 'work', kind: STEP_KIND.agent }] });
  await manager.recover();
  const launched = await waitForOpen(target.id, 1);
  expect(launched.userPrompt).toContain(persisted ? 'ACCEPTED recovered' : 'CATALOG recovered');
});

it('P6-13 recovery without live blocks reads current persisted bytes and reports deleted files', async () => {
  const target = store.createRun({ title: 'recovery', task: 'recovered', workflow: 'accepted', workflowDef: acceptedWorkflow,
    worktree: false, steps: [{ id: 'work', name: 'work', kind: STEP_KIND.agent }] });
  const dir = join(root, '.ai/cezar/runs', `${target.id}-images`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'current.png'), 'replacement');
  store.updateRun(target.id, { taskImages: [`/images/current.png`, '/images/deleted.png'] });
  await manager.recover();
  const launched = await waitForOpen(target.id, 1);
  expect(launched.images).toEqual([pastedImage('replacement')]);
  expect(store.eventLog.readEvents(target.id).filter(event => event.type === 'note' && String(event.message).includes('deleted.png')))
    .toEqual([expect.objectContaining({ message: 'task attachment deleted.png could not be read — starting without it' }),
      expect.objectContaining({ message: 'task attachment deleted.png could not be read — starting without it' })]);
});

it('P6-14 P6-34 a fresh retry selects the current project account and sends no opening images again', async () => {
  await registerProject(root, undefined, testHome());
  await account('first'); await account('retry'); await selectAccount('first');
  const workflow: WorkflowDef = { name: 'retry', source: 'built-in', steps: [
    { id: 'work', prompt: '{{task}}' },
    { id: 'check', command: 'test -f retry-marker || (touch retry-marker; exit 1)', onFail: { retry: 'work', max: 1 } },
  ] };
  const target = manager.startRun(workflow, { task: 'target', images: [pastedImage('first image')], worktree: false });
  const first = await waitForOpen(target.id, 1);
  expect(first.env?.CLAUDE_CONFIG_DIR).toBe(join(root, 'accounts/first'));
  expect(first.images).toEqual([pastedImage('first image')]);
  await selectAccount('retry');
  await completeStep(0);
  const retried = await waitForOpen(target.id, 2);
  expect(retried.env?.CLAUDE_CONFIG_DIR).toBe(join(root, 'accounts/retry'));
  expect(retried.images).toBeUndefined();
  expect(store.getRun(target.id)?.steps[0]?.iterations).toBe(2);
});

it.each(['skill', 'source'] as const)('P6-37 held task fails a team-only selection with its team %s disabled', async kind => {
  const head = await heldHead();
  const workflow: WorkflowDef = { name: 'skill', source: 'built-in', steps: [{ id: 'work', prompt: '{{task}}', skill: 'team-playbook' }] };
  const target = manager.startRun(workflow, { task: 'target', worktree: false });
  disableTeamSkill(kind);
  manager.cancel(head);
  await waitForSkillFailure(target.id, 1);
});

it('P6-37 held task fails a native skill removed before discovery', async () => {
  offerNativeSkill('playbook');
  const head = await heldHead();
  const target = manager.startRun({ name: 'skill', source: 'built-in', steps: [{ id: 'work', prompt: '{{task}}', skill: 'playbook' }] }, { task: 'target', worktree: false });
  manager.setSkillCatalog(fixedSkillCatalog());
  manager.cancel(head);
  await waitForSkillFailure(target.id, 1);
});

it('P6-17 P6-33 pump keeps a runnerless recovered task behind the current default account hold', async () => {
  config({ defaultRunner: 'codex' });
  const holder = store.createRun({ title: 'holder', task: 'hold', workflow: 'accepted', runner: 'codex', steps: [] });
  setRunStatus(store, holder.id, 'waiting', { autoResumeAt: new Date(Date.now() + 600_000).toISOString() });
  const target = store.createRun({ title: 'legacy', task: 'target', workflow: 'accepted', workflowDef: acceptedWorkflow,
    worktree: false, steps: [{ id: 'work', name: 'work', kind: STEP_KIND.agent }] });
  await manager.recover();
  await Promise.all([...fixtureWork(manager).pending].filter(([, label]) => label === 'pump').map(([work]) => work));
  expect(opened).toHaveLength(0);
  expect(store.getRun(target.id)?.status).toBe('queued');
  setRunStatus(store, holder.id, 'failed', { autoResumeAt: undefined });
  await semaphore.release();
  await waitForOpen(target.id, 1);
  expect(store.getRun(target.id)?.runner).toBe('codex');
});

it('P6-35 Continue worker identity wins over a conflicting recorded account', async () => {

  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
  const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'accepted', steps: [] });
  setRunStatus(store, parent.id, 'waiting', { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const workspace = await planOwnedWorkspace(root, randomUUID(), sha);
  const homePath = join(root, 'accepted-account');
  mkdirSync(homePath, { recursive: true });
  const account = { provider: 'claude', profileId: 'accepted', homePath, claudeLayout: { kind: 'relocated' } };
  const identity = acceptedWorkerIdentitySchema.parse({ kind: 'accepted', account, grants: {}, workflowHash: workerWorkflowHash(acceptedWorkflow),
    steps: [{ stepId: 'work', account, grants: {} }] });
  const target = store.createOwnedRun({ title: 'worker', task: 'target', runner: 'claude', agentProfile: 'accepted', workflow: 'accepted',
    workflowDef: acceptedWorkflow, steps: [{ id: 'work', name: 'work', kind: STEP_KIND.agent }] }, parent.id, randomUUID(),
    { role: 'worker', permissions: [], parentRunId: parent.id, workspace }, 'a'.repeat(64), spawnCapacityRefusal, identity);
  manager.enqueueOwnedRun(target.id);
  const first = await waitForOpen(target.id, 1);
  expect(first.env?.CLAUDE_CONFIG_DIR).toBe(homePath);
  await finishInitial(target.id);
  const blocker = manager.startRun(acceptedWorkflow, { task: 'blocker', worktree: false });
  await waitForOpen(blocker.id, 2);
  expect(manager.continueRun(target.id, { text: 'Continue' }, true)).toEqual({ ok: true });
  store.updateStep(target.id, 'work', { profileId: 'conflicting-account' });
  manager.cancel(blocker.id);
  const continued = await waitForOpen(target.id, 3);
  expect(continued.resume).toBe(true);
  expect(continued.env?.CLAUDE_CONFIG_DIR).toBe(homePath);
  expect(store.getRun(target.id)?.steps.at(-1)?.profileId).toBe('accepted');
});

function initGit(): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
}
function holdAccount(runner: 'claude' | 'codex'): string {
  const holder = store.createRun({ title: 'hold', task: 'hold', workflow: 'accepted', runner, steps: [] });
  setRunStatus(store, holder.id, 'waiting', { autoResumeAt: new Date(Date.now() + 600_000).toISOString() });
  return holder.id;
}

it('P6-14 opening attachments are selected after awaited worktree setup', async () => {
  initGit();
  config({ worktreeSetup: { commands: ['rm "$CEZ_PROJECT_ROOT/.ai/cezar/runs/$CEZ_TASK_ID-images/pasted-1.png"'] } });
  const target = manager.startRun(acceptedWorkflow, { task: 'target', images: [pastedImage('live bytes')] });
  const launched = await waitForOpen(target.id, 1);
  expect(store.getRun(target.id)?.worktreeSetup?.status).toBe('done');
  expect(launched.images).toEqual([pastedImage('live bytes')]);
  expect(launched.userPrompt).not.toContain('also saved on disk at:');
  expect(store.eventLog.readEvents(target.id).filter(event => event.type === 'note' && String(event.message).includes('pasted-1.png')))
    .toEqual([expect.objectContaining({ message: 'task attachment pasted-1.png could not be read — starting without it' })]);
});

it('P6-17 P6-33 startup rechecks an account hold added after dequeue', async () => {
  let entered!: () => void; let release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const load = configuration.loadConfig;
  vi.spyOn(configuration, 'loadConfig').mockImplementation(async (...args) => { const value = await load(...args); entered(); await gate; return value; });
  const target = manager.startRun(acceptedWorkflow, { task: 'target', worktree: false });
  let holder!: string;
  try { await reached; holder = holdAccount('claude'); } finally { release(); }
  // bound: the durable requeue note is emitted by the startup hold gate after config completes.
  await waitForProduct(manager, store, () => opened.length > 0 || store.eventLog.readEvents(target.id).some(event => event.type === 'note' && String(event.message).includes('this agent account is waiting')));
  expect(opened).toHaveLength(0);
  expect(store.getRun(target.id)?.status).toBe('queued');
  setRunStatus(store, holder, 'failed', { autoResumeAt: undefined });
  await semaphore.release();
  await waitForOpen(target.id, 1);
});

it('P6-17 P6-33 startup rechecks an account hold after the repository-root lease', async () => {
  initGit();
  manager.dispose();
  semaphore = new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 2 } });
  manager = createFixtureManager(store, root, { home: testHome(), semaphore });
  const head = await heldHead();
  const target = manager.startRun(acceptedWorkflow, { task: 'target', runner: 'codex', worktree: false });
  // bound: the lease wait note proves dequeue and initial hold admission completed.
  await waitForProduct(manager, store, () => store.eventLog.readEvents(target.id).some(event => event.type === 'note' && String(event.message).includes('waiting for exclusive access')));
  const holder = holdAccount('codex');
  manager.cancel(head);
  // bound: the post-lease gate emits this durable note after the holder releases the tree.
  await waitForProduct(manager, store, () => opened.length > 1 || store.eventLog.readEvents(target.id).some(event => event.type === 'note' && String(event.message).includes('this agent account is waiting')));
  expect(opened).toHaveLength(1);
  expect(store.getRun(target.id)?.status).toBe('queued');
  setRunStatus(store, holder, 'failed', { autoResumeAt: undefined });
  await semaphore.release();
  await waitForOpen(target.id, 2);
  expect(store.getRun(target.id)?.runner).toBe('codex');
});

it('P6-35 queued Continue checks current availability of its recorded account after acceptance', async () => {
  await registerProject(root, undefined, testHome());
  await account('recorded'); await account('later'); await selectAccount('recorded');
  const target = manager.startRun(acceptedWorkflow, { task: 'target', worktree: false });
  await waitForOpen(target.id, 1); await finishInitial(target.id);
  const blocker = manager.startRun(acceptedWorkflow, { task: 'blocker', worktree: false });
  await waitForOpen(blocker.id, 2);
  expect(manager.continueRun(target.id, { text: 'Continue' }, true)).toEqual({ ok: true });
  await selectAccount('later');
  await mergeWriteAgentAccounts(state => { state.accounts = state.accounts.filter(account => account.id !== 'recorded'); }, testHome());
  manager.cancel(blocker.id);
  const continued = await waitForOpen(target.id, 3);
  expect(continued.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
  expect(store.getRun(target.id)?.steps.at(-1)?.profileId).toBe('default');
});

it('P6-26 later step keeps its authored model ahead of the accepted run model', async () => {
  const workflow: WorkflowDef = { name: 'models', source: 'built-in', steps: [
    { id: 'first', prompt: '{{task}}' }, { id: 'second', prompt: '{{task}}', model: 'anthropic/claude-sonnet-4-6' },
  ] };
  const target = manager.startRun(workflow, { task: 'target', model: 'anthropic/claude-opus-4-6', worktree: false });
  const first = await waitForOpen(target.id, 1);
  expect(first.model).toBe('claude-opus-4-6');
  await completeStep(0);
  const second = await waitForOpen(target.id, 2);
  expect(second.model).toBe('claude-sonnet-4-6');
});
