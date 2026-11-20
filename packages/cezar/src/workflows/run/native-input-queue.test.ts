import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RUN_STATUS, STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { AgentSession, ContentBlock } from '../../core/agent-runner.ts';
import { noRunners } from '../../core/runners-under-test.testkit.ts';
import { testHome } from '../../home/test-home.testkit.ts';
import { setRunStatus } from '../../runs/run-store.testkit.ts';
import { RunStore } from '../../runs/store.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import { createActiveRun, type ActiveRun } from '../active-run.ts';
import { unused } from '../unused.testkit.ts';
import { InputDelivery } from './input-delivery.ts';
import { RunMemory } from './run-memory.ts';
import { TrackedWork } from './tracked-work.ts';
import { transitionTurnBoundary } from './turn-boundary.ts';
import type { RunModuleContext } from './types.ts';

type Host = ConstructorParameters<typeof InputDelivery>[1];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }];
function session(): AgentSession {
  return { open: true, result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
    sendMessage: vi.fn(() => true), sendAgentMessage: () => false, holdsHumanInput: () => false,
    discardQueuedMessages: () => {}, end: vi.fn(), interrupt: vi.fn() };
}

let root: string;
let store: RunStore;
let id: string;
let state: ActiveRun;
let wire: AgentSession;
let work: TrackedWork;
let delivery: InputDelivery;
let memory: RunMemory;
let host: Host;
let parked: boolean;
const active = new Map<string, ActiveRun>();
const nativeInput = vi.fn<Host['runSkills']['nativeInput']>();
const answeredElsewhere = vi.fn(() => false);
const parkForUser = vi.fn<Host['parkForUser']>();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'native-input-queue-'));
  store = RunStore.open(root);
  id = store.createRun({ title: 'input', task: 'work', workflow: 'quick-task',
    steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] }).id;
  setRunStatus(store, id, RUN_STATUS.running);
  active.clear();
  state = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
  state.liveSession.selectStep('task');
  wire = session();
  state.liveSession.attachSession(wire);
  active.set(id, state);
  work = new TrackedWork();
  parked = false;
  nativeInput.mockReset().mockImplementation(async (_id, _state, blocks) => blocks);
  answeredElsewhere.mockReset().mockReturnValue(false);
  parkForUser.mockReset().mockImplementation(() => { parked = true; });
  const context: RunModuleContext = { home: testHome(), createRunner: noRunners, store,
    repoRoot: root, dataDir: root, work, disposed: () => false,
    semaphore: new WorkspaceSemaphore({ home: testHome() }) };
  host = unused<Host>('native input host', {
    active, canProceedWithRun: () => true, workerExecutionStopped: () => false,
    executionBlockedByRootFinish: () => false, endParkHold: () => {}, owesWake: () => false,
    hasUnansweredHumanAsk: () => false, parkForUser,
    move: (runId, exit) => store.move(runId, exit),
    line: unused<Host['line']>('line', { isParked: () => parked, isAdmitted: () => false,
      unpark: () => { parked = false; } }),
    attachments: unused<Host['attachments']>('attachments', { persistPastedAttachments: () => [] }),
    workerQuestions: unused<Host['workerQuestions']>('worker questions', {
      supersedeWorkerFallback: () => false, answeredElsewhere }),
    runSkills: unused<Host['runSkills']>('skills', { nativeInput, enabledSkills: () => [] }),
    humanWaits: unused<Host['humanWaits']>('human waits', { holdsAgentWaits: () => false }),
  });
  memory = new RunMemory();
  delivery = new InputDelivery(context, host, 40, 'Answer this worker through its parent.', memory.liveness, memory);
  vi.spyOn(delivery, 'flushAgentInputs').mockReturnValue(false);
});
afterEach(async () => {
  await drain();
  store.close();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function drain(): Promise<void> {
  while (work.pending.size) await Promise.all([...work.pending.keys()]);
}
const queued = () => store.getRun(id)?.queuedMessages?.map(message => message.id) ?? [];

it('a rejected async read interrupts the current session and keeps the accepted message durable', async () => {
  const read = deferred<ContentBlock[]>();
  nativeInput.mockReturnValue(read.promise);
  expect(delivery.sendMessage(id, text('/demo work'), 'held')).toBe(true);
  expect(queued()).toEqual(['held']);
  expect(store.readEvents(id).filter(event => event.type === 'user-message').map(event => event.text)).toEqual(['/demo work']);
  read.reject(new Error('list failed'));
  await drain();
  expect(state.inputState.agentInputError).toContain('list failed');
  expect(wire.interrupt).toHaveBeenCalledOnce();
  expect(wire.sendMessage).not.toHaveBeenCalled();
  expect(queued()).toEqual(['held']);
  expect(store.readEvents(id)).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringContaining('list failed') }));
});

it('accepted native human input blocks every Squawk submission and flush until its read delivers', async () => {
  const read = deferred<ContentBlock[]>();
  nativeInput.mockReturnValue(read.promise);
  const sendAgent = vi.spyOn(wire, 'sendAgentMessage');
  const flush = vi.mocked(delivery.flushAgentInputs);
  flush.mockRestore();
  expect(delivery.sendMessage(id, text('/demo human'), 'human')).toBe(true);
  expect(delivery.submitAgentInput(id, state, text('no-wait nudge'))).toBe(false);
  expect(delivery.submitAgentInput(id, state, text('worker result'), ['worker-result'])).toBe(false);
  expect(delivery.flushAgentInputs(id)).toBe(false);
  expect(sendAgent).not.toHaveBeenCalled();
  // The unresolved read is the barrier; no timer or transport acknowledgement is involved.
  read.resolve(text('/demo human'));
  await drain();
  expect(wire.sendMessage).toHaveBeenCalledExactlyOnceWith(text('/demo human'));
  expect(queued()).toEqual([]);
});

