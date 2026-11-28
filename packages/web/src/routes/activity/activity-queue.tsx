import * as React from 'react'
import { Link as RouterLink } from 'react-router'
import type { ActivityRequest } from '@open-mercato/cezar-api-client/contract/activity'

import { Button } from '@/components/ui/button'
import { Link } from '@/lib/project-router'
import { runnerDisplayName, useRunners } from '@/api/runners'
import { cn } from '@/lib/utils'

import { ActivityWorkers, hoverHandlers, LineText } from './activity-card'
import { fullTimeOf, since, span } from './activity-format'
import { lineTexts, type PeerWait, type RunEntry } from './activity-model'
import { EMPTY_MOTION, type MotionState } from './activity-motion'
import { groupByProject, peerUnblocksText, type DecisionKind, type DecisionRecord } from './activity-queue-model'
import { RunShape, TONE_INK } from './activity-tone'
import { PeerLinks } from './peer-links'
import type { OnHover } from './use-wait-highlight'

/**
 * Top-tier Attention queue for Live Activity (hearsay-tools/squawk#4376): human-blocking
 * decisions (`Needs answer`, `Needs permission`, `Needs review`, `Failed`, `Needs you`)
 * rendered as shared decision records with unwrapped question previews, project identity,
 * age, peer-impact notes, and inline triage triggers.
 */

const LEFT_ACCENT: Record<DecisionKind, string> = {
  permission: 'border-l-pending',
  answer: 'border-l-pending',
  respond: 'border-l-pending',
  review: 'border-l-info',
  failed: 'border-l-danger',
}

export const PEER_LINK = 'relative z-[1] text-[12px] text-message-peer-accent hover:underline focus-visible:outline-2 focus-visible:outline-ring max-md:inline-flex max-md:min-h-11 max-md:items-center'

export const EMPTY_REQUESTS: readonly ActivityRequest[] = []
export const EMPTY_WAITS: readonly PeerWait[] = []
export const EMPTY_INDEX: ReadonlyMap<string, RunEntry> = new Map()

export function activityTaskHref(projectId: string, runId: string, global: boolean): string {
  return global
    ? `/p/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(runId)}`
    : `/tasks/${encodeURIComponent(runId)}`
}

export interface ActivityListSharedProps {
  requestsByProject: ReadonlyMap<string, readonly ActivityRequest[]>
  waitsByProject: ReadonlyMap<string, readonly PeerWait[]>
  indexByProject: ReadonlyMap<string, ReadonlyMap<string, RunEntry>>
  now: number
  /** Global `/activity` uses explicit `/p/:projectId/tasks/:runId` links; project scope uses relative `/tasks/:runId`. */
  global: boolean
  grouped: boolean
  projectOrder: readonly string[]
  linkedIds: ReadonlySet<string>
  motion?: MotionState
  onHover?: OnHover
}

export interface ActivityQueueProps extends ActivityListSharedProps {
  items: readonly DecisionRecord[]
  selectedRunId?: string | undefined
  onTriage: (record: DecisionRecord, trigger: HTMLButtonElement | null) => void
}

export function ActivityProjectGroups<T extends { projectId: string; projectName: string }>({
  items,
  grouped,
  projectOrder,
  countSuffix,
  renderItems,
}: {
  items: readonly T[]
  grouped: boolean
  projectOrder: readonly string[]
  countSuffix: string
  renderItems: (records: readonly T[]) => React.ReactNode
}) {
  if (!grouped) return <>{renderItems(items)}</>
  return (
    <div className="flex flex-col gap-3">
      {groupByProject(items, projectOrder).map((group) => (
        <div key={group.projectId} data-slot="activity-project-group" data-project={group.projectId} className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-[12.5px] font-semibold text-foreground">
            <span>{group.projectName}</span>
            <span className="text-[11.5px] font-normal text-muted-foreground tabular-nums">{group.items.length} {countSuffix}</span>
          </h3>
          {renderItems(group.items)}
        </div>
      ))}
    </div>
  )
}

