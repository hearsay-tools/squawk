import { transitionTurnBoundary } from './turn-boundary.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { createActiveRun } from '../active-run.ts';
import { clearAutosaveTimer } from './input-timers.ts';
import { AUTOSAVE_INTERVAL_MS } from './worktree-autosave.ts';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('arms the same interval and clears it synchronously without clearing idle or reply bounds', () => {
  vi.useFakeTimers();
  const state = createActiveRun({ cwd: '/task', pendingHumanAsk: false, autonomous: false });
  const group = state.autosave;
  const saved = vi.fn();
  const idle = vi.fn();
  const reply = vi.fn();
  transitionTurnBoundary(state, { kind: 'idle-expired', phase: 'armed', session: state.liveSession.session, timer: setTimeout(idle, AUTOSAVE_INTERVAL_MS * 2) });
  transitionTurnBoundary(state, { kind: 'reply-expired', phase: 'armed', session: state.liveSession.session, timer: setTimeout(reply, AUTOSAVE_INTERVAL_MS * 2) });
  group.armAutosave(saved);
  const handle = group.autosaveTimer!;
  expect(handle.hasRef()).toBe(false);
  expect(group.autosaveTimer).toBe(handle);
  vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS - 1);
  expect(saved).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(saved).toHaveBeenCalledOnce();
  clearAutosaveTimer(state);
  expect(group.autosaveTimer).toBeUndefined();
  expect(state.autosave).toBe(group);
  vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS);
  expect(saved).toHaveBeenCalledOnce();
  expect(idle).toHaveBeenCalledOnce();
  expect(reply).toHaveBeenCalledOnce();
  group.armAutosave(saved);
  expect(group.autosaveTimer).not.toBe(handle);
  clearAutosaveTimer(state);
});
