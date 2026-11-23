import { describe, expect, it, vi } from 'vitest';
import { WAIT_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { scheduleTaskRequestSchema, scheduledTaskSchema, type ScheduleTaskAnswer } from '@open-mercato/cezar-contract/scheduled-tasks';
import { squawkDoneRequestSchema, squawkWaitRequestSchema, type SquawkDoneAnswer, type SquawkWaitAnswer } from '@open-mercato/cezar-contract/waits';
import { callScheduleTask, callSquawkDone, callSquawkWait } from './client.ts';
import { squawkToolDefinitions } from './tool-catalog.ts';
import { squawkToolNames } from './tool-names.ts';
import { invokeDoneTool, invokeScheduleTaskTool, invokeWaitTool } from './tools.ts';

vi.mock('./client.ts', () => ({
  callSquawkAsk: vi.fn(), callSquawkCancelWait: vi.fn(), callSquawkDone: vi.fn(), callSquawkWait: vi.fn(),
  callPreviewServe: vi.fn(), callPreviewStop: vi.fn(), callScheduleTask: vi.fn(), callScheduledTasks: vi.fn(),
}));

/** What the agent reads: Squawk's answer as JSON on the first line, then the hint it acts on. */
function shown(result: { content: Array<{ type: string; text: string }>; isError?: boolean; details: unknown }) {
  const text = result.content[0]!.text;
  const newline = text.indexOf('\n');
  return { parts: result.content.length, type: result.content[0]!.type, answer: JSON.parse(text.slice(0, newline)) as unknown,
    hint: text.slice(newline + 1), isError: result.isError, details: result.details };
}

describe('Squawk tool answers', () => {
  // Requests the tool server accepts.
  const done = squawkDoneRequestSchema.parse({ summary: 'Tests pass.' });
  const wait = squawkWaitRequestSchema.parse({ kind: WAIT_KIND.timer, seconds: 600, note: 'deploy' });
  const schedule = scheduleTaskRequestSchema.parse({ name: 'Check the rollout', prompt: 'Check it', delay: '7d' });
  const accepted = { ok: true as const, finishes: 'at_turn_end' as const, open_waits: [] };
  it.each<[string, SquawkDoneAnswer, string]>([
    ['a refused finish', { ok: false, code: 'workers_outstanding', message: 'One worker still runs.' }, 'Not finished. Do what the message says'],
    ['an accepted step', { ...accepted, completes: 'step', next_step: 'review' }, `Squawk completes this step at its end and starts "review".`],
    ['an accepted task', { ...accepted, completes: 'task' }, `Squawk finishes the task at its end.`],
  ])('cezar_done answers %s with the hint for it', async (_name, answer, hint) => {
    vi.mocked(callSquawkDone).mockResolvedValue(answer);
    expect(shown(await invokeDoneTool(done))).toEqual({ parts: 1, type: 'text', answer, hint: expect.stringContaining(hint), isError: !answer.ok, details: answer });
  });

  it.each<[string, SquawkWaitAnswer, string]>([
    ['a new registration', { ok: true, wait_id: '4a6b6bf4-798c-4dc7-aede-e583428f667a', kind: WAIT_KIND.timer, deadline: '2026-11-05T14:00:00.000Z',
      open_waits: [], effect: 'applied', wait_phase: 'open' }, 'Registered. End your turn to wait'],
    ['a known refusal', { ok: false, effect: 'refused', code: 'capacity', message: 'full' }, 'Not registered by this call'],
  ])('cezar_wait answers %s with the hint for it', async (_name, answer, hint) => {
    vi.mocked(callSquawkWait).mockResolvedValue(answer);
    expect(shown(await invokeWaitTool(wait))).toEqual({ parts: 1, type: 'text', answer, hint: expect.stringContaining(hint), isError: !answer.ok, details: answer });
  });

  const task = { id: 'a1', name: 'Check the rollout', status: scheduledTaskSchema.shape.status.enum.waiting, due_at: '2026-10-29T08:00Z' };
  it.each<[string, ScheduleTaskAnswer, string]>([
    ['a scheduled task', { ok: true, task, note: 'n' }, 'due_at is UTC'],
    ['automations switched off', { ok: false, code: 'automations_off', message: 'off' }, 'Not scheduled. Tell the user'],
    ['an unreachable scheduler', { ok: false, code: 'unavailable', message: 'closed' }, 'Not scheduled. Tell the user'],
    ['an invalid call', { ok: false, code: 'invalid_request', message: 'delay: required' }, 'Not changed. Fix the call'],
  ])('cezar_schedule_task answers %s with the hint for it', async (_name, answer, hint) => {
    vi.mocked(callScheduleTask).mockResolvedValue(answer);
    expect(shown(await invokeScheduleTaskTool(schedule))).toEqual({ parts: 1, type: 'text', answer, hint: expect.stringContaining(hint), isError: !answer.ok, details: answer });
  });
});

describe('squawkToolNames', () => {
  it.each([
    {},
    { HSQ_PREVIEW: '1' },
    { HSQ_AUTOMATIONS: '0' },
    { HSQ_PREVIEW: '1', HSQ_AUTOMATIONS: '0' },
  ])('lists the names of the advertised definitions in order for %j', env => {
    expect(squawkToolNames(env)).toEqual(squawkToolDefinitions(env).map(tool => tool.name));
  });
});
