import '../core-registries.testkit.ts';
import { runnerDefinition } from './runner-registry.ts';
import { sessionWire } from '../workflows/runner-session-wires.testkit.ts';
import type { WireRow } from '../workflows/native-session-wire.testkit.ts';
import { fixedSkillCatalog } from './runner-skill-fixture.testkit.ts';
import { IN_THREAD } from './skill-resume-rows.testkit.ts';
import { asRecord, opencodeSessionGets, parsedLines, readRecording, setSkillResumeEngineCells, type SkillResumeEngineCells } from './skill-resume-parity.testkit.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
/**
 * hearsay-tools/squawk#3751: Continue and recovery keep native skill/session behavior without
 * injecting skill text or retriggering a skill in a resumed conversation.
 * These are the cells that run a workflow through RunManager; the seam cells (R56 and the
 * systemPromptOnResume declaration) live in skill-resume-parity.testkit.ts.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import { observationClock } from './observation-clock.testkit.ts';
import { IDLE_TIMEOUT_MS } from '../workflows/run/constants.ts';
import {
  HARNESS_ADAPTERS,
  promptFor,
  waitFor,
} from './harness-parity-core.testkit.ts';
import { setRunStatus, readPersistedRuns, seedRuns } from '../runs/run-store.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { createFixtureManager, drainFixtureManagers, fixtureWork } from '../workflows/fixture-manager.testkit.ts';
import { RunManager } from '../workflows/run.ts';
import { plannedWorkflow, skillTaskSteps } from '../workflows/types.ts';
import { onRunWrite } from '../runs/lifecycle-listeners.testkit.ts';
// Its stores reach worker executions: the shipped ones (hearsay-tools/squawk#4039).
import '../delegation/worker-executions.testkit.ts';


const execFileAsync = promisify(execFile);
const GIT_IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const SKILL_NAME = 'probe-project';
const SKILL_DESCRIPTION = 'Playbook for continued skill-driven tasks.';
const SKILL_BODY = 'PLAYBOOK-BODY-790-SENTINEL';
const EXTRA_PROMPT = 'EXTRA-PROMPT-790';

const LOST_OPENCODE_SESSION =
  'OpenCode session ses_mock_1 no longer exists; the continuation runs in a fresh session without the earlier conversation.';

function skillMarkdown(): string {
  return `---\nname: ${SKILL_NAME}\ndescription: ${SKILL_DESCRIPTION}\n---\n${SKILL_BODY}\n`;
}

function opencodeSessionPosts(recording: string): unknown[] {
  return parsedLines(recording).filter((row) => {
    const rec = asRecord(row);
    return rec?.method === 'POST' && rec.url === '/session';
  });
}

function recordedSessionId(store: RunStore, runId: string): string {
  const ids = store.getRun(runId)?.steps.map((step) => step.sessionId).filter((value): value is string => Boolean(value)) ?? [];
  const id = ids.at(-1);
  expect(id, `${runId} recorded a session id`).toBeDefined();
  return id!;
}

function assertReusedRecordedSession(
  backend: string,
  continuationRecording: string,
  sessionId: string,
  argsRecording: string,
): void {
  if (backend === 'opencode') {
    expect(opencodeSessionPosts(continuationRecording), `${backend} Continue must not POST /session`).toEqual([]);
    expect(opencodeSessionGets(continuationRecording)).toEqual([sessionId]);
    return;
  }
  if (backend === 'codex') {
    expect(continuationRecording).toContain('thread/resume');
    expect(continuationRecording).toContain(sessionId);
    expect(continuationRecording).not.toContain('thread/start');
    return;
  }
  if (backend === 'claude') {
    expect(continuationRecording).toMatch(/--resume/);
    expect(continuationRecording).toContain(sessionId);
    return;
  }
  if (backend === 'pi') {
    expect(continuationRecording).toMatch(/--session/);
    expect(continuationRecording).toContain(sessionId);
    return;
  }
  // The combined recording mirrors stdin requests in args. Read one source,
  // so the exact one-resume assertion counts native requests, not their copies.
  const rows = parsedLines(argsRecording) as WireRow[];
  expect(sessionWire(backend).resumed(rows)).toEqual([sessionId]);
  expect(sessionWire(backend).freshSessions(rows)).toBe(0);
}

function systemFromPrepended(text: string): string {
  const sep = '\n\n---\n\n';
  const at = text.lastIndexOf(sep);
  return at >= 0 ? text.slice(0, at) : text;
}

function appendedSystemPrompts(rows: unknown[]): string[] {
  return rows.flatMap((row) => {
    if (!Array.isArray(row)) return [];
    const index = row.indexOf('--append-system-prompt');
    return index >= 0 && typeof row[index + 1] === 'string' ? [row[index + 1]] : [];
  });
}

function recordedSystemPrompt(backend: string, rec: Record<string, unknown>): string | undefined {
  if (backend === 'codex' && rec.method === 'turn/start') {
    const input = (rec.params as { input?: Array<{ text?: string }> } | undefined)?.input;
    const text = input?.[0]?.text;
    if (typeof text === 'string') return systemFromPrepended(text);
  }
  if (backend === 'opencode' && typeof rec.url === 'string' && rec.url.endsWith('/command')) return (rec.body as { arguments?: string }).arguments;
  if (backend === 'opencode' && typeof rec.url === 'string' && rec.url.includes('prompt_async')) {
    const parts = (rec.body as { parts?: Array<{ type?: string; text?: string }> } | undefined)?.parts;
    const text = parts?.[0]?.text;
    if (typeof text === 'string') return systemFromPrepended(text);
  }
  return undefined;
}

function systemPromptsFrom(backend: string, recording: string): string[] {
  const rows = parsedLines(recording);
  if (backend === 'claude' || backend === 'pi' || backend === 'omp') return appendedSystemPrompts(rows);
  if (!['codex', 'opencode'].includes(backend)) {
    const prompt = sessionWire(backend).systemPrompt({ args: rows as WireRow[], stdin: rows as WireRow[] });
    return prompt === undefined ? [] : [prompt];
  }
  const texts: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const text = recordedSystemPrompt(backend, row as Record<string, unknown>);
    if (text !== undefined) texts.push(text);
  }
  return texts;
}

function fileText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

type WireMark = { args: number; stdin: number };

function wireSince(argsFile: string, stdinFile: string, marked: WireMark): string {
  return `${fileText(argsFile).slice(marked.args)}${fileText(stdinFile).slice(marked.stdin)}`;
}

function markWire(argsFile: string, stdinFile: string): WireMark {
  return { args: fileText(argsFile).length, stdin: fileText(stdinFile).length };
}

function skillInPrompt(prompt: string, _repoRoot: string): boolean {
  return !prompt.includes(SKILL_BODY) && !prompt.includes('Selected skill:') && prompt.includes(EXTRA_PROMPT);
}
function hasNativeTrigger(backend: string, recording: string): boolean {
  if (!['claude', 'codex', 'opencode', 'pi', 'omp'].includes(backend)) {
    const rows = parsedLines(recording) as WireRow[];
    return sessionWire(backend).skillTriggers({ args: rows, stdin: rows }, SKILL_NAME).length > 0;
  }
  return parsedLines(recording).some(row => {
    const rec = asRecord(row);
    if (!rec) return false;
    if (backend === 'codex') {
      const input = asRecord(rec.params)?.input;
      return rec.method === 'turn/start' && Array.isArray(input) && input.some(block => asRecord(block)?.type === 'skill');
    }
    if (backend === 'opencode') return typeof rec.url === 'string' && rec.url.endsWith('/command') && asRecord(rec.body)?.command === SKILL_NAME;
    if (backend === 'claude') return Array.isArray(rec.blocks) && rec.blocks.some(block => {
      const text = asRecord(block)?.text;
      return typeof text === 'string' && text.startsWith(`/${SKILL_NAME} `);
    });
    return typeof rec.userText === 'string' && rec.userText.startsWith(`/skill:${SKILL_NAME} `);
  });
}

const idleOwners = new WeakMap<RunManager, {
  store: RunStore;
  clock: ReturnType<typeof observationClock>;
  timers: Map<string, number>;
}>();

function observeIdle(manager: RunManager, store: RunStore): () => void {
  let published: string | undefined;
  const timers = new Map<string, number>();
  const onRun = (run: { id: string; status: string }) => { published = run.status === 'waiting' ? run.id : undefined; };
  const stopOnRun = onRunWrite(store.lifecycle, onRun);
  const clock = observationClock(delay => {
    if (delay !== IDLE_TIMEOUT_MS || !/\bat (?:[^ (\n]+\.)?armIdleTimer \(/.test(new Error().stack ?? '')) return false;
    if (!published) throw new Error('idle timer armed before publishing a waiting run');
    timers.set(published, clock.captured);
    return true;
  });
  idleOwners.set(manager, { store, clock, timers });
  return () => { stopOnRun(); clock.restore(); idleOwners.delete(manager); };
}

async function idleClose(manager: RunManager, runId: string): Promise<void> {
  const owner = idleOwners.get(manager)!;
  expect(owner.timers.has(runId), 'the parked run armed its shipped idle timer').toBe(true);
  const message = `session closed after ${Math.round(IDLE_TIMEOUT_MS / 60_000)}m of inactivity`;
  const closed = () => owner.store.eventLog.readEvents(runId).filter(event => event.type === 'lifecycle' && event.message === message);
  const before = closed().length;
  await owner.clock.advance(IDLE_TIMEOUT_MS);
  await waitFor(() => !manager.isActive(runId));
  await Promise.all([...fixtureWork(manager).pending.keys()]);
  expect(closed()).toHaveLength(before + 1);
}

/** What a run-aware wait reads; the fixture's getters follow a restart to the new store and manager. */
interface RunWatch {
  readonly manager: RunManager;
  readonly store: RunStore;
  readonly runId: string;
  readonly wireSince: (marked: WireMark) => string;
}