interface DecisionRowProps {
  record: DecisionRecord
  requests: readonly ActivityRequest[]
  waits: readonly PeerWait[]
  index: ReadonlyMap<string, RunEntry>
  now: number
  global: boolean
  selected: boolean
  linked: boolean
  motion: MotionState
  onHover?: OnHover | undefined
  onTriage: (record: DecisionRecord, trigger: HTMLButtonElement | null) => void
}

const PREVIEW_TONE: Record<DecisionKind, string> = {
  permission: 'text-foreground',
  answer: 'text-foreground',
  respond: 'text-foreground',
  review: 'text-muted-foreground',
  failed: 'font-mono text-[12px] text-signal-word-red',
}

function DecisionTitleLink({ href, title, global }: { href: string; title: string; global: boolean }) {
  const cls = 'hover:underline focus-visible:outline-2 focus-visible:outline-ring max-md:inline-flex max-md:min-h-11 max-md:items-center pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center'
  return global ? <RouterLink to={href} className={cls}>{title}</RouterLink> : <Link to={href} className={cls}>{title}</Link>
}

function DecisionAction({
  record,
  href,
  global,
  selected,
  onTriage,
}: {
  record: DecisionRecord
  href: string
  global: boolean
  selected: boolean
  onTriage: (record: DecisionRecord, trigger: HTMLButtonElement | null) => void
}) {
  if (record.kind === 'permission') {
    return (
      <Button asChild size="sm" variant="primary" className="min-h-9 max-md:min-h-11 max-md:flex-1">
        {global ? <RouterLink to={href}>{record.actionLabel}</RouterLink> : <Link to={href}>{record.actionLabel}</Link>}
      </Button>
    )
  }
  const variant = record.kind === 'answer' || record.kind === 'respond' ? 'primary' : 'outline'
  return (
    <Button
      type="button"
      size="sm"
      variant={variant}
      data-slot="activity-triage-trigger"
      aria-expanded={selected}
      className="min-h-9 max-md:min-h-11 max-md:flex-1"
      onClick={(event) => onTriage(record, event.currentTarget)}
    >
      {record.actionLabel}
    </Button>
  )
}

