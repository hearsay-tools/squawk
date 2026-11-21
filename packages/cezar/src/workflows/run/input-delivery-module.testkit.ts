import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished, vi } from 'vitest';
import type { AgentInput } from '@open-mercato/cezar-contract';
import { STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { AgentEvent, AgentRunResult, AgentSession, InputDelivery as InputDeliveryPolicy } from '../../core/agent-runner.ts';
import { RunStore } from '../../runs/store.ts';
import type { RunEventInput } from '../../runs/ports.ts';
import { createActiveRun, type ActiveRun } from '../active-run.ts';
import { unused } from '../unused.testkit.ts';
import { MAX_AUTO_CONTINUES, UNREAD_INPUT_GRACE_MS } from './constants.ts';
import { InputDelivery, type InputGroup } from './input-delivery.ts';
import * as inputReceipts from './input-receipts.ts';
import { clearHeldHumanInputTimer, clearUnreadInputTimer } from './input-timers.ts';
import type { RunLine } from './run-line.ts';
import { markTurnBoundary, type SessionHelperHost } from './session-events.ts';
import type { RunModuleContext, SessionTurn } from './types.ts';
import { pendingConversationWakes } from './wake-ledger.ts';

type DeliveryHost = ConstructorParameters<typeof InputDelivery>[1];

/** What the fake runner session does: its acknowledgement and whether it holds human input. */
export interface WireControls { ack: () => Promise<void>; holds: boolean }

export interface InputDeliveryModule {
  store: RunStore; runId: string; state: ActiveRun; group: InputGroup; context: RunModuleContext;
  delivery: InputDelivery; receiptHost: inputReceipts.InputReceiptsHost; wire: WireControls;
  input(text: string): AgentInput;
  receipt(id: string): AgentInput | undefined;
  /** The runner's `onAgentInputConsumed` callback. */
  consumed(ids: readonly string[]): void;
  /** A session event through the receipt handler, as both launch entries route it; content it
   *  publishes is appended to the store. */
  receiptEvent(event: AgentEvent): boolean;
  /** The session reached a turn end (`markTurnBoundary`). */
  turnEnd(): void;
}

/** Wires a delivery host's own calls back into the module, as `run/compose.ts` does. */
function deliveryHost(context: RunModuleContext, active: ReadonlyMap<string, ActiveRun>, delivery: () => InputDelivery,
  receiptHost: inputReceipts.InputReceiptsHost): DeliveryHost {
  const line = unused<RunLine>('input line', { isParked: () => false, isAdmitted: () => false, hasWake: () => false,
    unpark: () => undefined, retireAdmission: () => false, admissions: () => new Set() });
  const reads = { routedAnswer: () => undefined, countAutomaticWakes: () => 0, providerOwnsInboxInput: () => false };
  return unused<DeliveryHost>('input host', {
    active, line, inputReceiptHost: receiptHost,
    workerExecutionStopped: () => false, executionBlockedByRootFinish: () => false, hasUnansweredHumanAsk: () => false,
    recoveringRun: () => false, routedAnswer: () => undefined, owesWake: () => false, countAutomaticWakes: () => 0,
    pendingConversationWakes: run => pendingConversationWakes(run, reads, MAX_AUTO_CONTINUES), holdPeerWakesAtCap: () => undefined,
    move: (id, exit) => context.store.move(id, exit), unreadInputGraceMs: () => UNREAD_INPUT_GRACE_MS,
    reconcileWorkerWaits: () => undefined, endParkHold: () => undefined, canAutoContinue: () => true,
    submitAgentInput: (...args) => delivery().submitAgentInput(...args),
    settleTurn: vi.fn(() => true), boundaryTurn: (_id, _state, session, done) => ({ session, done, stepId: 'task', ask: null, nudgedLastTurn: false, humanGate: false, monitoring: false }),
    waitEngine: unused<DeliveryHost['waitEngine']>('wait engine', { resolvePeerWaits: () => undefined }),
    workerExecutions: unused<DeliveryHost['workerExecutions']>('worker executions', { trackDelivery: () => undefined }),
    workerQuestions: unused<DeliveryHost['workerQuestions']>('worker questions', { supersedeWorkerFallback: () => false }),
    humanWaits: unused<DeliveryHost['humanWaits']>('human waits', { holdsAgentWaits: () => true }),
  });
}

function fakeWire(wire: WireControls): AgentSession {
  let open = true;
  let finish!: (value: AgentRunResult) => void;
  const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
  const close = () => { open = false; finish({ text: '', toolCalls: [], tokensUsed: 0 }); };
  return { get open() { return open; }, result, sendMessage: () => true, sendAgentMessage: () => wire.ack(),
    discardQueuedMessages: () => {}, holdsHumanInput: () => wire.holds, end: close, interrupt: close };
}

/** One running root run with an open session of `policy`: `InputDelivery` and the receipt
 *  functions over a real store, with no `RunManager`. */
export function inputDeliveryModule(policy: InputDeliveryPolicy): InputDeliveryModule {
  const root = mkdtempSync(join(tmpdir(), 'cez-input-delivery-'));
  const store = RunStore.open(join(root, '.ai/cezar'));
  const runId = store.createRun({ title: 'input', task: 'work', workflow: 'quick-task', steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] }).id;
  store.move(runId, 'start');
  store.updateStep(runId, 'task', { status: STEP_STATUS.running });
  store.commitDelegation([{ id: runId, delegation: { role: 'root', permissions: [], receipts: [] } }]);
  const state = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
  const active = new Map([[runId, state]]);
  const wire: WireControls = { ack: () => Promise.resolve(), holds: false };
  const session = fakeWire(wire);
  state.inputState.declareDelivery(policy); state.inputState.resetUnreadInputs(); state.inputState.resetEarlyConsumption();
  state.liveSession.attachSession(session); state.liveSession.selectStep('task');
  const context = unused<RunModuleContext>('context', { store, repoRoot: root, dataDir: join(root, '.ai/cezar'), disposed: () => false });
  const receiptHost: inputReceipts.InputReceiptsHost = {
    reconcileWorkerWaits: () => undefined, isCurrentState: (id, current) => active.get(id) === current,
    openDeliveryScope: (...args) => delivery.openDeliveryScope(...args), flushAgentInputs: id => { delivery.flushAgentInputs(id); },
  };
  const delivery: InputDelivery = new InputDelivery(context, deliveryHost(context, active, () => delivery, receiptHost), MAX_AUTO_CONTINUES, 'routed refusal');
  const steps = unused<inputReceipts.InputReceiptSteps>('receipt steps', {
    clearUnread: clearUnreadInputTimer, clearHeld: clearHeldHumanInputTimer, noteActivity: () => undefined });
  const turn: SessionTurn = { text: '', scheduleWakeup: undefined, sessionError: undefined };
  onTestFinished(async () => {
    clearUnreadInputTimer(state); clearHeldHumanInputTimer(state);
    store.flush(); await store.factsWarmIdle(); store.close(); rmSync(root, { recursive: true, force: true });
  });
  return {
    store, runId, state, group: state.inputState, context, delivery, receiptHost, wire,
    input: text => ({ id: randomUUID(), parentRunId: runId, source: 'lifecycle', text, createdAt: new Date().toISOString() }),
    receipt: id => store.getRun(runId)?.agentInputs?.find(entry => entry.id === id),
    consumed: ids => inputReceipts.handleAgentInputConsumed(context, receiptHost, runId, state, session, ids),
    receiptEvent: event => inputReceipts.handleReceiptEvent(context, receiptHost, steps, runId, state, turn, event, 'task',
      published => { store.appendEvent(runId, published as RunEventInput); }, session),
    turnEnd: () => markTurnBoundary(context, unused<SessionHelperHost>('session helper host', { inputReceiptHost: receiptHost }), runId, state, { type: 'turn-end' }),
  };
}
