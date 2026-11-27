import { taskResourceGrid } from '@/lib/task-list-render'
import { TaskListItems, TaskListFocusBoundary } from '@/components/task-list-items'
import { TaskTitleEditorProvider, useTaskTitleEditor } from '@/lib/task-title-editor'
import { useIsDesktop } from '@/lib/use-desktop'
import { useRunCacheWriter } from '@/api/use-run-cache-writer'
import { projectAddress } from '@/api/run-address'
import './task-lists.css'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ChevronsLeftIcon,
  ChevronsRightIcon,
  Clock3Icon,
  CoinsIcon,
  DollarSignIcon,
  ListChecksIcon,
  LinkIcon,
  MemoryStickIcon,
  PencilIcon,
  SearchXIcon,
  ZapIcon,
} from 'lucide-react'
import { ArchiveIcon, CpuIcon, FileDiffIcon, GitBranchIcon, PlusIcon, WorkflowIcon } from '@/components/design-icons'
import * as React from 'react'
import { Link, useNavigate } from '@/lib/project-router'
import { archiveFinished, markAllRunsSeen, patchRun } from '@/api/client'
import { useRunUsage } from '@/api/global-events'
import {
  queryKeys,
  useAutomationNames,
  useHealth,
  usePinRun,
  useProjects,
  useProjectRepoBase,
  useReferenceProjectId,
  useRuns,
} from '@/api/queries'
import { useRunners } from '@/api/runners'
import type { RunnersResponse, RunSummary } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { DiffStat, RelativeTime } from '@/components/data-primitives'
import {
  BranchChip,
  Dash,
  ResultCount,
  TaskBulkActions,
  TaskControlStrip,
  TaskViewTabs,
  headingTone,
  taskTitleClass,
  tasksOverviewDensity,
  tasksOverviewHeader,
  tasksOverviewRootProps,
  tasksOverviewSparseFooter,
  useArchivedPages,
} from './task-list-parts'
import { TablePage } from '@/components/page-shell'
import { DirectionalUsage, directionalUsageLabel } from '@/components/directional-usage'
import { TitleEditInput } from '@/components/editable-title'
import { Pill } from '@/components/pill'
import { PinToggle } from '@/components/pin-toggle'
import { TaskReferenceChip } from '@/components/reference-conflict-action'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { StatusDot } from '@/components/status-dot'
import { StatusGroupSection } from '@/components/task-status-groups'
import { TaskTable } from '@/components/task-table'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { deriveAttention } from '@/lib/attention'
import { isReadDoneItem, isUnread, unreadDoneCount, unreadMarkerTone } from '@/lib/read-state'
import {
  isColumnExpanded,
  normalizeExpandedColumns,
  taskColumnsForCapabilities,
  unifiedTableColumns,
  type NormalizedExpandedColumns,
  type TaskColumnDefinition,
  type TaskColumnIcon,
  type TaskColumnId,
} from '@/lib/task-columns'
import { ARCHIVED_WINDOW, BUCKET_ORDER, listCounts, runTitle, withArchivedPages, type BucketLabel, type ListView } from '@/lib/task-groups'
import { projectRunToTaskModel } from '@/lib/task-model'
import {
  archivedTabCount,
  availableOrigin,
  groupMembers,
  groupProjectRuns,
  matchesOrigin,
  originAutomationFlag,
  originCounts,
  parseOrigin,
  rowTasks,
  type TaskOrigin,
  type TaskStatusGroup,
} from '@/lib/task-origin'
import { useAutomationsAvailable } from '@/lib/capabilities'
import { useSearchParamsWriter, type SearchParamsUpdate } from '@/lib/use-search-params-writer'
import { useTaskListFoldsFromUrl } from '@/lib/use-task-list-folds'
import {
  filterRuns,
  finishedRunCount,
  formatCost,
  scheduledResume,
  taskReference,
  usageCells,
  workflowLabel,
  type UsageCell,
} from '@/lib/tasks-table'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { useTaskTableColumns } from '@/lib/use-task-table-columns'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

/** Archived runs older than the run list's window (#864). */
export type ArchivedPages = {
  runs: readonly RunSummary[]
  /** The search text these pages answer (`''` for the plain pages), or null while they are a
   *  previous text's pages kept on screen until the next ones load. */
  query: string | null
  /** Whether the server has an older page. */
  hasMore: boolean
  loading: boolean
  onLoadMore: () => void
  /** The last page request failed: the tab still shows what it has and offers a retry. */
  failed?: boolean
  /** Whether the unfiltered archive has an older page, whatever text these pages answer; absent
   *  while no unfiltered page has loaded. */
  plainHasMore?: boolean | undefined
}

const noAutomationName = () => undefined

/**
 * The Project Tasks overview at `/p/:projectId/` (hearsay-tools/squawk#4377).
 *
 * Uses two-tier chrome inside `<TablePage>` (Tier 1: title, scope, Active/Archived tabs, bulk
 * actions, New task CTA; Tier 2: search, origin filter, Columns popover, fold controls) and
 * renders both desktop summary rows and mobile cards through the shared `<TaskTable />` component.
 * The optional `Resource columns` detailed table remains available from the Columns popover.
 */
