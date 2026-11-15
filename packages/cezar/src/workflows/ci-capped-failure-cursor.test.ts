import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CiWaitResult, RunRecord } from '@open-mercato/cezar-contract';
import { STEP_STATUS, WAIT_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { acquireCiResources } from '../ci-wait/resources.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { WorktreeAutosave } from './run/worktree-autosave.ts';
import { MAX_WAKE_DELIVERY_ATTEMPTS } from './run.ts';
import { gatedProviderFailure } from './waits-parity.testkit.ts';
import { manager, restart, root, store, toolGenerationOf, until, useWorkerWaitFixture } from './worker-wait.testkit.ts';

// hearsay-tools/squawk#1621, review D1: a failed workflow step whose owed wake reached the delivery
// cap stays the resume cursor on disk before the final autosave, so a crash there keeps it.
const identity = { prUrl: 'https://github.com/acme/repo/pull/12', repository: 'acme/repo', prNumber: 12, headSha: 'a'.repeat(40) };
const ci = { settle: undefined as undefined | (() => void) };
const supervisor = {
  resolve: async () => identity,
  watch: () => new Promise<CiWaitResult>(resolve => { ci.settle = () => resolve({ outcome: 'passed', headSha: identity.headSha,
    observedAt: new Date().toISOString(), checks: [], totalChecks: 0, truncated: false }); }),
  close() {},
};

describe('a capped wake delivery on a failed workflow step', { timeout: 45_000 }, () => {
  useWorkerWaitFixture({ acquireCiResources: (workspace: object) => ({ ...acquireCiResources(workspace), supervisor }) });
  afterEach(() => vi.restoreAllMocks());

  it('persists the resume cursor before the final autosave, and the session recovered after a crash there runs the tail', async () => {
    const adapter = HARNESS_ADAPTERS.claude;
    const wire = gatedProviderFailure(root, 'claude');
    const run = manager.startRun({ name: 'ci-capped-chain', source: 'built-in', steps: [
      { id: 'first', prompt: adapter.scenarios['provider-error-controlled']! },
      { id: 'later', prompt: adapter.scenarios['cezar-done']! },
      { id: 'check', command: 'node -e "process.exit(0)"' },
    ] }, { runner: 'claude', task: 'Recover CI and run the remaining workflow', worktree: false });
    await until(wire.held);
    await manager.registerWait(run.id, { kind: WAIT_KIND.pr, pr: identity.prUrl, timeout_seconds: 30 }, 'cezar_wait', toolGenerationOf(run.id));
    // The result resolves while the turn is held, so the failing session closes owing it, on the
    // last delivery attempt.
    store.commitOutcome(run.id, { kind: 'counted', waitDeliveryFailures: MAX_WAKE_DELIVERY_ATTEMPTS - 1 });
    ci.settle!();
    await until(() => store.getRun(run.id)?.waits?.some(wait => wait.kind === WAIT_KIND.pr && !!wait.result) === true);
    const atFinalAutosave: RunRecord[] = [];
    let disk: unknown[] | undefined;
    const save = WorktreeAutosave.prototype.saveWorktree;
    vi.spyOn(WorktreeAutosave.prototype, 'saveWorktree').mockImplementation(function (this: WorktreeAutosave, id, state, reason) {
      if (id === run.id && reason === 'run finalize') {
        disk = structuredClone(readPersistedRuns(join(root, '.ai/cezar')));
        const persisted = (disk as RunRecord[]).find(record => record.id === run.id);
        if (persisted) atFinalAutosave.push(persisted);
      }
      return save.call(this, id, state, reason);
    });
    wire.release();
    await until(() => !manager.isActive(run.id));
    expect(atFinalAutosave).toHaveLength(1);
    expect(atFinalAutosave[0]!.steps.find(step => step.id === 'first')).toMatchObject({ status: STEP_STATUS.failed });
    expect(atFinalAutosave[0]!.workflowCursor).toEqual({ stepId: 'first', mode: 'resume' });
    // The process exits during that autosave: recovery reads the row as it was on disk.
    await restart(false, disk);
    expect(store.getRun(run.id)?.workflowCursor).toEqual({ stepId: 'first', mode: 'resume' });
    // Recovery reopens the failed step's session to deliver the owed result; its done runs the tail.
    await until(() => store.getRun(run.id)?.status === 'waiting' && manager.isActive(run.id));
    expect(manager.sendMessage(run.id, [{ type: 'text', text: adapter.scenarios['cezar-done']! }])).toBe(true);
    await until(() => ['done', 'review', 'failed'].includes(store.getRun(run.id)?.status ?? '') && !manager.isActive(run.id));
    expect(store.getRun(run.id)?.steps.filter(step => !step.synthetic).map(step => [step.id, step.status]))
      .toEqual([['first', STEP_STATUS.failed], ['later', STEP_STATUS.done], ['check', STEP_STATUS.done]]);
  });
});
