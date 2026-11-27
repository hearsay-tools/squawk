import { withOwnedInputRun } from './worker-parity-core.testkit.ts';
import { runnerDefinition } from './runner-registry.ts';

import { describeHarnessPart, type HarnessPartScope, type HarnessRegistration } from './harness-parity-registrar.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { WAIT_KIND, WAIT_PHASE } from '@open-mercato/cezar-contract/wait-factories.testkit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { nativeRecording, sessionWire } from '../workflows/runner-session-wires.testkit.ts';
import { hasPendingAsk, readPersistedRuns } from '../runs/run-store.testkit.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { createFixtureManager, drainFixtureManagers } from '../workflows/fixture-manager.testkit.ts';
import { IDLE_TIMEOUT_MS } from '../workflows/run.ts';
import { promptFor, waitFor } from './harness-parity-core.testkit.ts';
import { runGroups, type ServerFatalScenario, type RunCells } from './harness-parity-run.rows.testkit.ts';
import { driveObservedRun, openTimerWait, runRowCell, TERMINAL, timerWakeOf } from './harness-parity-run-tier.testkit.ts';
import { observationClock } from './observation-clock.testkit.ts';
import { RUNNER_FACTS } from './runner-facts.ts';
import { runnerGolden } from './runner-golden.testkit.ts';
import { driveRun, type RunObservation } from './workflow-parity-core.testkit.ts';
import { onRunWrite } from '../runs/lifecycle-listeners.testkit.ts';

// #723: use the real RunManager on both event-handler construction paths.
async function continueDiagnosticRun(backend: string, prompt: string): Promise<RunObservation> {
  return driveObservedRun(backend, 'baseline', record => record?.status === 'waiting', 30_000,
    async ({ store, manager, runId, idle }) => {
      await idle.advance(IDLE_TIMEOUT_MS);
      await waitFor(() => !manager.isActive(runId));
      expect(manager.continueRun(runId, { text: prompt }).ok).toBe(true);
      await waitFor(() => TERMINAL.includes(store.getRun(runId)?.status ?? ''), 30_000);
    });
}

/** R44 and R45: a skill warning keeps a fresh or continued run successful. */
function skillWarningCell(backend: string, continuation: boolean) {
  return {
    assert: (obs: RunObservation) => {
      expect(['review', 'done']).toContain(obs.record?.status);
      expect(obs.record?.error).toBeFalsy();
      expect(obs.events.filter(e => e.type === 'error')).toEqual([]);
      const notes = runnerGolden(backend, 'skillWarningNotes');
      expect(notes.length).toBeGreaterThan(0);
      for (const message of notes) expect(obs.events).toContainEqual(expect.objectContaining({ type: 'note', message }));
      expect(obs.events.filter(e => e.type === 'turn.completed').every(e => e.stopReason === 'end_turn')).toBe(true);
      expect(obs.events.some(e => e.type === 'turn.completed')).toBe(true);
    },
    observe: () => continuation ? continueDiagnosticRun(backend, promptFor(backend, 'skill-warning'))
      : driveRun(backend, 'skill-warning', record => TERMINAL.includes(record?.status ?? '')),
  };
}

const SERVER_FATAL_DETAIL: Readonly<Record<ServerFatalScenario, string>> = {
  'unscoped-provider-failure': 'restoring service',
  'scoped-skill-failure': '/skills/required/SKILL.md',
  'scoped-frontmatter-failure': '/skills/bad4/SKILL.md: Failed to parse YAML frontmatter',
};

