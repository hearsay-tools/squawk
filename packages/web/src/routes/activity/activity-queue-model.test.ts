import { describe, expect, it } from 'vitest'

import { ACTIVITY_WAIT_KIND, RUN_STATUS, iso, project, request, run } from './activity.testkit'
import { peerWaits, runIndex } from './activity-model'
import { groupByProject, isAttentionTask, newAttentionAnnouncement, partitionActivity, peerUnblocksText } from './activity-queue-model'

describe('activity-queue-model', () => {
  it('partitions human-blocking tasks into Attention and live non-blocking tasks into Working', () => {
    const failed = run({ runId: 'f1', title: 'Sync docs', status: RUN_STATUS.failed, rung: 'failed', error: 'Schema mismatch', finishedAt: iso(-30_000) })
    const review = run({ runId: 'r1', title: 'Fix padding', status: RUN_STATUS.review, rung: 'needs-review', finishedAt: iso(-60_000) })
    const askOlder = run({
      runId: 'a1', title: 'API contract', status: RUN_STATUS.waiting, rung: 'needs-you',
      wait: { kind: ACTIVITY_WAIT_KIND.human, since: iso(-120_000), detail: { reason: 'question', question: 'Keep inReview field?' } },
    })
    const askNewer = run({
      runId: 'a2', title: 'Webhook status', status: RUN_STATUS.waiting, rung: 'needs-you',
      wait: { kind: ACTIVITY_WAIT_KIND.human, since: iso(-20_000), detail: { reason: 'question', question: 'Return 200 or 409?' } },
    })
    const perm = run({ runId: 'p1', title: 'Run migration', status: RUN_STATUS.waiting, rung: 'needs-permission', startedAt: iso(-10_000) })
    const queued = run({ runId: 'q1', title: 'Queued job', status: RUN_STATUS.queued, rung: 'queued' })
    const waitingCi = run({
      runId: 'ci1', title: 'Harden SSE', status: RUN_STATUS.waiting, rung: 'waiting-for-ci',
      wait: { kind: ACTIVITY_WAIT_KIND.pr, since: iso(-40_000), deadline: iso(600_000), detail: { number: 42, target: 'checks' } },
    })
    const working = run({ runId: 'w1', title: 'Implement queue', status: RUN_STATUS.running, rung: 'running' })

    const pAlpha = project({ projectId: 'alpha', name: 'alpha', tasks: [queued, failed, askNewer, working] })
    const pBeta = project({ projectId: 'beta', name: 'beta', tasks: [waitingCi, review, askOlder, perm] })

    const { attention, working: workRows } = partitionActivity([pAlpha, pBeta])

    expect(attention.map((item) => [item.runId, item.kind, item.projectName, item.actionLabel])).toEqual([
      ['p1', 'permission', 'beta', 'Open task'],
      ['a1', 'answer', 'beta', 'Answer'],
      ['a2', 'answer', 'alpha', 'Answer'],
      ['r1', 'review', 'beta', 'Review'],
      ['f1', 'failed', 'alpha', 'Inspect'],
    ])
    expect(attention[1]!.blockingReason).toBe('Keep inReview field?')
    expect(attention[4]!.blockingReason).toBe('Schema mismatch')
    expect(workRows.map((item) => [item.runId, item.tier, item.projectName])).toEqual([
      ['w1', 'running', 'alpha'],
      ['ci1', 'waiting', 'beta'],
      ['q1', 'queued', 'alpha'],
    ])
  })

  it('classifies review and failed roots as attention even when they still have live workers', () => {
    const rev = run({ runId: 'r1', status: RUN_STATUS.review, rung: 'needs-review' })
    const fail = run({ runId: 'f1', status: RUN_STATUS.failed, rung: 'failed' })
    const done = run({ runId: 'd1', status: RUN_STATUS.done, rung: 'done' })
    expect(isAttentionTask(rev)).toBe(true)
    expect(isAttentionTask(fail)).toBe(true)
    expect(isAttentionTask(done)).toBe(false)
  })

  it('groups records by project in rail order', () => {
    const pAlpha = project({ projectId: 'alpha', name: 'alpha', tasks: [run({ runId: 'a1', status: RUN_STATUS.review, rung: 'needs-review' })] })
    const pBeta = project({ projectId: 'beta', name: 'beta', tasks: [run({ runId: 'b1', status: RUN_STATUS.failed, rung: 'failed' })] })
    const { attention } = partitionActivity([pAlpha, pBeta])
    const grouped = groupByProject(attention, ['beta', 'alpha'])
    expect(grouped.map((g) => [g.projectId, g.items.map((i) => i.runId)])).toEqual([
      ['beta', ['b1']],
      ['alpha', ['a1']],
    ])
  })

  it('summarizes peer tasks unblocked by answering an Attention item', () => {
    const blocker = run({ runId: 'r1', title: 'API contract', status: RUN_STATUS.waiting, rung: 'needs-you' })
    const sender = run({ runId: 'r2', title: 'Schema migration', status: RUN_STATUS.waiting, rung: 'waiting-on-workers' })
    const waiter = run({
      runId: 'r3', title: 'Schema rollout', status: RUN_STATUS.waiting, rung: 'waiting-on-workers',
      wait: { kind: ACTIVITY_WAIT_KIND.peers, since: iso(-10_000), deadline: iso(60_000), detail: { peerRunIds: ['r1'] } },
    })
    const proj = project({ tasks: [blocker, sender, waiter], requests: [request({ senderRunId: 'r2', recipientRunId: 'r1' })] })
    expect(peerUnblocksText('r1', proj.requests, peerWaits(proj.tasks), runIndex(proj))).toBe('Unblocks Schema migration + Schema rollout')
  })

  it('announces newly arriving Attention items only after mount', () => {
    const item = partitionActivity([project({ tasks: [run({ runId: 'a1', title: 'API contract', status: RUN_STATUS.review, rung: 'needs-review' })] })]).attention
    expect(newAttentionAnnouncement(undefined, item)).toBeUndefined()
    expect(newAttentionAnnouncement(new Set(['a1']), item)).toBeUndefined()
    expect(newAttentionAnnouncement(new Set(), item)).toBe('New item needs your decision: API contract')
  })
})
