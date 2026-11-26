import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { waitFor } from '../../core/harness-parity-core.testkit.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { withOwnedInputRun } from '../../core/worker-parity-core.testkit.ts';
import { withRejectedInput } from '../../core/owned-input-delivery.testkit.ts';
import { SessionEndedBeforeAcknowledgement } from '../../core/agent-runner-values.ts';
import { agentInputSchema } from '@open-mercato/cezar-contract/agent-input';
import type { AgentInput } from '@open-mercato/cezar-contract';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../core/agent-runner.ts';
import type { UiEvent } from '../../core/ui-events.ts';
import { AntigravityRunner } from './antigravity-runner.ts';
import { antigravityRunner } from './definition.ts';

useRunners(onlyRunner(antigravityRunner, () => new AntigravityRunner()));
sealTestRunners();

const bin = join(import.meta.dirname, '../../../scripts/mock-acp.mjs');
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function workspace() { const dir = await mkdtemp(join(tmpdir(), 'antigravity-perm-steer-')); dirs.push(dir); return dir; }

const agentInput = (parentRunId: string, text: string): AgentInput => ({
  id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId, text, createdAt: new Date().toISOString(),
});

describe('Antigravity permission-wait steer deferral (hearsay-tools/squawk#4181)', () => {
  it('returns false from sendAgentMessage while an ACP permission is open and signals onAgentInputReady once resolved', async () => {
    const cwd = await workspace();
    const wire = join(cwd, 'wire.ndjson');
    const events: AgentEvent[] = [];
    const ui: UiEvent[] = [];
    let readyCount = 0;
    let ack: Promise<void> | false = false;
    const session = new AntigravityRunner({ bin }).startSession(
      { cwd, toolGrant: { kind: 'unset' }, userPrompt: 'mock:approval', env: { HSQ_APPROVAL_GATE: '1', CEZ_MOCK_STDIN_FILE: wire } },
      event => events.push(event),
      {
        autoEndAfterFirstTurn: true,
        onUiEvent: event => ui.push(event),
        onAgentInputReady: () => { readyCount++; },
      },
    );
    try {
      await waitFor(() => ui.some(event => event.type === 'permission.requested'));
      const request = ui.find((event): event is Extract<UiEvent, { type: 'permission.requested' }> => event.type === 'permission.requested')!;
      expect(session.sendAgentMessage([{ type: 'text', text: 'deferred during open permission' }])).toBe(false);
      const beforeReady = readyCount;
      expect(session.respondPermission?.(request.requestId, 'allow-once')).toBe(true);
      await waitFor(() => readyCount > beforeReady);
      ack = session.sendAgentMessage([{ type: 'text', text: 'delivered after permission' }]);
      expect(ack).not.toBe(false);
      await ack;
      await session.result;
      const frames = (await readFile(wire, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const permissionReplyIndex = frames.findIndex(frame => !frame.method && frame.result?.outcome?.optionId === 'allow-once');
      const steeredPromptIndex = frames.findIndex(frame => frame.method === 'session/prompt' && JSON.stringify(frame.params.prompt).includes('delivered after permission'));
      expect(permissionReplyIndex).toBeGreaterThan(-1);
      expect(steeredPromptIndex).toBeGreaterThan(permissionReplyIndex);
      expect(events.filter(event => event.type === 'text').map(event => event.text).join('')).toContain('delivered after permission');
    } finally { session.interrupt(); await session.result.catch(() => undefined); }
  });

  it.each([
    ['auto-approved before rejection arrives', 'mock:permission-race-auto', {}],
    ['rejection arrives before auto-approved permission', 'mock:permission-race-early', {}],
    ['rejection arrives before gated permission card', 'mock:permission-race-early gated', { HSQ_APPROVAL_GATE: '1' }],
  ] as const)('retries a mid-turn sendAgentMessage steer without failing when %s', async (_label, userPrompt, env) => {
    const cwd = await workspace();
    const events: AgentEvent[] = [];
    const ui: UiEvent[] = [];
    const session = new AntigravityRunner({ bin }).startSession(
      { cwd, toolGrant: { kind: 'explicit', tools: ['Bash'] }, userPrompt, env },
      event => events.push(event),
      { autoEndAfterFirstTurn: true, onUiEvent: event => ui.push(event) },
    );
    try {
      await waitFor(() => events.some(event => event.type === 'tool-call'));
      const ack = session.sendAgentMessage([{ type: 'text', text: 'peer progress steer' }]);
      expect(ack).not.toBe(false);
      if (userPrompt.includes('gated')) {
        await waitFor(() => ui.some(event => event.type === 'permission.requested'));
        const request = ui.find((event): event is Extract<UiEvent, { type: 'permission.requested' }> => event.type === 'permission.requested')!;
        expect(session.respondPermission?.(request.requestId, 'allow-once')).toBe(true);
      }
      await ack;
      await session.result;
      expect(events.filter(event => event.type === 'error')).toEqual([]);
      expect(events.filter(event => event.type === 'text').map(event => event.text).join('')).toContain('saw: peer progress steer');
    } finally { session.interrupt(); await session.result.catch(() => undefined); }
  });

  it.each([
    ['permission approved mid-turn', 'allow-once'],
    ['permission denied ending the turn', 'reject-once'],
  ] as const)('retries a mid-turn sendMessage steer without closing the session when %s', async (_label, decision) => {
    const cwd = await workspace();
    const events: AgentEvent[] = [];
    const ui: UiEvent[] = [];
    const session = new AntigravityRunner({ bin }).startSession(
      { cwd, toolGrant: { kind: 'unset' }, userPrompt: 'mock:permission-race-early gated', env: { HSQ_APPROVAL_GATE: '1' } },
      event => events.push(event),
      { autoEndAfterFirstTurn: true, onUiEvent: event => ui.push(event) },
    );
    try {
      await waitFor(() => events.some(event => event.type === 'tool-call'));
      expect(session.sendMessage([{ type: 'text', text: 'human steer during race' }])).toBe(true);
      expect(session.holdsHumanInput()).toBe(true);
      await waitFor(() => ui.some(event => event.type === 'permission.requested'));
      const request = ui.find((event): event is Extract<UiEvent, { type: 'permission.requested' }> => event.type === 'permission.requested')!;
      expect(session.holdsHumanInput()).toBe(true);
      expect(session.respondPermission?.(request.requestId, decision)).toBe(true);
      await session.result;
      expect(session.holdsHumanInput()).toBe(false);
      expect(events.filter(event => event.type === 'error')).toEqual([]);
      const text = events.filter(event => event.type === 'text').map(event => event.text).join('');
      expect(text).toContain('human steer during race');
    } finally { session.interrupt(); await session.result.catch(() => undefined); }
  });

  it('holds a steer rejected for ask_question until the human answers instead of hijacking the question', async () => {
    const cwd = await workspace();
    const events: AgentEvent[] = [];
    const ui: UiEvent[] = [];
    const session = new AntigravityRunner({ bin }).startSession(
      { cwd, toolGrant: { kind: 'unset' }, userPrompt: 'mock:permission-race-ask' },
      event => events.push(event),
      { autoEndAfterFirstTurn: true, onUiEvent: event => ui.push(event) },
    );
    try {
      await waitFor(() => events.some(event => event.type === 'tool-call'));
      const ack = session.sendAgentMessage([{ type: 'text', text: 'deferred peer update' }]);
      expect(ack).not.toBe(false);
      await waitFor(() => ui.some(event => event.type === 'ask.requested') && ui.some(event => event.type === 'turn.completed'));
      // The deferred agent steer must not answer the native ask_question card.
      expect(events.filter(event => event.type === 'text').map(event => event.text).join('')).not.toContain('Answer received:');
      expect(session.sendMessage([{ type: 'text', text: 'Question: Vitest' }])).toBe(true);
      await ack;
      await session.result;
      const text = events.filter(event => event.type === 'text').map(event => event.text).join('');
      expect(text).toContain('Answer received: Vitest');
      expect(text).toContain('deferred peer update');
    } finally { session.interrupt(); await session.result.catch(() => undefined); }
  });

  it('drains a deferred agent steer followed by a deferred human steer once the permission resolves', async () => {
    const cwd = await workspace();
    const events: AgentEvent[] = [];
    const ui: UiEvent[] = [];
    const session = new AntigravityRunner({ bin }).startSession(
      { cwd, toolGrant: { kind: 'explicit', tools: ['Bash'] }, userPrompt: 'mock:permission-race-early gated', env: { HSQ_APPROVAL_GATE: '1' } },
      event => events.push(event),
      { autoEndAfterFirstTurn: true, onUiEvent: event => ui.push(event) },
    );
    try {
      await waitFor(() => events.some(event => event.type === 'tool-call'));
      const ack = session.sendAgentMessage([{ type: 'text', text: 'first deferred agent steer' }]);
      expect(ack).not.toBe(false);
      await waitFor(() => ui.some(event => event.type === 'permission.requested'));
      const request = ui.find((event): event is Extract<UiEvent, { type: 'permission.requested' }> => event.type === 'permission.requested')!;
      expect(session.sendMessage([{ type: 'text', text: 'second deferred human steer' }])).toBe(true);
      expect(session.holdsHumanInput()).toBe(true);
      expect(session.respondPermission?.(request.requestId, 'allow-once')).toBe(true);
      await ack;
      await session.result;
      expect(session.holdsHumanInput()).toBe(false);
      const text = events.filter(event => event.type === 'text').map(event => event.text).join('');
      expect(text).toContain('first deferred agent steer');
      expect(text).toContain('second deferred human steer');
      expect(events.filter(event => event.type === 'error')).toEqual([]);
    } finally { session.interrupt(); await session.result.catch(() => undefined); }
  });

  it('still fails delivery on unrelated ACP RPC rejections for sendAgentMessage and sendMessage', async () => {
    await withRejectedInput('antigravity', async () => {
      const cwd = await workspace();
      const events: AgentEvent[] = [];
      const session = new AntigravityRunner({ bin }).startSession(
        { cwd, toolGrant: { kind: 'unset' }, userPrompt: 'mock:steer-tool', env: { CEZ_MOCK_STEER_GATE: join(cwd, 'release') } },
        event => events.push(event),
        {},
      );
      const settled = session.result.catch(() => undefined);
      try {
        await waitFor(() => events.some(event => event.type === 'tool-call'));
        const ack = session.sendAgentMessage([{ type: 'text', text: 'reject-owned-turn' }]);
        expect(ack).not.toBe(false);
        await expect(ack).rejects.toThrow('owned turn rejected');
      } finally { session.interrupt(); await settled; }
    });
  });

  it('rejects a deferred sendAgentMessage with SessionEndedBeforeAcknowledgement when closed before permission resolves', async () => {
    const cwd = await workspace();
    const events: AgentEvent[] = [];
    const ui: UiEvent[] = [];
    const session = new AntigravityRunner({ bin }).startSession(
      { cwd, toolGrant: { kind: 'unset' }, userPrompt: 'mock:permission-race-early gated', env: { HSQ_APPROVAL_GATE: '1' } },
      event => events.push(event),
      { onUiEvent: event => ui.push(event) },
    );
    try {
      await waitFor(() => events.some(event => event.type === 'tool-call'));
      const ack = session.sendAgentMessage([{ type: 'text', text: 'cancelled while deferred' }]);
      expect(ack).not.toBe(false);
      await waitFor(() => ui.some(event => event.type === 'permission.requested'));
      session.end();
      await expect(ack).rejects.toBeInstanceOf(SessionEndedBeforeAcknowledgement);
      await session.result;
    } finally { session.interrupt(); await session.result.catch(() => undefined); }
  });

  it('parity: RunManager keeps queued worker input across an open Antigravity permission card and delivers once approved', async () => {
    await withOwnedInputRun('antigravity', 'approval', async ({ store, manager, runId, parentRunId }) => {
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.eventLog.readEvents(runId).some(event => event.type === 'permission.requested'));
      expect(store.getRun(runId)).toMatchObject({ status: RUN_STATUS.waiting, hasPendingPermission: true });
      const request = store.eventLog.readEvents(runId).find(event => event.type === 'permission.requested')!;
      const steer = agentInput(parentRunId, 'mock:agent-echo steer after approval');
      expect(manager.steerWorker(runId, steer)).toBe('queued');
      expect(store.getRun(runId)?.agentInputs?.find(item => item.id === steer.id)?.deliveredAt).toBeUndefined();
      expect(manager.respondPermission(runId, request.requestId as string, 'allow-once')).toBe(true);
      await waitFor(() => !!store.getRun(runId)?.agentInputs?.find(item => item.id === steer.id)?.deliveredAt);
      await waitFor(() => !manager.isActive(runId));
      expect(store.getRun(runId)?.status).toBe(RUN_STATUS.done);
      const text = store.eventLog.readEvents(runId).filter(event => event.type === 'text').map(event => event.text).join('\n');
      expect(text).toContain('steer after approval');
    });
  }, 45_000);

  it('parity: RunManager survives an Antigravity auto-approved permission wire race without failing the worker', async () => {
    await withOwnedInputRun('antigravity', 'baseline', async ({ store, manager, runId, parentRunId }) => {
      store.updateRun(runId, { task: 'mock:permission-race-auto with-done' });
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.eventLog.readEvents(runId).some(event => event.type === 'tool-call'));
      const steer = agentInput(parentRunId, 'peer progress during auto-approval race');
      expect(manager.steerWorker(runId, steer)).toBe('queued');
      await waitFor(() => !!store.getRun(runId)?.agentInputs?.find(item => item.id === steer.id)?.deliveredAt);
      await waitFor(() => !manager.isActive(runId));
      expect(store.getRun(runId)?.status).toBe(RUN_STATUS.done);
      expect(store.getRun(runId)?.error).toBeUndefined();
      const text = store.eventLog.readEvents(runId).filter(event => event.type === 'text').map(event => event.text).join('\n');
      expect(text).toContain('saw: peer progress during auto-approval race');
    });
  }, 45_000);
});
