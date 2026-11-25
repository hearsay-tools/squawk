import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { readPersistedRuns, seedRuns } from './run-store.testkit.ts';

/**
 * Saved runs on a runner id that the reading process did not register (spec
 * 2026-11-18-runner-definitions, "Saved runs"; the reversible fold decided for
 * hearsay-tools/squawk#3897). Each "process" is a fresh module graph, so its runner registry starts
 * empty and holds only what that phase registers.
 */
type Registration = 'none' | 'unsealed' | 'sealed empty' | 'built-in' | 'built-in and gemini';

async function processWith(registration: Registration) {
  vi.resetModules();
  const registry = await import('../core/runner-registry.ts');
  const bundled = await import('../core/bundled-runners.testkit.ts');
  const { RunStore } = await import('./store.ts');
  if (registration !== 'none' && registration !== 'sealed empty') await bundled.registerBundledRunners();
  // A runner this build does not ship: the Claude definition under another id.
  if (registration === 'built-in and gemini') registry.registerRunner({ ...(await bundled.bundledRunnerDefinitions())[0]!, id: 'gemini' as never });
  if (registration !== 'none' && registration !== 'unsealed') registry.sealRunners();
  return RunStore;
}

const SAVED = {
  id: 'gem',
  title: 'work on gemini',
  workflow: 'plan-and-build',
  task: 'work',
  status: RUN_STATUS.done,
  createdAt: '2026-01-01T00:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  runner: 'gemini',
  steps: [
    { id: 'plan', name: 'Plan', kind: STEP_KIND.agent, status: STEP_STATUS.done, iterations: 1, tokensUsed: 0, sessionId: 'claude-sess', backend: 'claude' },
    { id: 'build', name: 'Build', kind: STEP_KIND.agent, status: STEP_STATUS.done, iterations: 1, tokensUsed: 0,
      sessionId: 'gem-sess', sessionTransport: 'gem-wire', backend: 'gemini', startedAt: '2026-01-01T00:01:00.000Z' },
  ],
  workflowDef: { name: 'plan-and-build', source: 'file', steps: [
    { id: 'plan', name: 'Plan', prompt: 'plan {{task}}' },
    { id: 'build', name: 'Build', prompt: 'build {{task}}', runner: 'gemini', model: 'g-1', effort: 'high', agentProfile: 'work' },
  ] },
};

describe('a run saved on an unregistered runner', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-unregistered-runner-'));
    seedRuns(dataDir, [SAVED]);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it.each(['built-in', 'sealed empty'] as const)('opens as a removed-runner run with a %s registry', async registration => {
    const RunStore = await processWith(registration);
    const store = RunStore.open(dataDir);
    const run = store.getRun('gem');
    expect(run?.removedRunner).toBe('gemini');
    expect(run?.runner).toBeUndefined();
    if (registration === 'built-in') expect(run?.steps[0]).toMatchObject({ sessionId: 'claude-sess', backend: 'claude' });
    else expect(run?.steps[0]).toMatchObject({ removedBackend: 'claude' });
    expect(run?.steps[1]?.removedBackend).toBe('gemini');
    for (const key of ['sessionId', 'sessionTransport', 'backend']) expect(run?.steps[1]).not.toHaveProperty(key);
    expect(run?.workflowDef?.steps[1]).toEqual({ id: 'build', name: 'Build', prompt: 'build {{task}}' });
    store.close();
  });

  it('keeps its runner, sessions and step settings through a write, and reads as before once the runner is registered', async () => {
    const without = (await processWith('built-in')).open(dataDir);
    without.updateRun('gem', { titleSummary: 'renamed' });
    without.close();
    expect(readPersistedRuns(dataDir)[0]).toMatchObject({ runner: 'gemini', titleSummary: 'renamed',
      steps: [{ id: 'plan' }, { id: 'build', backend: 'gemini', sessionId: 'gem-sess', sessionTransport: 'gem-wire' }],
      workflowDef: { steps: [{ id: 'plan' }, { id: 'build', runner: 'gemini', model: 'g-1', effort: 'high', agentProfile: 'work' }] } });

    const store = (await processWith('built-in and gemini')).open(dataDir);
    const run = store.getRun('gem');
    expect(run?.titleSummary).toBe('renamed');
    expect(run?.runner).toBe('gemini');
    expect(run?.removedRunner).toBeUndefined();
    // `sessionTransport` is not in the step schema: the store keeps it as a raw extra, checked above.
    expect(run?.steps[1]).toMatchObject({ backend: 'gemini', sessionId: 'gem-sess' });
    expect(run?.steps[1]).not.toHaveProperty('removedBackend');
    expect(run?.workflowDef?.steps[1]).toMatchObject({ runner: 'gemini', model: 'g-1', effort: 'high', agentProfile: 'work' });
    store.close();
  });

  it('lets a write that sets a removed field keep its own value', async () => {
    // A Continue on another runner sets the run's runner and starts a new step on it.
    const without = (await processWith('built-in')).open(dataDir);
    without.updateRun('gem', { runner: 'codex', removedRunner: undefined });
    without.addStep('gem', { id: 'continue-1', name: 'Continue', kind: STEP_KIND.agent });
    without.updateStep('gem', 'continue-1', { backend: 'codex', sessionId: 'codex-sess' });
    without.close();

    const store = (await processWith('built-in and gemini')).open(dataDir);
    const run = store.getRun('gem');
    expect(run?.runner).toBe('codex');
    expect(run?.removedRunner).toBeUndefined();
    expect(run?.steps.find(step => step.id === 'build')).toMatchObject({ backend: 'gemini', sessionId: 'gem-sess' });
    expect(run?.steps.find(step => step.id === 'continue-1')).toMatchObject({ backend: 'codex', sessionId: 'codex-sess' });
    store.close();
  });

  it('reads as continued, like a cursor run, after a Continue on another runner in a process still without it', async () => {
    const first = (await processWith('built-in')).open(dataDir);
    first.updateRun('gem', { runner: 'claude', removedRunner: undefined });
    first.close();
    const store = (await processWith('built-in')).open(dataDir);
    const run = store.getRun('gem');
    expect(run?.runner).toBe('claude');
    expect(run?.removedRunner).toBeUndefined();
    expect(run?.steps[1]?.removedBackend).toBe('gemini');
    expect(run?.steps[1]).not.toHaveProperty('sessionId');
    store.close();
  });

  it('lets a session that a later write starts on a folded step keep its own runner and id', async () => {
    const without = (await processWith('built-in')).open(dataDir);
    without.updateRun('gem', { runner: 'codex', removedRunner: undefined });
    without.updateStep('gem', 'build', { backend: 'codex', sessionId: 'codex-sess' });
    without.close();
    for (const registration of ['built-in', 'built-in and gemini'] as const) {
      const store = (await processWith(registration)).open(dataDir);
      expect(store.getRun('gem')?.steps[1]).toMatchObject({ backend: 'codex', sessionId: 'codex-sess' });
      expect(store.getRun('gem')?.removedRunner).toBeUndefined();
      store.close();
    }
  });

  it.each(['none', 'unsealed'] as const)('keeps saved data through an unrelated write in a %s process', async registration => {
    // The empty registry has no opinion (planner decision 2026-11-20, option a): no fold, no
    // rejection, the row reads exactly as stored. Production entries register the built-ins
    // before they open a store (index-runners.test.ts), so this is the saved-run rule only.
    const store = (await processWith(registration)).open(dataDir);
    const run = store.getRun('gem');
    expect(run?.runner).toBe('gemini');
    expect(run?.removedRunner).toBeUndefined();
    expect(run?.steps[1]).toMatchObject({ backend: 'gemini', sessionId: 'gem-sess' });
    store.updateRun('gem', { titleSummary: 'renamed' });
    store.close();
    expect(readPersistedRuns(dataDir)[0]).toMatchObject({ runner: 'gemini', titleSummary: 'renamed',
      steps: [{ id: 'plan' }, { id: 'build', sessionId: 'gem-sess' }] });
  });
});

