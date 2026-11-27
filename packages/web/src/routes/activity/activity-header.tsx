import { ArrowUpRightIcon, BotIcon, MessageSquareIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link as RouterLink } from 'react-router'

import { StatusDot } from '@/components/status-dot'
import type { PageShellHeaderProps } from '@/components/page-shell'
import { Button } from '@/components/ui/button'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { agoOf, fullTimeOf, since } from './activity-format'
import type { ActivitySummary } from './activity-model'
import type { MotionState } from './activity-motion'

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
    <nav aria-label="Activity scope" data-slot="activity-scope" className="ml-auto inline-flex max-w-full rounded-lg border border-border bg-muted/60 p-1">
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
      <Button variant={primary ? 'primary' : 'outline'} size="sm" asChild className="max-md:min-h-11">
        <Link to="/new">New task</Link>
      </Button>
      <Button variant="outline" size="sm" asChild className="max-md:min-h-11">
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
    <li data-slot="activity-chip" data-chip={label} className="inline-flex items-center gap-[7px] rounded-full border border-border bg-card px-[11px] py-[5px] text-[12px] text-muted-foreground">
      {icon}
      <Count value={count} bump={bump} /> {label}
    </li>
  )
}

export function SummaryChips({ summary, tasksTo, bumps = {} }: { summary: ActivitySummary; tasksTo: string; bumps?: MotionState['bumps'] }) {
  const bump = (chip: keyof ActivitySummary) => bumps[chip]?.key
  return (
    <ul data-slot="activity-summary" aria-live="polite" aria-label="Summary" className="flex flex-wrap gap-2">
      <Chip icon={<StatusDot tone="pending" aria-hidden="true" />} count={summary.needsYou} label="needs you" bump={bump('needsYou')} />
      <Chip icon={<StatusDot tone="running" aria-hidden="true" />} count={summary.working} label="working" bump={bump('working')} />
      <Chip icon={<StatusDot tone="running" shape="ring" aria-hidden="true" />} count={summary.waiting} label="waiting" bump={bump('waiting')} />
      <Chip icon={<StatusDot tone="neutral" shape="ring" aria-hidden="true" />} count={summary.queued} label="queued" bump={bump('queued')} />
      <Chip icon={<BotIcon aria-hidden="true" className="size-3.5" />} count={summary.activeWorkers} label="active workers" bump={bump('activeWorkers')} />
      <Chip icon={<MessageSquareIcon aria-hidden="true" className="size-3.5 text-message-peer-accent" />} count={summary.openRequests} label="open requests" bump={bump('openRequests')} />
      <li data-slot="activity-chip" data-chip="in review">
        {/* The one chip that leads somewhere: review work has no card here, so it opens the task
            list. The arrow and the hover border say it is a link, not a count. */}
        <Link to={tasksTo} className="inline-flex items-center gap-[7px] rounded-full border border-border bg-card px-[11px] py-[5px] text-[12px] text-muted-foreground transition-colors hover:border-accent-text/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring max-md:min-h-11">
          <StatusDot tone="info" aria-hidden="true" />
          <Count value={summary.inReview} bump={bump('inReview')} /> in review
          <ArrowUpRightIcon aria-hidden="true" className="size-3 text-soft-foreground" />
        </Link>
      </li>
    </ul>
  )
}
