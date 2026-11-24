import '../built-in-run-slots.testkit.ts';
/**
 * Worker and delegation fixtures for the harness parity matrix: owned workers, parent replies,
 * and skill parents that run against real `DelegationController` / `DelegationService`.
 *
 * Kept separate from `workflow-parity-core.testkit.ts` so non-worker parity tests do not load
 * `delegation/provision.ts` or `delegation/service.ts` (hearsay-tools/squawk#4176).
 */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { agentInputSchema } from '@open-mercato/cezar-contract/agent-input';
import { RUN_STATUS, STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { spawnCapacityRefusal } from '../delegation/capacity.ts';
import { scopeFixtureProcesses } from '../delegation/process-scope.testkit.ts';
import { DelegationController } from '../delegation/provision.ts';
import { workerWorkflowHash, type WorkerExecutionIdentity } from '../delegation/execution-identity.ts';
import { planOwnedWorkspace } from '../delegation/workspace.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { historyPaths } from '../runs/history-file.ts';
import { setRunStatus, readPersistedRuns, seedRuns } from '../runs/run-store.testkit.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { createFixtureManager, drainFixtureManagers } from '../workflows/fixture-manager.testkit.ts';
import { RunManager } from '../workflows/run.ts';
import { plannedWorkflow, skillTaskSteps, stepKind, type WorkflowDef } from '../workflows/types.ts';
import type { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { profileEnv } from './agent-profiles.ts';
import { fixedSkillCatalog } from './runner-skill-fixture.testkit.ts';
import { HARNESS_ADAPTERS, promptFor, waitFor, type ScenarioName } from './harness-parity-core.testkit.ts';
import { trackTurnBookkeeping } from './workflow-parity-core.testkit.ts';

const execFileAsync = promisify(execFile);
const GIT_IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * The owning parent answers the worker's pending question (hearsay-tools/cezarion#2410): the reply is
 * committed with its outcome as `service.send` does, and goes to the worker through the answer seam a
 * human answer used before. A worker's question has one addressee, so no human answers it.
 */
export async function answerAsParent(store: RunStore, manager: RunManager, parentRunId: string, workerRunId: string, text: string): Promise<string> {
  await waitFor(() => store.transcriptFacts.transcriptFacts(workerRunId).pendingAsk?.routedMessageId !== undefined);
  const requestId = store.transcriptFacts.transcriptFacts(workerRunId).pendingAsk!.routedMessageId!;
  const root = store.getRun(parentRunId)?.delegation;
  if (root?.role !== 'root' || !root.conversation) throw Error('the parent has no conversation');
  const now = new Date().toISOString();
  const id = randomUUID();
  const attribution = { senderRunId: parentRunId, recipientRunId: workerRunId, kind: 'reply' as const, requestId };
  const state = root.conversation;
  store.commitConversation(parentRunId, {
    messages: [...state.messages, { id, ...attribution, text, createdAt: now, requestHash: 'b'.repeat(64), state: 'accepted' }],
    outcomes: [...state.outcomes, { requestId, status: 'replied', observedAt: now, replyId: id }],
  }, { recipientRunId: workerRunId, input: { id, source: agentInputSchema.shape.source.enum.agent, parentRunId, text, createdAt: now, conversation: attribution } });
  manager.deliverConversationInput(workerRunId);
  return id;
}

function readOptional(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); } catch { return undefined; }
}

type OwnedInputOptions = NonNullable<Parameters<typeof withOwnedInputRun>[3]>;

