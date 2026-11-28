import * as React from 'react'
import type { ActivityRequest } from '@open-mercato/cezar-api-client/contract/activity'

import { cn } from '@/lib/utils'

import { counter, since } from './activity-format'
import type { PeerWait } from './activity-model'
import { EMPTY_MOTION, type MotionState } from './activity-motion'
import { useComets } from './use-comets'

/**
 * Collapsible left-margin SVG arcs spanning the vertical Attention queue and compact Working
 * list (hearsay-tools/squawk#4376). Keeps live task-to-task visibility (marching peer requests,
 * dotted peer waits, hover highlights, and reply comets) without stretched multi-column cards.
 * Collapses to `0px` when no peer edges connect visible rows, and hides below `md` where rows
 * render inline `PeerLinks`.
 */

export type MarginEdge =
  | { kind: 'request'; id: string; from: string; to: string; createdAt: string; closing?: boolean; replied?: boolean }
  | { kind: 'wait'; id: string; from: string; to: string; since: string; closing?: boolean }

export interface MarginArcGeometry {
  edge: MarginEdge
  path: string
  laneX: number
  labelY: number
  endX: number
  endY: number
}

const LANE_BASE = 36
const LANE_STEP = 22
const MAX_LANES = 4
const CORNER_R = 10

/** Visible peer edges connecting two rows of the same project currently rendered in the stage, plus the gutter width. */
export function marginArcEdges(
  requests: readonly ActivityRequest[],
  waits: readonly PeerWait[],
  visibleProjects: ReadonlyMap<string, string>,
  motion: MotionState = EMPTY_MOTION,
): { edges: MarginEdge[]; gutterWidth: number } {
  const edges: MarginEdge[] = []
  const sameProject = (a: string, b: string) => {
    const pA = visibleProjects.get(a)
    return pA !== undefined && pA === visibleProjects.get(b)
  }
  for (const request of requests) {
    if (request.relationship !== 'peer') continue
    if (!sameProject(request.senderRunId, request.recipientRunId)) continue
    const closing = motion.closing[request.requestId]
    edges.push({
      kind: 'request',
      id: request.requestId,
      from: request.senderRunId,
      to: request.recipientRunId,
      createdAt: request.createdAt,
      ...(closing ? { closing: true, replied: closing.replied } : {}),
    })
  }
  for (const wait of waits) {
    if (!sameProject(wait.peerRunId, wait.waiterRunId)) continue
    edges.push({
      kind: 'wait',
      id: wait.id,
      from: wait.peerRunId,
      to: wait.waiterRunId,
      since: wait.since,
      ...(wait.id in motion.waitsClosing ? { closing: true } : {}),
    })
  }
  if (edges.length === 0) return { edges, gutterWidth: 0 }
  const lanes = Math.min(MAX_LANES, edges.length)
  return { edges, gutterWidth: Math.min(132, 64 + (lanes - 1) * LANE_STEP) }
}

/** Connected run ids for pointer/focus highlight across both peer requests and peer waits. */
export function peerConnectedIds(
  activeRunId: string | undefined,
  requests: readonly ActivityRequest[],
  waits: readonly PeerWait[],
): Set<string> {
  const linked = new Set<string>()
  if (!activeRunId) return linked
  for (const request of requests) {
    if (request.relationship !== 'peer') continue
    if (request.senderRunId === activeRunId || request.recipientRunId === activeRunId) {
      linked.add(request.senderRunId)
      linked.add(request.recipientRunId)
    }
  }
  for (const wait of waits) {
    if (wait.peerRunId === activeRunId || wait.waiterRunId === activeRunId) {
      linked.add(wait.peerRunId)
      linked.add(wait.waiterRunId)
    }
  }
  return linked
}

