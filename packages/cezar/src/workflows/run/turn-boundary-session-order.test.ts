import { afterEach, expect, it, vi } from 'vitest';
import type { UiEvent } from '../../core/ui-events.ts';
import type { UiEventSink } from '../../runs/ui-event-sink.ts';
import { unused } from '../fixture-no-runner.testkit.ts';
import { boundaryOrderFixture } from './boundary-order.testkit.ts';
import * as receipts from './input-receipts.ts';
import * as usage from './usage-accounting.ts';
import { handleRunnerUiEvent, markTurnBoundary, type SessionHelperHost } from './session-events.ts';
import { transitionTurnBoundary } from './turn-boundary.ts';

afterEach(() => vi.restoreAllMocks());

it('fresh and continued completion preserve receipt-before-boundary order at their shared handler', () => {
  const f = boundaryOrderFixture();
  f.state.waitIdentity.rotateCiTurn('old-turn');
  transitionTurnBoundary(f.state, { kind: 'input-ack', phase: 'wake-turn', session: f.wire });
  vi.spyOn(receipts, 'retireUnreadInputs').mockImplementation((_context, _host, id, state, ids, outOfTurn) => {
    f.log.push('retire');
    expect(id).toBe(f.run.id); expect(state).toBe(f.state);
    expect(ids).toEqual(['unread']); expect(outOfTurn).toBe(false);
    expect(state.boundary.waitWakeTurn).toBe(f.wire);
    expect(state.boundary.atTurnBoundary).toBeUndefined();
  });
  vi.spyOn(receipts, 'readBundledInputs').mockImplementation(() => {
    f.log.push('bundled');
    expect(f.state.waitIdentity.ciTurnId).toBe('old-turn');
    expect(f.state.boundary.atTurnBoundary).toBeUndefined();
  });
  const host = unused<SessionHelperHost>('session host', { inputReceiptHost: unused('receipt host') });
  f.log.length = 0;
  markTurnBoundary(f.context, host, f.run.id, f.state, { type: 'turn-end', unconsumedInputIds: ['unread'] });
  expect(f.log).toEqual(['retire', 'bundled', 'boundary:turn-end/ui-completed']);
  expect(f.state.boundary.waitWakeTurn).toBeUndefined();
  expect(f.state.boundary.atTurnBoundary).toBe(f.wire);
  expect(f.state.waitIdentity.ciTurnId).not.toBe('old-turn');
});

function activityFixture() {
  const f = boundaryOrderFixture();
  transitionTurnBoundary(f.state, { kind: 'turn-end', phase: 'ui-completed', session: f.wire });
  transitionTurnBoundary(f.state, { kind: 'nudge-fact', phase: 'record', session: f.wire, nudge: { cause: 'autonomous', state: 'refused' } });
  const host = unused<SessionHelperHost>('session host', {
    line: f.line,
    trackSubagentEvent: () => {
      f.log.push('children');
      expect(f.state.boundary.atTurnBoundary).toBe(f.wire);
    },
    noteNoWaitNudgeContent: () => {
      f.log.push('reply-content');
      expect(f.state.boundary.atTurnBoundary).toBe(f.wire);
    },
    cancelAutonomousNudgeBound: () => { f.log.push('nudge-bound'); },
  });
  const sink = unused<UiEventSink>('sink', { handle: () => { f.log.push('persist-ui'); return undefined; } });
  const originalUsage = usage.recordUsageUiEvent;
  vi.spyOn(usage, 'recordUsageUiEvent').mockImplementation((...args) => {
    f.log.push('usage'); originalUsage(...args);
  });
  f.log.length = 0;
  return { ...f, host, sink };
}

it('parent activity invalidates boundary after persisted UI and child tracking', () => {
  const f = activityFixture();
  handleRunnerUiEvent(f.context, f.host, f.run.id, f.state, f.sink, { type: 'turn.started', turnId: 'turn' });
  expect(f.log).toEqual(['usage', 'persist-ui', 'children', 'reply-content',
    'boundary:nudge-fact/retire', 'nudge-bound', 'boundary:turn-started/clear-boundary']);
  expect(f.state.boundary.atTurnBoundary).toBeUndefined();
  expect(f.state.boundary.nudge).toBeUndefined();
});

// hearsay-tools/squawk#2443: a submitted autonomous nudge is still owed its acknowledgement after
// the reply starts; the activity stops its bound, and the turn end bounds it again.
it('parent activity keeps a nudge still owed its acknowledgement and stops its bound', () => {
  const f = activityFixture();
  transitionTurnBoundary(f.state, { kind: 'nudge-fact', phase: 'record', session: f.wire, nudge: { cause: 'autonomous', state: 'submitted' } });
  f.log.length = 0;
  handleRunnerUiEvent(f.context, f.host, f.run.id, f.state, f.sink, { type: 'turn.started', turnId: 'turn' });
  expect(f.log).toEqual(['usage', 'persist-ui', 'children', 'reply-content', 'nudge-bound', 'boundary:turn-started/clear-boundary']);
  expect(f.state.boundary.nudge).toEqual({ session: f.wire, cause: 'autonomous', state: 'submitted' });
});

it('child-only content persists and tracks the child without invalidating the parent boundary', () => {
  const f = activityFixture();
  const event: UiEvent = { type: 'item.completed', item: { kind: 'message', id: 'item', role: 'assistant', text: 'child', parentItemId: 'child' } };
  handleRunnerUiEvent(f.context, f.host, f.run.id, f.state, f.sink, event);
  expect(f.log).toEqual(['usage', 'persist-ui', 'children', 'reply-content']);
  expect(f.state.boundary.atTurnBoundary).toBe(f.wire);
  expect(f.state.boundary.nudge).toEqual({ session: f.wire, cause: 'autonomous', state: 'refused' });
});
