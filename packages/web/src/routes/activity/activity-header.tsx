import { ArrowUpRightIcon, BotIcon, FolderKanbanIcon, InfoIcon, MessageSquareIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link as RouterLink } from 'react-router'

import { StatusDot } from '@/components/status-dot'
import type { PageShellHeaderProps } from '@/components/page-shell'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { agoOf, fullTimeOf, since } from './activity-format'
import type { ActivitySummary } from './activity-model'
import type { MotionState } from './activity-motion'
import { Heartbeat } from './now-box-view'

/**
 * The activity view's header and summary chips (spec 2026-11-05-live-activity-view, "Header" and
 * "Summary chips"). The chips are a polite live region; the cards are not. A chip whose count
 * changed bumps.
 */

const SEGMENT = 'inline-flex min-w-0 items-center rounded-md border px-3 py-1 text-[12px] font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring max-md:min-h-11'

/** "<project> / All projects". The project segment always reads as the project's name, on the
 *  project view and the global one alike, so the label never changes under the user. The global
 *  link is outside every project, so it is a plain router link. */
export function ScopeSwitch({ scope, projectId, projectName }: { scope: 'project' | 'all'; projectId: string | null; projectName?: string | undefined }) {
  const segment = (active: boolean) => cn(SEGMENT, active ? 'border-border bg-card text-foreground shadow-xs' : 'border-transparent text-muted-foreground hover:text-foreground')
  return (
    <nav aria-label="Activity scope" data-slot="activity-scope" className="inline-flex max-w-full rounded-lg border border-border bg-muted/60 p-1">
      {projectId === null ? null : (
        <RouterLink to={`/p/${encodeURIComponent(projectId)}/activity`} aria-current={scope === 'project' ? 'page' : undefined} className={segment(scope === 'project')}>
          <span className="max-w-40 truncate" title={projectName ?? projectId}>{projectName ?? projectId}</span>
        </RouterLink>
      )}
      <RouterLink to="/activity" state={{ activityProjectId: projectId }} aria-current={scope === 'all' ? 'page' : undefined} className={segment(scope === 'all')}>
        All projects
      </RouterLink>
    </nav>
  )
}

/** Explicit project grouping toggle shared by project and global Activity (hearsay-tools/squawk#4376). */
export function GroupByProjectToggle({ grouped, onToggle }: { grouped: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      data-slot="activity-group-toggle"
      aria-pressed={grouped}
      onClick={onToggle}
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring max-md:min-h-11 pointer-coarse:min-h-11',
        grouped
          ? 'border-accent-text/60 bg-accent-strong/10 text-foreground'
          : 'border-border bg-card text-muted-foreground hover:text-foreground',
      )}
    >
      <FolderKanbanIcon aria-hidden="true" className="size-3.5" />
      <span>Group by project</span>
    </button>
  )
}