/** Build nested rounded-elbow SVG paths in the left gutter, shortest vertical span innermost. */
export function layoutMarginArcs(
  edges: readonly MarginEdge[],
  anchors: ReadonlyMap<string, { x: number; y: number }>,
): MarginArcGeometry[] {
  const measured = edges
    .map((edge) => {
      const start = anchors.get(edge.from)
      const end = anchors.get(edge.to)
      if (!start || !end) return undefined
      return { edge, start, end, span: Math.abs(end.y - start.y) }
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    .sort((a, b) => a.span - b.span)

  return measured.map(({ edge, start, end }, index) => {
    const lane = index % MAX_LANES
    const laneX = Math.max(10, Math.min(start.x, end.x) - LANE_BASE - lane * LANE_STEP)
    const dy = end.y - start.y
    const dir = dy >= 0 ? 1 : -1
    const r = Math.min(CORNER_R, Math.abs(dy) / 2, Math.max(2, start.x - laneX - 2))
    const endX = edge.kind === 'request' ? end.x - 2 : end.x - 6
    const path = [
      `M ${start.x} ${start.y}`,
      `L ${laneX + r} ${start.y}`,
      `Q ${laneX} ${start.y} ${laneX} ${start.y + dir * r}`,
      `L ${laneX} ${end.y - dir * r}`,
      `Q ${laneX} ${end.y} ${laneX + r} ${end.y}`,
      `L ${endX} ${end.y}`,
    ].join(' ')
    const labelY = start.y + dy * (0.5 + (index % 2 === 0 ? -0.06 : 0.08))
    return { edge, path, laneX, labelY, endX: end.x - 4, endY: end.y }
  })
}

function measureRowAnchors(stage: HTMLElement): Map<string, { x: number; y: number }> {
  const anchors = new Map<string, { x: number; y: number }>()
  const host = stage.getBoundingClientRect()
  for (const el of stage.querySelectorAll<HTMLElement>('[data-activity-row]')) {
    const id = el.getAttribute('data-activity-row')
    if (!id) continue
    const rect = el.getBoundingClientRect()
    anchors.set(id, { x: rect.left - host.left, y: rect.top - host.top + Math.min(rect.height / 2, 24) })
  }
  return anchors
}

export interface ActivityMarginArcsProps {
  stage: HTMLDivElement | null
  edges: readonly MarginEdge[]
  active?: string | undefined
  now: number
  layoutKey: string
  motion?: MotionState
  paused?: boolean
}

export function ActivityMarginArcs({
  stage,
  edges,
  active,
  now,
  layoutKey,
  motion = EMPTY_MOTION,
  paused = false,
}: ActivityMarginArcsProps) {
  const markerId = React.useId()
  const [arcs, setArcs] = React.useState<MarginArcGeometry[]>([])

  React.useLayoutEffect(() => {
    if (!stage || edges.length === 0) {
      setArcs([])
      return
    }
    const measure = () => setArcs(layoutMarginArcs(edges, measureRowAnchors(stage)))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [stage, edges, layoutKey])

  const drawnRequestIds = React.useMemo(
    () => new Set(arcs.filter((arc) => arc.edge.kind === 'request').map((arc) => arc.edge.id)),
    [arcs],
  )
  const cometsRef = useComets(motion.comets, drawnRequestIds, paused)

  // Keep the SVG comet layer mounted even at 0 edges so `useComets` binds on mount and can
  // animate the first peer request/reply that arrives later without needing a remount.
  return (
    <div
      data-slot="activity-margin-arcs"
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute inset-0 z-[5] hidden overflow-visible',
        edges.length > 0 && 'md:block',
      )}
    >
      <svg className="size-full overflow-visible">
        <defs>
          <marker id={markerId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0 1 L7 4 L0 7 z" className="fill-message-peer-accent" />
          </marker>
        </defs>
        {arcs.map((arc) => {
          const { edge } = arc
          const touched = active !== undefined && (edge.from === active || edge.to === active)
          const dimmed = active !== undefined && !touched
          const strokeClass = edge.kind === 'request'
            ? cn(
                'fill-none stroke-message-peer-accent transition-opacity',
                !edge.closing && 'activity-march',
                edge.closing && 'activity-line-out',
              )
            : cn(
                'fill-none stroke-message-peer-accent transition-opacity',
                !edge.closing && 'activity-drift',
                edge.closing && 'activity-line-out',
              )
          return (
            <g key={`${edge.kind}:${edge.id}`} opacity={dimmed ? 0.22 : touched ? 1 : 0.82}>
              <path
                d={arc.path}
                data-request={edge.kind === 'request' ? edge.id : undefined}
                data-wait={edge.kind === 'wait' ? edge.id : undefined}
                strokeWidth={touched ? 2.4 : 1.8}
                strokeDasharray={edge.kind === 'request' ? (edge.replied ? undefined : '6 4') : '0 7'}
                strokeLinecap={edge.kind === 'wait' ? 'round' : undefined}
                markerEnd={edge.kind === 'request' ? `url(#${markerId})` : undefined}
                className={strokeClass}
              />
              {edge.kind === 'wait' ? (
                <circle
                  cx={arc.endX}
                  cy={arc.endY}
                  r="3.2"
                  strokeWidth="1.7"
                  className="fill-card stroke-message-peer-accent"
                />
              ) : null}
            </g>
          )
        })}
        <g ref={cometsRef} />
      </svg>
      {arcs.map((arc) => {
        const { edge } = arc
        const touched = active !== undefined && (edge.from === active || edge.to === active)
        const dimmed = active !== undefined && !touched
        const age = counter(since(edge.kind === 'request' ? edge.createdAt : edge.since, now))
        return (
          <span
            key={`label:${edge.kind}:${edge.id}`}
            style={{ left: arc.laneX, top: arc.labelY }}
            className={cn(
              'absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-message-peer-accent/60 bg-card px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap text-message-peer-accent tabular-nums shadow-xs transition-opacity',
              edge.kind === 'wait' && 'border-dashed',
              dimmed && 'opacity-25',
            )}
          >
            {edge.kind === 'request' ? `Req · ${age}` : `Wait · ${age}`}
          </span>
        )
      })}
    </div>
  )
}
