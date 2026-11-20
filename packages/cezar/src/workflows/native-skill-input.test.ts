import { makeHumanWait } from '@open-mercato/cezar-contract/test-factories.testkit';
import { beforeEach, expect, it, vi } from 'vitest';
import type { RunnerSkill } from '@open-mercato/cezar-contract/runner-skills';
import type { AgentEvent, AgentRunResult, AgentRunSpec, ContentBlock } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../runners/claude/spec-support.ts';
import { RUNNER_FACTS } from '../core/runner-facts.ts';
import { fixedSkillCatalog } from '../core/runner-skill-fixture.testkit.ts';
import { runnerHook, setupMonitoringFixture, waitForProduct } from './run-fixture.testkit.ts';
import { factsAtDone } from './run/done-accepted.ts';
import { fixtureWork } from './fixture-cleanup.testkit.ts';

const f = setupMonitoringFixture();
let emit: (event: AgentEvent) => void;
let opened: Promise<void>;
let openedResolve: () => void;
let sent: ContentBlock[][];
let backend: string;
let launches: AgentRunSpec[];

beforeEach(() => {
  backend = 'claude';
  launches = [];
  sent = [];
  opened = new Promise(resolve => { openedResolve = resolve; });
  runnerHook.runner = {
    get backend() { return backend; }, specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
    inputDelivery: { mode: 'steer', consumption: 'unobservable', acknowledgement: 'write', humanInputAtTurnEnd: 'never-held', via: 'native skill fixture' },
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {},
    startSession(spec, onEvent) {
      launches.push(spec);
      let open = true;
      let finish!: (result: AgentRunResult) => void;
      const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
      const close = () => { open = false; finish({ text: '', toolCalls: [], tokensUsed: 0 }); };
      emit = event => onEvent?.(event);
      queueMicrotask(() => { emit({ type: 'session', sessionId: 'native-input', resumed: false }); openedResolve(); });
      return { get open() { return open; }, result, sendMessage: blocks => { sent.push(structuredClone(blocks)); return true; },
        sendAgentMessage: async () => {}, discardQueuedMessages: () => {}, holdsHumanInput: () => false,
        end: close, interrupt: close };
    },
  };
});

async function start(runner: string = 'claude', skills: RunnerSkill[] = [{ id: 'known', name: 'Known', path: '/listed/known', scope: 'repo' as const }]) {
  backend = runner;
  f.manager.setSkillCatalog(fixedSkillCatalog(skills));
  const record = f.manager.startRun(f.SINGLE_STEP, { task: 'work', runner, worktree: false });
  f.currentId = record.id;
  await opened;
  return record.id;
}
async function readFinished() {
  await waitForProduct(f.manager, f.store, () => ![...fixtureWork(f.manager).pending.values()].includes('nativeSkillInput'));
}
const say = (id: string, text: string) => f.manager.sendMessage(id, [{ type: 'text', text }]);

it('holds a known trigger during a turn and sends it at the turn end', async () => {
  const id = await start();
  expect(say(id, '/known arguments')).toBe(true);
  expect(sent).toEqual([]); // No asynchronous work starts while the turn holds the trigger.
  expect(f.store.getRun(id)?.queuedMessages?.[0]?.text).toBe('/known arguments');
  emit({ type: 'turn-end' });
  await waitForProduct(f.manager, f.store, () => sent.length === 1 && !f.store.getRun(id)?.queuedMessages?.length);
  expect(sent[0]?.[0]).toEqual({ type: 'skill', id: 'known', path: '/listed/known', args: 'arguments' });
  expect(f.store.readEvents(id).some(event => event.type === 'user-message' && event.text === '/known arguments')).toBe(true);
});

it('skillTriggerMidTurn true sends a native trigger during a running turn', async () => {
  expect(String(RUNNER_FACTS.pi!.skillTriggerMidTurn)).toBe('true');
  const id = await start('pi');
  expect(say(id, '/known now')).toBe(true);
  await readFinished();
  expect(sent[0]?.[0]).toMatchObject({ type: 'skill', id: 'known', args: 'now' });
});

it('skillUnknownName error still receives an unknown typed name as unchanged text', async () => {
  expect(RUNNER_FACTS.opencode!.skillUnknownName).toBe('error');
  const id = await start('opencode');
  expect(say(id, '/unknown verbatim')).toBe(true);
  await readFinished();
  expect(sent[0]?.[0]).toEqual({ type: 'text', text: '/unknown verbatim' });
});