/** Subtle header info popover replacing the bottom Legend disclosure (hearsay-tools/squawk#4376). */
export function ActivityLegendTrigger() {
  const row = 'flex items-center gap-2'
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="activity-legend"
          aria-label="Activity legend"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring max-md:min-h-11 pointer-coarse:min-h-11"
        >
          <InfoIcon aria-hidden="true" className="size-3.5" />
          <span>Legend</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 text-[12px] text-muted-foreground">
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold tracking-[0.05em] text-foreground uppercase">Activity legend</p>
          <div className={row}><StatusDot tone="pending" aria-hidden="true" /><span><strong className="text-foreground">Needs answer</strong> — waiting for your reply</span></div>
          <div className={row}><StatusDot tone="info" aria-hidden="true" /><span><strong className="text-foreground">Needs review</strong> — ready for diff review or PR</span></div>
          <div className={row}><StatusDot tone="danger" aria-hidden="true" /><span><strong className="text-foreground">Failed</strong> — stopped with an error</span></div>
          <div className={row}><StatusDot tone="running" aria-hidden="true" /><span><strong className="text-foreground">Working</strong> — running tools right now</span></div>
          <div className={row}><StatusDot tone="info" shape="ring" aria-hidden="true" /><span><strong className="text-foreground">Ring</strong> — waiting on CI, peer, or timer</span></div>
          <div className={row}><StatusDot tone="running" shape="workers" aria-hidden="true" /><span><strong className="text-foreground">Robot</strong> — waiting on its own workers</span></div>
          <div className={row}><Heartbeat rate={[0, 2, 5, 1, 3, 0, 4, 2]} className="w-[34px]" /><span>Heartbeat: tool calls, last 30 s</span></div>
          <div className={row}>
            <svg aria-hidden="true" viewBox="0 0 34 10" className="h-2.5 w-[34px] shrink-0">
              <path d="M2 5h30" strokeWidth={2} strokeDasharray="6 4" className="stroke-message-peer-accent" />
            </svg>
            <span>Open peer request (task → task)</span>
          </div>
          <div className={row}>
            <svg aria-hidden="true" viewBox="0 0 34 10" className="h-2.5 w-[34px] shrink-0">
              <path d="M2 5h24" strokeWidth={2.2} strokeLinecap="round" strokeDasharray="0 6" className="stroke-message-peer-accent opacity-80" />
              <circle cx="29.5" cy="5" r="3" strokeWidth={1.6} className="fill-card stroke-message-peer-accent" />
            </svg>
            <span>Waiting for a peer to write</span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Shared header action cluster: Legend popover, optional Group by project toggle, and ScopeSwitch. */
export function ActivityHeaderActions({
  scope,
  projectId,
  projectName,
  grouped,
  onToggleGroup,
}: {
  scope: 'project' | 'all'
  projectId: string | null
  projectName?: string | undefined
  grouped?: boolean | undefined
  onToggleGroup?: (() => void) | undefined
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ActivityLegendTrigger />
      {onToggleGroup ? <GroupByProjectToggle grouped={Boolean(grouped)} onToggle={onToggleGroup} /> : null}
      <ScopeSwitch scope={scope} projectId={projectId} projectName={projectName} />
    </div>
  )
}

/** The live indicator: "Live" and the snapshot's age; the full server time is its tooltip. When
 *  the last read or frame failed, it says the view is not updating; the last snapshot stays. */
function LiveClock({ now, updatedAt, stale }: { now: number; updatedAt: string | undefined; stale: boolean }) {
  const known = updatedAt !== undefined && !Number.isNaN(Date.parse(updatedAt))
  return (
    <span data-slot="activity-clock" data-stale={stale ? 'true' : undefined} title={fullTimeOf(now)} className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground tabular-nums">
      <span data-tone="success" className={cn('inline-flex size-[12px] items-center justify-center', !stale && 'activity-pulse')}>
        <StatusDot tone={stale ? 'neutral' : 'success'} aria-hidden="true" />
      </span>
      <b className={cn('font-semibold', stale ? 'text-muted-foreground' : 'text-success')}>{stale ? 'Not updating' : 'Live'}</b>
      {known ? <span>· updated {agoOf(since(updatedAt, now))}</span> : null}
    </span>
  )
}

export function activityHeaderProps({
  name,
  now,
  updatedAt,
  stale = false,
  scopeSwitch,
}: {
  name: string
  now?: number | undefined
  /** When the server built the snapshot on screen. */
  updatedAt?: string | undefined
  stale?: boolean
  scopeSwitch: ReactNode
}): PageShellHeaderProps {
  return {
    title: 'Activity',
    scope: name,
    subtitle: now === undefined ? undefined : <LiveClock now={now} updatedAt={updatedAt} stale={stale} />,
    secondaryActions: scopeSwitch,
  }
}

/** Shared next-step links for Activity empty and sparse states. */
export function ActivityQuickLinks({ primary = false }: { primary?: boolean }) {
  return (
    <>
      <Button variant={primary ? 'primary' : 'outline'} size="sm" asChild className="h-auto min-h-8 py-1.5 max-md:min-h-11">
        <Link to="/new">New task</Link>
      </Button>
      <Button variant="outline" size="sm" asChild className="h-auto min-h-8 py-1.5 max-md:min-h-11">
        <Link to="/">View tasks</Link>
      </Button>
    </>
  )
}

/** A chip's count. A new `bump` key replays the bump. */
function Count({ value, bump }: { value: number; bump: number | undefined }) {
  return (
    <strong key={bump ?? 'still'} data-bump={bump === undefined ? undefined : 'true'} className={cn('font-semibold text-foreground tabular-nums', bump !== undefined && 'activity-bump')}>
      {value}
    </strong>
  )
}

function Chip({ icon, count, label, bump }: { icon: ReactNode; count: number; label: string; bump: number | undefined }) {
  return (
    <li data-slot="activity-chip" data-chip={label} className="inline-flex items-center gap-[7px] rounded-full border border-card-edge bg-card px-[11px] py-[5px] text-xs text-muted-foreground shadow-card">
      {icon}
      <Count value={count} bump={bump} /> {label}
    </li>
  )
}

export function SummaryChips({ summary, tasksTo, bumps = {} }: { summary: ActivitySummary; tasksTo: string; bumps?: MotionState['bumps'] }) {
  const bump = (chip: keyof ActivitySummary) => bumps[chip]?.key
  return (
    <ul data-slot="activity-summary" aria-live="polite" aria-label="Summary" className="flex flex-wrap gap-2">
      <Chip icon={<StatusDot tone="pending" aria-hidden="true" />} count={summary.needsYou} label="Needs you" bump={bump('needsYou')} />
      <Chip icon={<StatusDot tone="running" aria-hidden="true" />} count={summary.working} label="Working" bump={bump('working')} />
      <Chip icon={<StatusDot tone="running" shape="ring" aria-hidden="true" />} count={summary.waiting} label="Waiting" bump={bump('waiting')} />
      <Chip icon={<StatusDot tone="neutral" shape="ring" aria-hidden="true" />} count={summary.queued} label="Queued" bump={bump('queued')} />
      <Chip icon={<BotIcon aria-hidden="true" className="size-3.5" />} count={summary.activeWorkers} label="Active workers" bump={bump('activeWorkers')} />
      <Chip icon={<MessageSquareIcon aria-hidden="true" className="size-3.5 text-message-peer-accent" />} count={summary.openRequests} label="Open requests" bump={bump('openRequests')} />
      <li data-slot="activity-chip" data-chip="Needs review">
        {/* The one chip that leads somewhere: review work has no card here, so it opens the task
            list. The arrow and the hover border say it is a link, not a count. */}
        <Link to={tasksTo} className="inline-flex items-center gap-[7px] rounded-full border border-card-edge bg-card px-[11px] py-[5px] text-xs text-muted-foreground shadow-card transition-colors hover:border-accent-text/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring max-md:min-h-11">
          <StatusDot tone="info" aria-hidden="true" />
          <Count value={summary.inReview} bump={bump('inReview')} /> Needs review
          <ArrowUpRightIcon aria-hidden="true" className="size-3 text-soft-foreground" />
        </Link>
      </li>
    </ul>
  )
}
