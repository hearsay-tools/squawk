import { describeHarnessPart, type HarnessPartScope, type HarnessRegistration } from './harness-parity-registrar.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { crashStore, readPersistedRuns, seedRuns } from '../runs/run-store.testkit.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { createFixtureManager, drainFixtureManagers, fixtureWork } from '../workflows/fixture-manager.testkit.ts';
import { promptFor, waitFor } from './harness-parity-core.testkit.ts';
import { ownershipGroups, type OwnershipCells } from './harness-parity-ownership.rows.testkit.ts';
import { driveObservedRun, TERMINAL } from './harness-parity-run-tier.testkit.ts';
import { driveRun } from './workflow-parity-core.testkit.ts';
// Its stores reach worker executions: the shipped ones (hearsay-tools/squawk#4039).
import '../delegation/worker-executions.testkit.ts';

/** Flush until `runId` has left the store's memory; false if it never does. */
async function leavesMemory(store: RunStore, runId: string): Promise<boolean> {
  try {
    await waitFor(() => { store.persistence.flush(); return !store.queries.heldIds().includes(runId); }, 10_000);
    return true;
  } catch {
    return false;
  }
}

const OWNERSHIP_CELLS: OwnershipCells = {
  R48: backend => ({
    assert: ({ pins, left, heldWhileContinuing, leftAgain, obs }) => {
      expect(left).toBe(true);
      expect(heldWhileContinuing).toBe(true);
      expect(leftAgain).toBe(true);
      // `execute` pins the first execution, then Continue's admission and `runContinuation`.
      expect(pins).toEqual(['active', 'continue', 'active']);
      expect(TERMINAL).toContain(obs.record?.status);
      expect(obs.record?.steps.map((step) => step.id)).toContain('continue-1');
    },
    observe: async () => {
      const pins: string[] = [];
      let left = false, heldWhileContinuing = false, leftAgain = false;
      const obs = await driveRun(backend, 'cezar-done', record => TERMINAL.includes(record?.status ?? ''), 30_000,
        async ({ store, manager, runId }) => {
          await waitFor(() => !manager.isActive(runId));
          left = await leavesMemory(store, runId);
          expect(manager.continueRun(runId, { text: promptFor(backend, 'cezar-done') }).ok).toBe(true);
          heldWhileContinuing = store.queries.heldIds().includes(runId);
          await waitFor(() => TERMINAL.includes(store.getRun(runId)?.status ?? '') && !manager.isActive(runId), 30_000);
          leftAgain = await leavesMemory(store, runId);
        },
        { beforeStart: ({ store }) => {
          const pin = store.runPins.pin.bind(store.runPins);
          store.runPins.pin = (id, holder) => { pins.push(holder); return pin(id, holder); };
        } });
      return { pins, left, heldWhileContinuing, leftAgain, obs };
    },
  }),
  R49: backend => ({
    assert: ({ repaired, left, continued, final }) => {
      expect(continued).toEqual({ ok: true });
      expect(repaired).toBe(true);
      expect(left).toBe(true);
      expect(TERMINAL).toContain(final?.status);
      expect(final?.steps.map((step) => step.id)).toContain('continue-1');
    },
    observe: async () => {
      let repaired = false, left = false;
      let continued: { ok: boolean; error?: string } = { ok: false };
      let final: RunRecord | undefined;
      await driveObservedRun(backend, 'cezar-done', record => TERMINAL.includes(record?.status ?? ''), 30_000,
        async ({ store, manager, runId, repoRoot }) => {
          await waitFor(() => !manager.isActive(runId));
          const dataDir = join(repoRoot, '.ai/cezar');
          store.persistence.flush();
          const records = readPersistedRuns(dataDir);
          await drainFixtureManagers(repoRoot);
          store.close();
          // The snapshot an older controller left: cancelled, intent still on it, no conversation.
          seedRuns(dataDir, records.map((record) => record.id !== runId ? record : { ...record, status: RUN_STATUS.cancelled,
            delegation: { role: 'root', permissions: [], receipts: [], finishRequestedAt: new Date().toISOString() } }));
          const rebooted = RunStore.open(dataDir, { keepLive: true });
          const recovered = createFixtureManager(rebooted, repoRoot);
          try {
            await recovered.recover();
            const root = rebooted.getRun(runId)?.delegation;
            repaired = root?.role === 'root' && root.finishRequestedAt === undefined;
            left = await leavesMemory(rebooted, runId);
            continued = recovered.continueRun(runId, { text: promptFor(backend, 'cezar-done') });
            if (continued.ok) await waitFor(() => TERMINAL.includes(rebooted.getRun(runId)?.status ?? '') && !recovered.isActive(runId), 30_000);
            final = structuredClone(rebooted.getRun(runId));
          } finally {
            await drainFixtureManagers(repoRoot);
            rebooted.close();
          }
        });
      return { repaired, left, continued, final };
    },
  }),
  R51: backend => ({
    assert: ({ adopted, startedByAdoption, settled, continued, startedByContinue, resumed }) => {
      expect(adopted).toBe(true);
      expect(startedByAdoption).toEqual([]);
      expect(settled).toMatchObject({ status: RUN_STATUS.failed, error: expect.stringContaining('interrupted') });
      expect(continued).toEqual({ ok: true });
      // Continue resumes the session the dead owner opened, through the one continuation path.
      expect(startedByContinue).toEqual(['runContinuation']);
      expect(resumed?.steps.map((step) => step.id)).toContain('continue-1');
    },
    observe: async () => {
      let adopted = false;
      const startedByAdoption: string[] = [], startedByContinue: string[] = [];
      let settled: RunRecord | undefined, resumed: RunRecord | undefined;
      let continued: { ok: boolean; error?: string } = { ok: false };
      // Mid-turn, with the session the owner opened recorded: what a restart would resume.
      await driveObservedRun(backend, 'hold', record => record?.status === 'running' && record.steps.some((step) => step.sessionId !== undefined), 30_000,
        async ({ store, manager, runId, repoRoot }) => {
          await waitFor(() => [...fixtureWork(manager).liveSessions].some(session => session.open));
          const dataDir = join(repoRoot, '.ai/cezar');
          store.persistence.flush();
          // This cockpit was already running beside the owner, which then crashed mid-session.
          const cockpit = RunStore.open(dataDir, { keepLive: true });
          try {
            manager.dispose();
            crashStore(store);
            await drainFixtureManagers(repoRoot);
            const recovered = createFixtureManager(cockpit, repoRoot);
            let adopting = true;
            const work = fixtureWork(recovered);
            const realTrack = work.track.bind(work);
            vi.spyOn(work, 'track').mockImplementation((label, promise) => {
              if (label === 'execute' || label === 'runContinuation') (adopting ? startedByAdoption : startedByContinue).push(label);
              return realTrack(label, promise);
            });
            // Recovery dispatches transcript work with setImmediate; keep that signal real.
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            adopted = await recovered.adoptOrphanedRun(runId);
            await vi.advanceTimersByTimeAsync(300);
            vi.useRealTimers();
            adopting = false;
            settled = structuredClone(cockpit.getRun(runId));
            continued = recovered.continueRun(runId, { text: promptFor(backend, 'cezar-done') });
            if (continued.ok) await waitFor(() => startedByContinue.length > 0, 30_000);
            resumed = structuredClone(cockpit.getRun(runId));
          } finally {
            vi.useRealTimers();
            await drainFixtureManagers(repoRoot);
            cockpit.close();
          }
        });
      return { adopted, startedByAdoption, settled, continued, startedByContinue, resumed };
    },
  }),
  R52: backend => ({
    assert: ({ adopted, started, stopped }) => {
      expect(adopted).toBe(true);
      expect(started).toEqual([]);
      expect(stopped).toMatchObject({ status: RUN_STATUS.cancelled });
      expect(stopped?.error).toBeUndefined();
      expect(stopped?.stopping).toBeUndefined();
      expect(stopped?.steps.some((step) => step.status === 'running' || step.status === 'waiting')).toBe(false);
    },
    observe: async () => {
      let adopted = false;
      const started: string[] = [];
      let stopped: RunRecord | undefined;
      await driveObservedRun(backend, 'hold', record => record?.status === 'running' && record.steps.some((step) => step.sessionId !== undefined), 30_000,
        async ({ store, manager, runId, repoRoot }) => {
          await waitFor(() => [...fixtureWork(manager).liveSessions].some(session => session.open));
          const dataDir = join(repoRoot, '.ai/cezar');
          store.persistence.flush();
          const cockpit = RunStore.open(dataDir, { keepLive: true });
          try {
            manager.dispose();
            crashStore(store);
            await drainFixtureManagers(repoRoot);
            const recovered = createFixtureManager(cockpit, repoRoot);
            const work = fixtureWork(recovered);
            const realTrack = work.track.bind(work);
            vi.spyOn(work, 'track').mockImplementation((label, promise) => {
              if (label === 'execute' || label === 'runContinuation') started.push(label);
              return realTrack(label, promise);
            });
            // Recovery dispatches transcript work with setImmediate; keep that signal real.
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            adopted = await recovered.adoptOrphanedRun(runId, { stop: true });
            await vi.advanceTimersByTimeAsync(300);
            vi.useRealTimers();
            stopped = structuredClone(cockpit.getRun(runId));
          } finally {
            vi.useRealTimers();
            await drainFixtureManagers(repoRoot);
            cockpit.close();
          }
        });
      return { adopted, started, stopped };
    },
  }),
};

export const OWNERSHIP_GROUPS = ownershipGroups(OWNERSHIP_CELLS);

/** Register the ownership part's cells for one runner: `harness-<runner>-ownership-parity.test.ts`. */
export function describeHarnessParity(scope: HarnessPartScope, registration?: HarnessRegistration): void {
  describeHarnessPart('ownership', OWNERSHIP_GROUPS, scope, registration);
}
