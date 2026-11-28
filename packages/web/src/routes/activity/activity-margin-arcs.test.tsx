import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NOW, iso, request } from './activity.testkit'
import { peerWaitId, type PeerWait } from './activity-model'
import { EMPTY_MOTION } from './activity-motion'
import { ActivityMarginArcs, layoutMarginArcs, marginArcEdges, peerConnectedIds } from './activity-margin-arcs'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('activity-margin-arcs', () => {
  it('collapses gutter to 0 when no peer edges connect visible rows', () => {
    const visible = new Map([['a', 'p1'], ['b', 'p1']])
    expect(marginArcEdges([], [], visible)).toEqual({ edges: [], gutterWidth: 0 })
    // Family requests do not produce peer margin arcs.
    const family = request({ relationship: 'family', senderRunId: 'a', recipientRunId: 'b' })
    expect(marginArcEdges([family], [], visible)).toEqual({ edges: [], gutterWidth: 0 })
  })

  it('never draws an arc across two different projects', () => {
    const visible = new Map([['g1', 'gamma'], ['a1', 'alpha']])
    const cross = request({ relationship: 'peer', senderRunId: 'g1', recipientRunId: 'a1' })
    expect(marginArcEdges([cross], [], visible)).toEqual({ edges: [], gutterWidth: 0 })
  })

  it('routes shorter spans onto inner lanes and longer spans onto outer lanes', () => {
    const visible = new Map([['a', 'p1'], ['b', 'p1'], ['c', 'p1']])
    const req = request({ relationship: 'peer', senderRunId: 'b', recipientRunId: 'a', createdAt: iso(-60_000) })
    const wait: PeerWait = { id: peerWaitId('c', 'a'), waiterRunId: 'c', peerRunId: 'a', since: iso(-30_000), deadline: iso(60_000) }
    const { edges, gutterWidth } = marginArcEdges([req], [wait], visible)
    expect(edges).toHaveLength(2)
    expect(gutterWidth).toBeGreaterThan(46)

    const anchors = new Map([
      ['a', { x: 80, y: 24 }],
      ['b', { x: 80, y: 200 }],
      ['c', { x: 80, y: 360 }],
    ])
    const laidOut = layoutMarginArcs(edges, anchors)
    expect(laidOut).toHaveLength(2)
    // Shorter span (b -> a) takes the inner lane (larger laneX, closer to cards).
    expect(laidOut[0]!.edge.kind).toBe('request')
    expect(laidOut[1]!.edge.kind).toBe('wait')
    expect(laidOut[0]!.laneX).toBeGreaterThan(laidOut[1]!.laneX)
  })

  it('collects connected ids across both peer requests and peer waits for hover highlighting', () => {
    const req = request({ relationship: 'peer', senderRunId: 'sender', recipientRunId: 'blocker' })
    const wait: PeerWait = { id: peerWaitId('waiter', 'blocker'), waiterRunId: 'waiter', peerRunId: 'blocker', since: iso(-10_000), deadline: iso(60_000) }
    expect(peerConnectedIds('blocker', [req], [wait])).toEqual(new Set(['blocker', 'sender', 'waiter']))
    expect(peerConnectedIds(undefined, [req], [wait])).toEqual(new Set())
  })

  it('keeps the comet layer mounted at zero edges so a later peer request starts the comet loop', () => {
    const raf = vi.fn(() => 1)
    vi.stubGlobal('requestAnimationFrame', raf)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const stage = document.createElement('div')
    stage.innerHTML = '<div data-activity-row="a"></div><div data-activity-row="b"></div>'
    document.body.appendChild(stage)
    const view = render(<ActivityMarginArcs stage={stage} edges={[]} now={NOW} layoutKey="empty" motion={EMPTY_MOTION} />)
    expect(raf).not.toHaveBeenCalled()
    const edge = { kind: 'request' as const, id: 'req-1', from: 'a', to: 'b', createdAt: iso(-1000) }
    const motion = { ...EMPTY_MOTION, comets: { 'req-1': { key: 1, requestId: 'req-1', reverse: false, tone: 'peer' as const } } }
    view.rerender(<ActivityMarginArcs stage={stage} edges={[edge]} now={NOW} layoutKey="one" motion={motion} />)
    expect(raf).toHaveBeenCalled()
    stage.remove()
  })
})