export function TasksOverview({
  runs,
  view,
  onViewChange,
  onArchiveFinished,
  archivePending = false,
  onMarkAllRead,
  onRename,
  onTogglePin,
  now = Date.now(),
  showTokens = true,
  showCost = true,
  expandedColumns = normalizeExpandedColumns(undefined),
  onToggleColumn = () => undefined,
  columnsPending = false,
  projectName,
  runners,
  error,
  onRetry,
  archivedPages,
  archivedTotal,
  onArchivedSearch,
  origin: originProp,
  onOriginChange,
  automations,
  urlQuery = '',
  onQueryChange,
  foldScope = 'project',
  automationName = noAutomationName,
}: {
  runs: RunSummary[] | undefined
  view: ListView
  onViewChange: (view: ListView) => void
  archivePending?: boolean
  onArchiveFinished: (automation?: boolean) => void
  onMarkAllRead: (automation?: boolean) => void
  onRename: (id: string, title: string) => void
  onTogglePin?: ((run: RunSummary, pinned: boolean) => void) | undefined
  now?: number
  showTokens?: boolean
  showCost?: boolean
  projectName?: string | undefined
  runners?: RunnersResponse | undefined
  expandedColumns?: NormalizedExpandedColumns
  onToggleColumn?: (id: TaskColumnId) => void
  columnsPending?: boolean
  error?: string | undefined
  onRetry?: (() => void) | undefined
  archivedPages?: ArchivedPages | undefined
  archivedTotal?: number | undefined
  onArchivedSearch?: (needle: string) => void
  origin?: TaskOrigin
  onOriginChange?: (origin: TaskOrigin) => void
  automations: boolean
  urlQuery?: string
  onQueryChange?: TasksQueryWriter
  foldScope?: string
  automationName?: (automationId: string) => string | undefined
}) {
  const [query, setQuery] = useUrlQuery(urlQuery, onQueryChange)
  React.useEffect(() => {
    onArchivedSearch?.(query.trim())
  }, [onArchivedSearch, query])
  const [origin, setOrigin] = useOriginOrOwn(originProp, onOriginChange, automations)
  const [detailedTable, setDetailedTable] = React.useState(false)
  const desktop = useIsDesktop()
  const all = React.useMemo(() => runs ?? [], [runs])
  const derived = React.useMemo(
    () => deriveProjectTaskGroups({ all, view, query, origin, archivedPages, archivedTotal, automationName }),
    [all, view, query, origin, archivedPages, archivedTotal, automationName],
  )
  const { groups, needle } = derived
  const resourceColumns = React.useMemo(
    () => taskColumnsForCapabilities({ tokens: showTokens, cost: showCost }),
    [showTokens, showCost],
  )
  const unifiedColumns = React.useMemo(() => unifiedTableColumns(), [])
  // A search shows every group holding a match, folded or not, without saving that choice.
  const revealed = new Set<BucketLabel>(needle ? groups.map((group) => group.label) : [])
  const folds = useTaskListFoldsFromUrl(foldScope, view, revealed, () => setQuery(''))
  const pinToggle = view === 'archived' ? undefined : onTogglePin

  return (
    <TaskTitleEditorProvider runs={archivedPages ? [...all, ...archivedPages.runs] : all} onRename={onRename}>
      <TablePage
        route="tasks"
        density={tasksOverviewDensity(runs, derived.visibleCount)}
        headerSpacing="compact"
        rootProps={tasksOverviewRootProps(detailedTable)}
        bodyClassName="gap-3"
        header={tasksOverviewHeader({
          projectName,
          status: (
            <TaskViewTabs
              view={view}
              onSelect={onViewChange}
              activeCount={derived.activeCount}
              archivedCount={derived.archivedCount}
              trailing={
                runs !== undefined && groups.length > 0 ? (
                  <ResultCount count={derived.visibleCount} incomplete={derived.incomplete} needle={needle} />
                ) : null
              }
            />
          ),
          secondaryActions: (
            <TaskBulkActions
              view={view}
              unread={derived.unread}
              finished={derived.finished}
              archivePending={archivePending}
              onMarkAllRead={() => onMarkAllRead(originAutomationFlag(origin))}
              onArchiveFinished={() => onArchiveFinished(originAutomationFlag(origin))}
            />
          ),
        })}
        sparseFooter={tasksOverviewSparseFooter(runs !== undefined, derived.visibleCount, view, needle)}
      >
        <TaskListFocusBoundary
          layout={`${desktop}:${detailedTable}`}
          revision={groups}
          visibilityRevision={JSON.stringify([BUCKET_ORDER.map(folds.isCollapsed), view, expandedColumns])}
          className="flex min-w-0 flex-1 flex-col gap-3"
        >
          <TaskControlStrip
            query={query}
            onQueryChange={setQuery}
            searchPlaceholder="Search tasks or automations…"
            searchLabel="Search tasks"
            origin={origin}
            originCounts={derived.originTotals}
            automations={automations}
            onOriginChange={setOrigin}
            columns={detailedTable ? resourceColumns : unifiedColumns}
            expandedColumns={expandedColumns}
            columnsPending={columnsPending}
            onToggleColumn={onToggleColumn}
            detailedTable={detailedTable}
            onToggleDetailed={() => setDetailedTable((value) => !value)}
            groupLabels={groups.map((group) => group.label)}
            onSetAllFolds={folds.setAll}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            {runs === undefined ? (
              <TasksLoading error={error} onRetry={onRetry} />
            ) : (
              <ProjectTaskResults
                view={view}
                query={query}
                origin={origin}
                onShowAll={() => {
                  setQuery('')
                  setOrigin('all')
                }}
                groups={groups}
                folds={folds}
                grouped={{
                  desktop,
                  detailedTable,
                  columns: resourceColumns,
                  expandedColumns,
                  onToggleColumn,
                  columnsPending,
                  onRename,
                  onTogglePin: pinToggle,
                  now,
                  showTokens,
                  showCost,
                  runners,
                  automationName,
                }}
              />
            )}
            {view === 'archived' && archivedPages ? <ArchivedOlder pages={archivedPages} /> : null}
          </div>
        </TaskListFocusBoundary>
      </TablePage>
    </TaskTitleEditorProvider>
  )
}

