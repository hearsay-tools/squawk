import '../../built-in-wait-kinds.testkit.ts';
import { describe, expect, it, vi } from 'vitest';
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunRecord } from '../../runs/store.ts';
import { createActiveRun } from '../active-run.ts';
import { workerExecutionStopped } from './run-guards.ts';
import { staleContinuationDisposition } from './continuation-session.ts';
import { sessionCloseKeepsWaiting, terminalScratchDisposition } from './run-settlement.ts';
import { latchInputFault } from './input-delivery.ts';
import { selectSessionFault } from './session-events.ts';

function root(deleting = false): RunRecord {
  return makeRunRecord({ id: 'parent', delegation: { role: 'root', permissions: [], receipts: [], historyDeletion: deleting ? 'pending' : undefined } });
}

function worker(destroy = false): RunRecord {
  return makeRunRecord({ id: 'child', delegation: { role: 'worker', parentRunId: 'parent', permissions: [],
    destroy: destroy ? { requestedAt: '2026-11-05T00:00:00Z', phase: 'requested', remaining: [] } : undefined,
    workspace: { ownerRunId: 'child', resourceId: 'resource', kind: 'owned-isolated', path: '/work', branch: 'task', baselineSha: 'a'.repeat(40) } } });
}

describe('workerExecutionStopped without an ActiveRun', () => {
  it.each([
    ['deleting root', root(true), undefined, false, true],
    ['deleting parent', worker(), root(true), false, true],
    ['invalid', makeRunRecord({ id: 'run', delegation: { role: 'invalid' } }), undefined, false, true],
    ['destroying', worker(true), root(), false, true],
    ['stopped', worker(), root(), true, true],
    ['live', worker(), root(), false, false],
    ['missing parent', worker(), undefined, false, false],
    ['ordinary', makeRunRecord({ id: 'run' }), root(true), false, false],
    ['absent', undefined, undefined, false, false],
  ] as const)('%s stops only blocked executions', (_name, row, parent, stopped, expected) => {
    const id = row?.id ?? 'missing';
    const store = { getRun(key: string) { return key === id ? row : parent; } };
    expect(workerExecutionStopped(store, id, key => key === id && stopped)).toBe(expected);
  });
});

describe('staleContinuationDisposition', () => {
  it.each(['missing', 'replaced', 'cancelled', 'stopped', 'hold'] as const)('%s selects the continuation disposition', mode => {
    const state = createActiveRun({ cwd: '.', pendingHumanAsk: false, autonomous: false });
    const replacement = createActiveRun({ cwd: '.', pendingHumanAsk: false, autonomous: false });
    if (mode === 'cancelled') state.liveSession.cancel();
    const current = mode === 'missing' ? undefined : mode === 'replaced' ? replacement : state;
    const expected = mode === 'missing' || mode === 'replaced' ? 'replaced' : mode === 'hold' ? 'hold' : 'cancel';
    expect(staleContinuationDisposition(current, state, () => mode === 'stopped')).toBe(expected);
  });
});

describe('sessionCloseKeepsWaiting', () => {
  it.each([
    [true, false, true, true, false, false],
    [false, true, true, true, false, false],
    [false, false, true, false, true, false],
    [false, false, false, true, true, true],
    [false, false, false, false, false, true],
    [false, false, undefined, false, false, true],
  ] as const)('cancelled=%s incomplete=%s idle=%s ask=%s', (cancelled, incomplete, idleClosed, answer, expected, asks) => {
    const ask = vi.fn(() => answer);
    expect(sessionCloseKeepsWaiting({ cancelled, incomplete, idleClosed }, ask)).toBe(expected);
    expect(ask).toHaveBeenCalledTimes(asks ? 1 : 0);
  });
});

describe('latchInputFault', () => {
  it.each([
    [false, undefined, undefined, false],
    [true, 'provider', undefined, false],
    [true, undefined, 'input', false],
    [true, undefined, undefined, true],
    [true, '', 'input', false],
    [true, '', '', true],
  ] as const)('current=%s session=%s input=%s', (current, session, input, expected) => {
    expect(latchInputFault({
      current: () => current,
      sessionFault: () => session,
      inputFault: () => input,
    })).toBe(expected);
  });
});

describe('selectSessionFault', () => {
  it.each([
    [undefined, undefined, 'provider'],
    [undefined, 'input', 'input'],
    ['provider first', 'later input', 'provider first'],
    ['input first', 'later input', 'input first'],
    ['', 'later input', ''],
    [undefined, '', ''],
  ] as const)('existing=%s input=%s retains %s', (existing, input, expected) => {
    const state = createActiveRun({ cwd: '.', pendingHumanAsk: false, autonomous: false });
    if (input !== undefined) state.inputState.recordInputError(input);
    const read = vi.fn(() => state.inputState.agentInputError);
    expect(selectSessionFault(existing, read, 'provider')).toBe(expected);
    expect(read).toHaveBeenCalledTimes(existing === undefined ? 1 : 0);
  });
});

function scratchReads(calls: string[], stop?: string, evidence: () => string[] | undefined = () => []) {
  const flag = (name: string) => { calls.push(name); return name === stop; };
  return {
    active: () => flag('active'), starting: () => flag('starting'), queued: () => flag('queued'), claimed: () => flag('claimed'),
    autosaveBlocker: () => flag('autosave') ? 'saving' : undefined,
    privateWorkers: () => { calls.push('evidence'); return evidence(); },
  };
}

describe('terminalScratchDisposition', () => {
  it('keeps scratch for a missing record without liveness or evidence reads', () => {
    const calls: string[] = [];
    expect(terminalScratchDisposition('missing', undefined, scratchReads(calls))).toBe('keep');
    expect(calls).toEqual([]);
  });

  it.each([RUN_STATUS.done, RUN_STATUS.review, RUN_STATUS.failed, RUN_STATUS.cancelled])('removes unheld %s scratch after checking evidence', status => {
    const run = makeRunRecord({ status });
    const calls: string[] = [];
    expect(terminalScratchDisposition(run.id, run, scratchReads(calls))).toBe('remove');
    expect(calls).toEqual(['active', 'starting', 'queued', 'claimed', 'autosave', 'evidence']);
  });

  it.each(['active', 'starting', 'queued', 'claimed', 'autosave'])('keeps scratch at the first %s hold', stop => {
    const run = makeRunRecord();
    const calls: string[] = [];
    expect(terminalScratchDisposition(run.id, run, scratchReads(calls, stop))).toBe('keep');
    const order = ['active', 'starting', 'queued', 'claimed', 'autosave'];
    expect(calls).toEqual(order.slice(0, order.indexOf(stop) + 1));
  });

  it.each([
    ['worker', worker(), [], 'schedule'],
    ['invalid', makeRunRecord({ id: 'run', delegation: { role: 'invalid' } }), [], 'schedule'],
    ['unreadable', makeRunRecord({ id: 'run' }), undefined, 'schedule'],
    ['listed', makeRunRecord({ id: 'run' }), ['lookup'], 'schedule'],
    ['not listed', makeRunRecord({ id: 'run' }), ['run'], 'remove'],
  ] as const)('%s reads evidence once and uses the lookup id', (_name, run, evidence, expected) => {
    const calls: string[] = [];
    expect(terminalScratchDisposition('lookup', run, scratchReads(calls, undefined, () => evidence ? [...evidence] : undefined))).toBe(expected);
    expect(calls.slice(0, 6)).toEqual(['active', 'starting', 'queued', 'claimed', 'autosave', 'evidence']);
    expect(calls.filter(value => value === 'evidence')).toHaveLength(1);
  });
});
