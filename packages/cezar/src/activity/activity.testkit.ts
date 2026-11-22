import { randomUUID } from 'node:crypto';
import type { ConversationMessage, DelegationState, RequestOutcome } from '@open-mercato/cezar-contract';
import { isLiveStatus } from '@open-mercato/cezar-contract/run-predicates';
import { toRunSummary } from '@open-mercato/cezar-contract/runs';
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { RunLifecycle, snapshotRun, type RunLifecycleHandlers } from '../runs/lifecycle.ts';
import type { RunRecord } from '../runs/store.ts';
import type { ActivityStore } from './read-model.ts';

/** The read clock of every activity test: one minute after the factories' `registeredAt`. */
export const NOW = Date.parse('2026-10-26T00:01:00.000Z');
export const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

type RootDelegation = Extract<DelegationState, { role: 'root' }>;

/** A running root task with an empty ledger. */
export function makeRoot(over: Partial<RunRecord> = {}): RunRecord {
  return makeRunRecord({ id: randomUUID(), status: RUN_STATUS.running, delegation: { role: 'root', permissions: [], receipts: [], conversation: { messages: [], outcomes: [] } }, ...over });
}

/** The root's own delegation record, to change in place. */
export function rootOf(run: RunRecord): RootDelegation {
  if (run.delegation?.role !== 'root') throw new Error('not a root fixture');
  return run.delegation;
}

/** A running worker the root owns by a receipt. */
export function makeWorker(parent: RunRecord, over: Partial<RunRecord> = {}): RunRecord {
  const worker = makeRunRecord({
    id: randomUUID(),
    status: RUN_STATUS.running,
    delegation: { role: 'worker', permissions: [], parentRunId: parent.id, workspace: { ownerRunId: '' } } as unknown as DelegationState,
    ...over,
  });
  rootOf(parent).receipts.push({ workerId: worker.id, requestId: randomUUID(), requestHash: 'b'.repeat(64) } as RootDelegation['receipts'][number]);
  return worker;
}

/** An accepted request in `ledger`'s conversation, with no outcome. */
export function addRequest(ledger: RunRecord, sender: RunRecord, recipient: RunRecord, over: Partial<ConversationMessage> = {}): ConversationMessage {
  const message: ConversationMessage = {
    id: randomUUID(), senderRunId: sender.id, recipientRunId: recipient.id, kind: 'request', text: 'Which branch?',
    createdAt: iso(-5_000), requestHash: 'a'.repeat(64), state: 'accepted', ...over,
  };
  rootOf(ledger).conversation!.messages.push(message);
  return message;
}

export function addOutcome(ledger: RunRecord, outcome: Pick<RequestOutcome, 'requestId' | 'status'> & Partial<RequestOutcome>): void {
  rootOf(ledger).conversation!.outcomes.push({ observedAt: iso(-1_000), ...outcome });
}

/** A lifecycle that counts its live subscriptions, so a test checks that each one is removed. */
export class CountedLifecycle extends RunLifecycle {
  subscriptions = 0;

  override subscribe(handlers: RunLifecycleHandlers): () => void {
    const off = super.subscribe(handlers);
    this.subscriptions++;
    let live = true;
    return () => {
      if (live) this.subscriptions--;
      live = false;
      off();
    };
  }

  /** Publish one write of `run` that changed nothing the test reads: `before` holds `run` itself. */
  changed(run: RunRecord): void {
    this.publish('run.updated', { run, before: snapshotRun(run) });
  }
}

export interface FakeStoreOptions {
  /** The runs `listRuns()` holds; by default every run with a live status. */
  held?: readonly string[];
  /** `listForeignClaimedRunIds()`. */
  foreign?: readonly string[];
  /** Rows whose record cannot be read: their summary still lists. */
  unreadable?: readonly string[];
  /** Workers whose execution settled (`readWorkerExecution().phase === 'complete'`). */
  complete?: readonly string[];
}

/** A run store over fixed records, with the reads the activity model makes and a lifecycle a test
 *  publishes run changes to. */
export function fakeStore(runs: readonly RunRecord[], options: FakeStoreOptions = {}): ActivityStore & { lifecycle: CountedLifecycle } {
  const unreadable = new Set(options.unreadable);
  const getRun = (id: string) => (unreadable.has(id) ? undefined : runs.find((run) => run.id === id));
  return {
    lifecycle: new CountedLifecycle(),
    listRuns: () => runs.filter((run) => (options.held ? options.held.includes(run.id) : isLiveStatus(run.status))),
    listForeignClaimedRunIds: () => [...(options.foreign ?? [])],
    getRun,
    withReadCache: <T>(fn: () => T): T => fn(),
    isUnreadable: (id: string) => unreadable.has(id),
    readWorkerExecution: (id: string) => (options.complete?.includes(id) ? { phase: 'complete' } : undefined),
    listRunSummaries: () => ({ runs: runs.filter((run) => !run.archived).map((run) => toRunSummary(run)), truncated: false }),
    listOwnedWorkers: (parentId: string) => {
      const parent = getRun(parentId);
      if (parent?.delegation?.role !== 'root') return [];
      return parent.delegation.receipts.flatMap((receipt) => getRun(receipt.workerId) ?? []);
    },
  } as unknown as ActivityStore & { lifecycle: CountedLifecycle };
}