/** Hands the search text to the page; the page calls `written` with each trimmed text its
 *  debounced write puts in the URL. */
type TasksQueryWriter = (query: string, written: (query: string) => void) => void

function useUrlQuery(urlQuery: string, onQueryChange: TasksQueryWriter | undefined) {
  const [query, setQuery] = React.useState(urlQuery)
  const shown = React.useRef(urlQuery)
  const typed = React.useRef(urlQuery)
  const sent = React.useRef<string[]>([])
  React.useEffect(() => {
    if (urlQuery === shown.current) return
    shown.current = urlQuery
    const own = sent.current.indexOf(urlQuery)
    sent.current = own === -1 ? [] : sent.current.slice(own + 1)
    if (own === -1 && urlQuery !== typed.current) setQuery(urlQuery)
  }, [urlQuery])
  React.useEffect(() => {
    typed.current = query.trim()
    onQueryChange?.(query, (written) => {
      sent.current.push(written)
    })
  }, [onQueryChange, query])
  return [query, setQuery] as const
}

function useOriginOrOwn(
  origin: TaskOrigin | undefined,
  onChange: ((origin: TaskOrigin) => void) | undefined,
  automations: boolean,
) {
  const [own, setOwn] = React.useState<TaskOrigin>('all')
  return [availableOrigin(origin ?? own, automations), onChange ?? setOwn] as const
}

function deriveProjectTaskGroups({
  all,
  view,
  query,
  origin,
  archivedPages,
  archivedTotal,
  automationName,
}: {
  all: readonly RunSummary[]
  view: ListView
  query: string
  origin: TaskOrigin
  archivedPages: ArchivedPages | undefined
  archivedTotal: number | undefined
  automationName: (automationId: string) => string | undefined
}) {
  const needle = query.trim()
  const nameOf = (run: RunSummary) =>
    run.automationId === undefined ? '' : automationName(run.automationId) ?? run.automationId
  const answered = archivedPages?.query === needle
  const matched = new Set(answered ? archivedPages.runs.map((run) => run.id) : [])
  const paged = withArchivedPages(all, answered || needle === '' ? archivedPages?.runs ?? [] : []).slice(all.length)
  const listed = filterRuns(all, query, nameOf)
  const listedIds = new Set(listed.map((run) => run.id))
  const serverMatched = filterRuns(
    all.filter((run) => matched.has(run.id) && !listedIds.has(run.id)),
    '',
  )
  const inOrigin = (run: RunSummary) => matchesOrigin(run, origin)
  const groups = groupProjectRuns([...listed, ...serverMatched, ...filterRuns(paged, '')].filter(inOrigin), view, all)
  const withPages = withArchivedPages(all, archivedPages?.query === '' ? archivedPages.runs : [])
  const archivedFull = listCounts(all).archived >= ARCHIVED_WINDOW
  const scoped = all.filter(inOrigin)
  return {
    groups,
    needle,
    visibleCount: groups.reduce((total, group) => total + groupMembers(group).length, 0),
    originTotals: originCounts(withPages, view),
    activeCount: originCounts(all, 'active')[origin],
    archivedCount: archivedTabCount(all, withPages, origin, archivedPages?.plainHasMore, archivedTotal),
    incomplete: view === 'archived' && archivedFull && archivedPages?.hasMore !== false,
    finished: finishedRunCount(scoped),
    unread: unreadDoneCount(scoped),
  }
}

function ProjectTaskResults({
  view,
  query,
  origin,
  onShowAll,
  groups,
  folds,
  grouped,
}: {
  view: ListView
  query: string
  origin: TaskOrigin
  onShowAll: () => void
  groups: TaskStatusGroup<RunSummary>[]
  folds: ReturnType<typeof useTaskListFoldsFromUrl>
  grouped: Omit<React.ComponentProps<typeof GroupedTasks>, 'group' | 'showHeader' | 'showReference'>
}) {
  if (groups.length === 0) {
    return <TasksEmptyState view={view} query={query} origin={origin} onShowAll={onShowAll} />
  }
  const open = groups.filter((group) => !folds.isCollapsed(group.label))
  const showReference = open.some((group) =>
    group.rows.flatMap(rowTasks).some((run) => taskReference(run) !== undefined),
  )
  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => {
        const members = groupMembers(group)
        return (
          <StatusGroupSection
            key={group.label}
            id={`tasks-group-${view}-${group.label.replaceAll(' ', '-')}`}
            label={group.label}
            count={members.length}
            tone={headingTone(group.label, members)}
            folded={folds.isFolded(group.label)}
            collapsed={folds.isCollapsed(group.label)}
            onToggle={() => folds.toggle(group.label)}
          >
            <GroupedTasks group={group} showHeader={group === open[0]} showReference={showReference} {...grouped} />
          </StatusGroupSection>
        )
      })}
    </div>
  )
}

