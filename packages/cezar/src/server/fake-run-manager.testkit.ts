import { randomUUID } from 'node:crypto';
import { workerWaitEntryToLegacy, type DeadlinedWorkerWaitEntry } from '@open-mercato/cezar-contract/waits';
import type { InboxClaim } from '@open-mercato/cezar-contract/agent-input';
import { RunnerSkillCatalog } from '../core/runner-skill-catalog.ts';
import { delegationExecutionSettings, selectDelegationExecutionSettings } from '../delegation/execution-settings.ts';
import { enqueueAgentInput, hasLiveInboxClaim } from '../delegation/input.ts';
import { DelegationPolicyError } from '../delegation/policy.ts';
import { extractTaskRefs, refineTaskRefs } from '../runs/task-refs.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { atTaskHead } from '../workflows/run/launch-read-resolver.ts';
import { WAIT_KINDS } from '../workflows/run/wait-kinds.ts';
import type { RunManager } from '../workflows/run.ts';
import { assertProjectAdmitted } from './cockpit-ownership.ts';
import { projectPaths } from '../project-paths.ts';
import type { ProjectRunManager, RunManagerFactory } from './project-context.ts';
import type { Home } from '../home/home.ts';
import { testHome } from '../home/test-home.testkit.ts';

type Options = Parameters<RunManagerFactory>[2];
type Method<K extends keyof RunManager> = RunManager[K] extends (...args: infer A) => unknown ? A : never;

/** The event the engine writes when Stop takes a run out of the scheduler's line. */
const CANCELLED_WHILE_QUEUED = 'cancelled while queued';

function notFaked(name: string): never {
  throw new Error(`FakeRunManager.${name} is not faked: use the engine testkit for a test that needs it`);
}

/**
 * A run engine for tests that drive routes, delegation bookkeeping or the CLI without running a session
 * (hearsay-tools/squawk#3937). It writes what the engine writes to the store when a run is accepted, queued,
 * stopped or finished before any session starts, and nothing more: no scheduler, no runner, no waits, no
 * recovery. A run it accepts stays queued until the test moves it. `fake-run-manager.contract.test.ts`
 * runs the same cases against the engine, so the two cannot drift.
 *
 * Every method is a real method, so a test can `vi.spyOn` it. A method a test reaches but no fake test
 * needs throws, naming itself.
 */
export class FakeRunManager implements ProjectRunManager {
  readonly #store: RunStore;
  readonly #root: string;
  readonly #options: Options;
  readonly #queued = new Set<string>();
  #skillCatalog: RunnerSkillCatalog | undefined;
  #cockpit: { origin: string; projectId: string } | undefined;
  #disposed = false;

  constructor(store: RunStore, root: string, options: Options) {
    this.#store = store;
    this.#root = root;
    this.#options = options;
    this.#skillCatalog = options.skillCatalog;
    this.#cockpit = options.cockpit;
  }

