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

function collectProjectGhosts(
  projects: readonly ActivityProject[],
  motion: MotionState,
): { requests: ActivityRequest[]; folding: ActivityRequest[]; waits: PeerWait[] } {
  const requests: ActivityRequest[] = []
  const folding: ActivityRequest[] = []
  const waits: PeerWait[] = []
  for (const project of projects) {
    const projectGhosts = ghostsOf(project, motion)
    requests.push(...projectGhosts.requests)
    folding.push(...projectGhosts.folding)
    waits.push(...waitGhosts(project.projectId, peerWaits(project.tasks), motion))
  }
  return { requests, folding, waits }
}

function restoreTriageFocus(
  trigger: HTMLButtonElement | null,
  stage: HTMLDivElement | null,
  root: HTMLDivElement | null,
): void {
  if (trigger && trigger.isConnected) {
    trigger.focus({ preventScroll: true })
    return
  }
  const nextTrigger = stage?.querySelector<HTMLButtonElement>('[data-slot="activity-triage-trigger"]')
  ;(nextTrigger ?? root)?.focus({ preventScroll: true })
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
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const [stageEl, setStageEl] = React.useState<HTMLDivElement | null>(null)
  const selectionSeqRef = React.useRef(0)
  const [selectedRef, setSelectedRef] = React.useState<{ token: number; projectId: string; runId: string; snapshot: DecisionRecord } | null>(null)
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

  const ghosts = React.useMemo(() => collectProjectGhosts(projects, motion), [projects, motion])

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
    const projectId = activeHover ? visibleProjects.get(activeHover) : undefined
    return projectId && activeHover
      ? peerConnectedIds(activeHover, requestsByProject.get(projectId) ?? [], waitsByProject.get(projectId) ?? [])
      : new Set<string>()
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

  // Track the live Attention item while open, and flag if it leaves Attention externally so the
  // drawer never keeps stale interactive controls mounted for a resolved or cancelled task.
  const liveDecision = React.useMemo(() => {
    if (!selectedRef) return null
    return attention.find((item) => item.runId === selectedRef.runId && item.projectId === selectedRef.projectId) ?? null
  }, [attention, selectedRef])
  const activeDecision = liveDecision ?? selectedRef?.snapshot ?? null
  const drawerResolvedExternally = selectedRef !== null && liveDecision === null

  const handleTriage = React.useCallback((record: DecisionRecord, trigger: HTMLButtonElement | null) => {
    triggerRef.current = trigger
    setSelectedRef({ token: ++selectionSeqRef.current, projectId: record.projectId, runId: record.runId, snapshot: record })
  }, [])

  const restoreFocus = React.useCallback(
    () => restoreTriageFocus(triggerRef.current, stageEl, rootRef.current),
    [stageEl],
  )

  const handleClose = React.useCallback(() => setSelectedRef(null), [])
  const handleResolved = React.useCallback((_runId: string, token?: number) => {
    setSelectedRef((previous) => (previous && (token === undefined || previous.token === token) ? null : previous))
  }, [])

  const layoutKey = `${grouped}:${attention.map((i) => i.runId).join(',')}:${working.map((i) => i.runId).join(',')}:${edges.map((e) => e.id).join(',')}`
  const isEmpty = attention.length === 0 && working.length === 0

  return (
    <div ref={rootRef} tabIndex={-1} className="flex min-w-0 flex-col gap-5 outline-none">
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
        selectionToken={selectedRef?.token}
        resolved={drawerResolvedExternally}
        now={now}
        onClose={handleClose}
        onResolved={handleResolved}
        onRestoreFocus={restoreFocus}
      />
    </div>
  )
}