function TasksLoading({ error, onRetry }: { error?: string | undefined; onRetry?: (() => void) | undefined }) {
  return error ? (
    <div role="alert" className="rounded-xl border border-border bg-card p-6">
      <h2 className="text-lg">Could not load tasks</h2>
      <p className="mt-2 text-sm text-muted-foreground">{error}</p>
      <Button variant="outline" className="mt-4" onClick={onRetry}>
        Retry
      </Button>
    </div>
  ) : (
    <div role="status" aria-label="Loading tasks" className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
      Loading tasks…
    </div>
  )
}

function ArchivedOlder({ pages }: { pages: ArchivedPages }) {
  if (pages.failed) {
    return (
      <p role="alert" data-slot="archived-older-error" className="mt-3.5 flex items-center justify-center gap-2.5 text-[13px] text-muted-foreground">
        Could not load older archived tasks.
        <Button variant="outline" className="min-h-11" onClick={pages.onLoadMore}>
          Retry
        </Button>
      </p>
    )
  }
  if (!pages.hasMore) return null
  return (
    <Button
      data-slot="archived-older"
      variant="outline"
      className="mt-3.5 min-h-11 self-center"
      disabled={pages.loading}
      onClick={pages.onLoadMore}
    >
      {pages.loading ? 'Loading older archived…' : 'Show older archived'}
    </Button>
  )
}

function TasksEmptyState({
  view,
  query,
  origin = 'all',
  onShowAll,
}: {
  view: ListView
  query: string
  origin?: TaskOrigin
  onShowAll?: () => void
}) {
  const needle = query.trim()
  const kind = needle || origin !== 'all' ? 'search-miss' : view === 'archived' ? 'archive' : 'no-tasks'
  return (
    <div data-slot="tasks-empty" data-empty-kind={kind} className="flex flex-1 flex-col">
      {kind === 'search-miss' ? (
        <CenteredState
          heading="h2"
          icon={<SearchXIcon />}
          tone="neutral"
          title="No matching tasks"
          subtitle={
            needle
              ? `No tasks match “${needle}”.`
              : origin === 'automations'
                ? 'No automation started a task here.'
                : 'No task here was started directly.'
          }
          actions={
            onShowAll ? (
              <Button variant="outline" className="min-h-11" data-action="clear-task-filters" onClick={onShowAll}>
                Show all tasks
              </Button>
            ) : undefined
          }
        />
      ) : kind === 'archive' ? (
        <CenteredState
          heading="h2"
          icon={<ArchiveIcon />}
          tone="neutral"
          title="Nothing archived yet"
          subtitle="Finished tasks you archive land here."
        />
      ) : (
        <CenteredState
          heading="h2"
          icon={<ListChecksIcon />}
          tone="primary"
          backdrop
          title="No tasks yet"
          subtitle="Describe a task to get started."
          actions={
            <Button asChild>
              <Link to="/new">
                <PlusIcon aria-hidden="true" />
                New task
              </Link>
            </Button>
          }
        />
      )}
    </div>
  )
}

type GroupedTask = { run: RunSummary; queuePosition: number | null }

function GroupedTasks({
  showHeader,
  showReference,
  desktop,
  group,
  detailedTable,
  columns,
  expandedColumns,
  onToggleColumn,
  columnsPending,
  onRename,
  onTogglePin,
  now,
  showTokens,
  showCost,
  runners,
  automationName,
}: {
  showHeader: boolean
  showReference: boolean
  desktop: boolean
  group: TaskStatusGroup<RunSummary>
  detailedTable: boolean
  columns: readonly TaskColumnDefinition[]
  expandedColumns: NormalizedExpandedColumns
  onToggleColumn: (id: TaskColumnId) => void
  columnsPending: boolean
  onRename: (id: string, title: string) => void
  onTogglePin?: ((run: RunSummary, pinned: boolean) => void) | undefined
  now: number
  showTokens: boolean
  showCost: boolean
  runners?: RunnersResponse | undefined
  automationName: (automationId: string) => string | undefined
}) {
  const rows: GroupedTask[] = React.useMemo(
    () =>
      group.rows.flatMap((row) =>
        rowTasks(row).map((run) => ({ run, queuePosition: run.status === 'queued' ? row.queuePosition : null })),
      ),
    [group.rows],
  )
  const models = React.useMemo(
    () =>
      rows.map(({ run, queuePosition }) =>
        projectRunToTaskModel({
          run,
          queuePosition,
          runners,
          automationName,
          now,
        }),
      ),
    [rows, runners, automationName, now],
  )

  const handleTogglePin = React.useCallback(
    (item: { run: RunSummary }, pinned: boolean) => {
      onTogglePin?.(item.run, pinned)
    },
    [onTogglePin],
  )

  if (desktop && detailedTable) {
    return (
      <div data-slot="tasks-table" className="overflow-x-auto rounded-lg border border-border bg-card">
        <TooltipProvider>
          <div
            role="table"
            aria-rowcount={rows.length + 1}
            className="task-resource-grid"
            style={taskResourceGrid(columns, expandedColumns) as React.CSSProperties}
          >
            <div role="row" aria-rowindex={1} className="task-resource-row">
              {columns.map((column) => (
                <TaskColumnHeader
                  key={column.id}
                  column={column}
                  expanded={isColumnExpanded(column.id, expandedColumns)}
                  onToggle={onToggleColumn}
                  disabled={columnsPending}
                />
              ))}
            </div>
            <TaskListItems itemSize={50} items={rows} itemKey={({ run }) => run.id}>
              {({ run, queuePosition }, index) => (
                <TableRow
                  rowIndex={index + 2}
                  run={run}
                  queuePosition={queuePosition}
                  onRename={onRename}
                  onTogglePin={onTogglePin}
                  now={now}
                  columns={columns}
                  expandedColumns={expandedColumns}
                  automationName={automationName}
                />
              )}
            </TaskListItems>
          </div>
        </TooltipProvider>
      </div>
    )
  }

  return (
    <TaskTable
      items={models}
      density={desktop ? 'table' : 'card'}
      now={now}
      showHeader={showHeader}
      showProject={false}
      showReferences={showReference}
      expandedColumns={expandedColumns}
      showTokens={showTokens}
      showCost={showCost}
      scopedLinks
      liveUsageSource="stream"
      allowRename={desktop}
      onTogglePin={onTogglePin ? handleTogglePin : undefined}
    />
  )
}

