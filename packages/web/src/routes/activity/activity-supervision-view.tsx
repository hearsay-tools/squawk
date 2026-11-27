import * as React from 'react'
import type { ActivityProject, ActivityRequest } from '@open-mercato/cezar-api-client/contract/activity'

import { ghostsOf } from './activity-board'
import type { FeedEntry } from './activity-feed'
import { ActivityMarginArcs, marginArcEdges, peerConnectedIds } from './activity-margin-arcs'
import { peerWaits, runIndex, type PeerWait, type RunEntry } from './activity-model'
import { EMPTY_MOTION, waitGhosts, type MotionState } from './activity-motion'
import { newAttentionAnnouncement, partitionActivity, type DecisionRecord } from './activity-queue-model'
import { ActivityQueue } from './activity-queue'
import { ActivityRail } from './activity-rail'
import { ActivityTriageDrawer } from './activity-triage-drawer'
import { ActivityWorkingList } from './activity-working-list'
import type { OnHover } from './use-wait-highlight'

/**
 * Unified supervision decision queue shared by Project Activity (`/p/:projectId/activity`) and
 * Global Activity (`/activity`) (hearsay-tools/squawk#4376):
 *  - Attention queue (`Needs answer`, `Needs review`, `Failed`, `Needs permission`, `Needs you`)
 *    with unwrapped previews, project identity, and right-hand triage drawer.
 *  - Compact live `Working & active` rows with step, tool/wait summary, heartbeat, elapsed time,
 *    and indented worker tree.
 *  - Collapsible left-margin SVG arcs spanning Attention + Working when open peer requests or
 *    peer waits connect visible rows.
 *  - Conditional `Open requests` and `Just now` panels (hidden completely when empty).
 *  - Polite non-shifting announcements when new Attention items arrive.
 */

export interface ActivitySupervisionViewProps {
  /** Readable projects to render in the queue and working list. */
  projects: readonly ActivityProject[]
  now: number
  global: boolean
  grouped: boolean
  projectOrder: readonly string[]
  motion?: MotionState
  feed?: readonly FeedEntry[] | undefined
  still?: boolean
  paused?: boolean
  emptyMessage?: string | undefined
}

function combinedIndex(projects: readonly ActivityProject[]): Map<string, RunEntry> {
  const index = new Map<string, RunEntry>()
  for (const project of projects) {
    for (const [id, entry] of runIndex(project)) index.set(id, entry)
  }
  return index
}