function DecisionRow({
  record,
  requests,
  waits,
  index,
  now,
  global,
  selected,
  linked,
  motion,
  onHover,
  onTriage,
}: DecisionRowProps) {
  const runners = useRunners().data
  const { task } = record
  const meta = [
    task.runner ? runnerDisplayName(runners, task.runner) : undefined,
    task.model,
    task.currentStepId ? `step ${task.currentStepId}` : undefined,
  ].filter(Boolean).join(' · ')
  const unblocks = peerUnblocksText(record.runId, requests, waits, index)
  const href = activityTaskHref(record.projectId, record.runId, global)
  const workerCtx = { now, titleOf: (runId: string) => index.get(runId)?.title ?? 'Unreadable task' }
  const hasWorkers = task.workers.length > 0

  return (
    <article
      data-activity-row={record.runId}
      data-activity-card={record.runId}
      data-slot="activity-decision"
      data-decision-kind={record.kind}
      data-rung={task.rung}
      data-selected={selected ? 'true' : undefined}
      data-linked={linked ? 'true' : undefined}
      {...hoverHandlers(record.runId, onHover)}
      className={cn(
        'relative grid min-w-0 grid-cols-1 items-center gap-3 rounded-xl border border-border border-l-[3px] bg-card px-4 py-3 transition-colors md:grid-cols-[minmax(0,1fr)_auto] md:gap-x-4',
        LEFT_ACCENT[record.kind],
        selected && 'border-accent-text bg-accent-strong/[0.06]',
        linked && 'outline-2 outline-offset-1 outline-message-peer-accent',
        record.runId in motion.entering && 'activity-card-enter',
      )}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn('inline-flex items-center gap-1.5 text-[12px] font-semibold', TONE_INK[record.tone])}>
            <RunShape run={task} role="root" />
            <span data-slot="activity-verb">{record.stateLabel}</span>
          </span>
          <h3 className="min-w-0 truncate text-[14px] font-semibold text-foreground">
            <DecisionTitleLink href={href} title={task.title} global={global} />
          </h3>
          <span
            data-slot="activity-project-badge"
            className="inline-flex shrink-0 items-center rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
          >
            {record.projectName}
          </span>
          {record.ageSince ? (
            <span
              data-slot="activity-age"
              title={fullTimeOf(record.ageSince)}
              className="text-[12px] text-muted-foreground tabular-nums"
            >
              {span(since(record.ageSince, now))}
            </span>
          ) : null}
        </div>
        <p data-slot="activity-main" className={cn('break-words text-[13px] leading-relaxed', PREVIEW_TONE[record.kind])}>
          {record.blockingReason}
        </p>
        {meta || unblocks ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-muted-foreground">
            {meta ? <span>{meta}</span> : null}
            {unblocks ? <span data-slot="activity-unblocks" className="font-medium text-message-peer-accent">· {unblocks}</span> : null}
          </div>
        ) : null}
        <PeerLinks
          runId={record.runId}
          requests={requests}
          waits={waits}
          index={index}
          link={global ? RouterLink : Link}
          pathOf={(runId) => (global ? `/p/${encodeURIComponent(record.projectId)}/tasks/${encodeURIComponent(runId)}` : `/tasks/${encodeURIComponent(runId)}`)}
          className="mt-1 flex flex-col gap-0.5 md:hidden"
          linkClassName={PEER_LINK}
        />
      </div>
      <div className="flex items-center gap-2 max-md:w-full">
        <DecisionAction record={record} href={href} global={global} selected={selected} onTriage={onTriage} />
      </div>
      {hasWorkers ? (
        <div className="min-w-0 md:col-span-2">
          <ActivityWorkers
            task={task}
            requests={requests}
            index={index}
            ctx={workerCtx}
            motion={motion}
            projectId={record.projectId}
            global={global}
            compact
          />
        </div>
      ) : null}
      <LineText texts={lineTexts(record.runId, requests, index, waits)} />
    </article>
  )
}

export function ActivityQueue({
  items,
  requestsByProject,
  waitsByProject,
  indexByProject,
  now,
  global,
  grouped,
  projectOrder,
  selectedRunId,
  linkedIds,
  motion = EMPTY_MOTION,
  onHover,
  onTriage,
}: ActivityQueueProps) {
  if (items.length === 0) return null

  const renderRows = (records: readonly DecisionRecord[]) => (
    <div className="flex flex-col gap-2.5">
      {records.map((record) => (
        <DecisionRow
          key={record.runId}
          record={record}
          requests={requestsByProject.get(record.projectId) ?? EMPTY_REQUESTS}
          waits={waitsByProject.get(record.projectId) ?? EMPTY_WAITS}
          index={indexByProject.get(record.projectId) ?? EMPTY_INDEX}
          now={now}
          global={global}
          selected={selectedRunId === record.runId}
          linked={linkedIds.has(record.runId)}
          motion={motion}
          onHover={onHover}
          onTriage={onTriage}
        />
      ))}
    </div>
  )

  return (
    <section data-slot="activity-attention" aria-label="Needs your decision" className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[12px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
          Needs your decision
        </h2>
        <span
          data-slot="activity-attention-count"
          className="inline-flex items-center rounded-full bg-inbox-count px-2 py-0.5 text-[11.5px] font-semibold text-inbox-count-foreground tabular-nums"
        >
          {items.length}
        </span>
        <span className="ml-auto hidden text-[12px] text-muted-foreground sm:inline">
          Resolve inline without leaving the queue
        </span>
      </div>
      <ActivityProjectGroups
        items={items}
        grouped={grouped}
        projectOrder={projectOrder}
        countSuffix="waiting"
        renderItems={renderRows}
      />
    </section>
  )
}