function Th({
  children,
  right = false,
  columnId,
  folded = false,
}: {
  children: React.ReactNode
  right?: boolean
  columnId: TaskColumnId
  folded?: boolean
}) {
  return (
    <div
      role="columnheader"
      data-column-id={columnId}
      data-folded={folded || undefined}
      className={cn(
        'h-[38px] border-b border-border px-2.5 text-left text-[11px] font-semibold tracking-[0.05em] whitespace-nowrap text-supporting-foreground uppercase first:pl-4 last:pr-4',
        right && 'text-right',
        folded && 'px-0 first:pl-0 last:pr-0',
      )}
    >
      {children}
    </div>
  )
}

function TaskColumnHeader({
  column,
  expanded,
  onToggle,
  disabled,
}: {
  column: TaskColumnDefinition
  expanded: boolean
  onToggle: (id: TaskColumnId) => void
  disabled: boolean
}) {
  if (!column.canFold) {
    return (
      <Th columnId={column.id} right={column.align === 'right'}>
        {column.label}
      </Th>
    )
  }

  const action = expanded ? 'Fold' : 'Expand'
  return (
    <Th columnId={column.id} right={column.align === 'right'} folded={!expanded}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`${action} ${column.label} column`}
            aria-pressed={expanded}
            disabled={disabled}
            onClick={() => onToggle(column.id)}
            className={cn(
              'inline-flex h-8 w-full items-center gap-1 rounded-sm px-0.5 text-inherit outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-wait disabled:opacity-60',
              column.align === 'right' ? 'justify-end' : 'justify-start',
              !expanded && 'justify-center px-0',
            )}
          >
            {expanded ? (
              <>
                <span>{column.label}</span>
                <ChevronsLeftIcon className="size-3 opacity-55" aria-hidden="true" />
              </>
            ) : (
              <>
                <TaskColumnIconView icon={column.icon} />
                <ChevronsRightIcon className="size-3 opacity-70" aria-hidden="true" />
              </>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {column.label} · {action} column
        </TooltipContent>
      </Tooltip>
    </Th>
  )
}

function TaskColumnIconView({ icon }: { icon?: TaskColumnIcon | undefined }) {
  const className = 'size-3.5'
  switch (icon) {
    case 'workflow':
      return <WorkflowIcon className={className} aria-hidden="true" />
    case 'branch':
      return <GitBranchIcon className={className} aria-hidden="true" />
    case 'diff':
      return <FileDiffIcon className={className} aria-hidden="true" />
    case 'reference':
      return <LinkIcon className={className} aria-hidden="true" />
    case 'tokens':
      return <CoinsIcon className={className} aria-hidden="true" />
    case 'cost':
      return <DollarSignIcon className={className} aria-hidden="true" />
    case 'cpu':
      return <CpuIcon className={className} aria-hidden="true" />
    case 'memory':
      return <MemoryStickIcon className={className} aria-hidden="true" />
    case 'started':
      return <Clock3Icon className={className} aria-hidden="true" />
    default:
      return null
  }
}

const TD_BASE = 'h-[88px] border-b border-border px-2.5 whitespace-nowrap first:pl-4 last:pr-4'

const TableRow = React.memo(function TableRow({
  rowIndex,
  run,
  queuePosition,
  onRename,
  onTogglePin,
  now,
  columns,
  expandedColumns,
  automationName,
}: {
  rowIndex: number
  run: RunSummary
  queuePosition: number | null
  onRename: (id: string, title: string) => void
  onTogglePin?: ((run: RunSummary, pinned: boolean) => void) | undefined
  now: number
  columns: readonly TaskColumnDefinition[]
  expandedColumns: NormalizedExpandedColumns
  automationName: (automationId: string) => string | undefined
}) {
  const navigate = useNavigate()
  const attention = deriveAttention(run)
  const scheduled = scheduledResume(run)
  const to = `/tasks/${run.id}`
  const cost = formatCost(run.costUsd)
  const reference = taskReference(run)

  return (
    <div
      role="row"
      aria-rowindex={rowIndex}
      data-slot="task-table-row"
      data-run-id={run.id}
      onClick={(event) => {
        if ((event.target as Element).closest('a, button, input')) return
        navigate(to)
      }}
      className="task-resource-row group/row cursor-pointer hover:bg-muted"
    >
      {columns.map((column) => {
        if (column.id === 'memory') return null
        if (column.id === 'cpu') {
          const cpuExpanded = isColumnExpanded('cpu', expandedColumns)
          const memoryExpanded = isColumnExpanded('memory', expandedColumns)
          return queuePosition !== null && (cpuExpanded || memoryExpanded) ? (
            <div
              role="cell"
              key={column.id}
              data-slot="queue-note"
              data-column-id="cpu-memory"
              aria-colspan={2}
              style={{ gridColumn: 'span 2' }}
              className={cn(TD_BASE, 'text-right font-mono text-[11px] text-supporting-foreground')}
            >
              #{queuePosition} in queue
            </div>
          ) : (
            <UsageTds key={column.id} run={run} cpuExpanded={cpuExpanded} memoryExpanded={memoryExpanded} />
          )
        }
        return (
          <TaskTableCell
            key={column.id}
            column={column}
            expanded={isColumnExpanded(column.id, expandedColumns)}
            run={run}
            attention={attention}
            scheduled={scheduled}
            reference={reference}
            cost={cost}
            to={to}
            onRename={onRename}
            onTogglePin={onTogglePin}
            now={now}
            automationName={automationName}
          />
        )
      })}
    </div>
  )
})

function DetailedTaskCell({
  run,
  to,
  onRename,
  onTogglePin,
  automationName,
}: {
  run: RunSummary
  to: string
  onRename: (id: string, title: string) => void
  onTogglePin?: ((run: RunSummary, pinned: boolean) => void) | undefined
  automationName: (automationId: string) => string | undefined
}) {
  const autoLabel =
    run.automationId !== undefined ? automationName(run.automationId) ?? run.automationId : undefined
  return (
    <div role="cell" data-column-id="task" className={cn(TD_BASE, 'min-w-[320px] max-w-0 whitespace-normal')}>
      <TitleCell lines={2} run={run} to={to} onRename={onRename} onTogglePin={onTogglePin} />
      {autoLabel ? (
        <div className="mt-1">
          <span
            data-slot="task-automation-badge"
            data-origin="automation"
            className="inline-flex max-w-[180px] items-center gap-1 truncate rounded-full border border-info/30 bg-info/10 px-2 py-px text-[11px] font-medium text-info"
          >
            <ZapIcon className="size-2.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{autoLabel}</span>
          </span>
        </div>
      ) : null}
    </div>
  )
}

function DetailedStatusCell({
  attention,
  scheduled,
}: {
  attention: ReturnType<typeof deriveAttention>
  scheduled: ReturnType<typeof scheduledResume>
}) {
  return (
    <div role="cell" data-column-id="status" className={cn(TD_BASE, 'overflow-hidden')}>
      <Pill
        dot={attention.tone}
        shape={attention.shape}
        pulse={attention.pulse}
        title={scheduled?.title ?? attention.label}
        className="w-full max-w-full overflow-hidden"
      >
        <span className="min-w-0 truncate">
          {attention.label}
          {scheduled ? (
            <>
              {' '}
              <span className="tabular-nums">{scheduled.label}</span>
            </>
          ) : null}
        </span>
      </Pill>
    </div>
  )
}

function TaskTableCell({
  column,
  expanded,
  run,
  attention,
  scheduled,
  reference,
  cost,
  to,
  onRename,
  onTogglePin,
  now,
  automationName,
}: {
  column: TaskColumnDefinition
  expanded: boolean
  run: RunSummary
  attention: ReturnType<typeof deriveAttention>
  scheduled: ReturnType<typeof scheduledResume>
  reference: ReturnType<typeof taskReference>
  cost: string
  to: string
  onRename: (id: string, title: string) => void
  onTogglePin?: ((run: RunSummary, pinned: boolean) => void) | undefined
  now: number
  automationName: (automationId: string) => string | undefined
}) {
  if (!expanded) return <FoldedTd column={column.id} />

  switch (column.id) {
    case 'status':
      return <DetailedStatusCell attention={attention} scheduled={scheduled} />
    case 'task':
      return (
        <DetailedTaskCell
          run={run}
          to={to}
          onRename={onRename}
          onTogglePin={onTogglePin}
          automationName={automationName}
        />
      )
    case 'workflow':
      return (
        <div role="cell" data-column-id={column.id} className={cn(TD_BASE, 'max-w-0 truncate text-[13px] text-muted-foreground')}>
          {workflowLabel(run)}
        </div>
      )
    case 'branch':
      return (
        <div role="cell" data-column-id={column.id} className={cn(TD_BASE, 'max-w-0 overflow-hidden')}>
          {run.branch ? <BranchChip branch={run.branch} /> : <Dash />}
        </div>
      )
    case 'diff':
      return (
        <div role="cell" data-column-id={column.id} className={cn(TD_BASE, 'overflow-hidden')}>
          {run.diffStat ? <DiffStat stat={run.diffStat} compact className="block max-w-full" /> : <Dash />}
        </div>
      )
    case 'reference':
      return (
        <div role="cell" data-column-id={column.id} className={cn(TD_BASE, 'overflow-hidden')}>
          {reference ? (
            <TaskReferenceChip run={run} reference={reference} compact className="max-w-full overflow-hidden" />
          ) : (
            <Dash />
          )}
        </div>
      )
    case 'tokens': {
      const tokensLabel = directionalUsageLabel(run.inputTokens, run.outputTokens)
      return (
        <div role="cell" data-column-id={column.id} className={cn(TD_BASE, 'text-right text-xs text-muted-foreground')}>
          <DirectionalUsage
            inputTokens={run.inputTokens}
            outputTokens={run.outputTokens}
            variant="table"
            omitWhenUnknown={false}
            title={tokensLabel}
            className="block max-w-full overflow-hidden text-ellipsis"
          />
        </div>
      )
    }
    case 'cost':
      return (
        <div
          role="cell"
          data-column-id={column.id}
          className={cn(TD_BASE, 'text-right font-mono text-xs text-muted-foreground tabular-nums')}
        >
          {cost ? <BoundedMetric text={cost} accessibleText={`$${run.costUsd}`} /> : <Dash />}
        </div>
      )
    case 'started':
      return (
        <div role="cell" data-column-id={column.id} className={cn(TD_BASE, 'text-right text-xs text-supporting-foreground')}>
          <RelativeTime iso={run.startedAt ?? run.createdAt} now={now} />
        </div>
      )
    default:
      return null
  }
}

function FoldedTd({ column }: { column: TaskColumnId }) {
  return (
    <div
      role="cell"
      aria-hidden="true"
      data-column-id={column}
      data-folded="true"
      className={cn(TD_BASE, 'px-0 first:pl-0 last:pr-0')}
    />
  )
}

function TitleCell({
  run,
  to,
  onTogglePin,
  lines = 1,
}: {
  run: RunSummary
  to: string
  lines?: 1 | 2
  onRename: (id: string, title: string) => void
  onTogglePin?: ((run: RunSummary, pinned: boolean) => void) | undefined
}) {
  const title = runTitle(run)
  const editor = useTaskTitleEditor(run)
  const unread = isUnread(run)
  const readDone = isReadDoneItem(run)

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

  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', lines === 1 ? 'h-[18px]' : 'min-h-[18px]')}>
      {run.delegation?.role === 'worker' ? <span className="shrink-0 text-xs text-muted-foreground">Worker</span> : null}
      <Link
        data-task-control="title"
        to={to}
        title={title}
        className={cn(
          taskTitleClass(unread, readDone, lines),
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link-foreground',
        )}
      >
        {title}
      </Link>
      {unread ? (
        <StatusDot
          tone={unreadMarkerTone(run)}
          role="img"
          aria-label="unread"
          title="Unread — not opened since it finished"
          className="shrink-0"
        />
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
          pinned={Boolean(run.pinned)}
          onToggle={(pinned) => onTogglePin(run, pinned)}
          className="size-[19px] opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 no-hover:opacity-100 data-[pinned=true]:opacity-100"
        />
      ) : null}
    </span>
  )
}

