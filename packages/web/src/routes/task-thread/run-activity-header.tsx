import { useMemo, type ReactNode } from 'react'
import { ChevronDownIcon, LayersIcon } from '@/components/design-icons'

import type { ApiRun } from '@open-mercato/cezar-api-client'
import { useRunRelationships } from '@/api/queries'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

import { RunActivityDock, useActivityStatusFacts } from './run-activity-dock'
import { listsWorkers } from './run-relationships'
import { activeStepIndex, railSteps } from './step-rail'
import type { ThreadState } from './thread-state'

export const ULTRAWIDE_ACTIVITY_QUERY = '(min-width: 1600px)'

export interface ThreadActivityProps {
  run: ApiRun
  thread: ThreadState
  currentThread: ThreadState
  currentComplete: boolean
  onOpenWorker: (id: string) => void
  /** Popover on mobile/standard desktop (or while Live Preview is open); sidebar on ultra-wide. */
  mode: 'popover' | 'sidebar'
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Keep the popover open while a child sheet (SubagentSheet) owns focus above it. */
  keepOpen?: boolean | undefined
  /** Optional custom auto-focus handler when the popover opens (e.g., restoring focus to a subagent row). */
  onOpenAutoFocus?: ((event: Event) => void) | undefined
}

function useHeaderActivityFacts(run: ApiRun, thread: ThreadState, currentThread: ThreadState, currentComplete: boolean) {
  const status = useActivityStatusFacts(run, thread, currentThread, currentComplete)
  const delegated = listsWorkers(run)
  const relationships = useRunRelationships(run.id, { enabled: delegated })
  const workerCount = useMemo(() => {
    const receiptIds = run.delegation?.role === 'root' ? run.delegation.receipts.map((r) => r.workerId) : []
    const fetchedIds = relationships.data?.workers.map((w) => w.workerId) ?? []
    return new Set([...receiptIds, ...fetchedIds]).size
  }, [run.delegation, relationships.data?.workers])
  const steps = railSteps(run)
  const activeStep = steps.length > 0 ? steps[activeStepIndex(run.currentStepId, steps)] : undefined

  return {
    statusText: status.statusText,
    glyph: status.glyph,
    allComplete: status.allComplete,
    failed: status.failed,
    activeStepName: activeStep?.name,
    workerCount,
    agentCounts: status.agentCounts,
    cost: status.cost,
    nextCheckText: status.line.nextCheck?.text,
  }
}

function triggerAriaLabel(facts: ReturnType<typeof useHeaderActivityFacts>, mode: 'popover' | 'sidebar'): string {
  const parts = [`Session activity: ${facts.statusText}`]
  if (facts.nextCheckText) parts.push(`Next check ${facts.nextCheckText}`)
  if (facts.activeStepName) parts.push(`step ${facts.activeStepName}`)
  if (facts.workerCount > 0) parts.push(`${facts.workerCount} ${facts.workerCount === 1 ? 'worker' : 'workers'}`)
  if (facts.agentCounts.total > 0) parts.push(`${facts.agentCounts.done}/${facts.agentCounts.total} subagents`)
  if (facts.cost) parts.push(`cost ${facts.cost}`)
  if (mode === 'sidebar') parts.push('toggle activity sidebar')
  return parts.join('; ')
}

function ActivityPopover({
  props,
  align,
  sideOffset,
  contentClassName,
  children,
}: {
  props: ThreadActivityProps
  align: 'center' | 'end'
  sideOffset: number
  contentClassName: string
  children: ReactNode
}) {
  const { run, thread, currentThread, currentComplete, onOpenWorker, open, onOpenChange, keepOpen = false, onOpenAutoFocus } = props
  const suppressWhileChildOpen = (event: Event) => {
    if (keepOpen) event.preventDefault()
  }
  return (
    <Popover open={open} onOpenChange={(next) => { if (!next && keepOpen) return; onOpenChange(next) }}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align={align}
        sideOffset={sideOffset}
        data-slot="run-activity-popover"
        className={contentClassName}
        onOpenAutoFocus={onOpenAutoFocus}
        onInteractOutside={suppressWhileChildOpen}
        onPointerDownOutside={suppressWhileChildOpen}
        onFocusOutside={suppressWhileChildOpen}
        onEscapeKeyDown={suppressWhileChildOpen}
      >
        <RunActivityDock
          presentation="panel"
          run={run}
          thread={thread}
          currentThread={currentThread}
          currentComplete={currentComplete}
          onOpenWorker={onOpenWorker}
        />
      </PopoverContent>
    </Popover>
  )
}

/**
 * Desktop header Activity trigger (hearsay-tools/squawk#4374): sits in `RunHeader`'s status slot,
 * opening the Activity popover on standard desktop (`< 1600px` or when Live Preview is open) or
 * toggling the ultra-wide right-hand Activity sidebar (`>= 1600px`).
 */
