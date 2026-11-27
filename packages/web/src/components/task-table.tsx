import * as React from 'react'
import { ArchiveRestoreIcon, EyeIcon, EyeOffIcon, PencilIcon, ZapIcon } from 'lucide-react'
import { Link as RouterLink, useNavigate as useRouterNavigate } from 'react-router'

import type { RunStatePreview, RunSummary } from '@open-mercato/cezar-api-client'
import type { AttentionTone } from '@/lib/attention'
import { DiffStat, Path, RelativeTime } from '@/components/data-primitives'
import { ArchiveIcon } from '@/components/design-icons'
import { TitleEditInput } from '@/components/editable-title'
import { Pill } from '@/components/pill'
import { PinToggle } from '@/components/pin-toggle'
import { TaskReferenceChip } from '@/components/reference-conflict-action'
import { ReferenceList } from '@/components/reference-overflow'
import { StatusDot } from '@/components/status-dot'
import { TaskListItems } from '@/components/task-list-items'
import { TaskTelemetryPopover, TelemetryOpenButton } from '@/components/task-telemetry-popover'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Link as ScopedLink, useNavigate as useScopedNavigate } from '@/lib/project-router'
import {
  isColumnExpanded,
  normalizeExpandedColumns,
  TASK_COLUMNS,
  UNIFIED_TABLE_COLUMN_IDS,
  type NormalizedExpandedColumns,
  type TaskColumnDefinition,
  type TaskColumnId,
} from '@/lib/task-columns'
import type { TaskRowModel } from '@/lib/task-model'
import { useTaskTitleEditor } from '@/lib/task-title-editor'
import { cn } from '@/lib/utils'

/** Supported `<TaskTable />` layout densities across Project Tasks, Global Tasks, and mobile. */
export type TaskTableDensity = 'table' | 'compact' | 'card'

export interface TaskTableProps {
  items: readonly TaskRowModel[]
  density: TaskTableDensity
  now: number
  /** False keeps the column names for assistive technology only (e.g. second open group). */
  showHeader?: boolean
  /** Render the automatic project badge on each row (Global Tasks). */
  showProject?: boolean
  /** False hides the Reference column when no visible row has a PR or issue reference. */
  showReferences?: boolean
  /** Workspace-persisted column visibility map. */
  expandedColumns?: NormalizedExpandedColumns
  showTokens?: boolean
  showCost?: boolean
  /** Project Tasks uses project-scoped links; Global Tasks uses absolute `/p/:projectId/...` links. */
  scopedLinks?: boolean
  /** Project Tasks reads live SSE usage when the telemetry popover opens; Global Tasks uses snapshots. */
  liveUsageSource?: 'stream' | 'snapshot'
  /** Enable inline task title rename when mounted inside `TaskTitleEditorProvider`. */
  allowRename?: boolean
  onTogglePin?: ((item: TaskRowModel, pinned: boolean) => void) | undefined
  onArchive?: ((item: TaskRowModel, archived: boolean) => void) | undefined
  onSetRead?: ((item: TaskRowModel, read: boolean) => void) | undefined
  busy?: boolean
  /** Historic surface slot names for E2E and route styling compatibility. */
  tableSlot?: string
  rowSlot?: string
  cardSlot?: string
}

const UNIFIED_COLUMN_SET = new Set<TaskColumnId>(UNIFIED_TABLE_COLUMN_IDS)

/** Ordered visible columns for `<TaskTable />` table and compact densities. */
export function resolveVisibleColumns(
  expandedColumns: NormalizedExpandedColumns,
  showReferences: boolean,
): TaskColumnDefinition[] {
  return TASK_COLUMNS.filter((column) => {
    if (!UNIFIED_COLUMN_SET.has(column.id)) return false
    if (column.id === 'task') return true
    if (column.id === 'reference' && !showReferences) return false
    return isColumnExpanded(column.id, expandedColumns)
  })
}

function gridTemplateFor(columns: readonly TaskColumnDefinition[]): string {
  return columns
    .map((column) => (column.id === 'task' ? 'minmax(0, 1fr)' : column.width ?? '100px'))
    .join(' ')
}