describe('a runs.json run on an unregistered runner', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-unregistered-import-'));
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([SAVED]), 'utf8');
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('keeps its sessions and step settings through the import, for a process that registers the runner', async () => {
    const importing = (await processWith('built-in')).open(dataDir);
    expect(importing.getRun('gem')?.removedRunner).toBe('gemini');
    importing.close();
    expect(readPersistedRuns(dataDir)[0]).toMatchObject({ runner: 'gemini',
      steps: [{ id: 'plan' }, { id: 'build', backend: 'gemini', sessionId: 'gem-sess', sessionTransport: 'gem-wire' }],
      workflowDef: { steps: [{ id: 'plan' }, { id: 'build', runner: 'gemini', model: 'g-1', effort: 'high', agentProfile: 'work' }] } });

    const store = (await processWith('built-in and gemini')).open(dataDir);
    const run = store.getRun('gem');
    expect(run?.runner).toBe('gemini');
    expect(run?.removedRunner).toBeUndefined();
    expect(run?.steps[1]).toMatchObject({ backend: 'gemini', sessionId: 'gem-sess' });
    expect(run?.workflowDef?.steps[1]).toMatchObject({ runner: 'gemini', model: 'g-1', effort: 'high', agentProfile: 'work' });
    store.close();
  });
});

describe('a run saved on a legacy or retired runner id', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-legacy-runner-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('keeps the session of a claude-cli run, read as claude', async () => {
    seedRuns(dataDir, [{ ...SAVED, id: 'cli', runner: 'claude-cli', workflowDef: undefined,
      steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent, status: STEP_STATUS.done, iterations: 1, tokensUsed: 0, sessionId: 'cli-sess', backend: 'claude-cli' }] }]);
    const store = (await processWith('built-in')).open(dataDir);
    const run = store.getRun('cli');
    expect(run?.runner).toBe('claude');
    expect(run?.removedRunner).toBeUndefined();
    expect(run?.steps[0]).toMatchObject({ backend: 'claude', sessionId: 'cli-sess' });
    store.close();
  });

  it('stores the fold of a cursor run on the next write, as before', async () => {
    seedRuns(dataDir, [{ ...SAVED, id: 'cur', runner: 'cursor', workflowDef: undefined,
      steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent, status: STEP_STATUS.done, iterations: 1, tokensUsed: 0, sessionId: 'cur-sess', backend: 'cursor' }] }]);
    const store = (await processWith('built-in')).open(dataDir);
    expect(store.getRun('cur')?.removedRunner).toBe('cursor');
    store.updateRun('cur', { titleSummary: 'renamed' });
    store.close();
    const stored = readPersistedRuns(dataDir)[0];
    expect(stored).toMatchObject({ removedRunner: 'cursor', steps: [{ id: 'task', removedBackend: 'cursor' }] });
    expect(stored).not.toHaveProperty('runner');
    expect(stored.steps[0]).not.toHaveProperty('sessionId');
  });
});