export function DesktopActivityHeaderControl(props: ThreadActivityProps) {
  const { run, thread, currentThread, currentComplete, mode, open, onOpenChange } = props
  const facts = useHeaderActivityFacts(run, thread, currentThread, currentComplete)
  const label = triggerAriaLabel(facts, mode)
  const statusColor = facts.allComplete ? 'text-semantic-green' : facts.failed ? 'text-semantic-red' : 'text-foreground'

  const button = (
    <button
      type="button"
      data-slot="run-activity-trigger"
      data-activity-mode={mode}
      aria-expanded={open}
      aria-label={label}
      onClick={mode === 'sidebar' ? () => onOpenChange(!open) : undefined}
      className={cn(
        'hidden min-h-9 min-w-0 max-w-full shrink items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-[12px] font-medium text-foreground shadow-xs transition-colors md:inline-flex',
        'pointer-hover:bg-muted/60 active:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        open && 'border-accent-strong/60',
      )}
    >
      <span data-slot="pill" className="inline-flex min-w-0 items-center gap-1.5">
        {facts.glyph}
        <span data-slot="run-activity-status" className={cn('truncate', statusColor)}>
          <span data-slot="run-activity-status-label">{facts.statusText}</span>
        </span>
      </span>
      {facts.activeStepName ? (
        <span className="hidden max-w-[140px] truncate text-muted-foreground xl:inline">· {facts.activeStepName}</span>
      ) : null}
      {facts.workerCount > 0 ? (
        <span data-slot="activity-workers-badge" className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground tabular-nums">
          {facts.workerCount} {facts.workerCount === 1 ? 'worker' : 'workers'}
        </span>
      ) : null}
      {facts.agentCounts.total > 0 ? (
        <span data-slot="activity-subagents-badge" className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground tabular-nums">
          {facts.agentCounts.done}/{facts.agentCounts.total} agents
        </span>
      ) : null}
      {facts.cost ? (
        <span data-slot="run-activity-cost" className="font-mono text-xs text-muted-foreground tabular-nums">
          {facts.cost}
        </span>
      ) : null}
      <ChevronDownIcon
        aria-hidden="true"
        className={cn(
          'size-3.5 shrink-0 text-soft-foreground motion-safe:transition-transform motion-reduce:transition-none',
          open && 'rotate-180',
        )}
      />
    </button>
  )

  if (mode === 'sidebar') return button

  return (
    <ActivityPopover
      props={props}
      align="end"
      sideOffset={6}
      contentClassName="w-[380px] max-w-[calc(100vw-2rem)] max-h-[min(70dvh,540px)] overflow-y-auto overscroll-contain p-0"
    >
      {button}
    </ActivityPopover>
  )
}

/**
 * Mobile header Activity strip (`< md`): a full-width 44px touch target inside `RunHeader`
 * that keeps Activity telemetry (Workers, Subagents, Workflow, Usage, Workspace) in the header
 * instead of between the active ask and reply input.
 */
export function MobileActivityHeaderControl(props: ThreadActivityProps) {
  const { run, thread, currentThread, currentComplete, open } = props
  const facts = useHeaderActivityFacts(run, thread, currentThread, currentComplete)
  const label = triggerAriaLabel(facts, 'popover')
  const statusColor = facts.allComplete ? 'text-semantic-green' : facts.failed ? 'text-semantic-red' : 'text-muted-foreground'

  return (
    <ActivityPopover
      props={props}
      align="center"
      sideOffset={4}
      contentClassName="w-[calc(100vw-1.5rem)] max-w-[420px] max-h-[min(65dvh,460px)] overflow-y-auto overscroll-contain p-0"
    >
      <button
        type="button"
        data-slot="run-activity-trigger-mobile"
        aria-expanded={open}
        aria-label={label}
        className={cn(
          'flex min-h-11 w-full min-w-0 items-center gap-2 border-t border-border bg-background px-1 text-start text-[13px] text-foreground md:hidden',
          'active:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
        )}
      >
        <LayersIcon aria-hidden="true" className="size-4 shrink-0 text-accent-text" />
        <span className="shrink-0 font-semibold">Activity</span>
        <span data-slot="run-activity-status" className={cn('inline-flex min-w-0 items-center gap-1.5 truncate', statusColor)}>
          {facts.glyph}
          <span data-slot="run-activity-status-label" className="truncate">{facts.statusText}</span>
        </span>
        {facts.workerCount > 0 ? (
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground tabular-nums">
            {facts.workerCount}w
          </span>
        ) : null}
        {facts.agentCounts.total > 0 ? (
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground tabular-nums">
            {facts.agentCounts.done}/{facts.agentCounts.total}
          </span>
        ) : null}
        {facts.cost ? (
          <span className="ms-auto shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
            {facts.cost}
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            'size-4 shrink-0 text-soft-foreground motion-safe:transition-transform motion-reduce:transition-none',
            !facts.cost && 'ms-auto',
            open && 'rotate-180',
          )}
        />
      </button>
    </ActivityPopover>
  )
}
