import { RUN_STATUS, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { describe, expect, it } from 'vitest';

import { branchFor } from '../git-worktree.ts';
import { automationRunsOf, conversationMembersOf, encodeRunRow, isLiveRecord, isLiveStatus } from './run-row.ts';
import type { RunRecord } from './store.ts';

const ID = '0123abcd-0000-4000-8000-000000000000';

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: ID, title: 't', workflow: 'quick-task', task: 'do it', status: RUN_STATUS.done, createdAt: '2026-10-05T00:00:00.000Z',
    tokensUsed: 0, archived: false, steps: [], ...overrides,
  } as RunRecord;
}

const worker = (extra: Record<string, unknown> = {}) => ({
  role: 'worker', parentRunId: 'parent-1',
  workspace: { ownerRunId: ID, resourceId: 'r', kind: 'owned-isolated', path: `/repo/.ai/cezar/worktrees/${ID}`, branch: 'cez/0123abcd', baselineSha: 'a'.repeat(40) },
  ...extra,
}) as unknown as RunRecord['delegation'];

describe('isLiveStatus', () => {
  it('is true only for queued, running and waiting', () => {
    expect(isLiveStatus('queued')).toBe(true);
    expect(isLiveStatus('running')).toBe(true);
    expect(isLiveStatus('waiting')).toBe(true);
    expect(isLiveStatus('done')).toBe(false);
    expect(isLiveStatus('review')).toBe(false);
    expect(isLiveStatus('failed')).toBe(false);
    expect(isLiveStatus('cancelled')).toBe(false);
  });
});

describe('isLiveRecord', () => {
  it('is false for a finished run with nothing pending', () => {
    for (const status of ['review', 'done', 'failed', 'cancelled'] as const) expect(isLiveRecord(record({ status }))).toBe(false);
  });

  // One case per clause: drop any clause from the predicate and its case goes false.
  it.each([
    ['queued', { status: RUN_STATUS.queued }],
    ['running', { status: RUN_STATUS.running }],
    ['waiting', { status: RUN_STATUS.waiting }],
    // A wait counts until it is delivered or cancelled (unified waits: `lastWaits` holds those).
    ['an open wait', { waits: [{ id: 'w', phase: WAIT_PHASE.open }] }],
    ['a resolved wait not yet delivered', { waits: [{ id: 'w', phase: WAIT_PHASE.resolved }] }],
    ['a pending usage-limit resume', { status: RUN_STATUS.failed, autoResumeAt: '2026-10-06T00:00:00.000Z' }],
    ['a worker whose destroy is still owed', { delegation: worker({ destroy: { phase: 'requested' } }) }],
    ['a root whose Finish has not settled', { status: RUN_STATUS.cancelled, delegation: { role: 'root', finishRequestedAt: '2026-10-05T00:00:00.000Z' } }],
    ['an accepted Stop not yet settled', { stopping: { requestedAt: '2026-10-05T00:00:00.000Z' } }],
  ])('is true for %s', (_name, overrides) => {
    expect(isLiveRecord(record(overrides as Partial<RunRecord>))).toBe(true);
  });

  it('lets a run go once its waits are delivered or cancelled', () => {
    expect(isLiveRecord(record({ lastWaits: [{ id: 'w', phase: WAIT_PHASE.delivered }, { id: 'x', phase: WAIT_PHASE.cancelled }] } as unknown as Partial<RunRecord>))).toBe(false);
  });

  it('lets a worker go once its destroy completed', () => {
    expect(isLiveRecord(record({ delegation: worker({ destroy: { phase: 'complete' } }) }))).toBe(false);
  });

  // Every worker wait is a list entry, covered by the open-wait case above: store schema 7 reads the
  // old engine's `delegation.wait` into the list on open (hearsay-tools/cezarion#1301).
  it('does not read the old engine\'s delegation.wait', () => {
    expect(isLiveRecord(record({ delegation: { role: 'root', wait: { id: 'wait' } } } as unknown as Partial<RunRecord>))).toBe(false);
    expect(isLiveRecord(record({ delegation: worker({ wait: { id: 'wait' } }) }))).toBe(false);
  });

  it('does not read a wait off a quarantined delegation', () => {
    expect(isLiveRecord(record({ delegation: { role: 'invalid', wait: { id: 'x' } } as unknown as RunRecord['delegation'] }))).toBe(false);
  });
});

describe('conversationMembersOf', () => {
  const message = (senderRunId: string, recipientRunId: string) => ({ senderRunId, recipientRunId });
  const root = (conversation?: unknown) => ({ role: 'root', permissions: [], receipts: [], ...(conversation ? { conversation } : {}) }) as unknown as RunRecord['delegation'];

  it("lists the marker and each sender and recipient once for a root's conversation", () => {
    const messages = [message('a', 'b'), message('b', 'a'), message('a', 'c')];
    expect(conversationMembersOf(record({ delegation: root({ messages, outcomes: [] }) }))).toEqual(['', 'a', 'b', 'c']);
    expect(conversationMembersOf(record({ delegation: root({ messages: [], outcomes: [] }) }))).toEqual(['']);
    expect(encodeRunRow(record({ delegation: root({ messages, outcomes: [] }) })).conversationMembers).toEqual(['', 'a', 'b', 'c']);
  });

  it('has none for a root without a conversation, a worker, or a run without delegation', () => {
    expect(conversationMembersOf(record({ delegation: root() }))).toBeNull();
    expect(conversationMembersOf(record({ delegation: worker() }))).toBeNull();
    expect(conversationMembersOf(record())).toBeNull();
  });
});

