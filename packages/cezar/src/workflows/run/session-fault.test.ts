import { describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../../core/agent-runner.ts';
import type { UiEventSink } from '../../runs/ui-event-sink.ts';
import { createActiveRun } from '../active-run.ts';
import { unused } from '../unused.testkit.ts';
import { createSessionEventHandler, recordSessionFault, type SessionEventHost, type SessionHelperHost } from './session-events.ts';
import type { ExecutionEmit, RunModuleContext, SessionTurn } from './types.ts';

describe('session fault precedence in the session event handler', () => {
  it('keeps the first of two provider faults in the same turn', () => {
    const interrupt = vi.fn();
    const state = createActiveRun({ cwd: '/work', pendingHumanAsk: false, autonomous: false });
    state.liveSession.attachSession(unused<AgentSession>('session', { interrupt }));
    const context = unused<RunModuleContext>('context');
    const turn: SessionTurn = { text: '', scheduleWakeup: undefined, sessionError: undefined };
    const emitted: Parameters<ExecutionEmit>[0][] = [];
    const host = unused<SessionEventHost>('session event host', {
      disposedSessionEvent: () => false,
      handleReceiptEvent: () => false,
      recordSessionFault: (faulted, faultTurn, message) =>
        recordSessionFault(context, unused<SessionHelperHost>('session helper host'), faulted, faultTurn, message),
    });
    const onEvent = createSessionEventHandler(context, host, {
      runId: 'run', state, turn, stepId: 'task', backend: 'claude', sink: unused<UiEventSink>('sink'),
      tokenBase: 0, emit: event => { emitted.push(event); }, acknowledge: () => true,
    });
    onEvent({ type: 'error', message: 'first provider fault' }, undefined);
    onEvent({ type: 'error', message: 'second provider fault' }, undefined);
    expect(interrupt).toHaveBeenCalledTimes(2);
    expect(turn.sessionError).toBe('first provider fault');
    expect(state.liveSession.agentSessionError).toBe('first provider fault');
    expect(emitted.filter(event => event.type === 'error').map(event => event.message))
      .toEqual(['first provider fault', 'second provider fault']);
  });
});