it('resolves an ambiguous held name at release and reports every path', async () => {
  const id = await start('claude', ['/one', '/two'].map(path => ({ id: 'known', name: 'Known', path, scope: 'repo' })));
  expect(say(id, '/known arguments')).toBe(true);
  expect(f.store.readEvents(id).some(event => event.type === 'note' && String(event.message).includes('ambiguous'))).toBe(false); // Resolution is deferred, with no real-time absence wait.
  emit({ type: 'turn-end' });
  await readFinished();
  expect(sent[0]?.[0]).toEqual({ type: 'text', text: '/known arguments' });
  const note = f.store.readEvents(id).find(event => event.type === 'note' && String(event.message).includes('ambiguous'));
  expect(note?.message).toContain('/one'); expect(note?.message).toContain('/two');
});

it('keeps the session snapshot and explains a name that appears only in a fresh list', async () => {
  const id = await start();
  f.manager.setSkillCatalog(fixedSkillCatalog([{ id: 'new', name: 'New', path: '/new', scope: 'repo' }]));
  expect(say(id, '/new arguments')).toBe(true);
  await readFinished();
  expect(sent[0]?.[0]).toEqual({ type: 'text', text: '/new arguments' });
  expect(f.store.readEvents(id).some(event => event.type === 'note' && String(event.message).includes('after the next Continue'))).toBe(true);
  expect(f.manager.sessionSkills(id).map(skill => skill.id)).toEqual(['known']);
});

it('skillsSeenBySession live resolves a newly listed name at send time', async () => {
  expect(RUNNER_FACTS.codex!.skillsSeenBySession).toBe('live');
  const id = await start('codex');
  f.manager.setSkillCatalog(fixedSkillCatalog([{ id: 'new', name: 'New', path: '/new', scope: 'repo' }]));
  expect(say(id, '/new arguments')).toBe(true);
  await readFinished();
  expect(sent).toEqual([]); // The live read found a trigger, but this runner holds it until turn end.
  emit({ type: 'turn-end' });
  await readFinished();
  expect(sent[0]?.[0]).toEqual({ type: 'skill', id: 'new', path: '/new', args: 'arguments' });
});

it('retains the accepted content when its caller changes the held message', async () => {
  const id = await start();
  const content: ContentBlock[] = [{ type: 'text', text: '/known original' }];
  expect(f.manager.sendMessage(id, content)).toBe(true);
  content[0] = { type: 'text', text: '/known changed' };
  emit({ type: 'turn-end' });
  await readFinished();
  expect(sent[0]?.[0]).toMatchObject({ type: 'skill', args: 'original' });
});

it('does not send a held trigger after Stop', async () => {
  const id = await start();
  expect(say(id, '/known arguments')).toBe(true);
  f.manager.cancel(id);
  await f.manager.awaitRunTermination(id, 15000); // bound: cancellation must release the fake session and its owned work.
  expect(sent).toEqual([]);
});

it('uses a plugin-qualified id exactly and preserves a near miss', async () => {
  const id = await start('pi', [{ id: 'plugin:known', name: 'Plugin skill', path: '/plugin', scope: 'user' }]);
  expect(say(id, '/plugin:known exact')).toBe(true);
  await readFinished();
  expect(sent[0]?.[0]).toMatchObject({ type: 'skill', id: 'plugin:known', args: 'exact' });
  expect(say(id, '/plugin:know near miss')).toBe(true);
  await readFinished();
  expect(sent[1]?.[0]).toEqual({ type: 'text', text: '/plugin:know near miss' });
});


it('fails a selected skill before a model call when its runner list is unavailable', async () => {
  const catalog = fixedSkillCatalog();
  vi.spyOn(catalog, 'get').mockResolvedValue({ runner: 'claude', skills: [], problems: [], source: 'unavailable', reason: 'probe refused sentinel' });
  f.manager.setSkillCatalog(catalog);
  const record = f.manager.startRun({ ...f.SINGLE_STEP, steps: [{ id: 'task', skill: 'known', prompt: '{{task}}' }] }, { task: 'work', runner: 'claude', worktree: false });
  f.currentId = record.id;
  await waitForProduct(f.manager, f.store, () => f.store.getRun(record.id)?.status === 'failed' && !f.manager.isActive(record.id));
  expect(f.store.getRun(record.id)?.error).toContain('claude account "default" skill "known"');
  expect(f.store.getRun(record.id)?.error).toContain('runner skill list is unavailable: probe refused sentinel');
  expect(f.store.readEvents(record.id).some(event => event.type === 'session')).toBe(false);
});

