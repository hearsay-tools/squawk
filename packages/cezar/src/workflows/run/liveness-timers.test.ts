import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentSession } from '../../core/agent-runner.ts';
import { cancelLivenessTimer, LIVENESS_BOUNDS, LivenessTimers, type LivenessKind } from './liveness-timers.ts';

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
afterEach(() => { vi.useRealTimers(); });

const session = (name: string) => ({ name }) as unknown as AgentSession;

it('names a scope for every bound kind of the spec', () => {
  expect(Object.keys(LIVENESS_BOUNDS).sort()).toEqual(['acknowledgement', 'auto-resume', 'held-human-input', 'idle-close',
    'inbox-claim', 'nudge-reply', 'request-deadline', 'subagent-ask-hold', 'subagent-grace', 'subagent-retry', 'unread-input', 'wake-backoff', 'wake-retry']);
  const kinds: LivenessKind[] = ['idle-close'];
  // @ts-expect-error a bound kind without a row is not a kind
  kinds.push('nudge-acknowledgement');
  expect(kinds).toHaveLength(2);
});

it('replaces the handle armed for the same kind, run and key, and keeps other keys', () => {
  const timers = new LivenessTimers();
  const fired: string[] = [];
  timers.arm({ kind: 'wake-retry', runId: 'a', delayMs: 10 }, () => fired.push('first'));
  timers.arm({ kind: 'wake-retry', runId: 'a', delayMs: 10 }, () => fired.push('second'));
  timers.arm({ kind: 'wake-retry', runId: 'a', key: 'other', delayMs: 10 }, () => fired.push('other'));
  timers.arm({ kind: 'wake-retry', runId: 'b', delayMs: 10 }, () => fired.push('run b'));
  expect(vi.getTimerCount()).toBe(3);
  vi.advanceTimersByTime(10);
  expect(fired).toEqual(['second', 'other', 'run b']);
  expect(timers.has('wake-retry', 'a')).toBe(false);
});

it('runs no expiry of a cancelled handle, wherever its caller kept it', () => {
  const timers = new LivenessTimers();
  const expire = vi.fn();
  const handle = timers.arm({ kind: 'unread-input', runId: 'a', delayMs: 10 }, expire);
  cancelLivenessTimer(handle);
  expect(timers.has('unread-input', 'a')).toBe(false);
  vi.advanceTimersByTime(10);
  expect(expire).not.toHaveBeenCalled();
});

it('forgets the handle at expiry and runs the expiry only while the armed session is current', () => {
  const timers = new LivenessTimers();
  const armed = session('armed');
  let current: AgentSession | undefined = armed;
  const log: string[] = [];
  const bound = { kind: 'nudge-reply' as const, runId: 'a', delayMs: 10, session: { armed, current: () => current }, forget: () => log.push('forget') };
  timers.arm(bound, () => log.push('expire'));
  vi.advanceTimersByTime(10);
  expect(log).toEqual(['forget', 'expire']);
  log.length = 0;
  timers.arm(bound, () => log.push('expire'));
  current = session('replacement');
  vi.advanceTimersByTime(10);
  expect(log).toEqual(['forget']);
  expect(timers.has('nudge-reply', 'a')).toBe(false);
});

it('clears one scope of one run and leaves the other scope and other runs armed', () => {
  const timers = new LivenessTimers();
  for (const kind of ['idle-close', 'unread-input', 'held-human-input', 'subagent-grace', 'wake-backoff', 'auto-resume'] as const) {
    timers.arm({ kind, runId: 'a', delayMs: 10 }, () => {});
  }
  timers.arm({ kind: 'unread-input', runId: 'b', delayMs: 10 }, () => {});
  timers.clearScope('a', 'execution');
  expect(timers.armedIn('a', 'execution')).toEqual([]);
  expect(timers.armedIn('a', 'run').sort()).toEqual(['auto-resume', 'wake-backoff']);
  expect(timers.armedIn('b', 'execution')).toEqual(['unread-input']);
  timers.clearScope('a', 'run');
  expect(timers.armedIn('a', 'run')).toEqual([]);
  expect(vi.getTimerCount()).toBe(1);
  timers.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it('tells its owner once a run holds no run-scope bound, not on a replacement or an execution bound', () => {
  const ended = vi.fn();
  const timers = new LivenessTimers(ended);
  timers.arm({ kind: 'wake-retry', runId: 'a', delayMs: 10 }, () => {});
  timers.arm({ kind: 'wake-retry', runId: 'a', delayMs: 10 }, () => {});
  timers.arm({ kind: 'auto-resume', runId: 'a', delayMs: 20 }, () => {});
  timers.arm({ kind: 'idle-close', runId: 'a', delayMs: 5 }, () => {});
  vi.advanceTimersByTime(10);
  expect(ended).not.toHaveBeenCalled();
  vi.advanceTimersByTime(10);
  expect(ended.mock.calls).toEqual([['a']]);
});