function prepareOwnedInputEnvironment(backend: string, scenario: ScenarioName, options: OwnedInputOptions): () => void {
  const adapter = HARNESS_ADAPTERS[backend]!;
  const savedBin = process.env[adapter.binEnv]!;
  const savedExtraBins = (options.extraBackends ?? []).map(extra => [HARNESS_ADAPTERS[extra]!.binEnv, process.env[HARNESS_ADAPTERS[extra]!.binEnv]] as const);
  for (const extra of options.extraBackends ?? []) process.env[HARNESS_ADAPTERS[extra]!.binEnv] = HARNESS_ADAPTERS[extra]!.mockBin;
  const savedDry = process.env.CEZ_DRY_RUN;
  const savedAutoName = process.env.CEZ_AUTONAME;
  // The worker ignores Squawk's no-wait nudge (hearsay-tools/cezarion#1234) and reaches its plain
  // park, so input delivery is what these fixtures decide. `options.env` may opt back in.
  const env = { CEZ_MOCK_NUDGE_REPLY: 'plain', ...adapter.scenarioEnv?.[scenario], ...options.env };
  const savedEnv = Object.keys(env).map(name => [name, process.env[name]] as const);
  Object.assign(process.env, env);
  // Naming is a separate auxiliary invocation, not part of input delivery.
  process.env.CEZ_AUTONAME = '0';
  process.env[adapter.binEnv]! = options.mockBin ?? adapter.mockBin;
  delete process.env.CEZ_DRY_RUN;
  return () => {
    if (savedBin === undefined) delete process.env[adapter.binEnv];
    else process.env[adapter.binEnv]! = savedBin;
    for (const [name, saved] of savedExtraBins) {
      if (saved === undefined) delete process.env[name]; else process.env[name] = saved;
    }
    if (savedDry !== undefined) process.env.CEZ_DRY_RUN = savedDry;
    if (savedAutoName === undefined) delete process.env.CEZ_AUTONAME;
    else process.env.CEZ_AUTONAME = savedAutoName;
    for (const [name, saved] of savedEnv) {
      if (saved === undefined) delete process.env[name]; else process.env[name] = saved;
    }
  };
}