it('passes an unknown opening command without probing the list a second time', async () => {
  const catalog = fixedSkillCatalog();
  const get = vi.spyOn(catalog, 'get');
  f.manager.setSkillCatalog(catalog);
  const record = f.manager.startRun(f.SINGLE_STEP, { task: '/unknown arguments', runner: 'claude', worktree: false });
  f.currentId = record.id;
  await opened;
  expect(get).toHaveBeenCalledOnce();
  expect(f.store.readEvents(record.id).some(event => event.type === 'note' && String(event.message).includes('after the next Continue'))).toBe(false);
});


it('starts a unique other-scope plugin skill without a reported path', async () => {
  f.manager.setSkillCatalog(fixedSkillCatalog([{ id: 'plugin:known', name: 'Plugin skill', scope: 'other' }]));
  const record = f.manager.startRun({ ...f.SINGLE_STEP, steps: [{ id: 'task', skill: 'plugin:known', prompt: '{{task}}' }] },
    { task: 'plugin arguments', runner: 'claude', worktree: false });
  f.currentId = record.id;
  await opened;
  expect(launches[0]?.skill).toEqual({ id: 'plugin:known', args: 'plugin arguments' });
});

it('turns a unique other-scope typed plugin name into a trigger', async () => {
  const id = await start('claude', [{ id: 'plugin:known', name: 'Plugin skill', scope: 'other' }]);
  expect(say(id, '/plugin:known exact')).toBe(true);
  emit({ type: 'turn-end' });
  await readFinished();
  expect(sent[0]?.[0]).toEqual({ type: 'skill', id: 'plugin:known', args: 'exact' });
});

it('delivers a native question answer ahead of a held trigger, then sends the trigger once', async () => {
  const id = await start();
  expect(say(id, '/known after the answer')).toBe(true);
  runnerHook.uiEvent({ type: 'ask.requested', requestId: 'native-question',
    questions: [{ header: 'Choice', question: 'Which implementation?' }] });
  expect(say(id, 'Use the first implementation')).toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.[0]).toEqual({ type: 'text', text: 'Use the first implementation' });
  expect(f.store.getRun(id)?.queuedMessages?.map(message => message.text)).toEqual(['/known after the answer']);
  emit({ type: 'turn-end' });
  await readFinished();
  expect(sent).toHaveLength(2);
  expect(sent[1]?.[0]).toMatchObject({ type: 'skill', id: 'known', args: 'after the answer' });
  expect(f.store.getRun(id)?.queuedMessages).toEqual([]);
});

it('resolves a second step slash prompt before adding its chain context', async () => {
  f.manager.setSkillCatalog(fixedSkillCatalog([{ id: 'known', name: 'Known', scope: 'repo', path: '/listed/known' }]));
  const record = f.manager.startRun({ name: 'slash-chain', source: 'built-in', steps: [
    { id: 'first', prompt: 'first step' }, { id: 'second', prompt: '/known arguments' },
  ] }, { task: 'work', runner: 'claude', worktree: false });
  f.currentId = record.id;
  await opened;
  // The first step has accepted done; its turn end starts the next step.
  f.store.commitOutcome(record.id, { kind: 'done-accepted', done: { session: 'native-input', at: new Date().toISOString(),
    seq: f.store.transcriptFacts(record.id).lastSeq, ...factsAtDone(f.store.getRun(record.id)!) } });
  emit({ type: 'turn-end' });
  await waitForProduct(f.manager, f.store, () => launches.length === 2);
  expect(launches[1]?.skill).toMatchObject({ id: 'known', path: '/listed/known' });
  expect(launches[1]?.skill?.args).toContain('arguments');
  expect(launches[1]?.skill?.args).toContain('you are running step 2 of 2');
  expect(launches[1]?.skill?.args).not.toContain('/known');
});


it('surfaces a turn-ending question before a held trigger and delivers the answer first', async () => {
  const id = await start();
  expect(say(id, '/known after the answer')).toBe(true);
  f.store.commitWait(id, makeHumanWait({ questions: [{ header: 'Choice', question: 'Which implementation?' }] }));
  emit({ type: 'turn-end' });
  expect(f.store.readEvents(id).some(event => event.type === 'ask.requested')).toBe(true);
  expect(sent).toEqual([]); // The question is surfaced; the held trigger cannot answer it.
  expect(say(id, 'Use the first implementation')).toBe(true);
  expect(sent[0]?.[0]).toEqual({ type: 'text', text: 'Use the first implementation' });
  emit({ type: 'turn-end' });
  await readFinished();
  expect(sent).toHaveLength(2);
  expect(sent[1]?.[0]).toMatchObject({ type: 'skill', id: 'known', args: 'after the answer' });
  expect(f.store.getRun(id)?.queuedMessages).toEqual([]);
});
