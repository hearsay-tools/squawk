import '../ci-wait/tools.testkit.ts';
import { describe, expect, it, vi } from 'vitest';
import type { ScheduleTaskAnswer, ScheduledTasksAnswer } from '@open-mercato/cezar-contract/scheduled-tasks';
import { AutomationToolsSlot, squawkToolHandlers, type ToolHost } from './run/squawk-tools.ts';
import type { RunModuleContext } from './run/types.ts';
import { unused } from './unused.testkit.ts';

// hearsay-tools/cezarion#1465: the schedule tools reach a project-level service, not the run. The
// server sets it after the boot manager recovers, so a session provisioned before the setter (a
// recovered run) must still reach it: the handlers read it at call time.
const task = { id: 'a1', name: 'n', status: 'paused' as const, due_at: '2026-10-29T09:00Z' };
const created: ScheduleTaskAnswer = { ok: true, task, note: 'note' };
const listed: ScheduledTasksAnswer = { ok: true, tasks: [task] };
const signal = new AbortController().signal;
function fixture(cockpitAttached = true) {
  const slot = new AutomationToolsSlot(unused<RunModuleContext>('run module context'), () => cockpitAttached);
  const handlers = squawkToolHandlers('run-1', 'generation',
    unused<ToolHost>('tool host', { awaitAutomationTools: abort => slot.awaitAutomationTools(abort) }));
  return { slot, handlers };
}

describe('automation tools slot', () => {
  it('a handler provisioned before setAutomationTools reaches the service set afterwards', async () => {
    // No live session entry: the handlers are built for a run nothing has started.
    const { slot, handlers } = fixture();
    const scheduleTask = vi.fn(async () => created);
    const scheduledTasks = vi.fn(async () => listed);
    slot.setAutomationTools({ scheduleTask, scheduledTasks });
    await expect(handlers.scheduleTask!({ name: 'n', prompt: 'p', delay: '1h' }, signal)).resolves.toEqual(created);
    await expect(handlers.scheduledTasks!({ action: 'list' }, signal)).resolves.toEqual(listed);
    expect(scheduleTask).toHaveBeenCalledWith({ name: 'n', prompt: 'p', delay: '1h' });
  });

  // Review of #1465: recovery resumes a session before the server attaches the service. A call in
  // that window waits for it instead of answering unavailable, which the agent must not retry.
  it('a call made before the service is attached waits for it', async () => {
    const { slot, handlers } = fixture();
    const answer = handlers.scheduleTask!({ name: 'n', prompt: 'p', delay: '1h' }, signal);
    slot.setAutomationTools({ scheduleTask: async () => created, scheduledTasks: async () => listed });
    await expect(answer).resolves.toEqual(created);
  });

  it('no service within the startup window answers unavailable', async () => {
    const { slot, handlers } = fixture();
    vi.useFakeTimers();
    try {
      const first = handlers.scheduleTask!({ name: 'n', prompt: 'p', delay: '1h' }, signal);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(first).resolves.toMatchObject({ ok: false, code: 'unavailable' });
      slot.setAutomationTools({ scheduleTask: async () => created, scheduledTasks: async () => listed });
      slot.setAutomationTools(undefined);
      const second = handlers.scheduledTasks!({ action: 'list' }, signal);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(second).resolves.toMatchObject({ ok: false, code: 'unavailable' });
    } finally { vi.useRealTimers(); }
  });

  it('headless, with no cockpit address, answers unavailable at once', async () => {
    const { handlers } = fixture(false);
    await expect(handlers.scheduleTask!({ name: 'n', prompt: 'p', delay: '1h' }, signal)).resolves.toMatchObject({ ok: false, code: 'unavailable' });
  });
});
