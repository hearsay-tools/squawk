import type { ActivityRequest } from '@open-mercato/cezar-api-client/contract/activity'
import { Link as RouterLink } from 'react-router'

import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { ActivityWorkers, hoverHandlers, LineText } from './activity-card'
import { fullTimeOf, since, span } from './activity-format'
import { lineTexts, type PeerWait, type RunEntry } from './activity-model'
import { EMPTY_MOTION, passedChecks, type MotionState } from './activity-motion'
import {
  ActivityProjectGroups,
  activityTaskHref,
  EMPTY_INDEX,
  EMPTY_REQUESTS,
  EMPTY_WAITS,
  PEER_LINK,
  type ActivityListSharedProps,
} from './activity-queue'
import type { WorkingRecord } from './activity-queue-model'
import { RunShape, TONE_INK } from './activity-tone'
import { rootNow, type NowBox, type NowContext } from './now-box'
import { CheckSegments, Heartbeat } from './now-box-view'
import { PeerLinks } from './peer-links'
import type { OnHover } from './use-wait-highlight'

const COMPACT_CHECK_LIMIT = 12
const BUCKET_SEVERITY = { fail: 4, pending: 3, pass: 2, skipping: 1, cancel: 0 } as const

function compactCheckOverflow(
  checks: NonNullable<NowBox['checks']>,
  existing: NowBox['overflow'],
): NowBox['overflow'] {
  const omitted = checks.slice(COMPACT_CHECK_LIMIT)
  if (omitted.length === 0) return existing
  let count = omitted.length + (existing?.count ?? 0)
  let bucket = existing?.bucket ?? omitted[0]!.bucket
  for (const check of omitted) {
    if (BUCKET_SEVERITY[check.bucket] > BUCKET_SEVERITY[bucket]) bucket = check.bucket
  }
  return { count, bucket }
}

/**
 * Second-tier compact live rows for Live Activity (hearsay-tools/squawk#4376): replaces
 * stretched sparse cards with crisp single-row summaries showing current step, active tool or
 * wait state, heartbeat sparkline, elapsed time, and an indented worker tree.
 */