function titleTextClass(unread: boolean, readDone: boolean, clamp: boolean): string {
  return cn(
    clamp
      ? 'line-clamp-2 min-w-0 whitespace-normal rounded-sm text-[13.5px] leading-[1.35]'
      : 'min-w-0 truncate rounded-sm text-[13px] leading-[18px]',
    unread ? 'font-semibold text-foreground' : readDone ? 'font-normal text-foreground' : 'font-medium text-foreground',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link-foreground',
  )
}

const PREVIEW_BADGE: Record<RunStatePreview['kind'], { label: string; tone: string }> = {
  ask: { label: 'Ask', tone: 'text-pending-strong' },
  permission: { label: 'Permission', tone: 'text-pending-strong' },
  review: { label: 'Review', tone: 'text-accent-text' },
  error: { label: 'Error', tone: 'text-danger' },
}

/** Concise 1-line urgent or error preview rendered beneath the row metadata. */
export function TaskStatePreview({ preview }: { preview: RunStatePreview | undefined }) {
  if (!preview) return null
  const badge = PREVIEW_BADGE[preview.kind]
  return (
    <p
      data-slot="task-state-preview"
      data-preview-kind={preview.kind}
      title={preview.text}
      className="mt-1 flex min-w-0 items-baseline gap-1.5 text-xs leading-[1.35] text-muted-foreground"
    >
      <span className={cn('shrink-0 text-[11px] font-semibold', badge.tone)}>{badge.label}</span>
      <span className="min-w-0 truncate">{preview.text}</span>
    </p>
  )
}

function AutomationBadge({ badge }: { badge: NonNullable<TaskRowModel['automationBadge']> }) {
  return (
    <span
      data-slot="task-automation-badge"
      data-origin="automation"
      title={`Automation ${badge.id}`}
      className="inline-flex max-w-[180px] shrink-0 items-center gap-1 truncate rounded-full border border-info/30 bg-info/10 px-2 py-px text-[11px] font-medium text-info"
    >
      <ZapIcon className="size-2.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{badge.label}</span>
    </span>
  )
}

function ProjectBadge({ name, href }: { name: string; href?: string | undefined }) {
  const cls = 'inline-flex max-w-[140px] shrink-0 items-center truncate rounded-md border border-border bg-muted px-1.5 py-px font-mono text-[11px] font-medium text-foreground'
  if (!href) {
    return (
      <span data-slot="task-project" className={cls} title={name}>
        {name}
      </span>
    )
  }
  return (
    <RouterLink to={href} data-slot="task-project" title={name} className={cn(cls, 'hover:border-control-border hover:bg-muted/80')}>
      {name}
    </RouterLink>
  )
}

function TaskLink({ scoped, to, className, title, children, ...props }: {
  scoped: boolean
  to: string
  className?: string | undefined
  title?: string | undefined
  children: React.ReactNode
} & Record<string, unknown>) {
  if (scoped) {
    return (
      <ScopedLink to={to} title={title} className={className} {...props}>
        {children}
      </ScopedLink>
    )
  }
  return (
    <RouterLink to={to} title={title} className={className} {...props}>
      {children}
    </RouterLink>
  )
}

