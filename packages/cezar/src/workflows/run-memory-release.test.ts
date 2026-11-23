import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import '../core/created-runners.testkit.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { runnerHook, run, GIT_ID, waitForProduct } from './run-fixture.testkit.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-manager.testkit.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunResult, AgentSession, ContentBlock } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../runners/claude/spec-support.ts';
import { RunStore } from '../runs/store.ts';
import { seedWaits, setRunStatus } from '../runs/run-store.testkit.ts';
import { RunMemory } from './run/run-memory.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { type RunManager } from './run.ts';
import { type WorkflowDef } from './types.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/wait-factories.testkit';
// Its runs are deleted, reclaimed or archived, or start worker executions: the shipped removal slots.
import '../built-in-run-slots.testkit.ts';

sealTestRunners(claudeRunner);

/** hearsay-tools/squawk#2064: per-run memory ends with the run. */
describe('run memory release (hearsay-tools/squawk#2064)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let semaphore: WorkspaceSemaphore;
  let memory: RunMemory;
  let capacity = 0;

  const WORKFLOW: WorkflowDef = { name: '(planned)', source: 'built-in', steps: [{ id: 'task', name: 'Do the task', prompt: '{{task}}' }] };
  const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
  const image = (): ContentBlock => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('png').toString('base64') } });
  /** A run the engine holds as queued, with one attachment persisted: its slot holds `imageSeq`. */
  const queuedWithAttachment = () => {
    const record = manager.startRun(WORKFLOW, { task: 'ship it', worktree: false });
    expect(manager.enqueueMessage(record.id, [image(), { type: 'text', text: 'like this' }])).not.toBeNull();
    expect(memory.read(record.id, 'imageSeq')).toBe(1);
    return record;
  };
  /** A run no session holds, settled at `status`, with a slot. */
  const settledWithSlot = (status: (typeof RUN_STATUS)[keyof typeof RUN_STATUS]) => {
    const record = store.createRun({ title: 't', workflow: 'quick-task', task: 'task', steps: [] });
    setRunStatus(store, record.id, status);
    memory.write(record.id, 'retainedNote', 'retained');
    return record;
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-run-memory-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'base.txt'), 'base');
    await run('git', ['add', 'base.txt'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    capacity = 0;
    semaphore = new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 0 }, load: async () => ({ maxParallel: capacity, memoryLimitMb: null }) });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    memory = new RunMemory();
    manager = createFixtureManager(store, repoRoot, { home: testHome(), semaphore, memory });
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    runnerHook.runner = undefined;
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('drops a message deferred for a run whose session never opened, so a later Continue does not deliver it', async () => {
    const record = manager.startRun(WORKFLOW, { task: 'ship it', worktree: false });
    const delivered: ContentBlock[][] = [];
    let starts = 0;
    let continued: AgentSession | undefined;
    runnerHook.runner = {
      backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => undefined,
      startSession: () => {
        starts += 1;
        if (starts === 1) {
          expect(manager.deferMessage(record.id, text('buffer me'))).toBe(true);
          throw new Error('spawn failed');
        }
        let open = true;
        let finish!: (result: AgentRunResult) => void;
        const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
        const close = () => { open = false; finish({ text: '', toolCalls: [], tokensUsed: 0 }); };
        continued = { result, sendMessage: content => { delivered.push(content); return true; },
          sendAgentMessage: async content => { delivered.push(content); },
          discardQueuedMessages: () => undefined, holdsHumanInput: () => false,
          end: close, interrupt: close, get open() { return open; } };
        queueMicrotask(close);
        return continued;
      },
    };
    capacity = 1;
    await semaphore.refresh();
    await semaphore.release();
    await waitForProduct(manager, store, () => store.getRun(record.id)?.status === RUN_STATUS.failed && !manager.isActive(record.id));

    expect(manager.continueRun(record.id, { text: 'try again' })).toEqual({ ok: true });
    await waitForProduct(manager, store, () => continued !== undefined && !manager.isActive(record.id));

    expect(delivered).toEqual([]);
    expect(store.eventLog.readEvents(record.id).some(event => event.type === 'user-message' && JSON.stringify(event).includes('buffer me'))).toBe(false);
  });

  it('releases the attachment counter of a queued run that is cancelled', () => {
    const record = queuedWithAttachment();
    expect(manager.cancel(record.id)).toBe(true);
    expect(store.getRun(record.id)?.status).toBe(RUN_STATUS.cancelled);
    expect(memory.holds(record.id)).toBe(false);
  });

  it('keeps a review run\'s memory and releases it when the run is finished', () => {
    const record = settledWithSlot(RUN_STATUS.review);
    expect(memory.holds(record.id)).toBe(true);
    setRunStatus(store, record.id, RUN_STATUS.done);
    expect(memory.holds(record.id)).toBe(false);
  });

  it('keeps the memory of a failed run with an open wait until the wait goes', () => {
    const record = settledWithSlot(RUN_STATUS.failed);
    const due = new Date(Date.now() + 60_000).toISOString();
    seedWaits(store, record.id, { waits: [{ id: 'w1', kind: WAIT_KIND.timer, source: WAIT_SOURCE.agent, via: WAIT_VIA.cezar_wait,
      registeredAt: due, deadline: due, phase: WAIT_PHASE.open, turnId: 'turn', seconds: 60 }] });
    memory.write(record.id, 'retainedNote', 'still retained');
    expect(memory.holds(record.id)).toBe(true);
    seedWaits(store, record.id, { waits: [] });
    expect(memory.holds(record.id)).toBe(false);
  });

  it('releases a deleted run\'s memory', () => {
    const record = settledWithSlot(RUN_STATUS.review);
    expect(store.retention.deleteRun(record.id)).toBe(true);
    expect(memory.holds(record.id)).toBe(false);
  });

  it('releases every slot on dispose', () => {
    const record = settledWithSlot(RUN_STATUS.review);
    manager.dispose();
    expect(memory.holds(record.id)).toBe(false);
  });

  it('a family reconciler that throws is logged, and memory release still runs and the write goes on', () => {
    const record = settledWithSlot(RUN_STATUS.review);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // The reconciler lists the runs awaiting a settled peer; nothing else in this write lists runs.
    vi.spyOn(store.queries, 'listRuns').mockImplementation(() => { throw new Error('reconcile failed'); });
    try {
      expect(setRunStatus(store, record.id, RUN_STATUS.done)?.status).toBe(RUN_STATUS.done);
    } finally { vi.restoreAllMocks(); }
    expect(memory.holds(record.id)).toBe(false);
    expect(errors).toHaveBeenCalledWith(`[hsq] run lifecycle listener failed on run.updated for run ${record.id}: reconcile failed`);
  });

  it('dispose unsubscribes from the run lifecycle: a later write releases no memory', () => {
    const record = settledWithSlot(RUN_STATUS.review);
    manager.dispose();
    memory.write(record.id, 'retainedNote', 'after dispose');
    setRunStatus(store, record.id, RUN_STATUS.done);
    expect(memory.holds(record.id)).toBe(true);
  });
});