describe('automationRunsOf', () => {
  it('lists the launching and the triggering automation with their receipts', () => {
    const automation = { automationId: 'daily', receiptId: 'r1' } as unknown as RunRecord['automation'];
    const automationTrigger = { automationId: 'poll', receiptId: 'r2' } as unknown as RunRecord['automationTrigger'];
    expect(automationRunsOf(record({ automation }))).toEqual([['daily', 'r1']]);
    expect(automationRunsOf(record({ automationTrigger }))).toEqual([['poll', 'r2']]);
    expect(automationRunsOf(record({ automation, automationTrigger }))).toEqual([['daily', 'r1'], ['poll', 'r2']]);
    expect(encodeRunRow(record({ automation })).automationRuns).toEqual([['daily', 'r1']]);
    expect(automationRunsOf(record())).toBeNull();
  });
});

describe('encodeRunRow', () => {
  it('stores the live predicate as the live column', () => {
    expect(encodeRunRow(record()).live).toBe(false);
    expect(encodeRunRow(record({ status: RUN_STATUS.running })).live).toBe(true);
    expect(encodeRunRow(record({ waits: [{ id: 'w', phase: WAIT_PHASE.open }] as unknown as RunRecord['waits'] })).live).toBe(true);
  });

  it('copies the query columns off the record', () => {
    const row = encodeRunRow(record({
      clientRequestId: 'req', groupId: 'g', worktreePath: '/w/t', branch: 'cez/t', baseBranch: 'main', finishedAt: '2026-10-05T01:00:00.000Z',
    }));
    expect(row).toMatchObject({
      clientRequestId: 'req', groupId: 'g', worktreePath: '/w/t', branch: 'cez/t', baseBranch: 'main',
      finishedAt: '2026-10-05T01:00:00.000Z', parentRunId: null,
    });
    expect(encodeRunRow(record())).toMatchObject({
      clientRequestId: null, groupId: null, worktreePath: null, branch: null, baseBranch: null, finishedAt: null,
    });
  });

  it('keeps a reclaimed worktree out of the worktree column', () => {
    expect(encodeRunRow(record({ worktreePath: '/w/t', worktreeReclaimedAt: '2026-10-05T00:00:00.000Z' })).worktreePath).toBeNull();
  });

  it("keeps a worker's worktree in the worktree column until its destroy completes", () => {
    for (const phase of ['requested', 'terminating', 'cleaning', 'incomplete']) {
      expect(encodeRunRow(record({ worktreePath: '/w/t', delegation: worker({ destroy: { phase } }) })).worktreePath, phase).toBe('/w/t');
    }
    expect(encodeRunRow(record({ worktreePath: '/w/t', delegation: worker({ destroy: { phase: 'complete' } }) })).worktreePath).toBeNull();
  });

  it("names the branch a run owns: its own, an owned worker's planned one, else its worktree's task branch", () => {
    expect(encodeRunRow(record({ branch: 'feature/x', worktreePath: '/w/t' })).branch).toBe('feature/x');
    expect(encodeRunRow(record({ worktreePath: '/w/t' })).branch).toBe('cez/0123abcd');
    expect(encodeRunRow(record({ delegation: worker() })).branch).toBe('cez/0123abcd');
    expect(encodeRunRow(record({ worktree: false })).branch).toBeNull();
  });

  it("gives a worker in its host's directory no branch and no worktree column (hearsay-tools/squawk#3819)", () => {
    const shared = { role: 'worker', parentRunId: 'parent-1',
      workspace: { ownerRunId: ID, resourceId: 'r', kind: 'shared', path: '/repo/.ai/cezar/worktrees/host', hostRunId: 'parent-1', baselineSha: 'a'.repeat(40) } } as unknown as RunRecord['delegation'];
    expect(encodeRunRow(record({ delegation: shared, baseBranch: 'a'.repeat(40) }))).toMatchObject({ branch: null, worktreePath: null, parentRunId: 'parent-1' });
  });

  it("spells a worktree's task branch exactly as branchFor does, which it cannot import", () => {
    for (const id of [ID, 'short', 'ffffffff-ffff-4fff-8fff-ffffffffffff']) {
      expect(encodeRunRow(record({ id, worktreePath: '/w/t' })).branch).toBe(branchFor(id));
    }
  });

  it("files a worker under its parent", () => {
    expect(encodeRunRow(record({ delegation: worker() })).parentRunId).toBe('parent-1');
    expect(encodeRunRow(record({ delegation: { role: 'root' } as unknown as RunRecord['delegation'] })).parentRunId).toBeNull();
  });
});