export function EditableRunTitle({
  run,
  to,
  title,
  unread,
  unreadTone,
  readDone,
  isWorker,
  pinned,
  automationBadge,
  scoped = true,
  onTogglePin,
  lines = 1,
  compact = false,
}: {
  run: RunSummary
  to: string
  title: string
  unread: boolean
  unreadTone: AttentionTone
  readDone: boolean
  isWorker: boolean
  pinned: boolean
  automationBadge?: TaskRowModel['automationBadge'] | undefined
  scoped?: boolean
  onTogglePin?: ((pinned: boolean) => void) | undefined
  lines?: 1 | 2
  compact?: boolean
}) {
  const editor = useTaskTitleEditor(run)
  if (editor.editing) {
    return (
      <div className="flex flex-wrap items-center gap-2" data-slot="table-title-editor">
        <TitleEditInput editor={editor} className="basis-full text-[13px] font-medium" />
        <Button size="sm" aria-label="Save title" onMouseDown={(event) => event.preventDefault()} onClick={editor.commit}>
          Save
        </Button>
        <Button size="sm" variant="outline" aria-label="Cancel rename" onMouseDown={(event) => event.preventDefault()} onClick={editor.cancel}>
          Cancel
        </Button>
      </div>
    )
  }
  const titleClass = cn(
    lines === 2
      ? 'line-clamp-2 min-w-0 whitespace-normal rounded-sm text-[13px] leading-[18px]'
      : 'min-w-0 truncate rounded-sm text-[13px] leading-[18px]',
    unread ? 'font-semibold text-foreground' : readDone ? 'font-normal text-foreground' : 'font-medium text-foreground',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link-foreground',
  )
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', compact || lines === 1 ? 'h-[18px]' : 'min-h-[18px]')}>
      {isWorker ? <span className="shrink-0 text-xs text-muted-foreground">Worker</span> : null}
      <TaskLink scoped={scoped} to={to} title={title} data-task-control="title" className={titleClass}>
        {title}
      </TaskLink>
      {automationBadge ? <AutomationBadge badge={automationBadge} /> : null}
      {unread ? (
        <StatusDot tone={unreadTone} role="img" aria-label="unread" title="Unread — not opened since it finished" className="shrink-0" />
      ) : null}
      <button
        type="button"
        data-slot="row-rename"
        aria-label="Rename task"
        onClick={editor.begin}
        className="shrink-0 rounded-sm p-0.5 text-soft-foreground opacity-0 transition-opacity group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <PencilIcon className="size-3" aria-hidden="true" />
      </button>
      <span aria-hidden="true" className="flex-1" />
      {onTogglePin ? (
        <PinToggle
          pinned={pinned}
          onToggle={onTogglePin}
          className="size-[19px] opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 no-hover:opacity-100 data-[pinned=true]:opacity-100"
        />
      ) : null}
    </span>
  )
}

function EditableTaskTitle({ model, scoped, onTogglePin, compact }: {
  model: TaskRowModel
  scoped: boolean
  onTogglePin?: ((item: TaskRowModel, pinned: boolean) => void) | undefined
  compact: boolean
}) {
  return (
    <EditableRunTitle
      run={model.run}
      to={model.href}
      title={model.title}
      unread={model.unread}
      unreadTone={model.unreadTone}
      readDone={model.readDone}
      isWorker={model.isWorker}
      pinned={model.pinned}
      automationBadge={model.automationBadge}
      scoped={scoped}
      onTogglePin={onTogglePin ? (pinned) => onTogglePin(model, pinned) : undefined}
      compact={compact}
    />
  )
}

function StaticTaskTitle({ model, scoped, showProject, onTogglePin, clamp }: {
  model: TaskRowModel
  scoped: boolean
  showProject: boolean
  onTogglePin?: ((item: TaskRowModel, pinned: boolean) => void) | undefined
  clamp: boolean
}) {
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', clamp ? 'items-start' : 'min-h-[18px]')}>
      {showProject && model.projectName ? <ProjectBadge name={model.projectName} href={model.projectHref} /> : null}
      {model.isWorker ? <span className="shrink-0 text-xs text-muted-foreground">Worker</span> : null}
      <TaskLink scoped={scoped} to={model.href} title={model.title} data-task-control="title" className={cn(titleTextClass(model.unread, model.readDone, clamp), clamp && 'flex-1')}>
        {model.title}
      </TaskLink>
      {!clamp && model.automationBadge ? <AutomationBadge badge={model.automationBadge} /> : null}
      {model.unread ? (
        <StatusDot tone={model.unreadTone} role="img" aria-label="unread" title="Unread — not opened since it finished" className={cn('shrink-0', clamp && 'mt-1.5')} />
      ) : null}
      {!clamp ? <span aria-hidden="true" className="flex-1" /> : null}
      {onTogglePin ? (
        <PinToggle
          pinned={model.pinned}
          onToggle={(pinned) => onTogglePin(model, pinned)}
          className={clamp
            ? '-mt-0.5 shrink-0'
            : 'size-[19px] opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 no-hover:opacity-100 data-[pinned=true]:opacity-100'}
        />
      ) : null}
    </span>
  )
}

