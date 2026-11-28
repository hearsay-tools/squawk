import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ACTIVITY_WAIT_KIND, RUN_STATUS, iso, run, worker } from './activity.testkit'
import { RunShape, shapeOf } from './activity-tone'

afterEach(cleanup)

describe('status shape labels', () => {
  it('names a worker that waits on its parent and a root that waits on peers', () => {
    const asking = worker({ status: RUN_STATUS.waiting, rung: 'waiting-on-workers', wait: { kind: ACTIVITY_WAIT_KIND.workers, since: iso(-1_000), detail: { owed: 1, total: 1, settled: 0, replies: true, recipientRunIds: ['parent'] } } })
    expect(shapeOf(asking, 'worker').label).toBe('Waiting for parent reply')
    // hearsay-tools/squawk#3819: a worker parked on Squawk's completion wait on the worker it started.
    const supervising = worker({ status: RUN_STATUS.waiting, rung: 'waiting-on-workers', wait: { kind: ACTIVITY_WAIT_KIND.workers, since: iso(-1_000), detail: { owed: 1, total: 1, settled: 0, recipientRunIds: [] } } })
    expect(shapeOf(supervising, 'worker').label).toBe('Waiting for 1 worker')
    const peers = run({ status: RUN_STATUS.waiting, rung: 'waiting-on-workers', wait: { kind: ACTIVITY_WAIT_KIND.peers, since: iso(-1_000), deadline: iso(60_000), detail: { peerRunIds: ['a', 'b'] } } })
    expect(shapeOf(peers, 'root').label).toBe('Waiting for 2 tasks')
    const replies = run({ status: RUN_STATUS.waiting, rung: 'waiting-on-workers', wait: { kind: ACTIVITY_WAIT_KIND.workers, since: iso(-1_000), detail: { owed: 1, total: 1, settled: 0, replies: true, recipientRunIds: ['b'] } } })
    expect(shapeOf(replies, 'root').label).toBe('Waiting for replies')
    const owed = run({ status: RUN_STATUS.waiting, rung: 'waiting-on-workers', wait: { kind: ACTIVITY_WAIT_KIND.workers, since: iso(-1_000), detail: { owed: 2, total: 3, settled: 1, recipientRunIds: [] } } })
    expect(shapeOf(owed, 'root').label).toBe('Waiting for 2 workers')
    const subagents = run({ status: RUN_STATUS.waiting, rung: 'waiting-on-subagents', wait: { kind: ACTIVITY_WAIT_KIND.subagents, since: iso(-1_000), deadline: iso(60_000), detail: { running: 1 } } })
    expect(shapeOf(subagents, 'root').label).toBe('Waiting for 1 subagent')
  })

  it('gives the dot that label as its accessible name', () => {
    const asking = worker({ runId: 'w', status: RUN_STATUS.waiting, rung: 'waiting-on-workers' })
    const { getByRole } = render(<RunShape run={asking} role="worker" />)
    expect(getByRole('img').getAttribute('aria-label')).toBe('Waiting for parent reply')
  })
})
