// real-clock: static ISO timestamps used solely to validate schema parsing; never compared against system clock.
import { describe, expect, it } from 'vitest';
import { ACTIVITY_TOOL_KINDS, activityWaitSchema, activityQuerySchema, activityRunSchema } from './activity.ts';
import { WAIT_KIND } from './wait-factories.testkit.ts';
import { RUN_STATUS } from './test-factories.testkit.ts';
import type { ToolKind } from './tool-display.ts';

type Assert<T extends true> = T;
type _EveryToolKind = Assert<[ToolKind] extends [(typeof ACTIVITY_TOOL_KINDS)[number]] ? true : false>;

describe('the activity contract', () => {
  it('takes a project slug or the boot alias, never a colon', () => {
    expect(activityQuerySchema.parse({})).toEqual({});
    expect(activityQuerySchema.parse({ project: 'default' })).toEqual({ project: 'default' });
    expect(activityQuerySchema.parse({ project: 'all' })).toEqual({ project: 'all' });
    expect(activityQuerySchema.safeParse({ project: 'shop:all' }).success).toBe(false);
    expect(activityQuerySchema.safeParse({ project: 'Shop' }).success).toBe(false);
  });

  it('holds a heartbeat of exactly 30 buckets', () => {
    const run = { runId: 'r', title: 't', status: RUN_STATUS.running, rung: 'running', rate: Array.from({ length: 30 }, () => 0), workers: [] };
    expect(activityRunSchema.safeParse(run).success).toBe(true);
    expect(activityRunSchema.safeParse({ ...run, rate: [0] }).success).toBe(false);
  });

  it('accepts optional createdAt and finishedAt timestamps for decision-queue age', () => {
    const run = {
      runId: 'r', title: 't', status: RUN_STATUS.review, rung: 'needs-review',
      createdAt: '2026-11-23T10:00:00Z', startedAt: '2026-11-23T10:01:00Z', finishedAt: '2026-11-23T10:05:00Z',
      rate: Array.from({ length: 30 }, () => 0), workers: [],
    };
    expect(activityRunSchema.parse(run)).toEqual(run);
  });
});

it.each([undefined, '2026-11-23T12:00:00Z'])('parses generic plugin activity with deadline %s', (deadline) => {
  const wait = {
    kind: WAIT_KIND.plugin, since: '2026-11-23T11:00:00Z', ...(deadline ? { deadline } : {}),
    detail: { pluginKind: 'uninstalled.check', summary: 'Checking remote job' },
  };
  expect(activityWaitSchema.parse(wait)).toEqual(wait);
  expect(activityWaitSchema.safeParse({ ...wait, detail: { ...wait.detail, extra: true } }).success).toBe(false);
});