function RowMetaLine({ model, showProject, showAutomationOnMeta, trailing }: {
  model: TaskRowModel
  showProject: boolean
  showAutomationOnMeta: boolean
  trailing?: React.ReactNode
}) {
  const { attention, scheduled, queuePosition, runnerModel, tags } = model
  return (
    <div data-slot="task-meta-line" className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
      <Pill
        dot={attention.tone}
        shape={attention.shape}
        pulse={attention.pulse}
        title={scheduled?.title ?? attention.label}
        className="shrink-0 py-0.5"
      >
        {attention.label}
        {scheduled ? <span className="tabular-nums"> {scheduled.label}</span> : null}
      </Pill>
      {showProject && model.projectName ? <ProjectBadge name={model.projectName} href={model.projectHref} /> : null}
      {showAutomationOnMeta && model.automationBadge ? <AutomationBadge badge={model.automationBadge} /> : null}
      {runnerModel ? (
        <>
          <span aria-hidden="true">·</span>
          <span data-slot="task-runner-model" className="min-w-0 truncate">{runnerModel}</span>
        </>
      ) : null}
      {model.run.status === 'queued' && queuePosition !== null ? (
        <>
          <span aria-hidden="true">·</span>
          <span data-slot="queue-note" className="shrink-0 tabular-nums">#{queuePosition} in queue</span>
        </>
      ) : null}
      {tags.map((tag) => (
        <span key={tag} data-slot="task-tag" className="rounded bg-muted px-1.5 py-px text-[11px] text-soft-foreground">
          {tag}
        </span>
      ))}
      {trailing}
    </div>
  )
}

function PopoverRowActions({ model, onSetRead, onArchive, busy }: {
  model: TaskRowModel
  onSetRead?: ((item: TaskRowModel, read: boolean) => void) | undefined
  onArchive?: ((item: TaskRowModel, archived: boolean) => void) | undefined
  busy: boolean
}) {
  if (!onSetRead && !onArchive) return null
  return (
    <>
      {onSetRead && model.canToggleRead ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-action={model.unread ? 'mark-read' : 'mark-unread'}
          aria-label={model.unread ? `Mark ${model.title} read` : `Mark ${model.title} unread`}
          disabled={busy}
          onClick={() => onSetRead(model, model.unread)}
          className="max-md:min-h-11"
        >
          {model.unread ? <EyeIcon className="size-3.5" aria-hidden="true" /> : <EyeOffIcon className="size-3.5" aria-hidden="true" />}
          {model.unread ? 'Mark read' : 'Mark unread'}
        </Button>
      ) : null}
      {onArchive && model.canArchive ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-action={model.run.archived ? 'unarchive-run' : 'archive-run'}
          aria-label={model.run.archived ? `Restore ${model.title} to the active list` : `Archive ${model.title}`}
          disabled={busy}
          onClick={() => onArchive(model, !model.run.archived)}
          className="max-md:min-h-11"
        >
          {model.run.archived ? <ArchiveRestoreIcon className="size-3.5" aria-hidden="true" /> : <ArchiveIcon className="size-3.5" aria-hidden="true" />}
          {model.run.archived ? 'Unarchive' : 'Archive'}
        </Button>
      ) : null}
    </>
  )
}

function ReferenceCellContent({ model, scoped }: { model: TaskRowModel; scoped: boolean }) {
  if (model.references.length === 0) return <span className="text-xs text-soft-foreground">—</span>
  if (scoped) {
    return <TaskReferenceChip run={model.run} reference={model.references[0]!} compact />
  }
  return (
    <ReferenceList
      references={model.references}
      maxVisible={1}
      taskTitle={model.title}
      projectId={model.projectId}
      runId={model.runId}
      repoBase={model.repoBase}
      compact
    />
  )
}

interface TaskRowRenderContext {
  model: TaskRowModel
  now: number
  scoped: boolean
  showProject: boolean
  allowRename: boolean
  showTokens: boolean
  showCost: boolean
  liveUsageSource: 'stream' | 'snapshot'
  compact: boolean
  onTogglePin?: ((item: TaskRowModel, pinned: boolean) => void) | undefined
  onSetRead?: ((item: TaskRowModel, read: boolean) => void) | undefined
  onArchive?: ((item: TaskRowModel, archived: boolean) => void) | undefined
  busy: boolean
}

