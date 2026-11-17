import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { LivenessTimers } from './run/liveness-timers.ts';
import { InputDelivery } from './run/input-delivery.ts';
import { runnerHook, setupMonitoringFixture, waitForProduct } from './run-fixture.testkit.ts';

/** hearsay-tools/squawk#3662: an execution's liveness bounds end at `dropActive`, the unread-input bound too. */
const f = setupMonitoringFixture();
afterEach(() => { vi.restoreAllMocks(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function openSession() {
  const ready = deferred<void>();
  const wire: { emit?: (event: AgentEvent) => void; close?: () => void } = {};
  runnerHook.runner = {
    backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
    inputDelivery: { mode: 'steer', consumption: 'observable', acknowledgement: 'response', humanInputAtTurnEnd: 'never-held', via: 'liveness fixture' },
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {},
    startSession(_spec, onEvent) {
      const result = deferred<AgentRunResult>();
      let open = true;
      const close = () => { open = false; result.resolve({ text: '', toolCalls: [], tokensUsed: 0 }); };
      wire.emit = event => onEvent?.(event);
      wire.close = close;
      queueMicrotask(() => { onEvent?.({ type: 'session', sessionId: 'liveness-session', resumed: false }); ready.resolve(); });
      return { get open() { return open; }, result: result.promise, sendMessage: () => true, sendAgentMessage: () => Promise.resolve(),
        discardQueuedMessages: () => {}, holdsHumanInput: () => false, end: close, interrupt: close };
    },
  };
  return { ready: ready.promise, wire };
}

it('dropActive leaves no execution-scope bound armed, the unread-input bound included', async () => {
  const arm = vi.spyOn(LivenessTimers.prototype, 'arm');
  const clearScope = vi.spyOn(LivenessTimers.prototype, 'clearScope');
  const unread = vi.spyOn(InputDelivery.prototype, 'armUnreadInputTimer');
  const { ready, wire } = openSession();
  const record = f.manager.startRun(f.SINGLE_STEP, { task: 'work', runner: 'claude', worktree: false });
  f.currentId = record.id;
  await ready;
  f.store.commitDelegation([{ id: record.id, delegation: { role: 'root', permissions: [], receipts: [] } }]);
  const message = { id: randomUUID(), parentRunId: record.id, source: 'lifecycle' as const, text: 'read me', createdAt: new Date().toISOString() };
  f.store.commitAgentInputs(record.id, [message]);
  f.manager.deliverConversationInput(record.id);
  // bound: the acknowledgement checkpoint is the product signal that the harness accepted the input.
  await waitForProduct(f.manager, f.store, () => !!f.store.getRun(record.id)?.agentInputs?.find(input => input.id === message.id)?.deliveredAt);
  wire.emit!({ type: 'turn-end' });
  // bound: the turn-end settlement arms the bound after its native-input priority checkpoint.
  await waitForProduct(f.manager, f.store, () => unread.mock.calls.length > 0);
  expect(unread).toHaveBeenCalled();
  const owner = arm.mock.contexts.find(context => context instanceof LivenessTimers) as LivenessTimers | undefined;
  expect(owner?.armedIn(record.id, 'execution')).toContain('unread-input');
  wire.close!();
  await waitForProduct(f.manager, f.store, () => !f.manager.isActive(record.id));
  expect(clearScope.mock.calls).toContainEqual([record.id, 'execution']);
  expect(owner?.armedIn(record.id, 'execution')).toEqual([]);
});