function UsageTds({
  run,
  cpuExpanded,
  memoryExpanded,
}: {
  run: RunSummary
  cpuExpanded: boolean
  memoryExpanded: boolean
}) {
  const sample = useRunUsage(run.id)
  const cells = usageCells(run, sample)
  return (
    <>
      {cpuExpanded ? <UsageTd column="cpu" cell={cells.cpu} /> : <FoldedTd column="cpu" />}
      {memoryExpanded ? <UsageTd column="memory" cell={cells.mem} /> : <FoldedTd column="memory" />}
    </>
  )
}

function UsageTd({ column, cell }: { column: 'cpu' | 'memory'; cell: UsageCell }) {
  const accessibleText = cell.text && cell.title ? `${cell.text}; ${cell.title}` : cell.text
  return (
    <div
      role="cell"
      data-usage={column === 'memory' ? 'mem' : column}
      data-column-id={column}
      data-usage-kind={cell.kind}
      className={cn(
        TD_BASE,
        'overflow-hidden text-right font-mono tabular-nums',
        cell.kind === 'live' && 'bg-accent-strong/5 text-xs font-medium text-foreground',
        cell.kind === 'peak' && 'text-[11px] text-supporting-foreground',
        cell.kind === 'none' && 'text-xs text-soft-foreground',
      )}
    >
      <BoundedMetric text={cell.text || '—'} accessibleText={accessibleText || undefined} />
    </div>
  )
}