const SETTLED_RUN: ReadonlySet<string> = new Set(['review', 'done', 'failed', 'cancelled']);
const DESCRIBED_RUN_EVENTS = 40;
const DESCRIBED_WIRE_CHARS = 4_000;

function clip(text: string, max: number): string {
  return text.length > max ? `…${text.slice(text.length - max)}` : text;
}

/** The run's state, its status history, its last events and the wire since `marked`, for a failure message. */
function describeRun(fixture: RunWatch, statuses: readonly string[], marked: WireMark | undefined): string {
  const run = fixture.store.getRun(fixture.runId);
  if (!run) return `run ${fixture.runId}: not in the store`;
  const steps = run.steps.map(step => `  ${step.id} ${step.status}${step.sessionId ? ` session=${step.sessionId}` : ''}${step.backend ? ` backend=${step.backend}` : ''}`);
  const events = fixture.store.eventLog.readEvents(fixture.runId);
  const from = Math.max(0, events.length - DESCRIBED_RUN_EVENTS);
  return [
    `run ${run.id}: status=${run.status} active=${fixture.manager.isActive(run.id)} currentStep=${run.currentStepId ?? '-'}${run.error ? ` error=${run.error}` : ''}`,
    `statuses during the wait: ${statuses.join(' -> ') || '(no write)'}`,
    'steps:', ...steps,
    `events${from > 0 ? ` (last ${DESCRIBED_RUN_EVENTS} of ${events.length})` : ''}:`,
    ...events.slice(from).map(event => `  ${clip(JSON.stringify(event), 400)}`),
    ...(marked ? ['wire since the mark:', clip(fixture.wireSince(marked), DESCRIBED_WIRE_CHARS)] : []),
  ].join('\n');
}

