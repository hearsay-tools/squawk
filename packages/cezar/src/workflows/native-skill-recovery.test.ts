import { beforeEach, expect, it } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec, ContentBlock } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../runners/claude/spec-support.ts';
import { fixedSkillCatalog } from '../core/runner-skill-fixture.testkit.ts';
import { crashStore } from '../runs/run-store.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { createFixtureManager, fixtureWork, fixtureWorkSettled } from './fixture-cleanup.testkit.ts';
import { runnerHook, setupMonitoringFixture, waitForProduct } from './run-fixture.testkit.ts';
import type { RunManager } from './run.ts';
import { join } from 'node:path';

const f = setupMonitoringFixture();
const catalog = () => fixedSkillCatalog([{ id: 'known', name: 'Known', path: '/listed/known', scope: 'repo' }]);
type Session = { emit(event: AgentEvent): void; close(): void; spec: AgentRunSpec; sent: ContentBlock[][] };
let sessions: Session[];
let store: RunStore;
let manager: RunManager;
let heldMessageId: string;
let heldAttachment: string;

beforeEach(() => {
  store = f.store;
  manager = f.manager;
  sessions = [];
  manager.setSkillCatalog(catalog());
  runnerHook.runner = {
    backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
    inputDelivery: { mode: 'steer', consumption: 'unobservable', acknowledgement: 'write', humanInputAtTurnEnd: 'never-held', via: 'recovery fixture' },
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {},
    startSession(spec, onEvent) {
      let open = true;
      let finish!: (result: AgentRunResult) => void;
      const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
      const close = () => { open = false; finish({ text: '', toolCalls: [], tokensUsed: 0 }); };
      const current: Session = { spec, sent: [], emit: event => onEvent?.(event), close };
      sessions.push(current);
      queueMicrotask(() => current.emit({ type: 'session', sessionId: `recovery-${sessions.length}`, resumed: !!spec.resume }));
      return { get open() { return open; }, result,
        sendMessage: blocks => { current.sent.push(structuredClone(blocks)); return true; },
        sendAgentMessage: async () => {}, holdsHumanInput: () => false, discardQueuedMessages: () => {},
        end: close, interrupt: close };
    },
  };
});

async function startHeld(): Promise<string> {
  const record = manager.startRun(f.SINGLE_STEP, { task: 'original task', runner: 'claude', worktree: false });
  f.currentId = record.id;
  await waitForProduct(manager, store, () => store.getRun(record.id)?.steps[0]?.sessionId === 'recovery-1');
  store.commitDelegation([{ id: record.id, delegation: { role: 'root', permissions: [], receipts: [] } }]);
  expect(manager.sendMessage(record.id, [{ type: 'text', text: '/known saved arguments' },
    { type: 'file', mediaType: 'text/plain', data: 'aGVsbG8=' }])).toBe(true);
  expect(sessions[0]!.sent).toEqual([]);
  expect(store.getRun(record.id)?.queuedMessages).toEqual([expect.objectContaining({ text: '/known saved arguments', replayAfterOpen: true })]);
  heldMessageId = store.getRun(record.id)!.queuedMessages![0]!.id;
  heldAttachment = store.getRun(record.id)!.queuedMessages![0]!.images![0]!;
  return record.id;
}

async function restart(): Promise<void> {
  store.flush();
  manager.dispose();
  sessions.at(-1)!.close();
  await fixtureWorkSettled(f.repoRoot);
  crashStore(store);
  store = RunStore.open(join(f.repoRoot, '.ai/cezar'), { keepLive: true });
  manager = createFixtureManager(store, f.repoRoot, { skillCatalog: catalog(), semaphore: f.semaphore });
  f.manager = manager;
  await manager.recover();
}

async function releaseHeld(id: string): Promise<Session> {
  const current = sessions.at(-1)!;
  expect(current.spec.userPrompt).not.toContain('/known saved arguments');
  expect(store.getRun(id)?.queuedMessages?.[0]?.id).toBe(heldMessageId);
  expect(manager.sendMessage(id, [{ type: 'text', text: 'later live input' }])).toBe(true);
  expect(current.sent).toEqual([]); // D6 keeps the restored trigger and all later input behind the running turn.
  current.emit({ type: 'turn-end' });
  await waitForProduct(manager, store, () => current.sent.length === 2 && !store.getRun(id)?.queuedMessages?.length);
  expect(current.sent[0]?.[0]).toEqual({ type: 'skill', id: 'known', path: '/listed/known', args: 'saved arguments' });
  expect(current.sent[0]?.some(block => block.type === 'text' && block.text.includes(heldAttachment.split('/').at(-1)!))).toBe(true);
  expect(store.getRun(id)?.queuedMessages?.some(message => message.id === heldMessageId)).toBe(false);
  expect(current.sent[1]?.[0]).toEqual({ type: 'text', text: 'later live input' });
  expect(store.readEvents(id).filter(event => event.type === 'user-message' && event.text === '/known saved arguments')).toHaveLength(1);
  return current;
}

it('replays a durable held trigger natively after restart, keeps FIFO, and never replays a delivered trigger on another restart', async () => {
  const id = await startHeld();
  await restart();
  await waitForProduct(manager, store, () => sessions.length === 2 && store.getRun(id)?.steps.at(-1)?.sessionId === 'recovery-2');
  await releaseHeld(id);
  await restart();
  await waitForProduct(manager, store, () => sessions.length === 3 && store.getRun(id)?.steps.at(-1)?.sessionId === 'recovery-3');
  expect(store.getRun(id)?.queuedMessages ?? []).toEqual([]);
  sessions[2]!.emit({ type: 'turn-end' });
  // Observe the reopened boundary's delivery work, rather than waiting for the unrelated
  // no-wait nudge to time out: the fixture deliberately emits no answer to that nudge.
  await waitForProduct(manager, store, () => ![...fixtureWork(manager).pending.values()]
    .some(label => label === 'nativeSkillInput'));
  expect(sessions.flatMap(session => session.sent).filter(blocks => blocks[0]?.type === 'skill')).toHaveLength(1);
  expect(sessions[2]!.spec.userPrompt).not.toContain('/known saved arguments');
});

it('replays a durable held trigger natively when Continue replaces the stopped session', async () => {
  const id = await startHeld();
  manager.cancel(id);
  await waitForProduct(manager, store, () => !manager.isActive(id));
  expect(store.getRun(id)?.queuedMessages).toHaveLength(1);
  expect(manager.continueRun(id, { text: 'Continue with the held input' })).toEqual({ ok: true });
  await waitForProduct(manager, store, () => sessions.length === 2 && store.getRun(id)?.steps.at(-1)?.sessionId === 'recovery-2');
  await releaseHeld(id);
});

it('keeps an unmarked queued message folded into the queued Continue opening', async () => {
  const id = await startHeld();
  manager.cancel(id);
  await waitForProduct(manager, store, () => !manager.isActive(id));
  const legacy = { id: 'legacy', text: 'legacy queued amendment', createdAt: new Date().toISOString() };
  store.updateRun(id, { queuedMessages: [legacy] });
  expect(manager.continueRun(id, { text: 'Continue the amended task' }, true)).toEqual({ ok: true });
  await waitForProduct(manager, store, () => sessions.length === 2 && store.getRun(id)?.steps.at(-1)?.sessionId === 'recovery-2');
  expect(sessions[1]!.spec.userPrompt).toContain('original task');
  expect(sessions[1]!.spec.userPrompt).toContain('legacy queued amendment');
  expect(sessions[1]!.sent).toEqual([]);
  expect(store.getRun(id)?.queuedMessages).toEqual([legacy]);
});
