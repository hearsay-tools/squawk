import './turn-boundary.types.testkit.ts';
import { expect, it } from 'vitest';
import type { AgentSession } from '../../core/agent-runner.ts';
import { createActiveRun } from '../active-run.ts';
import { transitionTurnBoundary } from './turn-boundary.ts';

const unused = (): never => { throw new Error('unused boundary capability'); };
function session(): AgentSession {
  return { open: true, result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
    sendMessage: unused, sendAgentMessage: unused, discardQueuedMessages: unused,
    holdsHumanInput: unused, end: unused, interrupt: unused };
}
const replace = (target: object, key: string, value: unknown) => Object.assign(target, { [key]: value });

it('owns a frozen completion record without freezing the runner', () => {
  const state = createActiveRun({ cwd: '.', pendingHumanAsk: false, autonomous: true });
  const wire = session();
  const group = state.boundary;
  transitionTurnBoundary(state, { kind: 'turn-end', phase: 'record-done', session: wire, done: true, request: { summary: 'done' }, keepClose: true });
  expect(group.doneClose).toEqual({ via: 'cezar_done', summary: 'done' });
  expect(Object.isFrozen(group.doneClose)).toBe(true);
  expect(Object.isFrozen(wire)).toBe(false);
  expect(state.boundary).toBe(group);
});

it('retains independent immutable records and their session identities across later transitions', () => {
  const state = createActiveRun({ cwd: '.', pendingHumanAsk: false, autonomous: false });
  const wire = session();
  const next = { session: wire, label: 'next' };
  const ack = { session: wire, monitoring: true };
  transitionTurnBoundary(state, { kind: 'session-open', phase: 'scope-step', session: wire, next });
  transitionTurnBoundary(state, { kind: 'turn-end', phase: 'save-ack', session: wire, boundary: ack });
  transitionTurnBoundary(state, { kind: 'turn-end', phase: 'record-done', session: wire, done: true, request: { summary: 'kept' }, keepClose: true });
  const group = state.boundary;
  const oldNext = group.nextStep;
  const oldAck = group.parkAfterAck;
  next.label = 'changed'; ack.monitoring = false;
  expect(oldNext).toEqual({ session: wire, label: 'next' });
  expect(oldAck).toEqual({ session: wire, monitoring: true });
  expect(group.nextStep).toBe(oldNext);
  expect(group.parkAfterAck).toBe(oldAck);
  for (const record of [oldNext, oldAck, group.doneClose]) expect(Object.isFrozen(record)).toBe(true);
  expect(() => replace(oldNext!, 'label', 'forged')).toThrow(TypeError);
  expect(() => replace(oldAck!, 'monitoring', false)).toThrow(TypeError);
  expect(() => replace(group.doneClose!, 'summary', 'forged')).toThrow(TypeError);
  transitionTurnBoundary(state, { kind: 'session-retired', phase: 'reset', session: wire });
  expect(group.nextStep).toBeUndefined(); expect(group.parkAfterAck).toBeUndefined();
  expect(oldNext?.session).toBe(wire); expect(oldAck?.monitoring).toBe(true);
});

it('keeps absent optional defaults and independent factory generations', () => {
  const a = createActiveRun({ cwd: '.', pendingHumanAsk: true, autonomous: true });
  const b = createActiveRun({ cwd: '.', pendingHumanAsk: false, autonomous: false });
  expect(a.boundary.pendingHumanAsk).toBe(true); expect(a.boundary.autonomous).toBe(true);
  expect(b.boundary.pendingHumanAsk).toBe(false); expect(b.boundary.autonomous).toBe(false);
  for (const value of [a.boundary.waitWakeTurn, a.boundary.noWaitNudgeReplyTimer, a.boundary.noWaitNudgeSawContent,
    a.boundary.noWaitNudgeParked, a.boundary.doneAtBoundary, a.boundary.requestRefusedDone, a.boundary.nextStep,
    a.boundary.completedStepId, a.boundary.doneClose, a.boundary.parkAfterAck, a.boundary.atTurnBoundary,
    a.boundary.idleTimer, a.boundary.idleClosed, a.boundary.monitoringCapNoted, a.boundary.nudge,
    a.boundary.noWaitNudged, a.boundary.incomingRequestRefused, a.boundary.sentRequestRefused,
    a.boundary.completionNudged, a.boundary.completionNudgeAnswered, a.boundary.heldForSubagents]) expect(value).toBeUndefined();
  transitionTurnBoundary(a, { kind: 'mode-disabled', phase: 'disable', session: undefined });
  expect(a.boundary.autonomous).toBe(false); expect(b.boundary.autonomous).toBe(false);
});