function RowTelemetryControl({
  model,
  scoped,
  showTokens,
  showCost,
  liveUsageSource,
  onSetRead,
  onArchive,
  busy,
  className,
}: Pick<
  TaskRowRenderContext,
  'model' | 'scoped' | 'showTokens' | 'showCost' | 'liveUsageSource' | 'onSetRead' | 'onArchive' | 'busy'
> & { className?: string | undefined }) {
  return (
    <TaskTelemetryPopover
      model={model}
      showTokens={showTokens}
      showCost={showCost}
      liveUsageSource={liveUsageSource}
      className={className}
      openLink={
        <TelemetryOpenButton>
          <TaskLink scoped={scoped} to={model.href} data-task-control="open">
            Open task<span className="sr-only">: {model.title}</span>
          </TaskLink>
        </TelemetryOpenButton>
      }
      extraActions={<PopoverRowActions model={model} onSetRead={onSetRead} onArchive={onArchive} busy={busy} />}
    />
  )
}

function TableCell({
  column,
  hasUsageColumn,
  ...ctx
}: TaskRowRenderContext & {
  column: TaskColumnDefinition
  hasUsageColumn: boolean
}) {
  const { model, now, scoped, showProject, allowRename, compact, onTogglePin } = ctx
  switch (column.id) {
    case 'task':
      return (
        <div role="cell" data-column-id="task" className={cn('min-w-0 pr-3', compact ? 'py-1.5' : 'py-2.5')}>
          {allowRename ? (
            <EditableTaskTitle model={model} scoped={scoped} onTogglePin={onTogglePin} compact={compact} />
          ) : (
            <StaticTaskTitle model={model} scoped={scoped} showProject={showProject} onTogglePin={onTogglePin} clamp={false} />
          )}
          <RowMetaLine
            model={model}
            showProject={false}
            showAutomationOnMeta={false}
            trailing={
              !hasUsageColumn ? (
                <RowTelemetryControl {...ctx} className="ml-auto h-6 px-1.5 text-[11px]" />
              ) : null
            }
          />
          <TaskStatePreview preview={model.statePreview} />
        </div>
      )
    case 'runner':
      return (
        <div role="cell" data-column-id="runner" className="min-w-0 truncate text-xs text-muted-foreground" title={model.runnerModel}>
          {model.runnerModel ?? <span className="text-soft-foreground">—</span>}
        </div>
      )
    case 'workflow':
      return (
        <div role="cell" data-column-id="workflow" className="min-w-0 truncate text-xs text-muted-foreground" title={model.workflow}>
          {model.workflow}
        </div>
      )
    case 'branch':
      return (
        <div role="cell" data-column-id="branch" className="min-w-0 overflow-hidden">
          {model.branch ? <Path value={model.branch} variant="chip" /> : <span className="text-xs text-soft-foreground">—</span>}
        </div>
      )
    case 'diff':
      return (
        <div role="cell" data-column-id="diff" className="text-xs">
          {model.diffStat ? <DiffStat stat={model.diffStat} /> : <span className="text-soft-foreground">—</span>}
        </div>
      )
    case 'reference':
      return (
        <div role="cell" data-column-id="reference" className="min-w-0">
          <ReferenceCellContent model={model} scoped={scoped} />
        </div>
      )
    case 'usage':
      return (
        <div role="cell" data-column-id="usage" className="flex justify-end">
          <RowTelemetryControl {...ctx} />
        </div>
      )
    case 'started':
      return (
        <div role="cell" data-column-id="started" className="text-right text-xs text-muted-foreground">
          <RelativeTime iso={model.startedAt} now={now} />
        </div>
      )
    default:
      return null
  }
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('a, button, input, [role="dialog"]'))
}

function sameTaskModel(a: TaskRowModel, b: TaskRowModel): boolean {
  return (
    a.run === b.run &&
    a.projectName === b.projectName &&
    a.projectHref === b.projectHref &&
    a.runnerModel === b.runnerModel &&
    a.usageSummary === b.usageSummary &&
    a.queuePosition === b.queuePosition &&
    a.automationBadge?.label === b.automationBadge?.label &&
    a.tags.length === b.tags.length &&
    a.tags.every((tag, index) => tag === b.tags[index])
  )
}

