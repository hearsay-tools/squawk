import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUNNER_FACTS } from '../core/runner-facts.ts';
import { HARNESS_ADAPTERS, promptFor, waitFor } from '../core/harness-parity.testkit.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
import type { SessionWire, WireRow } from './native-session-wire.testkit.ts';
import { sessionWire } from './runner-session-wires.testkit.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** The UUID Squawk writes on a step before the runner reports its own session id. */
const LAUNCH_SESSION_ID = '0b6f1f8e-6c2a-4f55-9d0e-3c7c1a2b9e41';

/** Two agent steps at different efforts, so the wire shows which step a Continue runs as. */
const CHAIN_DEF: WorkflowDef = {
  name: 'two-step',
  source: 'file',
  steps: [
    { id: 'implement', name: 'Implement', prompt: '{{task}}', effort: 'high' },
    { id: 'review', name: 'Review', prompt: 'review {{task}}', effort: 'low' },
  ],
};

function rows(wire: string): WireRow[] {
  return wire.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as WireRow]; } catch { return []; }
  });
}

/** How each runner's mock wire shows a session (`runners/<id>/session-wire.testkit.ts`); a missing
 *  reader fails naming the file to add. */
function wireOf(backend: string): SessionWire {
  return sessionWire(backend);
}

/**
 * Squawk saves a launch UUID on the step before the runner's `session` event. A runner that opens
 * its session under that id (`sessionIdSource: 'launch'`) resumes it after a crash in that
 * window. A runner that mints its own id (`native`) never knew it, so the Continue opens a fresh
 * session. Either way the Continue runs as the step it continues. The real native mocks show the
 * session on the wire (hearsay-tools/cezarion#2991).
 */
describe('Continue after a crash before the native session event', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  let argsFile: string;
  const saved = new Map<string, string | undefined>();

  function setEnv(name: string, value: string): void {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-native-continue-'));
    argsFile = join(repoRoot, 'wire.args.ndjson');
    setEnv('CEZ_AUTONAME', '0');
    setEnv('CEZ_MOCK_ARGS_FILE', argsFile);
    setEnv('CEZ_MOCK_STDIN_FILE', join(repoRoot, 'wire.stdin.ndjson'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    manager?.dispose();
    manager = undefined;
    store.persistence.flush();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    saved.clear();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A failed run whose first step holds `sessionId`. `launched` writes the step-start event a
   *  real launch writes before the runner starts; without it the run has no event history. */
  function failedRun(backend: string, sessionId: string, options: { launched: boolean }): string {
    setEnv(HARNESS_ADAPTERS[backend]!.binEnv, HARNESS_ADAPTERS[backend]!.mockBin);
    const workflowDef = CHAIN_DEF;
    const created = store.createRun({
      title: 't', workflow: workflowDef.name, task: promptFor(backend, 'baseline'), runner: backend,
      steps: workflowDef.steps.map(step => ({ id: step.id, name: step.name ?? step.id, kind: STEP_KIND.agent })),
    });
    setRunStatus(store, created.id, RUN_STATUS.failed, {
      finishedAt: new Date().toISOString(), workflowDef, worktree: false, error: 'boom',
    });
    if (options.launched) {
      store.eventLog.appendEvent(created.id, { type: 'step-start', stepId: 'implement', name: 'Implement', kind: STEP_KIND.agent, iteration: 1 });
    }
    store.updateStep(created.id, 'implement', { status: STEP_STATUS.failed, iterations: 1, sessionId, backend, error: 'boom' });
    return created.id;
  }

  async function continueWire(runId: string, backend: string): Promise<WireRow[]> {
    expect(manager!.continueRun(runId, { text: promptFor(backend, 'baseline') })).toEqual({ ok: true });
    const read = () => rows(existsSync(argsFile) ? readFileSync(argsFile, 'utf8') : '');
    // A turn that ended or a run that settled has written whatever its mock records.
    const settled = () => ['failed', 'review', 'done'].includes(store.getRun(runId)?.status ?? '')
      || store.eventLog.readEvents(runId).some(event => event.type === 'turn-end');
    // bound: hang guard; the turn's first request on the wire is the product signal.
    await waitFor(() => wireOf(backend).started(read()) || settled(), 30_000);
    if (!existsSync(argsFile)) {
      throw new Error(`scripts/${basename(HARNESS_ADAPTERS[backend]!.mockBin)} recorded nothing to CEZ_MOCK_ARGS_FILE, so `
        + `runners/${backend}/session-wire.testkit.ts has no wire to read: the mock must record its launch and requests there.`);
    }
    expect(store.getRun(runId)?.error).toBeUndefined();
    return read();
  }

  for (const backend of BUILT_IN_RUNNER_IDS) {
    const source = RUNNER_FACTS[backend]!.sessionIdSource;
    it(`${backend} ${source === 'launch' ? 'resumes' : 'never resumes'} the launch UUID and runs as the continued step`, async () => {
      const id = failedRun(backend, LAUNCH_SESSION_ID, { launched: true });
      const wire = await continueWire(id, backend);
      if (source === 'launch') {
        expect(wireOf(backend).resumed(wire)).toEqual([LAUNCH_SESSION_ID]);
        expect(wireOf(backend).freshSessions(wire)).toBe(0);
      } else {
        expect(wireOf(backend).resumed(wire)).toEqual([]);
        expect(wireOf(backend).freshSessions(wire)).toBeGreaterThan(0);
      }
      // The Continue runs as `implement`, the step whose session it continues.
      expect(wireOf(backend).effort(wire)).toBe('high');
      if (source === 'native') {
        // bound: hang guard; the runner reports its own id, which the Continue step records.
        await waitFor(() => store.eventLog.readEvents(id).some(event => event.type === 'session' && event.stepId === 'continue-1'), 15_000);
        expect(store.getRun(id)?.steps.find(step => step.id === 'continue-1')?.sessionId).not.toBe(LAUNCH_SESSION_ID);
      }
    }, 60_000);
  }

  it('resumes a saved native id when the run has no event history', async () => {
    // Older or salvaged run data can keep the step record without its event history. Nothing
    // then shows that the runner never reported the id, so the Continue keeps the conversation.
    const id = failedRun('codex', 'thread-from-salvaged-run', { launched: false });
    const wire = await continueWire(id, 'codex');
    expect(wireOf('codex').resumed(wire)).toEqual(['thread-from-salvaged-run']);
    expect(wireOf('codex').freshSessions(wire)).toBe(0);
    expect(wireOf('codex').effort(wire)).toBe('high');
  }, 60_000);
});