  get disposed(): boolean { return this.#disposed; }
  get createRunner(): RunManager['createRunner'] { return this.#options.createRunner; }
  get previewHost(): RunManager['previewHost'] { return this.#options.preview; }

  async recover(): Promise<void> {}
  dispose(): void { this.#disposed = true; this.#queued.clear(); }

  setCockpitAddress(address: { origin: string; projectId: string } | undefined): void { this.#cockpit = address; }
  cockpitAddress(): { origin: string; projectId: string } | undefined { return this.#cockpit; }
  setAutomationTools(): void {}
  setSkillCatalog(catalog: RunnerSkillCatalog): void { this.#skillCatalog = catalog; }
  runnerSkills(...[query]: Method<'runnerSkills'>): ReturnType<RunManager['runnerSkills']> {
    this.#skillCatalog ??= new RunnerSkillCatalog({ adapters: {} });
    return this.#skillCatalog.get(query);
  }
  setDelegationProvisioner(): () => void { return () => {}; }
  setWorkerWorkspaces(): void {}
  pauseWorkerCleanup(): void {}
  recoverWorkerCleanup(): void {}

  // --- Accepting runs -----------------------------------------------------------------------------

  /** The engine's acceptance writes, without the job it queues: the run stays queued. */
  startRun(...[workflow, input, clientRequest]: Method<'startRun'>): RunRecord {
    assertProjectAdmitted(projectPaths(this.#root).write);
    if (atTaskHead.images(input)?.length) notFaked('startRun with attachments');
    const effective = atTaskHead.acceptInput(this.#root, input, this.#options.home);
    const run = this.#store.createRun(atTaskHead.acceptedRunFields(input, workflow, effective, clientRequest));
    // The row exists from here on: a later write that throws still leaves the run queued, as in the engine.
    try {
      this.#store.updateRun(run.id, atTaskHead.acceptedWorkflowFields(workflow));
      const refs = refineTaskRefs(extractTaskRefs(atTaskHead.task(input)), atTaskHead.skillHint(workflow));
      if (refs.prNumber !== undefined || refs.issueNumber !== undefined) {
        this.#store.updateRun(run.id, {
          ...(refs.prNumber !== undefined ? { prNumber: refs.prNumber } : {}),
          ...(refs.issueNumber !== undefined ? { issueNumber: refs.issueNumber } : {}),
        });
      }
    } finally {
      this.#queued.add(run.id);
    }
    return this.#store.getRun(run.id)!;
  }

  startRunIdempotent(...[workflow, input, request]: Method<'startRunIdempotent'>): ReturnType<RunManager['startRunIdempotent']> {
    const existing = this.#store.findRunByClientRequestId(request.id);
    if (existing) return existing.clientRequestHash === request.hash ? { run: existing, created: false } : { conflict: true };
    return { run: this.startRun(workflow, input, request), created: true };
  }

  /** An owned worker the store already accepted joins the line, as the engine's admission does. */
  enqueueOwnedRun(runId: string): void {
    const run = this.#store.getRun(runId);
    if (!run || run.status !== 'queued') throw new DelegationPolicyError('incompatible_state', 'Owned queued run not found');
    this.#queued.add(runId);
  }

  // --- Run controls ---------------------------------------------------------------------------------

  isActive(runId: string): boolean { return this.#queued.has(runId); }

  /** The engine's Stop on a run no session holds: a queued run leaves the line, a worker's queued proof completes. */
  cancel(runId: string): boolean {
    if (this.#store.claims.writeRefusal(runId)) return false;
    const queued = this.#queued.has(runId);
    const run = this.#store.getRun(runId);
    if (run?.delegation?.role === 'worker') {
      if (queued || !['review', 'done', 'failed', 'cancelled'].includes(run.status)) {
        this.#store.move(runId, 'stop-worker', {}, queued ? { event: CANCELLED_WHILE_QUEUED } : {});
      }
      const proof = this.#store.workerExecutions.readWorkerExecution(runId);
      if (proof?.phase === 'queued') this.#store.workerExecutions.commitWorkerExecutionComplete(runId, proof.generation);
    }
    if (queued) {
      this.#queued.delete(runId);
      this.#store.move(runId, 'cancel', {}, { event: CANCELLED_WHILE_QUEUED });
      this.#store.persistence.flush();
      return true;
    }
    const current = this.#store.getRun(runId);
    if (current && (current.delegation || current.waits?.length) && ['queued', 'running', 'waiting'].includes(current.status)) {
      this.#store.move(runId, 'cancel');
      return true;
    }
    return false;
  }

  requestWorkerStop(runId: string): ReturnType<RunManager['requestWorkerStop']> {
    if (this.#store.getRun(runId)?.delegation?.role !== 'worker') throw new Error('Worker not found');
    const complete = () => this.#store.workerExecutions.readWorkerExecution(runId)?.phase === 'complete';
    if (!this.isActive(runId) && ['done', 'failed', 'cancelled', 'review'].includes(this.#store.getRun(runId)!.status) && complete()) {
      return { workerId: runId, state: 'terminated' };
    }
    this.cancel(runId);
    return { workerId: runId, state: complete() ? 'terminated' : 'stopping' };
  }

  /** No execution runs here, so termination is proven once the worker's proof is complete or absent. */
  async awaitRunTermination(...[runId]: Method<'awaitRunTermination'>): Promise<boolean> {
    const proof = this.#store.workerExecutions.readWorkerExecution(runId);
    return !proof || proof.phase === 'complete';
  }

  takeWorkerTerminationBlocker(): ReturnType<RunManager['takeWorkerTerminationBlocker']> { return undefined; }
  settleOrphanedWorkerExecution(): boolean { return false; }
  claimWorkerCleanup(): () => void { return () => {}; }
  claimForPublish(): () => void { return () => {}; }
  claimWorktreeReclaim(): () => void { return () => {}; }
  claimForBranchCleanup(): () => void { return () => {}; }

  /** A review run with no session accepts Finish as done; anything else needs the engine. */
  finish(runId: string): boolean {
    const run = this.#store.getRun(runId);
    if (run?.status !== 'review' || this.#queued.has(runId)) return false;
    this.#store.move(runId, 'accept-review');
    this.#store.eventLog.appendEvent(runId, { type: 'lifecycle', message: 'review accepted — finished without a PR' });
    return true;
  }

  finishBlockedReason(): string | undefined { return undefined; }
  adoptOrphanedRun(): Promise<false> { return Promise.resolve(false); }
  sendMessage(): boolean { return false; }
  deferMessage(): boolean { return false; }
  cancelAutoResume(): boolean { return false; }
  /** A missing run is refused as the engine refuses it; accepting a Continue needs the engine. */
  continueRun(...[runId]: Method<'continueRun'>): ReturnType<RunManager['continueRun']> {
    if (!this.#store.getRun(runId)) return { ok: false, error: 'not found' };
    return notFaked('continueRun');
  }

  /** A message stacked on a queued run, as the engine stores it while the run waits for a slot. */
  enqueueMessage(...[runId, content]: Method<'enqueueMessage'>): ReturnType<RunManager['enqueueMessage']> {
    if (!this.#queued.has(runId)) return null;
    const run = this.#store.getRun(runId);
    if (!run) return null;
    if (content.some(block => block.type !== 'text')) notFaked('enqueueMessage with attachments');
    const text = content.map(block => block.type === 'text' ? block.text : '').join('\n');
    const message = { id: randomUUID(), text, createdAt: new Date().toISOString() };
    if (run.waits?.length) this.#store.commitHumanMessageBesideWaits(runId, message);
    else this.#store.updateRun(runId, { queuedMessages: [...(run.queuedMessages ?? []), message] });
    return message;
  }

  editQueuedMessage(): never { return notFaked('editQueuedMessage'); }
  removeQueuedMessage(): never { return notFaked('removeQueuedMessage'); }
  editTask(): never { return notFaked('editTask'); }
  respondPermission(): never { return notFaked('respondPermission'); }
  get ciProgress(): never { return notFaked('ciProgress'); }

  // --- Delegation -------------------------------------------------------------------------------------

  /** No live session holds settings here: the engine's answer for a run without one. Tests spy it. */
  delegationExecutionSettings(_runId: string): ReturnType<RunManager['delegationExecutionSettings']> {
    return delegationExecutionSettings(undefined);
  }

  async selectDelegationExecutionSettings(...[runId, selection, validateModel]: Method<'selectDelegationExecutionSettings'>): ReturnType<RunManager['selectDelegationExecutionSettings']> {
    return selectDelegationExecutionSettings(this.#root, this.delegationExecutionSettings(runId), selection, validateModel, this.#options.home);
  }

  /** Steering input for a worker with no session queues on the record, as the engine does. */
  steerWorker(...[runId, input]: Method<'steerWorker'>): 'queued' {
    const run = this.#store.getRun(runId);
    if (!run || run.delegation?.role !== 'worker' || run.delegation.parentRunId !== input.parentRunId) {
      throw new DelegationPolicyError('denied_scope', 'not an owned worker');
    }
    const queue = enqueueAgentInput(run, input);
    this.#store.commitAgentInputs(runId, queue);
    this.#store.eventLog.appendEvent(runId, { type: 'agent-input', input: queue[queue.length - 1]! });
    return 'queued';
  }

  reconcileWorkerWaits(): void {}
  deliverConversationInput(): void {}

  registerWorkerWait(...[parentId]: Method<'registerWorkerWait'>): never { return this.#refuseWait(parentId); }
  registerRequestWait(...[runId]: Method<'registerRequestWait'>): never { return this.#refuseWait(runId); }
  registerPeerWait(...[runId]: Method<'registerPeerWait'>): never { return this.#refuseWait(runId); }
  cancelPeerWait(): never { return notFaked('cancelPeerWait'); }

  #refuseWait(runId: string): never {
    const status = this.#store.getRun(runId)?.status ?? 'missing';
    throw new DelegationPolicyError('incompatible_state', `Run is ${status} with no available active session; register a wait from an executing parent or worker`);
  }

  /** A settled or retained worker wait reads back; cancelling an open one needs the engine's wait engine. */
  cancelWorkerWait(...[parentId, waitId]: Method<'cancelWorkerWait'>): ReturnType<RunManager['cancelWorkerWait']> {
    const run = this.#store.getRun(parentId);
    if (!run?.delegation || run.delegation.role === 'invalid') throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    const matches = (wait: unknown): wait is DeadlinedWorkerWaitEntry => (wait as { id?: string }).id === waitId && WAIT_KINDS.worker.hasDeadline(wait as never);
    const entry = WAIT_KINDS.worker.select(run.waits ?? []).find(matches);
    if (!entry) {
      const settled = WAIT_KINDS.worker.select(run.lastWaits ?? []).filter(matches).at(-1);
      if (settled) return workerWaitEntryToLegacy(settled);
      throw new DelegationPolicyError('incompatible_state', 'Worker wait is no longer current');
    }
    if (entry.phase !== 'open') return workerWaitEntryToLegacy(entry);
    return notFaked('cancelWorkerWait on an open wait');
  }

  // --- Inbox ------------------------------------------------------------------------------------------

  canClaimInboxInput(runId: string, id: string): boolean {
    const run = this.#store.getRun(runId);
    const input = run?.agentInputs?.find(entry => entry.id === id);
    return !this.#disposed && !!run && ['queued', 'running', 'waiting'].includes(run.status) &&
      !!input && input.source === 'agent' && !!input.conversation && !input.deliveredAt && !hasLiveInboxClaim(input);
  }

  reserveInboxInputs(runId: string, generation: string, ids: readonly string[]): ReturnType<RunManager['reserveInboxInputs']> {
    if (!ids.length || ids.some(id => !this.canClaimInboxInput(runId, id)) ||
      this.#store.getRun(runId)?.agentInputs?.some(input => !input.deliveredAt && hasLiveInboxClaim(input))) return undefined;
    const claim: InboxClaim = { receiptId: randomUUID(), generation, expiresAt: new Date(Date.now() + 120_000).toISOString() };
    this.#store.claimInboxInputs(runId, ids, claim);
    return { receiptId: claim.receiptId, expiresAt: claim.expiresAt, inputIds: [...ids] };
  }

  acknowledgeInbox(runId: string, generation: string, receiptId: string): 'acknowledged' | 'already-acknowledged' {
    if (this.#disposed) throw new Error('inbox receipt displaced');
    return this.#store.ackInboxInputs(runId, receiptId, generation, new Date().toISOString());
  }

  releaseInbox(runId: string, generation: string, receiptId: string): 'released' {
    if (this.#disposed) throw new Error('inbox manager disposed');
    return this.#store.releaseInboxInputs(runId, receiptId, generation);
  }
}

/** The fake starts no session, so it never builds a runner. */
const noRunner = (): never => { throw new Error('FakeRunManager starts no runner'); };

/** A fake for a test that builds a manager by hand, as `createFixtureManager` does for the engine. */
export function fakeRunManager(store: RunStore, root: string, home: Home = testHome()): FakeRunManager {
  return new FakeRunManager(store, root, { home, createRunner: noRunner });
}

/** The manager factory `serve` passes, with the fake in place of the engine. */
export const createFakeRunManager: RunManagerFactory = (store, root, options) => new FakeRunManager(store, root, options);
