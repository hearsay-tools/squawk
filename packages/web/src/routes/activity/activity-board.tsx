import * as React from 'react'
import type { ActivityProject, ActivityRequest, ActivityRun } from '@open-mercato/cezar-api-client/contract/activity'

import type { FeedEntry } from './activity-feed'
import { ActivityCard } from './activity-card'
import { ActivityLines } from './activity-lines'
import { nameOf, peerWaits, runIndex, type PeerWait } from './activity-model'
import { EMPTY_MOTION, waitGhosts, type MotionState } from './activity-motion'
import { ActivityRail } from './activity-rail'
import { COLUMN_GAP, COMPACT_COLUMN_GAP, DENSE_AFTER, columnCount, placeCards, samePlacement, type Columns } from './layout'
import type { NowContext } from './now-box'
import { useFlip } from './use-flip'
import { useWaitHighlight } from './use-wait-highlight'

/**
 * The project graph and its rail (spec 2026-11-05-live-activity-view, "Project view"): task cards
 * in stable columns (D9) across the full width, the lines between them, and the details below
 * (open requests, the feed and the legend), with their motion. The column count follows the
 * graph's width and the number of cards; one column is the narrow layout.
 */

/** The graph's width, measured now and again on every resize. */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = React.useState(0)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setWidth(el.clientWidth)
    read()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(read)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return width
}

/** D9: the placement survives snapshot changes; only the ids that came or went move. */
function useStablePlacement(ids: readonly string[], count: number, weight: (id: string) => number): Columns {
  const [placement, setPlacement] = React.useState<Columns | undefined>(undefined)
  const next = placeCards(placement, ids, count, weight)
  // Derived state: React re-renders at once with the stored placement, before painting.
  if (!samePlacement(placement, next)) setPlacement(next)
  return next
}

export interface Ghosts {
  cards: ActivityRun[]
  requests: ActivityRequest[]
  folding: ActivityRequest[]
  waits: PeerWait[]
}

/** What the motion still draws of a project: cards that left, requests that closed and peer waits
 *  that ended, while they collapse or fade. Each is left out once the snapshot has it again. */
export function ghostsOf(project: ActivityProject, motion: MotionState, waits: readonly PeerWait[] = peerWaits(project.tasks)): Ghosts {
  const tasks = new Set(project.tasks.map((task) => task.runId))
  const open = new Set(project.requests.map((request) => request.requestId))
  const closing = Object.values(motion.closing).filter((ghost) => ghost.projectId === project.projectId && !open.has(ghost.request.requestId))
  return {
    cards: Object.values(motion.leaving).filter((ghost) => ghost.projectId === project.projectId && !tasks.has(ghost.task.runId)).map((ghost) => ghost.task),
    requests: closing.map((ghost) => ghost.request),
    waits: waitGhosts(project.projectId, waits, motion),
    // The rail entry folds while the reply comet travels, or while a closure without a reply
    // fades; it leaves no gap while the line still says "Replied".
    folding: closing.filter((ghost) => ghost.phase === 'reply' || !ghost.replied).map((ghost) => ghost.request),
  }
}

export interface BoardProps {
  project: ActivityProject
  now: number
  watchingSince: string
  motion?: MotionState
  feed?: readonly FeedEntry[]
  /** Reduced motion: cards move at once, without FLIP, and no comet flies. */
  still?: boolean
  paused?: boolean
}

export function ActivityBoard({ project, now, watchingSince, motion = EMPTY_MOTION, feed, still = false, paused = false }: BoardProps) {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const width = useWidth(hostRef)
  const index = React.useMemo(() => runIndex(project), [project])
  const waits = React.useMemo(() => peerWaits(project.tasks), [project.tasks])
  const ghosts = React.useMemo(() => ghostsOf(project, motion, waits), [project, motion, waits])
  const drawnRequests = React.useMemo(() => [...project.requests, ...ghosts.requests], [project.requests, ghosts.requests])
  const drawnWaits = React.useMemo(() => [...waits, ...ghosts.waits], [waits, ghosts.waits])
  const highlight = useWaitHighlight(waits)
  const tasks = new Map([...ghosts.cards, ...project.tasks].map((task) => [task.runId, task]))
  const ghostIds = new Set(ghosts.cards.map((task) => task.runId))
  // Never more columns than cards: a column without a card is an empty strip beside narrow cards.
  const fit = columnCount(width)
  const count = Math.min(fit, Math.max(1, tasks.size))
  // A card with workers is taller; the weight keeps the columns near the same height.
  const weight = (id: string) => 1 + 0.35 * (tasks.get(id)?.workers.length ?? 0)
  const columns = useStablePlacement([...tasks.keys()], count, weight)
  // Narrow is about the width, not the count: one card on a wide graph still draws its lines.
  const narrow = fit === 1
  const dense = project.tasks.length > DENSE_AFTER
  const ctx: NowContext = { now, titleOf: (runId) => nameOf(index, runId) }
  const placement = columns.map((column) => column.join(',')).join('|')
  const columnGap = narrow ? 0 : drawnRequests.length + drawnWaits.length > 0 ? COLUMN_GAP : COMPACT_COLUMN_GAP
  const layoutKey = `${project.tasks.length}:${count}:${dense}:${placement}:${drawnRequests.map((request) => request.requestId).join(',')}:${drawnWaits.map((wait) => wait.id).join(',')}`
  useFlip(hostRef, 'data-flip', placement, !still && !paused)

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="min-w-0">
        {project.tasks.length === 0 ? (
          <p data-slot="activity-empty" className="py-6 text-[13px] text-muted-foreground">No active work in this project.</p>
        ) : null}
        <div
          ref={hostRef}
          data-slot="activity-graph"
          data-columns={count}
          data-dense={dense ? 'true' : undefined}
          className="relative grid items-start"
          style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`, columnGap }}
        >
          {columns.map((column, i) => (
            <div key={i} data-slot="activity-column" className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-[30px] max-md:gap-4">
              {column.map((id) => {
                const task = tasks.get(id)
                if (!task) return null
                return (
                  <ActivityCard
                    key={id}
                    task={task}
                    requests={project.requests}
                    waits={waits}
                    index={index}
                    ctx={ctx}
                    dense={dense}
                    narrow={narrow}
                    motion={motion}
                    ghost={ghostIds.has(id)}
                    linked={highlight.linked.has(id)}
                    onHover={highlight.onHover}
                  />
                )
              })}
            </div>
          ))}
          <ActivityLines requests={drawnRequests} waits={drawnWaits} active={highlight.active} index={index} peers={!narrow} layoutKey={layoutKey} now={now} motion={motion} paused={paused || still} />
        </div>
      </div>
      {/* Two card columns share the rail's column gap, so card and panel edges line up. */}
      <ActivityRail columnGap={count === 2 ? columnGap : undefined} requests={project.requests} closing={ghosts.folding} index={index} now={now} watchingSince={watchingSince} feed={feed} motion={motion} />
    </div>
  )
}
