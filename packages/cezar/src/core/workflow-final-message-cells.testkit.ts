import '../built-in-wait-kinds.testkit.ts';
import { assertPromptResponseCompletion } from './owned-input-delivery.testkit.ts';
import { runnerDefinition } from './runner-registry.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { agentInputSchema } from '@open-mercato/cezar-contract/agent-input';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { observationClock } from './observation-clock.testkit.ts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as realDelay } from 'node:timers/promises';
import { expect, vi } from 'vitest';
import type { CellBody } from './parity-partition.testkit.ts';
import { HARNESS_ADAPTERS, driveSeam, promptFor, waitFor } from './harness-parity-core.testkit.ts';
import { workflowFinalMessage } from './workflow-final-message-rows.testkit.ts';
import { withOwnedInputRun } from './worker-parity-core.testkit.ts';
import { NO_WAIT_NO_REPLY_NOTE, NO_WAIT_NUDGE_NOTE } from '../workflows/run.ts';
import { onRunWrite } from '../runs/lifecycle-listeners.testkit.ts';

function replyObservationClock() {
  return observationClock(delay => delay === 300 &&
    /\bat (?:[^ (\n]+\.)?armNoWaitNudgeReplyTimer \(/.test(new Error().stack ?? ''));
}

// A plain park must stay outside the pool even when its default exemption would hide it.
function expectParkedOutsidePool(semaphore: WorkspaceSemaphore): void {
  const limit = vi.spyOn(semaphore, 'maxMonitoringSessions').mockReturnValue(0);
  try { expect(semaphore.busy()).toBe(0); }
  finally { limit.mockRestore(); }
}

// Poll native process/store signals while the product's reply clock is frozen.
async function waitForNativeContent(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`Native reply signal missing: ${ready.toString()}`);
    // bound: real I/O poll; fake time must not advance until native content arrives.
    await realDelay(10);
  }
}

// The no-wait nudge absorbed the final-message nudge (hearsay-tools/cezarion#1234): these rows pin
// its reply bound, #544's liveness. A worker's fallback stays the plain park.
const nudgeNotes = (events: readonly Record<string, unknown>[]) =>
  events.filter(e => e.type === 'note' && String(e.message).startsWith(NO_WAIT_NUDGE_NOTE));
const noReplyNotes = (events: readonly Record<string, unknown>[]) =>
  events.filter(e => e.type === 'note' && e.message === NO_WAIT_NO_REPLY_NOTE);
const lateDoneContent = (events: readonly Record<string, unknown>[]) =>
  events.some(e => {
    if (e.type === 'text') return String(e.text).includes('Filed #543');
    if (e.type !== 'item.completed') return false;
    const item = e.item as { kind?: string; text?: string } | undefined;
    return item?.kind === 'message' && (item.text ?? '').includes('Filed #543');
  });

// The exemption cell of each row a runner may exempt, by row id.
const EXEMPTION_CELLS: Record<string, (backend: string) => CellBody> = {
  F7: backend => async () => {
    expect(HARNESS_ADAPTERS[backend]!.scenarios['silent-tail-ack-delay']).toBeUndefined();
  },
  F8: backend => async () => {
    expect(HARNESS_ADAPTERS[backend]!.scenarios['silent-tail-no-reply']).toBeUndefined();
    if (runnerDefinition(backend).mock.promptResponseEndsTurn) await assertPromptResponseCompletion(backend);
    await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId }) => {
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.getRun(runId)?.status === 'waiting');
      const started = store.eventLog.readEvents(runId).filter(e => e.type === 'turn.started').length;
      expect(manager.sendMessage(runId, [{ type: 'text', text: 'mock:hold' }])).toBe(true);
      await waitFor(() => store.eventLog.readEvents(runId).filter(e => e.type === 'turn.started').length > started);
    });
  },
  F9: backend => async () => {
    expect(HARNESS_ADAPTERS[backend]!.scenarios['silent-tail-late-reply']).toBeUndefined();
    if (runnerDefinition(backend).mock.promptResponseEndsTurn) await assertPromptResponseCompletion(backend);
    const observed = await driveSeam(backend, 'silent-tail');
    expect(observed.v2.some(event => event.type === 'turn.started')).toBe(true);
    expect(observed.v1.some(event => event.type === 'turn-end')).toBe(true);
  },
  F11: backend => async () => {
    expect(HARNESS_ADAPTERS[backend]!.scenarios['silent-tail-late-turn-start']).toBeUndefined();
  },
};

