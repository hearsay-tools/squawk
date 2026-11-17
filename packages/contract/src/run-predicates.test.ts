import { describe, expect, it } from 'vitest';
import { deriveAttention } from './attention.ts';
import { engineOwnsRun, isSessionOpen, isSweepable, latestSession, latestSessionStep, sessionRunner } from './run-predicates.ts';
import { runStatusSchema } from './run-status.ts';
import type { ArchiveFinishedScope, RunStatus } from './runs.ts';
import { computeWaitingOn, isUsageLimitHold } from './waits.ts';

/** The run predicates (hearsay-tools/cezarion#1496), at every status with a resume time set and unset. */

const ALL_STATUSES: readonly RunStatus[] = runStatusSchema.options;
const AT = '2026-10-25T23:00:00.000Z';
const records = ALL_STATUSES.flatMap((status) => [{ status }, { status, autoResumeAt: AT }]);
const name = (run: { status: RunStatus; autoResumeAt?: string }) => `${run.status}${run.autoResumeAt ? ' with a resume time' : ''}`;

describe('isUsageLimitHold', () => {
  it('is a waiting run with a resume time and nothing else', () => {
    expect(records.filter((run) => isUsageLimitHold(run)).map(name)).toEqual(['waiting with a resume time']);
    expect(isUsageLimitHold({})).toBe(false);
    expect(isUsageLimitHold({ autoResumeAt: AT })).toBe(false);
  });

  // Rung 6 and `computeWaitingOn`'s usage-limit wait read the same fact (spec 2026-10-17-unified-waits).
  it.each(records.map((run) => [name(run), run] as const))('names the rung and the wait exactly when it holds, for %s', (_name, run) => {
    const held = isUsageLimitHold(run);
    expect(computeWaitingOn(run)?.kind === 'usage-limit').toBe(held);
    expect(deriveAttention(run).rung === 'usage-limit').toBe(held);
  });
});

describe('engineOwnsRun and isSessionOpen', () => {
  it('own queued, running and waiting runs, never a hold, and open a session only once out of the line', () => {
    expect(records.filter(engineOwnsRun).map(name)).toEqual(['queued', 'queued with a resume time', 'running', 'running with a resume time', 'waiting']);
    expect(records.filter(isSessionOpen).map(name)).toEqual(['running', 'running with a resume time', 'waiting']);
  });
});

describe('isSweepable', () => {
  type Input = Parameters<typeof isSweepable>[0];
  /** packages/cezar/src/runs/store.ts `isSweepable`, the copy the server swept with. */
  const storeCopy = (run: Input, scope?: ArchiveFinishedScope, automation?: boolean): boolean => {
    if (run.archived || !['done', 'failed', 'cancelled'].includes(run.status)) return false;
    if (run.delegation?.role === 'worker') return false;
    if (automation !== undefined && (run.automationId !== undefined) !== automation) return false;
    if (scope === 'unpinned') return !run.pinned;
    if (scope === 'pinned') return run.pinned === true;
    return true;
  };
  const inputs: Input[] = records.flatMap((run) => [false, true].flatMap((archived) => [undefined, true, false].flatMap((pinned) =>
    [undefined, { role: 'root' }, { role: 'worker' }].flatMap((delegation) => [undefined, 'automation-1'].map((automationId) => ({
      ...run, archived,
      ...(pinned === undefined ? {} : { pinned }),
      ...(delegation === undefined ? {} : { delegation }),
      ...(automationId === undefined ? {} : { automationId }),
    }))))));
  const scopes = [undefined, 'unpinned', 'pinned'] as const;

  it('agrees with the store copy for every input, scope and tab', () => {
    for (const run of inputs) for (const scope of scopes) for (const automation of [undefined, true, false]) {
      expect(isSweepable(run, scope, automation), JSON.stringify({ run, scope, automation })).toBe(storeCopy(run, scope, automation));
    }
  });
});

describe('latestSessionStep', () => {
  const step = (id: string, sessionId?: string, startedAt?: string) => ({ id, sessionId, startedAt });
  it('reads start time, not array order (hearsay-tools/squawk#3024)', () => {
    // `review` ran after the appended `continue-1`, which sits after it in the array.
    const steps = [step('implement', 'launch'), step('review', 'review-session', '2026-11-16T00:00:03Z'), step('continue-1', 'thread', '2026-11-16T00:00:02Z')];
    expect(latestSessionStep(steps)?.id).toBe('review');
    expect(latestSessionStep(steps, 'review')?.id).toBe('continue-1');
  });
  it('keeps array order for steps saved without a start time, and skips steps with no session', () => {
    expect(latestSessionStep([step('a', 's1'), step('b', 's2'), step('c')])?.id).toBe('b');
    expect(latestSessionStep([step('c')])).toBeUndefined();
  });
});

describe('sessionRunner', () => {
  it('reads the step backend, else the run runner, else Claude', () => {
    expect(sessionRunner({ backend: 'codex' }, { runner: 'claude' })).toBe('codex');
    expect(sessionRunner({}, { runner: 'pi' })).toBe('pi');
    expect(sessionRunner(undefined, undefined)).toBe('claude');
  });
});

describe('latestSession', () => {
  it('pairs the latest session with its runner and account, else the run runner, else Claude', () => {
    const steps = [{ id: 'implement', sessionId: 'a', startedAt: '2026-11-16T00:00:01Z', backend: 'codex' as const, profileId: 'work' }];
    expect(latestSession({ steps, runner: 'claude' })).toEqual({ sessionId: 'a', backend: 'codex', profileId: 'work' });
    expect(latestSession({ steps: [{ id: 'x', sessionId: 'b' }], runner: 'pi' })).toEqual({ sessionId: 'b', backend: 'pi', profileId: undefined });
    expect(latestSession({ steps: [] })).toEqual({ sessionId: undefined, backend: 'claude', profileId: undefined });
  });
});

// hearsay-tools/squawk#3715: work on a removed runner after the latest session leaves nothing to hand off.
describe('latestSession after work on a removed runner', () => {
  const steps = [
    { id: 'plan', sessionId: 'plan-session', backend: 'claude' as const, startedAt: '2026-01-01T10:00:00.000Z' },
    { id: 'build', removedBackend: 'cursor', startedAt: '2026-01-01T10:01:00.000Z' },
  ];

  it('names no session when a removed-runner step started after the latest session', () => {
    expect(latestSession({ steps, runner: 'claude' }).sessionId).toBeUndefined();
  });

  it('keeps the latest session when it started after the removed-runner step', () => {
    const later = [...steps, { id: 'review', sessionId: 'review-session', backend: 'codex' as const, startedAt: '2026-01-01T10:02:00.000Z' }];
    expect(latestSession({ steps: later, runner: 'claude' })).toMatchObject({ sessionId: 'review-session', backend: 'codex' });
  });
});