function BoundedMetric({ text, accessibleText }: { text: string; accessibleText?: string | undefined }) {
  return (
    <span
      data-slot="bounded-metric"
      {...(accessibleText ? { 'aria-label': accessibleText, title: accessibleText } : {})}
      className="block max-w-full overflow-hidden text-ellipsis"
    >
      {text}
    </span>
  )
}

export function TasksOverviewRoute() {
  const runs = useRuns()
  const runners = useRunners()
  const health = useHealth()
  const metricVisibility = usageMetricVisibility(health.data)
  const automations = useAutomationsAvailable()
  const { view, setView, origin, setOrigin, urlQuery, writeQuery } = useTasksUrlState()
  const writer = useRunCacheWriter()
  const queryClient = useQueryClient()
  const archived = useArchivedPages(runs.data, view)
  const archive = useMutation({
    mutationFn: (automation?: boolean) => archiveFinished(projectAddress(), undefined, automation),
    onSuccess: () => writer.invalidateAfter('runs', () => projectAddress()),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const markAllRead = useMutation({
    mutationFn: (automation?: boolean) => markAllRunsSeen(automation),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => patchRun(id, { title }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const pin = usePinRun()
  const now = useNow(30_000)
  const taskTableColumns = useTaskTableColumns()
  const projectId = useReferenceProjectId()
  const repoBase = useProjectRepoBase(undefined, { retryOnMount: false })
  const projects = useProjects({ retryOnMount: false })
  const projectName = projects.data?.projects?.find((project) => project.id === projectId)?.name
  const hasAutomationTasks = [...(runs.data ?? []), ...(archived.pages?.runs ?? [])].some(
    (run) => run.automationId !== undefined,
  )
  const automationNameIn = useAutomationNames([undefined], automations && hasAutomationTasks)
  const automationName = React.useCallback(
    (automationId: string) => automationNameIn(undefined, automationId),
    [automationNameIn],
  )
  const referenceRequests = React.useMemo(
    () =>
      projectId === undefined
        ? []
        : (runs.data ?? []).flatMap((run) => {
            const reference = taskReference(run)
            return reference ? [{ projectId, kind: reference.kind, number: reference.number }] : []
          }),
    [runs.data, projectId],
  )

  const onRename = React.useCallback((id: string, title: string) => rename.mutate({ id, title }), [rename.mutate])
  const onTogglePin = React.useCallback(
    (run: RunSummary, pinned: boolean) => pin.mutate({ id: run.id, pinned }),
    [pin.mutate],
  )

  return (
    <ReferenceStatusProvider projectId={projectId} repoBase={repoBase} requests={referenceRequests}>
      <TasksOverview
        runs={runs.data}
        runners={runners.data}
        projectName={projectName}
        error={runs.error?.message}
        onRetry={() => void runs.refetch()}
        view={view}
        onViewChange={setView}
        origin={origin}
        onOriginChange={setOrigin}
        automations={automations}
        urlQuery={urlQuery}
        onQueryChange={writeQuery}
        foldScope={`project:${projectId ?? 'default'}`}
        automationName={automationName}
        onArchiveFinished={(automation) => {
          if (!archive.isPending) archive.mutate(automation)
        }}
        archivePending={archive.isPending}
        onMarkAllRead={(automation) => markAllRead.mutate(automation)}
        onRename={onRename}
        onTogglePin={onTogglePin}
        now={now}
        showTokens={metricVisibility.tokens}
        showCost={metricVisibility.cost}
        expandedColumns={taskTableColumns.expandedColumns}
        onToggleColumn={taskTableColumns.toggleColumn}
        columnsPending={taskTableColumns.isPending}
        archivedPages={archived.pages}
        archivedTotal={archived.total}
        onArchivedSearch={archived.search}
      />
    </ReferenceStatusProvider>
  )
}

function setParam(key: string, value: string | null): SearchParamsUpdate {
  return (current) => {
    if (value === null) current.delete(key)
    else current.set(key, value)
    return current
  }
}

function useTasksUrlState() {
  const [searchParams, write] = useSearchParamsWriter()
  const urlView: ListView = searchParams.get('archived') === '1' ? 'archived' : 'active'
  const urlOrigin = parseOrigin(searchParams.get('origin'))
  const [view, setViewState] = React.useState(urlView)
  const [origin, setOriginState] = React.useState(urlOrigin)
  React.useEffect(() => setViewState(urlView), [urlView])
  React.useEffect(() => setOriginState(urlOrigin), [urlOrigin])
  const urlQuery = searchParams.get('q') ?? ''
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  React.useEffect(() => {
    const pending = timer
    return () => clearTimeout(pending.current)
  }, [])
  const writeQuery = React.useCallback<TasksQueryWriter>(
    (query, written) => {
      clearTimeout(timer.current)
      const trimmed = query.trim()
      timer.current = setTimeout(
        () =>
          write((current) => {
            const previousQuery = current.get('q')
            const next = setParam('q', trimmed === '' ? null : trimmed)(current)
            if (next.get('q') !== previousQuery) written(trimmed)
            return next
          }),
        QUERY_DEBOUNCE_MS,
      )
    },
    [write],
  )
  return {
    view,
    setView: (next: ListView) => {
      setViewState(next)
      write(setParam('archived', next === 'archived' ? '1' : null))
    },
    origin,
    setOrigin: (next: TaskOrigin) => {
      setOriginState(next)
      write(setParam('origin', next === 'all' ? null : next))
    },
    urlQuery,
    writeQuery,
  }
}

const QUERY_DEBOUNCE_MS = 250