export function ActivitySupervisionView({
  projects,
  now,
  global,
  grouped,
  projectOrder,
  motion = EMPTY_MOTION,
  feed = [],
  still = false,
  paused = false,
  emptyMessage,
}: ActivitySupervisionViewProps) {
  const [stageEl, setStageEl] = React.useState<HTMLDivElement | null>(null)
  const [selectedRef, setSelectedRef] = React.useState<{ projectId: string; runId: string; snapshot: DecisionRecord } | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement | null>(null)
  const [hover, setHover] = React.useState<{ pointer?: string; focus?: string }>({})
  const [announcement, setAnnouncement] = React.useState<string | undefined>(undefined)
  const seenAttentionRef = React.useRef<Set<string> | undefined>(undefined)

  const index = React.useMemo(() => combinedIndex(projects), [projects])
  const indexByProject = React.useMemo(
    () => new Map(projects.map((project) => [project.projectId, runIndex(project)] as const)),
    [projects],
  )
  const requestsByProject = React.useMemo(
    () => new Map(projects.map((project) => [project.projectId, project.requests] as const)),
    [projects],
  )
  const waitsByProject = React.useMemo(
    () => new Map(projects.map((project) => [project.projectId, peerWaits(project.tasks)] as const)),
    [projects],
  )
  const { attention, working } = React.useMemo(() => partitionActivity(projects), [projects])

  // Announce newly arriving Attention items without moving selection or scroll.
  React.useEffect(() => {
    const nextMessage = newAttentionAnnouncement(seenAttentionRef.current, attention)
    seenAttentionRef.current = new Set(attention.map((item) => item.runId))
    if (nextMessage) setAnnouncement(nextMessage)
  }, [attention])

  const openRequests = React.useMemo(() => projects.flatMap((project) => project.requests), [projects])
  const openWaits = React.useMemo(() => projects.flatMap((project) => peerWaits(project.tasks)), [projects])

  const ghosts = React.useMemo(() => {
    const requests: ActivityRequest[] = []
    const folding: ActivityRequest[] = []
    const waits: PeerWait[] = []
    for (const project of projects) {
      const pWaits = peerWaits(project.tasks)
      const g = ghostsOf(project, motion, pWaits)
      requests.push(...g.requests)
      folding.push(...g.folding)
      waits.push(...waitGhosts(project.projectId, pWaits, motion))
    }
    return { requests, folding, waits }
  }, [projects, motion])

  const drawnRequests = React.useMemo(() => [...openRequests, ...ghosts.requests], [openRequests, ghosts.requests])
  const drawnWaits = React.useMemo(() => [...openWaits, ...ghosts.waits], [openWaits, ghosts.waits])

  const visibleProjects = React.useMemo(
    () => new Map([
      ...attention.map((item) => [item.runId, item.projectId] as const),
      ...working.map((item) => [item.runId, item.projectId] as const),
    ]),
    [attention, working],
  )
  const { edges, gutterWidth } = React.useMemo(
    () => marginArcEdges(drawnRequests, drawnWaits, visibleProjects, motion),
    [drawnRequests, drawnWaits, visibleProjects, motion],
  )

  const activeHover = hover.pointer ?? hover.focus
  const linkedIds = React.useMemo(() => {
    if (!activeHover) return new Set<string>()
    const projectId = visibleProjects.get(activeHover)
    if (!projectId) return new Set<string>()
    return peerConnectedIds(activeHover, requestsByProject.get(projectId) ?? [], waitsByProject.get(projectId) ?? [])
  }, [activeHover, requestsByProject, visibleProjects, waitsByProject])

  const onHover: OnHover = React.useCallback((source, runId) => {
    setHover((previous) => {
      if (previous[source] === runId) return previous
      const next = { ...previous }
      if (runId === undefined) delete next[source]
      else next[source] = runId
      return next
    })
  }, [])

  // Keep the open drawer live with the latest record while open, or keep its snapshot while closing.
  const activeDecision = React.useMemo(() => {
    if (!selectedRef) return null
    return attention.find((item) => item.runId === selectedRef.runId && item.projectId === selectedRef.projectId) ?? selectedRef.snapshot
  }, [attention, selectedRef])

  const handleTriage = React.useCallback((record: DecisionRecord, trigger: HTMLButtonElement | null) => {
    triggerRef.current = trigger
    setSelectedRef({ projectId: record.projectId, runId: record.runId, snapshot: record })
  }, [])

  const restoreFocus = React.useCallback(() => {
    const button = triggerRef.current
    if (button && button.isConnected) {
      button.focus({ preventScroll: true })
      return
    }
    // If the resolved item left the queue, focus the next remaining triage trigger without scrolling.
    const nextTrigger = stageEl?.querySelector<HTMLButtonElement>('[data-slot="activity-triage-trigger"]')
    nextTrigger?.focus({ preventScroll: true })
  }, [stageEl])

  const handleClose = React.useCallback(() => setSelectedRef(null), [])
  const handleResolved = React.useCallback(() => setSelectedRef(null), [])

  const layoutKey = `${grouped}:${attention.map((i) => i.runId).join(',')}:${working.map((i) => i.runId).join(',')}:${edges.map((e) => e.id).join(',')}`
  const isEmpty = attention.length === 0 && working.length === 0

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <p data-slot="activity-announcement" role="status" aria-live="polite" className="sr-only">
        {announcement ?? ''}
      </p>
      {isEmpty && emptyMessage ? (
        <p data-slot="activity-empty" className="py-6 text-[13px] text-muted-foreground">
          {emptyMessage}
        </p>
      ) : null}
      {!isEmpty ? (
        <div
          ref={setStageEl}
          data-slot="activity-stage"
          data-has-arcs={gutterWidth > 0 ? 'true' : undefined}
          style={gutterWidth > 0 ? ({ '--activity-arc-gutter': `${gutterWidth}px` } as React.CSSProperties) : undefined}
          className={gutterWidth > 0 ? 'relative flex min-w-0 flex-col gap-6 md:pl-(--activity-arc-gutter)' : 'relative flex min-w-0 flex-col gap-6'}
        >
          <ActivityMarginArcs
            stage={stageEl}
            edges={edges}
            active={activeHover}
            now={now}
            layoutKey={layoutKey}
            motion={motion}
            paused={paused || still}
          />
          <ActivityQueue
            items={attention}
            requestsByProject={requestsByProject}
            waitsByProject={waitsByProject}
            indexByProject={indexByProject}
            now={now}
            global={global}
            grouped={grouped}
            projectOrder={projectOrder}
            selectedRunId={activeDecision?.runId}
            linkedIds={linkedIds}
            motion={motion}
            onHover={onHover}
            onTriage={handleTriage}
          />
          <ActivityWorkingList
            items={working}
            requestsByProject={requestsByProject}
            waitsByProject={waitsByProject}
            indexByProject={indexByProject}
            now={now}
            global={global}
            grouped={grouped}
            projectOrder={projectOrder}
            linkedIds={linkedIds}
            motion={motion}
            onHover={onHover}
          />
        </div>
      ) : null}
      <ActivityRail
        requests={openRequests}
        closing={ghosts.folding}
        index={index}
        now={now}
        feed={feed}
        motion={motion}
      />
      <ActivityTriageDrawer
        record={activeDecision}
        now={now}
        onClose={handleClose}
        onResolved={handleResolved}
        onRestoreFocus={restoreFocus}
      />
    </div>
  )
}