it.each(['session', 'state'] as const)('an old %s read cannot send or clear its replacement read', async replacement => {
  const oldRead = deferred<ContentBlock[]>();
  const newRead = deferred<ContentBlock[]>();
  nativeInput.mockReturnValueOnce(oldRead.promise).mockReturnValue(newRead.promise);
  expect(delivery.sendMessage(id, text('/demo old'), 'old')).toBe(true);
  const oldWork = [...work.pending.keys()];
  const oldWire = wire;
  delivery.clearNativeInputs(id);
  store.updateRun(id, { queuedMessages: [] }); // This test discards the old input; recovery is covered separately.
  if (replacement === 'state') {
    state = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
    state.liveSession.selectStep('task');
    active.set(id, state);
  }
  wire = session();
  state.liveSession.attachSession(wire);
  expect(delivery.sendMessage(id, text('/demo new'), 'new')).toBe(true);
  oldRead.resolve(text('/demo old'));
  await Promise.all(oldWork);
  expect(delivery.releaseNativeInputs(id, state)).toBe(true);
  expect(nativeInput).toHaveBeenCalledTimes(2);
  expect(oldWire.sendMessage).not.toHaveBeenCalled();
  newRead.resolve(text('/demo new'));
  await drain();
  expect(wire.sendMessage).toHaveBeenCalledExactlyOnceWith(text('/demo new'));
  expect(queued()).toEqual([]);
});

it('refuses a routed worker answer before accepting it into the durable queue', () => {
  answeredElsewhere.mockReturnValue(true);
  expect(delivery.sendMessage(id, text('/demo answer'), 'refused')).toBe(false);
  expect(queued()).toEqual([]);
  expect(nativeInput).not.toHaveBeenCalled();
  expect(wire.sendMessage).not.toHaveBeenCalled();
  expect(store.readEvents(id)).toContainEqual(expect.objectContaining({
    type: 'note', message: 'Answer this worker through its parent.' }));
});

it('keeps FIFO and accepted content while synchronous transport readiness drains the next message', async () => {
  const first = deferred<ContentBlock[]>();
  nativeInput.mockReturnValueOnce(first.promise);
  const trace: string[] = [];
  vi.mocked(wire.sendMessage).mockImplementation(blocks => {
    trace.push(blocks.filter(block => block.type === 'text').map(block => block.text).join(''));
    delivery.handleAgentInputReady(id, state, wire);
    return true;
  });
  vi.mocked(delivery.flushAgentInputs).mockImplementation(() => { trace.push('ready'); return false; });
  const original = text('/demo first');
  expect(delivery.sendMessage(id, original, 'first')).toBe(true);
  original[0] = { type: 'text', text: 'caller changed it' };
  expect(delivery.sendMessage(id, text('second'), 'second')).toBe(true);
  expect(queued()).toEqual(['first', 'second']);
  expect(store.readEvents(id).filter(event => event.type === 'user-message').map(event => event.text)).toEqual(['/demo first', 'second']);
  first.resolve(nativeInput.mock.calls[0]![2]);
  await drain();
  expect(trace).toEqual(['/demo first', 'second', 'ready']);
  expect(queued()).toEqual([]);
  expect(store.readEvents(id).filter(event => event.type === 'user-message').map(event => event.text)).toEqual(['/demo first', 'second']);
});

it('parks a refused boundary delivery and retries the same durable message once transport becomes ready', async () => {
  transitionTurnBoundary(state, { kind: 'turn-end', phase: 'ui-completed', session: wire });
  vi.mocked(wire.sendMessage).mockReturnValueOnce(false).mockReturnValue(true);
  expect(delivery.sendMessage(id, text('/demo retry'), 'retry')).toBe(true);
  await drain();
  expect(wire.sendMessage).toHaveBeenCalledOnce();
  expect(parkForUser).toHaveBeenCalledExactlyOnceWith(id, state, 'task');
  expect(queued()).toEqual(['retry']);
  delivery.handleAgentInputReady(id, state, wire);
  await drain();
  expect(wire.sendMessage).toHaveBeenCalledTimes(2);
  expect(queued()).toEqual([]);
  expect(parked).toBe(false);
  expect(store.readEvents(id).filter(event => event.type === 'user-message')).toHaveLength(1);
});

it('execution cleanup releases native input memory and prevents an old read from delivering', async () => {
  const read = deferred<ContentBlock[]>();
  nativeInput.mockReturnValue(read.promise);
  expect(delivery.sendMessage(id, text('/demo work'), 'held')).toBe(true);
  expect(memory.holds(id)).toBe(true);
  memory.forgetExecution(id);
  expect(memory.holds(id)).toBe(false);
  read.resolve(text('/demo work'));
  await drain();
  expect(wire.sendMessage).not.toHaveBeenCalled();
  expect(queued()).toEqual(['held']);
});

it('restores durable FIFO before a later live message in the session-open gap', async () => {
  store.updateRun(id, { queuedMessages: [{ id: 'restored', text: '/demo restored',
    createdAt: new Date().toISOString(), replayAfterOpen: true }] });
  expect(memory.holds(id)).toBe(false);
  expect(delivery.sendMessage(id, text('later live message'), 'later')).toBe(true);
  await drain();
  expect(vi.mocked(wire.sendMessage).mock.calls.map(([blocks]) => blocks[0])).toEqual([
    { type: 'text', text: '/demo restored' }, { type: 'text', text: 'later live message' },
  ]);
  expect(queued()).toEqual([]);
});