/**
 * Wait until `cond` holds for the fixture's run. A run that settles, or that sits `waiting` after its
 * live session ended, fails the wait at once: nothing in these cells starts it again. The bound stays
 * a hang guard. Either failure carries the run's state, its events and the wire since `marked`.
 */
async function untilRun(fixture: RunWatch, cond: () => boolean, marked?: WireMark, ms = 10_000): Promise<void> {
  const statuses: string[] = [];
  const stopWrites = onRunWrite(fixture.store.lifecycle, run => {
    if (run.id === fixture.runId && statuses.at(-1) !== run.status) statuses.push(run.status);
  });
  const start = Date.now();
  let wasActive = false;
  try {
    // bound: `ms` is a hang guard only; the run settling or its session ending is the earlier signal.
    while (!cond()) {
      const status = fixture.store.getRun(fixture.runId)?.status ?? 'missing';
      const active = fixture.manager.isActive(fixture.runId);
      const ended = SETTLED_RUN.has(status) || status === 'missing'
        ? `the run is ${status}`
        : wasActive && !active && status === 'waiting' ? 'the run\'s session ended while it waited' : undefined;
      if (ended) throw new Error(`${ended} before ${cond.toString()}\n${describeRun(fixture, statuses, marked)}`);
      wasActive ||= active;
      const elapsed = Date.now() - start;
      if (elapsed > ms) throw new Error(`waitFor timed out after ${elapsed}ms: ${cond.toString()}\n${describeRun(fixture, statuses, marked)}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally {
    stopWrites();
  }
}

const PROMPT_MARKERS = ['--append-system-prompt', 'turn/start', 'session/prompt', 'prompt_async', '--output-format'];

/** Wait until the continued run parks on its live session with its prompt on the wire since `marked`. */
async function untilParkedWithPrompt(fixture: RunWatch, marked: WireMark, markers: readonly string[] = PROMPT_MARKERS): Promise<void> {
  await untilRun(fixture, () => fixture.store.getRun(fixture.runId)?.status === 'waiting' && fixture.manager.isActive(fixture.runId), marked);
  await untilRun(fixture, () => markers.some(marker => fixture.wireSince(marked).includes(marker)), marked);
}

/** Idle-close leaves the run `waiting`, so a second wait-for-waiting is a race. */
async function continueAndPark(
  fixture: RunWatch,
  opts: { text: string; runner?: string },
  marked: WireMark,
): Promise<string> {
  expect(fixture.manager.continueRun(fixture.runId, opts).ok).toBe(true);
  await untilParkedWithPrompt(fixture, marked);
  return fixture.wireSince(marked);
}

async function withSkillResumeRun(
  backend: string,
  body: (fixture: {
    repoRoot: string;
    runId: string;
    store: RunStore;
    manager: RunManager;
    argsFile: string;
    stdinFile: string;
    snapshotWire: () => string;
    markWire: () => WireMark;
    wireSince: (marked: WireMark) => string;
    restart: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  runnerDefinition(backend);
  const adapter = HARNESS_ADAPTERS[backend]!;
  const saved: Array<[string, string | undefined]> = [];
  const remember = (name: string, value: string | undefined) => {
    saved.push([name, process.env[name]]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  const repoRoot = mkdtempSync(join(tmpdir(), `cez-skill-resume-${backend}-`));
  const argsFile = join(repoRoot, 'wire.args.ndjson');
  const stdinFile = join(repoRoot, 'wire.stdin.ndjson');
  remember(adapter.binEnv, adapter.mockBin);
  remember('CEZ_AUTONAME', '0');
  remember('CEZ_MOCK_ARGS_FILE', argsFile);
  remember('CEZ_MOCK_STDIN_FILE', stdinFile);
  const dry = process.env.CEZ_DRY_RUN;
  saved.push(['CEZ_DRY_RUN', dry]);
  delete process.env.CEZ_DRY_RUN;
  let store: RunStore | undefined;
  let manager: RunManager | undefined;
  let releaseIdle: (() => void) | undefined;
  try {
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
    await execFileAsync('git', [...GIT_IDENTITY, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar/skills', SKILL_NAME), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar/skills', SKILL_NAME, 'SKILL.md'), skillMarkdown());
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot, { skillCatalog: fixedSkillCatalog([{ id: SKILL_NAME, name: SKILL_NAME, path: join(repoRoot, 'SKILL.md'), scope: 'repo' }]) });
    releaseIdle = observeIdle(manager, store);
    const started = manager.startRun(plannedWorkflow(skillTaskSteps(SKILL_NAME)), {
      task: promptFor(backend, 'baseline'),
      runner: backend,
      worktree: false,
      systemPrompt: EXTRA_PROMPT,
    });
    const since = (marked: WireMark) => wireSince(argsFile, stdinFile, marked);
    const launch: RunWatch = { store, manager, runId: started.id, wireSince: since };
    await untilRun(launch, () => launch.store.getRun(launch.runId)?.status === 'waiting', undefined, 30_000);
    const snapshotWire = () => readRecording(argsFile, stdinFile);
    const mark = () => markWire(argsFile, stdinFile);
    const restart = async () => {
      store!.persistence.flush();
      const dataDir = join(repoRoot, '.ai/cezar');
      const checkpoint = readPersistedRuns(dataDir);
      await drainFixtureManagers(repoRoot);
      store!.close();
      releaseIdle!();
      seedRuns(dataDir, checkpoint);
      store = RunStore.open(dataDir, { keepLive: true });
      manager = createFixtureManager(store, repoRoot, { skillCatalog: fixedSkillCatalog([{ id: SKILL_NAME, name: SKILL_NAME, path: join(repoRoot, 'SKILL.md'), scope: 'repo' }]) });
      releaseIdle = observeIdle(manager, store);
      await manager.recover();
    };
    await body({
      repoRoot,
      runId: started.id,
      get store() { return store!; },
      get manager() { return manager!; },
      argsFile,
      stdinFile,
      snapshotWire,
      markWire: mark,
      wireSince: since,
      restart,
    });
  } finally {
    await drainFixtureManagers(repoRoot);
    releaseIdle?.();
    store?.close();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

function assertLaunchKeepsSkill(backend: string, repoRoot: string, recording: string): string {
  const prompts = systemPromptsFrom(backend, recording);
  expect(prompts.length, `${backend} launch recorded a system prompt`).toBeGreaterThan(0);
  const launch = prompts[0]!;
  expect(skillInPrompt(launch, repoRoot), `${backend} launch has extra context without skill text`).toBe(true);
  expect(hasNativeTrigger(backend, recording)).toBe(true);
  return launch;
}

function assertContinuationSkill(
  backend: string,
  repoRoot: string,
  _launchPrompt: string,
  continuationRecording: string,
): void {
  const prompts = systemPromptsFrom(backend, continuationRecording);
  expect(prompts.length, `${backend} continuation recorded a system prompt`).toBeGreaterThan(0);
  const continued = prompts[prompts.length - 1]!;
  if (!IN_THREAD.has(backend)) expect(skillInPrompt(continued, repoRoot)).toBe(true);
  expect(continued).not.toContain(SKILL_BODY);
  expect(continued).not.toContain('Selected skill:');
  expect(hasNativeTrigger(backend, continuationRecording)).toBe(false);
}

/** An engine part file calls this before `describeSkillResumeParity`. */
export function installSkillResumeEngine(): void {
  setSkillResumeEngineCells(ENGINE_CELLS);
}

const ENGINE_CELLS: SkillResumeEngineCells = {
  resumedContinue: backend => async () => {
    await withSkillResumeRun(backend, async (fixture) => {
      const launchPrompt = assertLaunchKeepsSkill(backend, fixture.repoRoot, fixture.snapshotWire());
      await idleClose(fixture.manager, fixture.runId);
      const marked = fixture.markWire();
      const continued = await continueAndPark(fixture, { text: promptFor(backend, 'baseline') }, marked);
      assertContinuationSkill(backend, fixture.repoRoot, launchPrompt, continued);
    });
  },
  recoveredContinuation: backend => async () => {
    await withSkillResumeRun(backend, async (fixture) => {
      const launchPrompt = assertLaunchKeepsSkill(backend, fixture.repoRoot, fixture.snapshotWire());
      await idleClose(fixture.manager, fixture.runId);
      const marked = fixture.markWire();
      expect(fixture.manager.continueRun(fixture.runId, { text: promptFor(backend, 'baseline') }).ok).toBe(true);
      const persisted = fixture.store.getRun(fixture.runId);
      expect(persisted?.continuationMessage).toBeDefined();
      expect(['running', 'queued']).toContain(persisted?.status);
      await fixture.restart();
      await untilParkedWithPrompt(fixture, marked);
      assertContinuationSkill(backend, fixture.repoRoot, launchPrompt, fixture.wireSince(marked));
    });
  },
  recordedSession: backend => async () => {
    await withSkillResumeRun(backend, async (fixture) => {
      await untilRun(fixture, () => Boolean(fixture.store.getRun(fixture.runId)?.steps?.some((step) => Boolean(step.sessionId))));
      const sessionId = recordedSessionId(fixture.store, fixture.runId);
      await idleClose(fixture.manager, fixture.runId);
      const continuedMark = fixture.markWire();
      const continued = await continueAndPark(fixture, { text: promptFor(backend, 'baseline') }, continuedMark);
      assertReusedRecordedSession(backend, continued, sessionId, fileText(fixture.argsFile).slice(continuedMark.args));
      expect(recordedSessionId(fixture.store, fixture.runId)).toBe(sessionId);

      await idleClose(fixture.manager, fixture.runId);
      const recoverMark = fixture.markWire();
      expect(fixture.manager.continueRun(fixture.runId, { text: promptFor(backend, 'baseline') }).ok).toBe(true);
      await fixture.restart();
      await untilParkedWithPrompt(fixture, recoverMark, [...PROMPT_MARKERS, 'session/load', 'thread/resume']);
      assertReusedRecordedSession(backend, fixture.wireSince(recoverMark), sessionId, fileText(fixture.argsFile).slice(recoverMark.args));
      expect(recordedSessionId(fixture.store, fixture.runId)).toBe(sessionId);
    });
  },
  interruptedContinue: backend => async () => {
    await withSkillResumeRun(backend, async (fixture) => {
      const sessionId = recordedSessionId(fixture.store, fixture.runId);
      await idleClose(fixture.manager, fixture.runId);
      fixture.store.addStep(fixture.runId, {
        id: 'continue-1', name: 'Continue', kind: STEP_KIND.agent, synthetic: 'continuation',
      });
      fixture.store.updateStep(fixture.runId, 'continue-1', {
        status: STEP_STATUS.running, sessionId, backend,
      });
      // A user's Continue checkpoints its message before the session opens; it answers the
      // question the run parked on (hearsay-tools/cezarion#1234).
      setRunStatus(fixture.store, fixture.runId, RUN_STATUS.running, { currentStepId: 'continue-1', finishedAt: undefined, continuationMessage: { id: 'continue-1', text: promptFor(backend, 'baseline'), origin: 'human', createdAt: new Date().toISOString() } });
      expect(fixture.store.eventLog.readEvents(fixture.runId).some(event =>
        event.type === 'session' && event.stepId === 'continue-1')).toBe(false);
      const marked = fixture.markWire();
      await fixture.restart();
      await untilRun(fixture, () => PROMPT_MARKERS.some(marker => fixture.wireSince(marked).includes(marker)), marked);
      assertReusedRecordedSession(backend, fixture.wireSince(marked), sessionId, fileText(fixture.argsFile).slice(marked.args));
      expect(fixture.store.getRun(fixture.runId)?.status).not.toBe('failed');
    });
  },
  skillGone: backend => async () => {
    await withSkillResumeRun(backend, async fixture => {
      await idleClose(fixture.manager, fixture.runId);
      fixture.manager.setSkillCatalog(fixedSkillCatalog());
      const marked = fixture.markWire();
      expect(fixture.manager.continueRun(fixture.runId, { text: promptFor(backend, 'baseline') }).ok).toBe(true);
      await untilRun(fixture, () => fixture.store.getRun(fixture.runId)?.status === 'failed', marked);
      expect(fixture.store.getRun(fixture.runId)?.error).toContain(`${backend} account "default"`);
      expect(hasNativeTrigger(backend, fixture.wireSince(marked))).toBe(false);
    });
  },
  freshSession: backend => async () => {
    const origin: string = 'claude';
    const savedClaude = process.env.CEZ_CLAUDE_BIN;
    const savedTarget = process.env[HARNESS_ADAPTERS[backend]!.binEnv];
    process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude!.mockBin;
    process.env[HARNESS_ADAPTERS[backend]!.binEnv] = HARNESS_ADAPTERS[backend]!.mockBin;
    try {
      await withSkillResumeRun(origin, async (fixture) => {
        const launchPrompt = assertLaunchKeepsSkill(origin, fixture.repoRoot, fixture.snapshotWire());
        await idleClose(fixture.manager, fixture.runId);
        const marked = fixture.markWire();
        const continuedWire = await continueAndPark(fixture, {
          text: promptFor(backend, 'baseline'),
          runner: backend,
        }, marked);
        const continued = systemPromptsFrom(backend, continuedWire);
        expect(continued.length).toBeGreaterThan(0);
        // The continuation's opening prompt; its turn end's nudge follows (hearsay-tools/cezarion#1234).
        const last = continued[0]!;
        expect(skillInPrompt(last, fixture.repoRoot)).toBe(true);
        expect(hasNativeTrigger(backend, continuedWire)).toBe(true);
        expect(launchPrompt).not.toContain(SKILL_BODY);
      });
    } finally {
      if (savedClaude === undefined) delete process.env.CEZ_CLAUDE_BIN;
      else process.env.CEZ_CLAUDE_BIN = savedClaude;
      if (savedTarget === undefined) delete process.env[HARNESS_ADAPTERS[backend]!.binEnv];
      else process.env[HARNESS_ADAPTERS[backend]!.binEnv] = savedTarget;
    }
  },
  lostSession: async () => {
    await withSkillResumeRun('opencode', async (fixture) => {
      const launchPrompt = assertLaunchKeepsSkill('opencode', fixture.repoRoot, fixture.snapshotWire());
      const lostId = recordedSessionId(fixture.store, fixture.runId);
      expect(lostId).toBe('ses_mock_1');
      await idleClose(fixture.manager, fixture.runId);
      const persist = `${fixture.argsFile}.opencode-sessions.json`;
      const stored = JSON.parse(readFileSync(persist, 'utf8')) as { seq: number; sessions: Record<string, unknown> };
      expect(stored.sessions[lostId]).toBeDefined();
      writeFileSync(persist, JSON.stringify({ seq: stored.seq, sessions: {} }));
      const marked = fixture.markWire();
      const continued = await continueAndPark(fixture, { text: promptFor('opencode', 'baseline') }, marked);
      expect(opencodeSessionGets(continued)).toEqual([lostId]);
      expect(opencodeSessionPosts(continued)).toHaveLength(1);
      const prompts = systemPromptsFrom('opencode', continued);
      expect(prompts.length).toBeGreaterThan(0);
      expect(skillInPrompt(prompts[0]!, fixture.repoRoot)).toBe(true);
      expect(hasNativeTrigger('opencode', continued)).toBe(true);
      expect(launchPrompt).not.toContain(SKILL_BODY);
      const events = fixture.store.eventLog.readEvents(fixture.runId);
      const notices = events.filter((event) => String(event.message).includes('no longer exists'));
      expect(notices).toHaveLength(1);
      expect(notices[0]?.type).toBe('note');
      expect(notices[0]?.message).toBe(LOST_OPENCODE_SESSION);
      expect(events.filter((event) => event.type === 'lifecycle' && String(event.message).includes('no longer exists'))).toEqual([]);
      const freshId = recordedSessionId(fixture.store, fixture.runId);
      expect(freshId).not.toBe(lostId);
      expect(freshId).toMatch(/^ses_mock_/);
    });
  },
};