async function createOwnedInputRepository(repoRoot: string): Promise<string> {
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  await execFileAsync('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
  await execFileAsync('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
  await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: repoRoot });
  await execFileAsync('git', ['config', 'user.email', 'test@local'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
  await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
  await execFileAsync('git', ['commit', '-q', '-m', 'base'], { cwd: repoRoot });
  const sha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
  return sha;
}

function createOwnedInputParent(store: RunStore): RunRecord {
  const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
  // A live root with its own unanswered question survives recovery without
  // launching a parent process. A terminal root correctly cancels its workers.
  setRunStatus(store, parent.id, RUN_STATUS.waiting);
  // It may message its workers, as provisioned roots do, so it answers their questions
  // (hearsay-tools/cezarion#2410).
  store.commitDelegation([{ id: parent.id, delegation: { role: 'root', permissions: ['spawn', 'steer'], receipts: [] } }]);
  store.eventLog.appendEvent(parent.id, { type: 'ask.requested', requestId: randomUUID(), questions: [{
    header: 'Parent', question: 'Which parent task should follow?',
    options: [{ label: 'First task' }, { label: 'Second task' }],
  }] });
  return parent;
}

async function createOwnedInputWorker(
  store: RunStore, repoRoot: string, runId: string, parentRunId: string, sha: string,
  backend: string, scenario: ScenarioName, options: OwnedInputOptions,
): Promise<void> {
  const workspace = await planOwnedWorkspace(repoRoot, runId, sha);
  const workflowDef = options.workflowDef;
  store.createOwnedRun({ title: 'worker', task: promptFor(backend, scenario), workflow: workflowDef?.name ?? 'quick-task', runner: backend,
    ...(options.agentProfile === undefined ? {} : { agentProfile: options.agentProfile }),
    ...(workflowDef ? { workflowDef } : {}),
    steps: workflowDef
      ? workflowDef.steps.map(step => ({ id: step.id, name: step.name ?? step.id, kind: stepKind(step) }))
      : [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] }, parentRunId, randomUUID(), {
    role: 'worker', parentRunId, permissions: [], workspace,
  }, 'a'.repeat(64), spawnCapacityRefusal, options.identity ?? { kind: 'internal', ...(workflowDef ? { workflowHash: workerWorkflowHash(workflowDef) } : {}) });
}

interface OwnedInputState {
  store: RunStore | undefined;
  manager: RunManager | undefined;
  runId: string | undefined;
  drainBookkeeping: () => Promise<void>;
}

async function restartOwnedInputRun(
  state: OwnedInputState, repoRoot: string, parentRunId: string, options: OwnedInputOptions,
  beforeOpen?: (dataDir: string) => void,
): Promise<{ store: RunStore; manager: RunManager }> {
  state.store!.persistence.flush();
  const dataDir = join(repoRoot, '.ai/cezar');
  const index = readPersistedRuns(dataDir);
  // The transcripts belong to the checkpoint too: the cancel that stops the processes below
  // writes its own events (a worker's question closes when it stops,
  // hearsay-tools/cezarion#2410), which a real crash never wrote. Their facts are a cache
  // written behind them, so recovery rebuilds those from the restored transcripts.
  const histories = [parentRunId, state.runId!].map(id => [historyPaths(dataDir, id).plain, readOptional(historyPaths(dataDir, id).plain)] as const);
  // Stop only test-owned processes, then restore the precise pre-crash disk
  // checkpoint. No fake manager/session: recovery opens a new real store.
  state.manager!.cancel(state.runId!);
  await waitFor(() => !state.manager!.isActive(state.runId!));
  await state.drainBookkeeping();
  state.manager!.dispose();
  state.store!.close();
  seedRuns(dataDir, index);
  for (const [path, content] of histories) {
    if (content === undefined) rmSync(path, { force: true });
    else writeFileSync(path, content);
  }
  for (const id of [parentRunId, state.runId!]) rmSync(historyPaths(dataDir, id).facts, { force: true });
  beforeOpen?.(join(repoRoot, '.ai/cezar'));
  state.store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
  state.manager = createFixtureManager(state.store, repoRoot, options);
  state.drainBookkeeping = trackTurnBookkeeping(state.manager);
  await state.manager.recover();
  return { store: state.store, manager: state.manager };
}

async function teardownOwnedInputRun(
  state: OwnedInputState, repoRoot: string, restoreEnvironment: () => void, restoreProcesses: () => void,
): Promise<void> {
  try {
    if (state.runId && state.manager) {
      state.manager.cancel(state.runId);
      await waitFor(() => !state.manager!.isActive(state.runId!));
    }
    await state.drainBookkeeping();
    await drainFixtureManagers(repoRoot);
    state.manager?.dispose();
    state.store?.close();
    restoreEnvironment();
    rmSync(repoRoot, { recursive: true, force: true });
  } finally { restoreProcesses(); }
}

/** An owned worker, using real disk/Git state and the native wire mocks for `BUILT_IN_RUNNER_IDS`. */
export async function withOwnedInputRun(
  backend: string,
  scenario: ScenarioName,
  body: (fixture: {
    repoRoot: string; runId: string; parentRunId: string;
    store: RunStore; manager: RunManager;
    /** The parent answers the worker's pending question; returns the reply's ID. */
    answer: (text: string) => Promise<string>;
    restart: (beforeOpen?: (dataDir: string) => void) => Promise<{ store: RunStore; manager: RunManager }>;
    /** Transfer fixture teardown to a reopened context without cancelling the old cleanup. */
    adoptContext: (context: { store: RunStore; manager: RunManager }) => Promise<void>;
  }) => Promise<void>,
  options: {
    /** A persisted catalog definition the worker runs instead of quick-task (#451). */
    workflowDef?: WorkflowDef | undefined;
    /** Internal runner deadlines for this fixture, including restarts. */
    timings?: Partial<import('./runner-runtime.ts').RunnerTimings>;
    /** The private identity evidence to write instead of the internal marker (#452); its run-level
     *  account must match `runner`/`agentProfile` on the record, as acceptance guarantees. */
    identity?: WorkerExecutionIdentity;
    agentProfile?: string;
    /** Further runners a mixed chain launches; their mocks are wired for the fixture's lifetime. */
    extraBackends?: readonly string[];
    /** Environment overrides restored after the native mock worker settles. */
    env?: Record<string, string>;
    /** Preserve a legacy native-wire fixture while the backend default changes. */
    mockBin?: string;
    noWaitNudgeReplyMs?: number;
    /** Admission capacity owned by the caller; omission keeps the manager default. */
    semaphore?: WorkspaceSemaphore;
  } = {},
): Promise<void> {
  const restoreEnvironment = prepareOwnedInputEnvironment(backend, scenario, options);
  const repoRoot = mkdtempSync(join(tmpdir(), `cez-owned-input-${backend}-`));
  // This fixture owns every native mock process; ambient host daemons cannot hold its new repo.
  const restoreProcesses = scopeFixtureProcesses();
  const state: OwnedInputState = { store: undefined, manager: undefined, runId: undefined, drainBookkeeping: async () => {} };
  try {
    const sha = await createOwnedInputRepository(repoRoot);
    state.store = RunStore.open(join(repoRoot, '.ai/cezar'));
    const parent = createOwnedInputParent(state.store);
    state.runId = randomUUID();
    await createOwnedInputWorker(state.store, repoRoot, state.runId, parent.id, sha, backend, scenario, options);
    state.manager = createFixtureManager(state.store, repoRoot, options);
    state.drainBookkeeping = trackTurnBookkeeping(state.manager);
    const adoptContext = async (context: { store: RunStore; manager: RunManager }) => {
      await state.drainBookkeeping();
      state.store = context.store;
      state.manager = context.manager;
      state.drainBookkeeping = trackTurnBookkeeping(state.manager);
    };
    const restart = (beforeOpen?: (dataDir: string) => void) => restartOwnedInputRun(state, repoRoot, parent.id, options, beforeOpen);
    const answer = (text: string) => answerAsParent(state.store!, state.manager!, parent.id, state.runId!, text);
    await body({ repoRoot, runId: state.runId, parentRunId: parent.id, store: state.store, manager: state.manager, answer, restart, adoptContext });
  } finally {
    await teardownOwnedInputRun(state, repoRoot, restoreEnvironment, restoreProcesses);
  }
}

/** Launch a skill-driven parent and accept its child through the real session settings/service.
 * Native mock recordings stay in each run's cwd; no worker prompt is supplied by the fixture. */
export async function withSkillParentRun(
  backend: string,
  env: Record<string, string>,
  body: (fixture: { repoRoot: string; parentRunId: string; runId: string; store: RunStore; manager: RunManager }) => Promise<void>,
): Promise<void> {
  const adapter = HARNESS_ADAPTERS[backend]!;
  const repoRoot = mkdtempSync(join(tmpdir(), `cez-skill-parent-${backend}-`));
  // Acceptance binds the live parent's account, and spawn requires that directory to exist.
  // Supply an empty test-owned home rather than relying on an installed host login.
  const accountHome = join(repoRoot, 'account');
  mkdirSync(accountHome);
  const overrides = { ...env, ...profileEnv(backend, accountHome), CEZ_HOME: join(repoRoot, 'workspace-home'),
    [adapter.binEnv]: adapter.mockBin, CEZ_AUTONAME: '0' };
  const saved = Object.keys({ ...overrides, CEZ_DRY_RUN: '' }).map(name => [name, process.env[name]] as const);
  Object.assign(process.env, overrides);
  delete process.env.CEZ_DRY_RUN;
  let store: RunStore | undefined;
  let manager: RunManager | undefined;
  let controller: DelegationController | undefined;
  let drainBookkeeping = async () => {};
  try {
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
    await execFileAsync('git', [...GIT_IDENTITY, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot, { skillCatalog: fixedSkillCatalog([{
      id: 'probe-project', name: 'probe-project', scope: 'repo', path: join(repoRoot, '.agents/skills/probe-project/SKILL.md'),
    }]) });
    drainBookkeeping = trackTurnBookkeeping(manager);
    controller = await DelegationController.start();
    controller.attachProject({ home: testHome(), id: 'project', root: repoRoot, store, manager });
    const parent = manager.startRun(plannedWorkflow(skillTaskSteps('probe-project')), {
      task: promptFor(backend, 'baseline'), runner: backend, worktree: false, systemPrompt: 'parent extra',
    });
    await waitFor(() => store!.getRun(parent.id)?.status === 'waiting', 30_000);
    // Authenticate a test-owned caller through the real registry. Execution settings still
    // come exclusively from the parent's actual live native session.
    const caller = controller.credentials.authenticate(controller.credentials.issue('project', parent.id, randomUUID()))!;
    const child = await controller.service.spawn(caller, {
      task: promptFor(backend, 'cezar-done'), baseline: 'HEAD', requestId: randomUUID(),
    });
    await body({ repoRoot, parentRunId: parent.id, runId: child.workerId, store, manager });
  } finally {
    for (const id of store?.queries.listRunIds() ?? []) manager?.cancel(id);
    if (manager && store) await waitFor(() => store!.queries.listRunIds().every(id => !manager!.isActive(id)), 30_000);
    await drainBookkeeping();
    await controller?.close();
    await drainFixtureManagers(repoRoot);
    manager?.dispose();
    store?.close();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(repoRoot, { recursive: true, force: true });
  }
}
