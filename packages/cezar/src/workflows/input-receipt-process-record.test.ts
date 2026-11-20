import { ABSENT_PROCESS_PID } from '../delegation/process-enumeration.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { createActiveRun } from './active-run.ts';
import { sessionResultWithReceipts, type InputReceiptsHost, type InputReceiptSteps } from './run/input-receipts.ts';
import type { RunModuleContext } from './run/types.ts';
import { TrackedWork } from './run/tracked-work.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentRunner, AgentSession, AgentRunResult, SessionOptions } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../runners/claude/spec-support.ts';
import * as processes from '../core/process-usage.ts';
import { RunStore } from '../runs/store.ts';
import { unused } from './unused.testkit.ts';
import { noRunners, useRunners } from '../core/runners-under-test.testkit.ts';

// The receipt setup contract with no run manager: `input-receipt-boundaries.test.ts` drives the rest on the engine.
const hook = vi.hoisted(() => ({ runner: undefined as AgentRunner | undefined }));
useRunners(async () => hook.runner!);

function signal<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

let root: string;
let store: RunStore;
let closeSession: (() => void) | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-receipt-process-record-'));
  store = RunStore.open(join(root, '.ai/cezar'));
});
afterEach(() => {
  closeSession?.();
  store.close(); vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function controlledRunner(beforeReturn: (opts: SessionOptions) => void = () => undefined) {
  const started = signal<SessionOptions>();
  const result = signal<AgentRunResult>();
  let open = true;
  const close = () => { open = false; result.resolve({ text: '', toolCalls: [], tokensUsed: 0 }); };
  const session: AgentSession = { get result() { return result.promise; }, get open() { return open; },
    sendMessage: () => true, sendAgentMessage: () => false, discardQueuedMessages() {}, holdsHumanInput: () => false,
    end: close, interrupt: vi.fn() };
  const runner: AgentRunner = { backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => undefined,
    startSession(_spec, _event, opts = {}) { beforeReturn(opts); started.resolve(opts); return session; } };
  hook.runner = runner; closeSession = close;
  return { started, result, session, close };
}

it('the receipt setup contract propagates recordProcess failure before marking prepared or reading the result', () => {
  const runner = controlledRunner();
  Object.defineProperty(runner.session, 'pid', { value: ABSENT_PROCESS_PID });
  const context: RunModuleContext = { createRunner: noRunners, home: testHome(), store, repoRoot: root, dataDir: join(root, '.ai/cezar'),
    semaphore: new WorkspaceSemaphore({ home: testHome() }), work: new TrackedWork(), disposed: () => false };
  const state = createActiveRun({ cwd: root, autonomous: false, pendingHumanAsk: false });
  const calls: string[] = [];
  const host = unused<InputReceiptsHost>('receipts', { openDeliveryScope: () => { calls.push('scope'); }, flushAgentInputs: () => { calls.push('inputs'); } });
  const steps = unused<InputReceiptSteps>('steps', {
    flushDeferred: () => { calls.push('deferred'); },
    recordProcess: (id, pid) => { calls.push('record'); expect([id, pid]).toEqual(['run', ABSENT_PROCESS_PID]); throw Error('record refused'); },
  });
  vi.spyOn(processes, 'registerRunProcess').mockImplementation(() => { calls.push('register'); });
  const prepared = vi.fn();
  const result = vi.spyOn(runner.session, 'result', 'get');
  expect(() => sessionResultWithReceipts(context, host, steps, 'run', state, runner.session, prepared)).toThrow('record refused');
  // The delivery scope opens before anything can be delivered into the session.
  expect(calls).toEqual(['scope', 'deferred', 'inputs', 'register', 'record']);
  expect(prepared).not.toHaveBeenCalled();
  expect(result).not.toHaveBeenCalled();
});
