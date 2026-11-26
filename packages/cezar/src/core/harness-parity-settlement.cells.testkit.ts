import { withOwnedInputRun } from './worker-parity-core.testkit.ts';
import { runnerDefinition } from './runner-registry.ts';
import { describeHarnessPart, type HarnessPartScope, type HarnessRegistration } from './harness-parity-registrar.testkit.ts';
import { RUN_STATUS, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { WAIT_KIND, WAIT_PHASE } from '@open-mercato/cezar-contract/wait-factories.testkit';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import * as gitWorktree from '../git-worktree.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { agentTmpDir, resolveAgentTmpDir } from '../runs/agent-tmpdir.ts';
import { hasPendingAsk } from '../runs/run-store.testkit.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { createApp } from '../server/server.ts';
import { cleanupCheckpoint, seedSettledFamily } from '../workflows/delegation-reconcile.testkit.ts';
import { fixtureWork } from '../workflows/fixture-manager.testkit.ts';
import { IDLE_TIMEOUT_MS, type RunManager } from '../workflows/run.ts';
import { answerThroughRoute } from './harness-parity-permission-route.testkit.ts';
import { promptFor, waitFor } from './harness-parity-core.testkit.ts';
import { driveObservedRun } from './harness-parity-run-tier.testkit.ts';
import { settlementGroups, type IdleClosedAnswer, type PendingScratchObservation, type SettlementCells } from './harness-parity-settlement.rows.testkit.ts';
import { observationClock } from './observation-clock.testkit.ts';
import { driveRun } from './workflow-parity-core.testkit.ts';

/** Keep the exact fire-and-forget settlement promise owned by the fixture. */
function observeSettlements(manager: RunManager) {
  const work = fixtureWork(manager);
  const track = work.track.bind(work);
  const pending: Promise<unknown>[] = [];
  const spy = vi.spyOn(work, 'track').mockImplementation((label, promise) => {
    if (label === 'settleSuccess') pending.push(promise);
    return track(label, promise);
  });
  return { pending, restore: () => spy.mockRestore() };
}

/** R28, R29 and R30: a multi-Continue run finishes as done, review or cancelled and closes every live step. */
const multiContinueCell = (backend: string, status: 'done' | 'review' | 'cancelled') => async () => {
  vi.stubEnv('CEZ_REVIEW_GATE', status === 'review' ? '1' : '0');
  try {
    await driveObservedRun(backend, 'baseline', record => record?.status === 'waiting', 30_000,
      async ({ store, manager, runId, repoRoot, idle }) => {
        for (let turn = 0; turn < 2; turn++) {
          await idle.advance(IDLE_TIMEOUT_MS);
          await waitFor(() => !manager.isActive(runId));
          // Idle close remains a park, not successful task completion.
          expect(store.getRun(runId)?.status).toBe('waiting');
          expect(store.getRun(runId)?.steps.every(step => step.status === 'waiting' && !step.finishedAt)).toBe(true);
          expect(manager.continueRun(runId, { text: promptFor(backend, 'baseline') }).ok).toBe(true);
          await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
        }
        const before = store.getRun(runId)!;
        expect(before.steps.map(step => step.id)).toEqual(['task', 'continue-1', 'continue-2']);
        // driveRun uses an in-place repository; expose that real diff to the gate.
        store.updateRun(runId, { worktreePath: repoRoot, baseBranch: 'main' });
        writeFileSync(join(repoRoot, 'a.txt'), 'changed for review\n');
        if (status === 'cancelled') {
          let release!: (diff: string) => void;
          const diff = vi.spyOn(gitWorktree, 'worktreeDiff').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
          try {
            expect(manager.finish(runId)).toBe(true);
            await waitFor(() => release !== undefined);
            expect(manager.cancel(runId)).toBe(true);
          } finally {
            release?.('changed');
            diff.mockRestore();
          }
        } else expect(manager.finish(runId)).toBe(true);
        await waitFor(() => !manager.isActive(runId));
        const completed = store.getRun(runId)!;
        expect(completed.status).toBe(status);
        expect(completed.steps.map(step => step.status)).toEqual(['done', status === 'cancelled' ? 'cancelled' : 'done', 'done']);
        for (const step of completed.steps) expect(step.finishedAt).toBeDefined();
        expect(completed.currentStepId).toBeUndefined();
      });
  } finally { vi.unstubAllEnvs(); }
};

/** R33 and R34: a stale Finish loses to a Continue that starts and idle-closes, or that queues. */
const supersededCell = (backend: string, queued: boolean) => async () => {
  await driveObservedRun(backend, 'baseline', record => record?.status === 'waiting', 30_000,
    async ({ store, manager, runId, repoRoot, idle, semaphore }) => {
      const idleClose = async () => {
        await idle.advance(IDLE_TIMEOUT_MS);
        await waitFor(() => !manager.isActive(runId));
        expect(store.getRun(runId)?.status).toBe('waiting');
      };
      await idleClose();
      store.updateRun(runId, { worktreePath: repoRoot, baseBranch: 'main' });
      let release: ((diff: string) => void) | undefined;
      const diff = vi.spyOn(gitWorktree, 'worktreeDiff').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      // Observe the real fire-and-forget settlement, including its config I/O.
      const settlement = observeSettlements(manager);
      // Hold only scheduler capacity; the run and its idle close use native wires.
      const capacity = queued ? vi.spyOn(semaphore, 'busy').mockReturnValue(Number.MAX_SAFE_INTEGER) : undefined;
      try {
        expect(manager.finish(runId)).toBe(true);
        await waitFor(() => release !== undefined);
        expect(settlement.pending).toHaveLength(1);
        const pending = settlement.pending[0]!;
        expect(manager.continueRun(runId, { text: promptFor(backend, 'baseline') }, queued).ok).toBe(true);
        if (!queued) {
          await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
          await idleClose();
        }
        expect(fixtureWork(manager).liveSessions.size).toBe(0);
        const before = structuredClone(store.getRun(runId)!);
        expect(before.status).toBe(queued ? 'queued' : 'waiting');
        expect(before.steps.at(-1)).toMatchObject({ id: 'continue-1', status: queued ? 'pending' : 'waiting' });
        release!('changed');
        await pending;
        const after = store.getRun(runId)!;
        expect(after.status).toBe(before.status);
        expect(after.steps).toEqual(before.steps);
        expect(after.finishedAt).toBeUndefined();
        expect(store.eventLog.readEvents(runId).some(event => event.type === 'lifecycle' &&
          (event.message === 'run finished' || (typeof event.message === 'string' && event.message.startsWith('changes ready for review'))))).toBe(false);
      } finally {
        release?.('changed');
        await Promise.allSettled(settlement.pending);
        diff.mockRestore();
        settlement.restore();
        // Cancel queued work before restoring capacity so teardown cannot launch it.
        manager.cancel(runId);
        capacity?.mockRestore();
      }
    });
};

/** R31 and R32: an accepted fresh or Continue Finish settles when the manager is disposed during diff I/O. */
const disposalCell = (backend: string, continuation: boolean) => async () => {
  vi.stubEnv('CEZ_REVIEW_GATE', '0');
  try {
    await driveObservedRun(backend, 'baseline', record => record?.status === 'waiting', 30_000,
      async ({ store, manager, runId, repoRoot, idle }) => {
        if (continuation) {
          await idle.advance(IDLE_TIMEOUT_MS);
          await waitFor(() => !manager.isActive(runId));
          expect(manager.continueRun(runId, { text: promptFor(backend, 'baseline') }).ok).toBe(true);
          await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
        }
        store.updateRun(runId, { worktreePath: repoRoot, baseBranch: 'main' });
        let release: ((diff: string) => void) | undefined;
        const diff = vi.spyOn(gitWorktree, 'worktreeDiff').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        // dispose clears active immediately. Observe actual engine cleanup,
        // so assertions and fixture deletion wait for the settlement callback.
        const settlement = observeSettlements(manager);
        try {
          expect(manager.finish(runId)).toBe(true);
          await waitFor(() => release !== undefined);
          manager.dispose();
          release!('changed');
          expect(settlement.pending).toHaveLength(1);
          await Promise.all(settlement.pending);
          const completed = store.getRun(runId)!;
          expect(completed.status).toBe('done');
          expect(completed.finishedAt).toBeDefined();
          expect(completed.currentStepId).toBeUndefined();
          expect(completed.steps).toHaveLength(continuation ? 2 : 1);
          for (const step of completed.steps) expect(step).toMatchObject({ status: STEP_STATUS.done, finishedAt: expect.any(String) });
        } finally {
          release?.('changed');
          diff.mockRestore();
          settlement.restore();
        }
      });
  } finally { vi.unstubAllEnvs(); }
};

const SETTLEMENT_CELLS: SettlementCells = {
  R20: backend => async () => {
    await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId, repoRoot }) => {
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.getRun(runId)?.status === 'waiting');
      expect(manager.finish(runId)).toBe(true);
      await waitFor(() => !manager.isActive(runId) && store.workerExecutions.readWorkerExecution(runId)?.phase === 'complete');
      const unrelated = seedSettledFamily(store, repoRoot);
      const reads = vi.spyOn(store.eventLog, 'readEvents');
      try {
        cleanupCheckpoint(store, runId);
        expect(store.workerExecutions.readWorkerExecution(runId)?.phase).toBe('complete');
        expect(reads.mock.calls.map(([id]) => id)).not.toContain(unrelated.parentId);
        expect(reads.mock.calls.map(([id]) => id)).not.toContain(unrelated.workerId);
      } finally { reads.mockRestore(); }
    });
  },
  R28: backend => multiContinueCell(backend, 'done'),
  R29: backend => multiContinueCell(backend, 'review'),
  R30: backend => multiContinueCell(backend, 'cancelled'),
  R33: backend => supersededCell(backend, false),
  R34: backend => supersededCell(backend, true),
  R31: backend => disposalCell(backend, false),
  R32: backend => disposalCell(backend, true),
  R22: backend => async () => {
    await driveObservedRun(backend, 'baseline', record => record?.status === 'waiting', 30_000,
      async ({ store, manager, runId, repoRoot, idle }) => {
        const original = resolveAgentTmpDir(join(repoRoot, '.ai/cezar'), runId);
        const dirs = new Set([agentTmpDir(join(repoRoot, '.ai/cezar'), runId), original]);
        const nextRoot = mkdtempSync(join(realpathSync('/tmp'), 'cez-next-'));
        const keys = ['TMPDIR', 'TEMP', 'TMP'] as const;
        const previous = keys.map(key => process.env[key]);
        try {
          for (const key of keys) process.env[key] = nextRoot;
          for (const dir of dirs) {
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, 'notes'), 'keep across turns');
          }
          for (let turn = 0; turn < 2; turn++) {
            await idle.advance(IDLE_TIMEOUT_MS);
            await waitFor(() => !manager.isActive(runId));
            expect(store.getRun(runId)?.status).toBe('waiting');
            for (const dir of dirs) expect(readFileSync(join(dir, 'notes'), 'utf8')).toBe('keep across turns');
            expect(resolveAgentTmpDir(join(repoRoot, '.ai/cezar'), runId)).toBe(original);
            expect(manager.continueRun(runId, { text: promptFor(backend, 'baseline') }).ok).toBe(true);
            await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
            for (const dir of dirs) expect(readFileSync(join(dir, 'notes'), 'utf8')).toBe('keep across turns');
          }
          expect(manager.finish(runId)).toBe(true);
          await waitFor(() => !manager.isActive(runId));
          expect(['done', 'review']).toContain(store.getRun(runId)?.status);
          for (const dir of dirs) expect(existsSync(dir)).toBe(false);
        } finally {
          keys.forEach((key, index) => {
            if (previous[index] === undefined) delete process.env[key];
            else process.env[key] = previous[index];
          });
          rmSync(nextRoot, { recursive: true, force: true });
        }
      });
  },
  R23: backend => ({
    assert(observation: PendingScratchObservation) {
      expect(observation.active).toBe(false);
      expect(observation.status).toBe(RUN_STATUS.waiting);
      expect(observation.phase).toBe('complete');
      expect(observation.scratch).toBe('pending answer');
    },
    observe: async () => {
      const idle = observationClock(delay => delay === IDLE_TIMEOUT_MS && /armIdleTimer/.test(new Error().stack ?? ''));
      let observation!: { active: boolean; status: string | undefined; phase: string | undefined; scratch: string };
      try {
        await withOwnedInputRun(backend, 'ask', async ({ manager, store, runId, repoRoot }) => {
          manager.enqueueOwnedRun(runId);
          // bound: the public native or portable ask frame identifies the parked question.
          await waitFor(() => store.eventLog.readEvents(runId).some(event => event.type === 'ask.requested'));
          const scratch = resolveAgentTmpDir(join(repoRoot, '.ai/cezar'), runId);
          writeFileSync(join(scratch, 'notes'), 'pending answer');
          // bound: the parked question, native or portable, arms its shipped idle timer.
          await waitFor(() => idle.pending > 0);
          await idle.advance(IDLE_TIMEOUT_MS);
          // bound: idle expiry closes the owned process and releases its active run.
          await waitFor(() => !manager.isActive(runId));
          observation = { active: manager.isActive(runId), status: store.getRun(runId)?.status,
            phase: store.workerExecutions.readWorkerExecution(runId)?.phase, scratch: readFileSync(join(scratch, 'notes'), 'utf8') };
        });
        return observation;
      } finally { idle.restore(); }
    },
  }),
  R129: (backend, ask) => ({
    assert(observation: IdleClosedAnswer) {
      expect(observation.closedWhileAsking).toEqual({ active: false, status: RUN_STATUS.waiting, pendingAsk: true });
      expect(observation.status).toBe(RUN_STATUS.done);
      expect(observation.pendingAsk).toBe(false);
      expect(observation.openHumanWaits).toEqual([]);
      expect(observation.idleCloses).toBe(1);
      expect(observation.delivered).toEqual([expect.objectContaining({ source: 'parent' })]);
      expect(observation.reopened).toBe(1);
    },
    observe: async () => {
      const idle = observationClock(delay => delay === IDLE_TIMEOUT_MS && /armIdleTimer/.test(new Error().stack ?? ''));
      let observation!: IdleClosedAnswer;
      try {
        await withOwnedInputRun(backend, ask.scenario, async ({ manager, store, runId, answer }) => {
          manager.enqueueOwnedRun(runId);
          // bound: the native ask frame parks the run with its question open.
          await waitFor(() => store.getRun(runId)?.status === RUN_STATUS.waiting && hasPendingAsk(store, runId));
          // bound: the parked native ask arms its shipped idle timer.
          await waitFor(() => idle.pending > 0);
          await idle.advance(IDLE_TIMEOUT_MS);
          // bound: idle expiry closes the native process and releases its active run.
          await waitFor(() => !manager.isActive(runId));
          const closedWhileAsking = { active: manager.isActive(runId), status: store.getRun(runId)?.status, pendingAsk: hasPendingAsk(store, runId) };
          idle.restore();
          const answerSeq = store.eventLog.readEvents(runId).length;
          // The reopened session does not hear its task again (hearsay-tools/squawk#3882), so the
          // answer carries the mock's plan to finish once answered.
          await answer(`${ask.answer}\n\nmock:resume-cezar-done`);
          // bound: the answer reopens the session, whose turn ends the run.
          await waitFor(() => !manager.isActive(runId) && ['done', 'review', 'failed'].includes(store.getRun(runId)?.status ?? ''), 30_000);
          const events = store.eventLog.readEvents(runId);
          const run = store.getRun(runId);
          observation = {
            closedWhileAsking, status: run?.status, pendingAsk: hasPendingAsk(store, runId),
            openHumanWaits: (run?.waits ?? []).filter(wait => wait.kind === WAIT_KIND.human && wait.phase === WAIT_PHASE.open),
            idleCloses: events.filter(event => event.type === 'lifecycle' && /session closed after \d+m of inactivity/.test(String(event.message))).length,
            delivered: events.filter(event => event.type === 'human-input-delivered'),
            reopened: events.slice(answerSeq).filter(event => event.type === 'session.started').length,
          };
        });
        return observation;
      } finally { idle.restore(); }
    },
  }),
  P1: (backend, decision, echo) => async () => {
    let repoRoot = '';
    const observation = await driveRun(backend, 'approval', run => !!run && ['done', 'review'].includes(run.status), 30_000, async ({ store, manager, runId }) => {
      // Continue builds ActiveRun at a second site. Old capabilities must stay
      // retired while a fresh native approval parks the resumed generation.
      const first = store.eventLog.readEvents(runId).find(event => event.type === 'permission.requested')!;
      await waitFor(() => !manager.isActive(runId));
      expect(manager.continueRun(runId, { text: 'mock:approval' })).toEqual({ ok: true });
      await waitFor(() => store.eventLog.readEvents(runId).filter(event => event.type === 'permission.requested').length === 2);
      const request = store.eventLog.readEvents(runId).filter(event => event.type === 'permission.requested')[1]!;
      expect(request.requestId).not.toBe(first.requestId);
      expect(store.getRun(runId)).toMatchObject({ status: RUN_STATUS.waiting, hasPendingPermission: true });
      const old = (first.options as Array<{ id: string }>)[0]!;
      expect(manager.respondPermission(runId, first.requestId as string, old.id)).toBe(false);
      const choice = (request.options as Array<{ id: string; label: string }>).find(option => option.label.toLowerCase().includes(decision))!;
      expect(manager.respondPermission(runId, request.requestId as string, choice.id)).toBe(true);
      await waitFor(() => ['done', 'review'].includes(store.getRun(runId)?.status ?? '') && !manager.isActive(runId));
    }, {
      autonomous: true,
      beforeStart: context => { repoRoot = context.repoRoot; },
      during: async ({ store, manager, runId }) => {
        await waitFor(() => store.eventLog.readEvents(runId).some(event => event.type === 'permission.requested'));
        expect(store.getRun(runId)).toMatchObject({ status: RUN_STATUS.waiting, hasPendingPermission: true });
        const request = store.eventLog.readEvents(runId).find(event => event.type === 'permission.requested')!;
        const options = request.options as Array<{ id: string; label: string }>;
        const choice = options.find(option => option.label.toLowerCase().includes(decision));
        expect(choice).toBeDefined();
        expect(manager.sendMessage(runId, [{ type: 'text', text: 'accept' }])).toBe(false);
        const live = [...fixtureWork(manager).liveSessions].find(session => session.open);
        expect(live?.sendAgentMessage([{ type: 'text', text: 'steer during open permission' }])).toBe(false);
        expect(manager.respondPermission(runId, request.requestId as string, 'not-offered')).toBe(false);
        const app = createApp({ home: testHome(), repoRoot, store, manager, version: 'test' });
        const response = await apiRequest(app, `/api/v1/runs/${runId}/permissions`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: request.requestId, optionId: choice!.id }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ delivered: true });
        expect(manager.respondPermission(runId, request.requestId as string, choice!.id)).toBe(false);
      },
    });
    expect(observation.events).toContainEqual(expect.objectContaining({ type: 'permission.resolved', optionId: expect.any(String) }));
    expect(observation.events).toContainEqual(expect.objectContaining({ type: 'turn.completed' }));
    expect(observation.events.filter(event => event.type === 'text').map(event => event.text).join('')).toContain(echo);
    expect(observation.record?.hasPendingPermission).toBe(false);
    expect(observation.events.some(event => event.type === 'ask.requested')).toBe(false);
  },
  P2: backend => async () => {
    const observation = await driveRun(backend, 'permission-default', run => !!run && ['done', 'review'].includes(run.status), 30_000);
    expect(observation.events.some(event => event.type === 'permission.requested')).toBe(false);
    expect(observation.record?.hasPendingPermission).toBeFalsy();
    expect(observation.events.filter(event => event.type === 'text').map(event => event.text).join('')).toContain(runnerDefinition(backend).mock.defaultApprovalEcho ?? 'Approval response: {"reply":"once"}');
    expect(observation.events).toContainEqual(expect.objectContaining({ type: 'turn.completed' }));
  },
  P9: (backend, label, action) => async () => {
    let repoRoot = '';
    // bound: hang guard for the live mock run; the predicate waits on the run settling, and a stuck card fails here instead of at the test timeout.
    const observation = await driveRun(backend, 'mcp-approval', run => !!run && ['done', 'review'].includes(run.status), 30_000, undefined, {
      beforeStart: context => { repoRoot = context.repoRoot; },
      during: async ({ store, manager, runId }) => {
        await waitFor(() => store.eventLog.readEvents(runId).some(event => event.type === 'permission.requested'));
        expect(store.getRun(runId)).toMatchObject({ status: RUN_STATUS.waiting, hasPendingPermission: true });
        const request = store.eventLog.readEvents(runId).find(event => event.type === 'permission.requested')!;
        expect(request.title).toBe('Codex requests an MCP tool call');
        const choice = (request.options as Array<{ id: string; label: string }>).find(option => option.label === label)!;
        expect(manager.sendMessage(runId, [{ type: 'text', text: 'accept' }])).toBe(false);
        const response = await answerThroughRoute(repoRoot, store, manager, runId, request, choice.id);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ delivered: true });
      },
    });
    expect(observation.events).toContainEqual(expect.objectContaining({ type: 'permission.resolved', optionId: expect.any(String) }));
    expect(observation.events.filter(event => event.type === 'text').map(event => event.text).join(''))
      .toContain(`Approval response: ${JSON.stringify({ action, content: null, _meta: null })}`);
    expect(observation.record?.hasPendingPermission).toBe(false);
  },
};

export const SETTLEMENT_GROUPS = settlementGroups(SETTLEMENT_CELLS);

/** Register the settlement part's cells for one runner: `harness-<runner>-settlement-parity.test.ts`. */
export function describeHarnessParity(scope: HarnessPartScope, registration?: HarnessRegistration): void {
  describeHarnessPart('settlement', SETTLEMENT_GROUPS, scope, registration);
}