function samePropsWithModel<T extends { model: TaskRowModel }>(previous: T, next: T): boolean {
  const { model: a, ...before } = previous
  const { model: b, ...after } = next
  return (
    sameTaskModel(a, b) &&
    (Object.keys(before) as (keyof typeof before)[]).every((key) => before[key] === after[key])
  )
}

export const TaskTableRow = React.memo(function TaskTableRow({
  rowIndex,
  columns,
  gridTemplate,
  rowSlot,
  ...ctx
}: TaskRowRenderContext & {
  rowIndex: number
  columns: readonly TaskColumnDefinition[]
  gridTemplate: string
  rowSlot: string
}) {
  const { model, scoped } = ctx
  const scopedNavigate = useScopedNavigate()
  const routerNavigate = useRouterNavigate()
  const navigateTo = (href: string) => (scoped ? scopedNavigate(href) : routerNavigate(href))
  const hasUsageColumn = columns.some((column) => column.id === 'usage')

  return (
    <div
      role="row"
      aria-rowindex={rowIndex}
      data-slot={rowSlot}
      data-task-row="true"
      data-status={model.run.status}
      data-urgent={model.urgent ? 'true' : undefined}
      data-run-id={model.runId}
      data-project={model.projectId}
      style={{ gridTemplateColumns: gridTemplate }}
      onClick={(event) => {
        if (isInteractiveTarget(event.target)) return
        navigateTo(model.href)
      }}
      className={cn(
        'group/row grid cursor-pointer items-center gap-x-3.5 border-b border-border transition-colors hover:bg-muted/70',
        model.urgent && 'bg-pending/[0.03]',
      )}
    >
      {columns.map((column) => (
        <TableCell key={column.id} column={column} hasUsageColumn={hasUsageColumn} {...ctx} />
      ))}
    </div>
  )
}, samePropsWithModel)