function WorkingRow({
  record,
  requests,
  waits,
  index,
  ctx,
  global,
  linked,
  motion,
  onHover,
}: {
  record: WorkingRecord
  requests: readonly ActivityRequest[]
  waits: readonly PeerWait[]
  index: ReadonlyMap<string, RunEntry>
  ctx: NowContext
  global: boolean
  linked: boolean
  motion: MotionState
  onHover?: OnHover | undefined
}) {
  const { task } = record
  const box = rootNow(task, ctx)
  const href = activityTaskHref(record.projectId, record.runId, global)
  const elapsedAnchor = task.startedAt ?? box.since ?? task.createdAt
  const slideKey = motion.slides[task.runId]?.key
  const passed = passedChecks(motion, task.runId)

  return (
    <article
      data-activity-row={record.runId}
      data-activity-card={record.runId}
      data-slot="activity-working-row"
      data-rung={task.rung}
      data-linked={linked ? 'true' : undefined}
      {...hoverHandlers(record.runId, onHover)}
      className={cn(
        'relative flex min-w-0 flex-col gap-1.5 px-3.5 py-2.5 transition-colors first:rounded-t-xl last:rounded-b-xl',
        linked && 'bg-message-peer-bg outline-2 outline-offset-1 outline-message-peer-accent',
        record.runId in motion.entering && 'activity-card-enter',
      )}
    >
      <div className="grid min-w-0 grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1 md:grid-cols-[14px_minmax(0,1.25fr)_minmax(0,1.45fr)_auto_auto]">
        <RunShape run={task} role="root" />
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="min-w-0 truncate text-[13px] font-semibold text-foreground">
            {global ? (
              <RouterLink to={href} className="hover:underline focus-visible:outline-2 focus-visible:outline-ring max-md:inline-flex max-md:min-h-11 max-md:items-center">
                {task.title}
              </RouterLink>
            ) : (
              <Link to={href} className="hover:underline focus-visible:outline-2 focus-visible:outline-ring max-md:inline-flex max-md:min-h-11 max-md:items-center">
                {task.title}
              </Link>
            )}
          </h3>
          <span
            data-slot="activity-project-badge"
            className="inline-flex shrink-0 items-center rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
          >
            {record.projectName}
          </span>
          {task.currentStepId ? (
            <span data-slot="activity-step" className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
              step {task.currentStepId}
            </span>
          ) : null}
        </div>
        <div className="col-span-2 col-start-2 flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground md:col-span-1 md:col-start-3">
          <span data-slot="activity-verb" className={cn('shrink-0 font-semibold', TONE_INK[box.tone])}>
            {box.verb}
          </span>
          <span
            key={slideKey ?? 'still'}
            data-slot="activity-main"
            className={cn(
              'min-w-0 truncate text-foreground',
              box.mono && 'font-mono text-[11.5px]',
              slideKey !== undefined && 'activity-slide',
            )}
          >
            {box.main}
          </span>
          {box.checks && box.checks.length > 0 ? (
            <CheckSegments
              checks={box.checks.slice(0, COMPACT_CHECK_LIMIT)}
              overflow={compactCheckOverflow(box.checks, box.overflow)}
              passed={passed}
              className="hidden w-20 shrink-0 items-center gap-[2px] sm:inline-flex"
            />
          ) : null}
          {box.checkSummary ? <span data-slot="activity-checks-summary" className="sr-only">{box.checkSummary}</span> : null}
        </div>
        <Heartbeat rate={task.rate} className="hidden h-3.5 w-[52px] md:block" />
        {elapsedAnchor ? (
          <span
            data-slot="activity-elapsed"
            title={fullTimeOf(elapsedAnchor)}
            className="col-start-3 row-start-1 justify-self-end text-[12px] text-muted-foreground tabular-nums md:col-start-5"
          >
            {span(since(elapsedAnchor, ctx.now))}
          </span>
        ) : <span className="col-start-3 row-start-1 md:col-start-5" />}
      </div>
      <LineText texts={lineTexts(record.runId, requests, index, waits)} />
      <PeerLinks
        runId={record.runId}
        requests={requests}
        waits={waits}
        index={index}
        link={global ? RouterLink : Link}
        pathOf={(runId) => activityTaskHref(record.projectId, runId, global)}
        className="ml-6 flex flex-col gap-0.5 md:hidden"
        linkClassName={PEER_LINK}
      />
      <ActivityWorkers
        task={record.task}
        requests={requests}
        index={index}
        ctx={ctx}
        motion={motion}
        projectId={record.projectId}
        global={global}
        compact
      />
    </article>
  )
}

export interface ActivityWorkingListProps extends ActivityListSharedProps {
  items: readonly WorkingRecord[]
}

export function ActivityWorkingList({
  items,
  requestsByProject,
  waitsByProject,
  indexByProject,
  now,
  global,
  grouped,
  projectOrder,
  linkedIds,
  motion = EMPTY_MOTION,
  onHover,
}: ActivityWorkingListProps) {
  if (items.length === 0) return null

  const renderBox = (records: readonly WorkingRecord[]) => (
    <div className="divide-y divide-border rounded-xl border border-border bg-card">
      {records.map((record) => {
        const index = indexByProject.get(record.projectId) ?? EMPTY_INDEX
        const ctx: NowContext = { now, titleOf: (runId) => index.get(runId)?.title ?? 'Unreadable task' }
        return (
          <WorkingRow
            key={record.runId}
            record={record}
            requests={requestsByProject.get(record.projectId) ?? EMPTY_REQUESTS}
            waits={waitsByProject.get(record.projectId) ?? EMPTY_WAITS}
            index={index}
            ctx={ctx}
            global={global}
            linked={linkedIds.has(record.runId)}
            motion={motion}
            onHover={onHover}
          />
        )
      })}
    </div>
  )

  return (
    <section data-slot="activity-working" aria-label="Working and active tasks" className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[12px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
          Working &amp; active
        </h2>
        <span
          data-slot="activity-working-count"
          className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11.5px] font-semibold text-foreground tabular-nums"
        >
          {items.length}
        </span>
        <span className="ml-auto hidden text-[12px] text-muted-foreground sm:inline">
          Live tool activity, waits, and worker trees
        </span>
      </div>
      <ActivityProjectGroups
        items={items}
        grouped={grouped}
        projectOrder={projectOrder}
        countSuffix="active"
        renderItems={renderBox}
      />
    </section>
  )
}