// The run cell of each row, by row id.
const ROW_CELLS: Record<string, (backend: string) => CellBody> = {
  F7: backend => async () => {
    const semaphore = new WorkspaceSemaphore({ home: testHome() });
    await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId, parentRunId }) => {
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.getRun(runId)?.status === 'waiting');
      const startSeq = store.eventLog.readEvents(runId).length;
      const inputId = randomUUID();
      expect(manager.steerWorker(runId, {
        id: inputId, source: agentInputSchema.shape.source.enum.agent, parentRunId,
        text: promptFor(backend, 'silent-tail-ack-delay'), createdAt: new Date().toISOString(),
      })).toBe('queued');
      await waitFor(() => store.eventLog.readEvents(runId).slice(startSeq).some(e => e.type === 'turn-end'));
      const input = store.getRun(runId)?.agentInputs?.find(input => input.id === inputId);
      expect(input).toBeDefined();
      expect(input?.deliveredAt).toBeUndefined();
      expect(nudgeNotes(store.eventLog.readEvents(runId).slice(startSeq))).toHaveLength(0);
      await waitFor(() => store.getRun(runId)?.agentInputs?.find(input => input.id === inputId)?.deliveredAt !== undefined);
      expect(nudgeNotes(store.eventLog.readEvents(runId).slice(startSeq))).toEqual([expect.objectContaining({
        stepId: store.getRun(runId)?.steps.at(-1)?.id,
      })]);
    }, { semaphore });
  },
  F8: backend => async () => {
    const semaphore = new WorkspaceSemaphore({ home: testHome() });
    await withOwnedInputRun(backend, 'silent-tail-no-reply', async ({ store, manager, runId }) => {
      const startSeq = store.eventLog.readEvents(runId).length;
      const clock = replyObservationClock();
      try {
        manager.enqueueOwnedRun(runId);
        await waitForNativeContent(() => clock.captured === 1 && clock.pending === 1);
        expect(nudgeNotes(store.eventLog.readEvents(runId).slice(startSeq))).toHaveLength(1);
        expect(store.getRun(runId)?.status).toBe('running');
        expect(semaphore.busy()).toBe(1);
        await clock.advance(150);
        expect(store.getRun(runId)?.status).toBe('running');
        expect(semaphore.busy()).toBe(1);
        expect(noReplyNotes(store.eventLog.readEvents(runId))).toHaveLength(0);
        await clock.advance(150);
        expect(clock.captured).toBe(1);
      } finally { clock.restore(); }
      expectParkedOutsidePool(semaphore);
      expect(nudgeNotes(store.eventLog.readEvents(runId).slice(startSeq))).toHaveLength(1);
      expect(noReplyNotes(store.eventLog.readEvents(runId))).toHaveLength(1);
      expect(store.getRun(runId)?.status).toBe('waiting');
    }, { semaphore, noWaitNudgeReplyMs: 300 });
  },
  F9: backend => async () => {
    const semaphore = new WorkspaceSemaphore({ home: testHome() });
    const gateRoot = mkdtempSync(join(tmpdir(), 'cez-late-reply-'));
    const release = join(gateRoot, 'release');
    try {
      await withOwnedInputRun(backend, 'silent-tail-late-reply', async ({ store, manager, runId }) => {
        const startSeq = store.eventLog.readEvents(runId).length;
        manager.enqueueOwnedRun(runId);
        await waitFor(() => noReplyNotes(store.eventLog.readEvents(runId).slice(startSeq)).length === 1);
        expect(store.getRun(runId)?.status).toBe('waiting');
        expectParkedOutsidePool(semaphore);
        // The native reply stays blocked until parking and slot release are observed.
        // Capture the resumed slot in the store callback: DONE can follow in the same tick.
        let resumedSlots: number | undefined;
        const onRun = (run: { id: string; status: string }) => {
          if (run.id === runId && run.status === 'running') resumedSlots ??= semaphore.busy();
        };
        const stopOnRun = onRunWrite(store.lifecycle, onRun);
        try {
          writeFileSync(release, 'go');
          await waitFor(() => resumedSlots !== undefined);
          expect(resumedSlots).toBe(1);
          await waitFor(() => store.getRun(runId)?.status === 'done');
        } finally { stopOnRun(); }
        expect(nudgeNotes(store.eventLog.readEvents(runId).slice(startSeq))).toHaveLength(1);
        expect(noReplyNotes(store.eventLog.readEvents(runId).slice(startSeq))).toHaveLength(1);
      }, { semaphore, noWaitNudgeReplyMs: 300, env: { CEZ_MOCK_RELEASE_FILE: release } });
    } finally { rmSync(gateRoot, { recursive: true, force: true }); }
  },
  F11: backend => async () => {
    const semaphore = new WorkspaceSemaphore({ home: testHome() });
    const gateRoot = mkdtempSync(join(tmpdir(), 'cez-late-turn-'));
    const release = join(gateRoot, 'release');
    try {
      await withOwnedInputRun(backend, 'silent-tail-late-turn-start', async ({ store, manager, runId }) => {
        const startSeq = store.eventLog.readEvents(runId).length;
        manager.enqueueOwnedRun(runId);
        await waitFor(() => noReplyNotes(store.eventLog.readEvents(runId).slice(startSeq)).length === 1);
        expect(store.getRun(runId)?.status).toBe('waiting');
        expectParkedOutsidePool(semaphore);
        const parkedSeq = store.eventLog.readEvents(runId).length;
        // The mock waits for observed parking instead of racing a 200 ms window.
        writeFileSync(release, 'go');
        // Content has its own gate, so only native turn-start can resume the run here.
        await waitFor(() => store.getRun(runId)?.status === 'running');
        expect(semaphore.busy()).toBe(1);
        expect(lateDoneContent(store.eventLog.readEvents(runId).slice(parkedSeq))).toBe(false);
        writeFileSync(`${release}.content`, 'go');
        await waitFor(() => store.getRun(runId)?.status === 'done');
        expect(nudgeNotes(store.eventLog.readEvents(runId).slice(startSeq))).toHaveLength(1);
        expect(noReplyNotes(store.eventLog.readEvents(runId).slice(startSeq))).toHaveLength(1);
      }, { semaphore, noWaitNudgeReplyMs: 300, env: { CEZ_MOCK_RELEASE_FILE: release } });
    } finally { rmSync(gateRoot, { recursive: true, force: true }); }
  },
  F10: backend => async () => {
    const semaphore = new WorkspaceSemaphore({ home: testHome() });
    await withOwnedInputRun(backend, 'silent-tail-slow-done', async ({ store, manager, runId }) => {
      const startSeq = store.eventLog.readEvents(runId).length;
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.getRun(runId)?.status === 'done' || store.getRun(runId)?.status === 'waiting');
      expect(store.getRun(runId)?.status).toBe('done');
      expect(nudgeNotes(store.eventLog.readEvents(runId).slice(startSeq))).toHaveLength(1);
      expect(noReplyNotes(store.eventLog.readEvents(runId).slice(startSeq))).toHaveLength(0);
    }, { semaphore, noWaitNudgeReplyMs: 300 });
  },
};

export const describeWorkflowFinalMessage = workflowFinalMessage({
  exemption: (backend, row) => EXEMPTION_CELLS[row.id]!(backend),
  row: (backend, row) => ROW_CELLS[row.id]!(backend),
});