const MONITORING_PROMPT_RULES = [
  'When the goal is fully achieved and verified and you have no question for the user, call cezar_done, then end your turn.',
  'call cezar_wait with kind "pr" for a pull request\'s checks or its merge, or kind "timer" to re-check later, then end your turn.',
];
// Each runner's reader says where its wire carries the prompts and the system prompt.
const recordingIn = (dir: string) => nativeRecording(join(dir, 'args'), join(dir, 'stdin'));
const messages = (backend: string, dir: string): string[] => sessionWire(backend).prompts(recordingIn(dir));
const systemPrompt = (backend: string, dir: string): string => {
  const text = sessionWire(backend).systemPrompt(recordingIn(dir));
  expect(text).toBeDefined();
  return text!;
};
const assertRules = (text: string, rules: readonly string[]) => {
  for (const rule of rules) expect(text).toContain(rule);
};
const recording = async (body: (dir: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-monitoring-prompt-'));
  vi.stubEnv('CEZ_MOCK_ARGS_FILE', join(dir, 'args'));
  vi.stubEnv('CEZ_MOCK_STDIN_FILE', join(dir, 'stdin'));
  try { await body(dir); }
  finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
};
const clearRecording = (dir: string) => {
  for (const channel of ['args', 'stdin']) writeFileSync(join(dir, channel), '');
};

/** R36 and R37: a fresh or continued session receives the shared monitoring wrap-up contract. */
const monitoringContractCell = (backend: string, continued: boolean) => async () => {
  await recording(async dir => {
    await driveObservedRun(backend, 'baseline', record => record?.status === 'waiting', 30_000,
      async ({ store, manager, runId, idle }) => {
        if (continued) {
          await idle.advance(IDLE_TIMEOUT_MS);
          await waitFor(() => !manager.isActive(runId));
          clearRecording(dir);
          expect(manager.continueRun(runId, { text: promptFor(backend, 'baseline') }).ok).toBe(true);
          await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
        }
        assertRules(systemPrompt(backend, dir), MONITORING_PROMPT_RULES);
        expect(systemPrompt(backend, dir)).toContain('When a user decision or missing input is needed, call cezar_ask');
      });
  });
};

/** PR1 and PR2: fresh and continued declarations reach the run and its persisted record. */
const multiPrCell = (backend: string, continuation: boolean) => async () => {
  let dataDir = '';
  const observed = await driveRun(backend, 'multi-pr-refs', record => record?.status === 'done', 60_000,
    async ({ store, manager, runId }) => {
      expect(store.getRun(runId)?.pullRequests?.map(pr => pr.number)).toEqual([812, 813, 814, 815, 816]);
      expect(store.getRun(runId)?.markerRefs?.pr).toBe(816);
      if (continuation) {
        await waitFor(() => !manager.isActive(runId));
        expect(manager.continueRun(runId, { text: 'mock:multi-pr-refs-continue' }).ok).toBe(true);
        await waitFor(() => !manager.isActive(runId) && store.getRun(runId)?.status === 'done', 60_000);
        expect(store.getRun(runId)?.markerRefs?.pr).toBe(817);
      }
      store.persistence.flush();
      expect(readPersistedRuns(dataDir).find(run => run.id === runId)?.pullRequests?.map((pr: NonNullable<RunRecord['pullRequests']>[number]) => pr.number))
        .toEqual(continuation ? [812, 813, 814, 815, 816, 817] : [812, 813, 814, 815, 816]);
    }, { beforeStart: ({ repoRoot }) => { dataDir = join(repoRoot, '.ai/cezar'); } });
  expect(observed.record?.pullRequests?.some(pr => pr.number === 999)).toBe(false);
};

const RUN_CELLS: RunCells = {
  R44: backend => skillWarningCell(backend, false),
  R45: backend => skillWarningCell(backend, true),
  R46: backend => async () => {
    const obs = await continueDiagnosticRun(backend, promptFor(backend, 'provider-error'));
    expect(obs.record?.status).toBe('failed');
    expect(obs.record?.error?.trim()).toBeTruthy();
    expect(obs.events).toContainEqual(expect.objectContaining({ type: 'error' }));
  },
  serverFatal: (backend, continuation, scenario) => async () => {
    const prompt = `mock:${scenario}`;
    const obs = continuation ? await continueDiagnosticRun(backend, prompt)
      : await driveRun(backend, { prompt }, record => TERMINAL.includes(record?.status ?? ''));
    expect(obs.record?.status).toBe('failed');
    expect(obs.record?.error).toContain('provider');
    expect(obs.record?.error).toContain(SERVER_FATAL_DETAIL[scenario]);
  },
  runRow: runRowCell,
  R15: backend => async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-post-park-'));
    const release = join(dir, 'release');
    try {
      await driveRun(backend, { prompt: `${promptFor(backend, 'subagent-after-park')} parity-release=${release}` },
        record => record?.status === 'waiting', 30_000,
        async ({ store, runId }) => {
          expect(store.getRun(runId)).toMatchObject({ status: RUN_STATUS.waiting });
          const wake = timerWakeOf(store.getRun(runId));
          expect(wake).toBeDefined();
          const before = store.eventLog.readEvents(runId).length;
          const changes: Array<{ status: string; monitoringWakeAt?: string | undefined }> = [];
          const recordChange = (record: NonNullable<RunObservation['record']>) => {
            if (record.id === runId) changes.push({ status: record.status, monitoringWakeAt: timerWakeOf(record) });
          };
          const stopRecordChange = onRunWrite(store.lifecycle, recordChange);
          try {
            writeFileSync(release, 'go');
            const discarded = runnerGolden(backend, 'postParkChildFrames') === 'discarded';
            await waitFor(() => store.eventLog.readEvents(runId).slice(before).some(event =>
              discarded
                ? event.type === 'usage.updated' && (event.usage as { total?: number } | undefined)?.total === 424242
                : JSON.stringify(event).includes('Post-park child update processed.')));
            expect({ ...store.getRun(runId), monitoringWakeAt: timerWakeOf(store.getRun(runId)) }).toMatchObject({ status: RUN_STATUS.waiting, monitoringWakeAt: wake });
            for (const change of changes) expect(change).toEqual({ status: RUN_STATUS.waiting, monitoringWakeAt: wake });
            const after = store.eventLog.readEvents(runId).slice(before);
            expect(after.some(event => event.type === 'turn.started')).toBe(false);
            const childItems = (discarded ? store.eventLog.readEvents(runId).slice(0, before) : after)
              .filter(event => event.type.startsWith('item.') && event.item && (event.item as { parentItemId?: string }).parentItemId);
            expect(childItems.length).toBeGreaterThan(0);
            if (discarded) expect(after.some(event => event.type.startsWith('item.'))).toBe(false);
          } finally { stopRecordChange(); }
        });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  R77: backend => async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-hook-park-'));
    const release = join(dir, 'release');
    try {
      await driveRun(backend, { prompt: `${promptFor(backend, 'hook-after-park')} parity-release=${release}` },
        record => record?.status === 'waiting', 30_000,
        async ({ store, runId }) => {
          expect(store.getRun(runId)).toMatchObject({ status: RUN_STATUS.waiting });
          const wake = timerWakeOf(store.getRun(runId));
          expect(wake).toBeDefined();
          const before = store.eventLog.readEvents(runId).length;
          const changes: Array<{ status: string; monitoringWakeAt?: string | undefined }> = [];
          const recordChange = (record: NonNullable<RunObservation['record']>) => {
            if (record.id === runId) changes.push({ status: record.status, monitoringWakeAt: timerWakeOf(record) });
          };
          const stopRecordChange = onRunWrite(store.lifecycle, recordChange);
          try {
            writeFileSync(release, 'go');
            await waitFor(() => store.eventLog.readEvents(runId).slice(before).some(event => JSON.stringify(event).includes('Late hook processed.')));
            expect({ ...store.getRun(runId), monitoringWakeAt: timerWakeOf(store.getRun(runId)) }).toMatchObject({ status: RUN_STATUS.waiting, monitoringWakeAt: wake });
            for (const change of changes) expect(change).toEqual({ status: RUN_STATUS.waiting, monitoringWakeAt: wake });
            expect(store.eventLog.readEvents(runId).slice(before).some(event => event.type === 'turn.started')).toBe(false);
            const hooks = store.eventLog.readEvents(runId)
              .filter(event => event.type === 'item.completed' && (event.item as { kind?: string } | undefined)?.kind === 'hook')
              .map(event => (event.item as { id: string }).id);
            expect(hooks).toHaveLength(2);
            expect(new Set(hooks).size).toBe(2);
          } finally { stopRecordChange(); }
        });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  R26: (backend, ask) => async () => {
    await withOwnedInputRun(backend, ask.scenario, async ({ store, manager, runId, answer }) => {
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.getRun(runId)?.status === 'waiting');
      expect(hasPendingAsk(store, runId)).toBe(true);
      // Check the real ask card too: relabelling the question fixture as a
      // plan fixture must not silently remove create_plan coverage.
      const expectedHeader = runnerDefinition(backend).mock.askResumeCases.find(entry => entry.kind === ask.kind)?.header ?? (ask.kind === 'cursor/create_plan' ? 'Plan'
        : ask.kind === 'cursor/ask_question' ? 'Tests' : 'Library');
      expect(store.eventLog.readEvents(runId).find(event => event.type === 'ask.requested')?.questions)
        .toMatchObject([{ header: expectedHeader }]);
      const statuses: string[] = [];
      const recordStatus = (run: { id: string; status: string }) => {
        if (run.id === runId) statuses.push(run.status);
      };
      const stopRecordStatus = onRunWrite(store.lifecycle, recordStatus);
      try {
        // The parent answers (hearsay-tools/cezarion#2410): the parked worker takes it as a wake.
        await answer(ask.answer);
        await waitFor(() => store.getRun(runId)?.status !== 'waiting');
        statuses.length = 0;
        await waitFor(() => !manager.isActive(runId) || statuses.includes('waiting'));
        expect(statuses).not.toContain('waiting');
        expect(store.getRun(runId)?.status).toBe('done');
        expect(store.getRun(runId)?.steps[0]?.status).toBe('done');
        expect(hasPendingAsk(store, runId)).toBe(false);
      } finally {
        stopRecordStatus();
      }
      const events = store.eventLog.readEvents(runId);
      expect(events.filter(event => event.type === 'ask.requested')).toHaveLength(1);
      // The parent's answer is its conversation reply, never a human message.
      expect(events.filter(event => event.type === 'user-message')).toEqual([]);
      expect(events.filter(event => event.type === 'human-input-delivered')).toEqual([expect.objectContaining({ source: 'parent' })]);
    });
  },
  R130: backend => async () => {
    await withOwnedInputRun(backend, 'ask', async fixture => {
      fixture.manager.enqueueOwnedRun(fixture.runId);
      const asks = (store: typeof fixture.store) => store.eventLog.readEvents(fixture.runId).filter(event => event.type === 'ask.requested');
      await waitFor(() => asks(fixture.store).length === 1 && fixture.store.getRun(fixture.runId)?.status === 'waiting');
      const { store } = await fixture.restart();
      const first = store.getRun(fixture.runId)!.waits!.find(wait => wait.kind === WAIT_KIND.human)!;
      expect(first).toMatchObject({ phase: WAIT_PHASE.open, askSeq: asks(store)[0]!.seq });
      await fixture.answer(`Vitest. ${promptFor(backend, RUNNER_FACTS[backend]!.nativeAsk === 'answerable' ? 'ask' : 'cezar-ask')}`);
      await waitFor(() => asks(store).length === 2 && store.getRun(fixture.runId)?.status === 'waiting');
      const second = asks(store)[1]!;
      const human = (store.getRun(fixture.runId)?.waits ?? []).filter(wait => wait.kind === WAIT_KIND.human);
      // The open wait shows the new question, never the answered one.
      const next = human.find(wait => wait.askSeq === second.seq);
      expect(next).toMatchObject({ phase: WAIT_PHASE.open, questions: second.questions });
      expect(human.filter(wait => wait.id === first.id && wait.askSeq !== first.askSeq)).toEqual([]);
      // Its answer settles it, and the answered question's wait with it at the latest.
      await fixture.answer('Library: Vitest');
      const settled = (id: string) => store.getRun(fixture.runId)?.lastWaits?.find(wait => wait.id === id);
      await waitFor(() => !!settled(first.id) && !!settled(next!.id));
      expect([settled(first.id)?.phase, settled(next!.id)?.phase]).toEqual([WAIT_PHASE.delivered, WAIT_PHASE.delivered]);
    });
  },
  R36: backend => monitoringContractCell(backend, false),
  R37: backend => monitoringContractCell(backend, true),
  R38: backend => async () => {
    await recording(async dir => {
      await withOwnedInputRun(backend, 'cezar-wait', async fixture => {
        fixture.manager.enqueueOwnedRun(fixture.runId);
        await waitFor(() => fixture.store.getRun(fixture.runId)?.status === 'waiting' && !!timerWakeOf(fixture.store.getRun(fixture.runId)));
        clearRecording(dir);
        const wakeClock = observationClock(() => /WaitEngine\.armWait/.test(new Error().stack ?? ''));
        const { manager } = await fixture.restart();
        // hearsay-tools/cezarion#1233: recovery re-arms the park's persisted monitoring timer
        // instead of resuming at once; its wake starts the recovered session.
        expect(wakeClock.pending).toBe(1);
        wakeClock.fire(0);
        await waitFor(() => manager.isActive(fixture.runId) && messages(backend, dir).length > 0);
        assertRules(systemPrompt(backend, dir), MONITORING_PROMPT_RULES);
      });
    });
  },
  R39: backend => async () => {
    await recording(async dir => {
      const wakeClock = observationClock(() => /WaitEngine\.armWait/.test(new Error().stack ?? ''));
      await driveRun(backend, 'cezar-wait', record => record?.status === 'waiting' && !!timerWakeOf(record), 30_000,
        async ({ store, runId }) => {
          const waitId = openTimerWait(store.getRun(runId))!.id;
          expect(wakeClock.pending).toBe(1);
          wakeClock.fire(0);
          await waitFor(() => messages(backend, dir).length > 1);
          const wake = messages(backend, dir)[1]!;
          expect(wake).toContain(`Timer ${waitId} fired: Re-check the downstream work.`);
          expect(wake).toContain('Continue toward the task goal; register another wait if you are still waiting.');
          expect(store.eventLog.readEvents(runId).some(event => event.type === 'user-message')).toBe(false);
        });
    });
  },
  R40: backend => async () => {
    await driveRun(backend, 'baseline', record => record?.status === 'waiting', 30_000,
      async ({ store, manager, runId }) => {
        const prose = 'The PR merged. No further monitoring is needed. Everything is complete.';
        expect(manager.sendMessage(runId, [{ type: 'text', text: `mock:agent-echo ${prose}` }])).toBe(true);
        await waitFor(() => store.eventLog.readEvents(runId).some(event => event.type === 'text' && String(event.text).includes(prose)));
        await waitFor(() => store.getRun(runId)?.status === 'waiting');
        expect(manager.isActive(runId)).toBe(true);
      });
  },
  PR1: backend => multiPrCell(backend, false),
  PR2: backend => multiPrCell(backend, true),
  R50: backend => ({
    assert: ({ afterHeadless, afterRestart, answered, final }) => {
      expect(afterHeadless).toBe('waiting');
      expect(afterRestart).toBe('waiting');
      expect(answered).toEqual({ ok: true });
      expect(TERMINAL).toContain(final?.status);
    },
    observe: async () => {
      let afterHeadless: string | undefined, afterRestart: string | undefined;
      let answered: { ok: boolean; error?: string } = { ok: false };
      let final: RunRecord | undefined;
      await driveObservedRun(backend, 'ask', record => record?.status === 'waiting', 30_000,
        async ({ store, runId, repoRoot }) => {
          const dataDir = join(repoRoot, '.ai/cezar');
          store.persistence.flush();
          RunStore.open(dataDir).close();
          afterHeadless = readPersistedRuns(dataDir).find((record) => record.id === runId)?.status;
          store.close();
          await drainFixtureManagers(repoRoot);
          const rebooted = RunStore.open(dataDir, { keepLive: true });
          const recovered = createFixtureManager(rebooted, repoRoot);
          try {
            await recovered.recover();
            afterRestart = rebooted.getRun(runId)?.status;
            answered = recovered.continueRun(runId, { text: promptFor(backend, 'cezar-done') });
            if (answered.ok) await waitFor(() => TERMINAL.includes(rebooted.getRun(runId)?.status ?? '') && !recovered.isActive(runId), 30_000);
            final = structuredClone(rebooted.getRun(runId));
          } finally {
            await drainFixtureManagers(repoRoot);
            rebooted.close();
          }
        });
      return { afterHeadless, afterRestart, answered, final };
    },
  }),
};

export const RUN_GROUPS = runGroups(RUN_CELLS);

/** Register the run part's cells for one runner: `harness-<runner>-run-parity.test.ts`. */
export function describeHarnessParity(scope: HarnessPartScope, registration?: HarnessRegistration): void {
  describeHarnessPart('run', RUN_GROUPS, scope, registration);
}