export const TaskTableCard = React.memo(function TaskTableCard({
  model,
  now,
  scoped,
  showProject,
  showTokens,
  showCost,
  liveUsageSource,
  onTogglePin,
  onSetRead,
  onArchive,
  busy,
  cardSlot,
}: {
  model: TaskRowModel
  now: number
  scoped: boolean
  showProject: boolean
  showTokens: boolean
  showCost: boolean
  liveUsageSource: 'stream' | 'snapshot'
  onTogglePin?: ((item: TaskRowModel, pinned: boolean) => void) | undefined
  onSetRead?: ((item: TaskRowModel, read: boolean) => void) | undefined
  onArchive?: ((item: TaskRowModel, archived: boolean) => void) | undefined
  busy: boolean
  cardSlot: string
}) {
  const scopedNavigate = useScopedNavigate()
  const routerNavigate = useRouterNavigate()
  const navigateTo = (href: string) => (scoped ? scopedNavigate(href) : routerNavigate(href))

  return (
    <article
      data-slot={cardSlot}
      data-task-row="true"
      data-status={model.run.status}
      data-urgent={model.urgent ? 'true' : undefined}
      data-run-id={model.runId}
      data-project={model.projectId}
      onClick={(event) => {
        if (isInteractiveTarget(event.target)) return
        navigateTo(model.href)
      }}
      className="flex cursor-pointer flex-col gap-1.5 border-b border-border py-2.5"
    >
      <div data-slot="mobile-task-title-row">
        <StaticTaskTitle model={model} scoped={scoped} showProject={false} onTogglePin={onTogglePin} clamp />
      </div>
      <RowMetaLine model={model} showProject={showProject} showAutomationOnMeta />
      <TaskStatePreview preview={model.statePreview} />
      <div data-slot="mobile-task-meta" className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
        <span data-slot="mobile-task-workflow" className="min-w-0 truncate">{model.workflow}</span>
        {model.references.length > 0 ? <ReferenceCellContent model={model} scoped={scoped} /> : null}
        {model.queuePosition !== null ? (
          <span data-slot="queue-note" className="tabular-nums">#{model.queuePosition} in queue</span>
        ) : model.diffStat ? (
          <DiffStat stat={model.diffStat} />
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <TaskTelemetryPopover
            model={model}
            showTokens={showTokens}
            showCost={showCost}
            liveUsageSource={liveUsageSource}
            openLink={
              <TelemetryOpenButton>
                <TaskLink scoped={scoped} to={model.href} data-task-control="open">
                  Open task<span className="sr-only">: {model.title}</span>
                </TaskLink>
              </TelemetryOpenButton>
            }
            extraActions={<PopoverRowActions model={model} onSetRead={onSetRead} onArchive={onArchive} busy={busy} />}
          />
          <RelativeTime iso={model.startedAt} now={now} />
        </span>
      </div>
    </article>
  )
}, samePropsWithModel)

/**
 * Shared task list component for Project Tasks, Global Tasks, and mobile task cards
 * (hearsay-tools/squawk#4377). Supports `table`, `compact`, and `card` densities over one
 * `TaskRowModel` projection and `TaskListItems` virtualization.
 */
export function TaskTable({
  items,
  density,
  now,
  showHeader = true,
  showProject = false,
  showReferences = true,
  expandedColumns = normalizeExpandedColumns(undefined),
  showTokens = true,
  showCost = true,
  scopedLinks = true,
  liveUsageSource = 'stream',
  allowRename = false,
  onTogglePin,
  onArchive,
  onSetRead,
  busy = false,
  tableSlot = 'tasks-summary',
  rowSlot = 'task-summary-row',
  cardSlot = 'task-card',
}: TaskTableProps) {
  const columns = React.useMemo(
    () => resolveVisibleColumns(expandedColumns, showReferences),
    [expandedColumns, showReferences],
  )
  const gridTemplate = React.useMemo(() => gridTemplateFor(columns), [columns])

  if (density === 'card') {
    return (
      <TooltipProvider>
        <div
          data-slot="task-cards"
          data-task-table="true"
          data-density="card"
          className="flex flex-col rounded-lg border border-border bg-card px-3"
        >
          <TaskListItems itemSize={112} items={items} itemKey={(item) => item.key}>
            {(item) => (
              <TaskTableCard
                key={item.key}
                model={item}
                now={now}
                scoped={scopedLinks}
                showProject={showProject}
                showTokens={showTokens}
                showCost={showCost}
                liveUsageSource={liveUsageSource}
                onTogglePin={onTogglePin}
                onSetRead={onSetRead}
                onArchive={onArchive}
                busy={busy}
                cardSlot={cardSlot}
              />
            )}
          </TaskListItems>
        </div>
      </TooltipProvider>
    )
  }

  const compact = density === 'compact'
  return (
    <TooltipProvider>
      <div
        data-slot={tableSlot}
        data-task-table="true"
        data-density={density}
        data-head={showHeader}
        data-reference-column={showReferences}
        className="overflow-x-auto"
      >
        <div
          role="table"
          aria-rowcount={items.length + 1}
          className="rounded-lg border border-border bg-card px-4"
        >
          <div
            role="row"
            aria-rowindex={1}
            data-slot="task-table-head"
            style={{ gridTemplateColumns: gridTemplate }}
            className={cn('grid items-center gap-x-3.5', !showHeader && 'sr-only')}
          >
            {columns.map((column) => (
              <div
                role="columnheader"
                key={column.id}
                data-column-id={column.id}
                className={cn(
                  'flex h-8 items-center border-b border-border text-[11px] font-medium tracking-[0.04em] text-muted-foreground uppercase',
                  column.align === 'right' && 'justify-end text-right',
                )}
              >
                {column.summaryLabel ?? column.label}
              </div>
            ))}
          </div>
          <TaskListItems itemSize={compact ? 56 : 74} items={items} itemKey={(item) => item.key}>
            {(item, index) => (
              <TaskTableRow
                key={item.key}
                model={item}
                rowIndex={index + 2}
                columns={columns}
                gridTemplate={gridTemplate}
                now={now}
                scoped={scopedLinks}
                showProject={showProject}
                allowRename={allowRename}
                showTokens={showTokens}
                showCost={showCost}
                liveUsageSource={liveUsageSource}
                compact={compact}
                onTogglePin={onTogglePin}
                onSetRead={onSetRead}
                onArchive={onArchive}
                busy={busy}
                rowSlot={rowSlot}
              />
            )}
          </TaskListItems>
        </div>
      </div>
    </TooltipProvider>
  )
}
