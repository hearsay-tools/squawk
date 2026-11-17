import { describe, expect, it } from 'vitest';
import { createActiveRun } from './active-run.ts';

describe('createActiveRun', () => {
  it('sets every field a run starts with, to what the two literals set before the factory', () => {
    const state = createActiveRun({ cwd: '/work/tree', pendingHumanAsk: true, autonomous: true });
    // The keys the `execute` and `runContinuation` literals both set. A field added to `ActiveRun`
    // as required fails to compile in the factory; an optional one lands here.
    expect(Object.keys(state).sort()).toEqual([
      'autosave', 'boundary', 'children', 'inputState', 'liveSession', 'skills', 'usage', 'waitIdentity',
    ]);
    expect(state).toMatchObject({ liveSession: { cwd: '/work/tree', cancelled: false }, boundary: { pendingHumanAsk: true, autonomous: true } });
    expect(Object.isFrozen(state)).toBe(true);
    expect(state.waitIdentity.ciTurnId).toBeUndefined();
    expect(state.autosave.autosaveTimer).toBeUndefined();
    expect(state.liveSession.delegationSettings).toBeUndefined();
    expect(state.liveSession.revokeDelegation).toBeUndefined();
    expect(state.liveSession.interrupt()).toBeUndefined();
    expect([...state.liveSession.pendingPermissions]).toEqual([]);
    // No native subagent is known before a session reports one (hearsay-tools/cezarion#2431).
    expect([...state.children.backgroundChildren]).toEqual([]);
    // The registry is loaded after the run is registered, by `loadRunSkills`, never by the factory.
    expect(state.skills.catalog).toEqual([]);
    expect(state.skills.query).toBeUndefined();
  });

  it('takes cwd, the pending ask and the mode from its caller, and shares no mutable state', () => {
    const first = createActiveRun({ cwd: '/a', pendingHumanAsk: false, autonomous: false });
    const second = createActiveRun({ cwd: '/b', pendingHumanAsk: true, autonomous: true });
    expect(first).toMatchObject({ liveSession: { cwd: '/a' }, boundary: { pendingHumanAsk: false, autonomous: false } });
    expect(second).toMatchObject({ liveSession: { cwd: '/b' }, boundary: { pendingHumanAsk: true, autonomous: true } });
    first.liveSession.requestPermission('p');
    expect(second.liveSession.pendingPermissions?.size).toBe(0);
    expect(first.children).not.toBe(second.children);
    expect(first.children.backgroundChildren).not.toBe(second.children.backgroundChildren);
    expect(second.children.backgroundChildren.size).toBe(0);
  });
});
