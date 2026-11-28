import { GlobalTasksEmptyState, GlobalTasksLoadError, OtherProjects, TruncatedNotice } from './global-tasks-states'
import { FilterBar, panelFacetCount } from './global-tasks-filter-bar'
import { TaskListFocusBoundary } from '@/components/task-list-items'
import { projectAddress, runAddress } from '@/api/run-address'
import { useRunCacheWriter } from '@/api/use-run-cache-writer'
import './task-lists.css'
import {
  TaskBulkActions,
  TaskControlStrip,
  TaskViewTabs,
  headingTone,
} from './task-list-parts'
import {
  PageShellActionButton,
  PageShellSparseFooter,
  TablePage,
  pageShellDensity,
} from '@/components/page-shell'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PlusIcon, SlidersHorizontalIcon } from '@/components/design-icons'
import * as React from 'react'
import { useIsDesktop } from '@/lib/use-desktop'
import { Link } from 'react-router'
import { archiveFinished, archiveRun, markAllRunsSeen, pinRun, setRunRead } from '@/api/client'
import {
  queryKeys,
  rememberReferenceStatuses,
  useAutomationNames,
  useHealth,
  useProjects,
  useRunsIndex,
  workspaceQueryKeys,
} from '@/api/queries'
import { useRunners } from '@/api/runners'
import type { RunIndexEntry, RunnersResponse } from '@open-mercato/cezar-api-client'
import { Count } from '@/components/data-primitives'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { StatusGroupSection } from '@/components/task-status-groups'
import { TaskTable } from '@/components/task-table'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import {
  finishedRunCount,
  isOwnRepoReference,
  taskReferences,
} from '@/lib/tasks-table'
import {
  NO_FILTERS,
  filterGlobalTasks,
  urlStateFromSearchParams,
  urlStateToSearchParams,
  groupGlobalTasks,
  hasActiveFilters,
  tagValuesOf,
  tasksExcludingFacet,
  toGlobalTasks,
  toggleFacetValue,
  withOrigin,
  truncatedProjectNames,
  type FacetId,
  type GlobalTask,
  type GlobalTaskFilters,
  type GlobalTasksUrlState,
  type GroupBy,
  type TaskGroup,
} from '@/lib/global-tasks'
import { scopeTo } from '@/lib/project-router'
import { isUnread, unreadDoneCount } from '@/lib/read-state'
import { unifiedTableColumns, type NormalizedExpandedColumns } from '@/lib/task-columns'
import { BUCKET_ORDER, type BucketLabel, type ListView } from '@/lib/task-groups'
import { globalTaskToTaskModel, type TaskRowModel } from '@/lib/task-model'
import {
  groupIndexedTasks,
  groupMembers,
  matchesOrigin,
  originAutomationFlag,
  originCounts,
  rowTasks,
  type TaskOrigin,
  type TaskStatusGroup,
} from '@/lib/task-origin'
import { useAutomationsAvailable } from '@/lib/capabilities'
import { useSearchParamsWriter } from '@/lib/use-search-params-writer'
import { useTaskListFolds } from '@/lib/use-task-list-folds'
import { useTaskTableColumns } from '@/lib/use-task-table-columns'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

/** Backstop polling interval on top of `/workspace/events` stream invalidations. */
const RUNS_INDEX_POLL_MS = 15_000
/** Search input debounce before updating the URL. */
const QUERY_DEBOUNCE_MS = 250
/** Archivable statuses — outcomes, not human gates. */
const ARCHIVABLE_STATUSES: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled'])

type IndexedRunTarget = { projectId: string; runId: string }

/** Archive (or restore) one indexed run in its own project. */
function useArchiveIndexedRun() {
  return useIndexedRunMutation({
    request: ({ projectId, runId, archived }: IndexedRunTarget & { archived: boolean }) =>
      archiveRun(runAddress(runId, { projectId }), archived),
    patch: ({ archived }) => (run) => ({ ...run, archived }),
  })
}

/** Mark one indexed run read or unread in its own project. */
function useReadIndexedRun() {
  return useIndexedRunMutation({
    request: ({ projectId, runId, read }: IndexedRunTarget & { read: boolean }) =>
      setRunRead(runAddress(runId, { projectId }), read),
    patch:
      ({ read }) =>
      (run) => {
        if (read) return { ...run, seenAt: new Date().toISOString() }
        const { seenAt: _dropped, ...rest } = run
        return rest
      },
  })
}

/** Pin or unpin one indexed run in its own project. */
function usePinIndexedRun() {
  return useIndexedRunMutation({
    request: ({ projectId, runId, pinned }: IndexedRunTarget & { pinned: boolean }) =>
      pinRun(runAddress(runId, { projectId }), pinned),
    patch: ({ pinned }) => (run) => ({ ...run, pinned }),
  })
}

function useIndexedRunMutation<V extends IndexedRunTarget>({
  request,
  patch,
}: {
  request: (variables: V) => Promise<unknown>
  patch: (variables: V) => (run: RunIndexEntry) => RunIndexEntry
}) {
  const writer = useRunCacheWriter()
  return useMutation({
    mutationFn: request,
    onMutate: (variables: V) =>
      writer.patchIndex(runAddress(variables.runId, { projectId: variables.projectId }), () =>
        patch(variables),
      ),
    onError: (error: Error, _variables, context) => {
      context?.rollback()
      toast(error.message, { tone: 'danger' })
    },
    onSettled: (_data, _error, { projectId, runId }, context) => {
      if (context) context.settle()
      else writer.invalidateAfter('indexed', runAddress(runId, { projectId }))
    },
  })
}

/**
 * Bulk cross-project sweep helper: fires one project-scoped request per affected project in
 * parallel, surfaces any rejection, and invalidates the workspace runs index.
 */
async function runAcrossProjects(
  projectIds: readonly string[],
  action: (projectId: string) => Promise<unknown>,
): Promise<void> {
  if (projectIds.length === 0) return
  const results = await Promise.allSettled(projectIds.map((projectId) => action(projectId)))
  const firstFailure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (firstFailure) {
    const message = firstFailure.reason instanceof Error ? firstFailure.reason.message : String(firstFailure.reason)
    throw new Error(message)
  }
}

/**
 * Filter loaded tasks to the bulk-action scope: active origin plus any selected Project or Tag
 * filter. Search text and status/workflow facets do not narrow bulk actions.
 */
function selectBulkScopeTasks(
  tasks: readonly GlobalTask[],
  origin: TaskOrigin,
  filters: GlobalTaskFilters,
): GlobalTask[] {
  const projectSet = filters.projects && filters.projects.length > 0 ? new Set(filters.projects) : undefined
  const tagSet =
    filters.tags.length > 0 ? new Set(filters.tags.map((tag) => tag.toLowerCase())) : undefined
  return tasks.filter((task) => {
    if (!matchesOrigin(task.run, origin)) return false
    if (projectSet && !projectSet.has(task.run.projectId)) return false
    if (tagSet) {
      const taskTags = tagValuesOf(task)
      if (!taskTags.some((tag) => tagSet.has(tag.toLowerCase()))) return false
    }
    return true
  })
}

function globalTasksHeader({
  projectCount,
  bootProject,
  status,
  secondaryActions,
}: {
  projectCount: number
  bootProject: string | undefined
  status: React.ReactNode
  secondaryActions: React.ReactNode
}) {
  return {
    title: 'All tasks',
    status: (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {projectCount > 0 ? (
          <span data-slot="tasks-project-scope" className="text-xs font-medium text-muted-foreground tabular-nums">
            {projectCount} {projectCount === 1 ? 'project' : 'projects'}
          </span>
        ) : null}
        {status}
      </div>
    ),
    secondaryActions,
    primaryAction: (
      <PageShellActionButton asChild variant="primary" data-slot="new-task-inline">
        <Link to={scopeTo(bootProject ?? 'default', '/new')}>
          <PlusIcon aria-hidden="true" />
          New task
        </Link>
      </PageShellActionButton>
    ),
  }
}

function globalTasksSparseFooter(
  ready: boolean,
  visibleCount: number,
  filtered: boolean,
  bootProject: string | undefined,
) {
  if (!ready || visibleCount <= 0 || filtered) return undefined
  return (
    <PageShellSparseFooter
      summary={`Showing ${visibleCount} ${visibleCount === 1 ? 'task' : 'tasks'} across registered projects.`}
      actions={
        <Button variant="outline" size="sm" asChild className="max-md:min-h-11">
          <Link to={scopeTo(bootProject ?? 'default', '/new')}>Start a task</Link>
        </Button>
      }
    />
  )
}

/**
 * Global Tasks page at `/tasks` (hearsay-tools/squawk#4377).
 *
 * Shares the two-tier `<TablePage>` chrome, `<TaskControlStrip>`, `<TaskColumnsPopover>`,
 * `<TaskBulkActions>`, and `<TaskTable />` primitives with Project Tasks, adding automatic project
 * badges, cross-project pinning, column selection, and origin+Project/Tag-scoped bulk actions.
 */
function useGlobalBulkActions({
  tasks,
  origin,
  filters,
}: {
  tasks: readonly GlobalTask[]
  origin: TaskOrigin
  filters: GlobalTaskFilters
}) {
  const queryClient = useQueryClient()
  const bulkScopeTasks = React.useMemo(
    () => selectBulkScopeTasks(tasks, origin, filters),
    [tasks, origin, filters],
  )
  const bulkRuns = React.useMemo(() => bulkScopeTasks.map((task) => task.run), [bulkScopeTasks])
  const unread = React.useMemo(() => unreadDoneCount(bulkRuns), [bulkRuns])
  const finished = React.useMemo(() => finishedRunCount(bulkRuns), [bulkRuns])

  const invalidate = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.runsIndex })
    void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
  }, [queryClient])

  const markAllRead = useMutation({
    mutationFn: (projectIds: readonly string[]) =>
      runAcrossProjects(projectIds, (projectId) =>
        markAllRunsSeen(originAutomationFlag(origin), projectAddress({ projectId })),
      ),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
    onSettled: invalidate,
  })
  const archiveAllFinished = useMutation({
    mutationFn: (projectIds: readonly string[]) =>
      runAcrossProjects(projectIds, (projectId) =>
        archiveFinished(projectAddress({ projectId }), undefined, originAutomationFlag(origin)),
      ),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
    onSettled: invalidate,
  })

  const onMarkAllRead = React.useCallback(() => {
    if (markAllRead.isPending) return
    const projectIds = [
      ...new Set(bulkScopeTasks.filter((task) => isUnread(task.run)).map((task) => task.run.projectId)),
    ]
    if (projectIds.length > 0) markAllRead.mutate(projectIds)
  }, [bulkScopeTasks, markAllRead])

  const onArchiveFinished = React.useCallback(() => {
    if (archiveAllFinished.isPending) return
    const projectIds = [
      ...new Set(
        bulkScopeTasks
          .filter((task) => !task.run.archived && ARCHIVABLE_STATUSES.has(task.run.status))
          .map((task) => task.run.projectId),
      ),
    ]
    if (projectIds.length > 0) archiveAllFinished.mutate(projectIds)
  }, [bulkScopeTasks, archiveAllFinished])

  return {
    unread,
    finished,
    archivePending: archiveAllFinished.isPending,
    markReadPending: markAllRead.isPending,
    onMarkAllRead,
    onArchiveFinished,
  }
}

function useGlobalRowActions() {
  const { mutate: mutateArchive, isPending: archivePending } = useArchiveIndexedRun()
  const { mutate: mutateRead, isPending: readPending } = useReadIndexedRun()
  const { mutate: mutatePin, isPending: pinPending } = usePinIndexedRun()

  const onArchive = React.useCallback(
    (item: TaskRowModel, archived: boolean) => {
      if (item.projectId) mutateArchive({ projectId: item.projectId, runId: item.runId, archived })
    },
    [mutateArchive],
  )
  const onSetRead = React.useCallback(
    (item: TaskRowModel, read: boolean) => {
      if (item.projectId) mutateRead({ projectId: item.projectId, runId: item.runId, read })
    },
    [mutateRead],
  )
  const onTogglePin = React.useCallback(
    (item: TaskRowModel, pinned: boolean) => {
      if (item.projectId) mutatePin({ projectId: item.projectId, runId: item.runId, pinned })
    },
    [mutatePin],
  )
  return {
    onArchive,
    onSetRead,
    onTogglePin,
    busy: archivePending || readPending || pinPending,
  }
}

export function GlobalTasksRoute() {
  const desktop = useIsDesktop()
  const projects = useProjects()
  const runners = useRunners()
  const health = useHealth()
  const metrics = usageMetricVisibility(health.data)
  const index = useRunsIndex(true, RUNS_INDEX_POLL_MS)
  const taskTableColumns = useTaskTableColumns()
  const unifiedColumns = React.useMemo(() => unifiedTableColumns(), [])
  const [searchParams, writeSearchParams] = useSearchParamsWriter()
  const automations = useAutomationsAvailable()
  const { filters, groupBy, view } = React.useMemo(
    () => urlStateFromSearchParams(searchParams, automations),
    [searchParams, automations],
  )
  const now = useNow(30_000)

  const commit = (next: (current: GlobalTasksUrlState) => GlobalTasksUrlState) =>
    writeSearchParams((current) => {
      const params = urlStateToSearchParams(next(urlStateFromSearchParams(current, true)))
      const renderer = current.get('tasks')
      if (renderer === 'flat' || renderer === 'virtual') params.set('tasks', renderer)
      return params
    })
  const setFilters = (next: (current: GlobalTaskFilters) => GlobalTaskFilters) =>
    commit((state) => ({ ...state, filters: next(state.filters) }))
  const setGroupBy = (nextGroupBy: GroupBy) => commit((state) => ({ ...state, groupBy: nextGroupBy }))
  const setView = (nextView: ListView) => commit((state) => ({ ...state, view: nextView }))

  const narrowing = panelFacetCount(filters) + (groupBy === 'none' ? 0 : 1)
  const [filterDetailsOpen, setFilterDetailsOpen] = React.useState(narrowing > 0)
  const [queryDraft, setQueryDraft] = useQueryDraft(filters.query, (query) =>
    setFilters((current) => ({ ...current, query })),
  )

  const indexedStatuses = index.data?.referenceStatuses
  React.useEffect(() => {
    if (indexedStatuses) rememberReferenceStatuses(indexedStatuses)
  }, [indexedStatuses])

  const registry = React.useMemo(() => projects.data?.projects ?? [], [projects.data])
  const indexRuns = React.useMemo(() => index.data?.runs ?? [], [index.data])
  const tasks = React.useMemo(() => toGlobalTasks(indexRuns, registry), [indexRuns, registry])
  const { nameOf, visible, originTotals, statusGroups, folds } = useStatusGroups({
    tasks,
    filters,
    view,
    groupBy,
    index: indexRuns,
    automationsOn: automations,
  })
  const groups = React.useMemo(() => groupGlobalTasks(visible, groupBy), [visible, groupBy])
  const origin = filters.origin ?? 'all'
  const tabCounts = React.useMemo(() => {
    const runs = tasks.map((task) => task.run)
    return { active: originCounts(runs, 'active')[origin], archived: originCounts(runs, 'archived')[origin] }
  }, [tasks, origin])
  const setOrigin = (next: TaskOrigin) => setFilters((current) => withOrigin(current, next))

  const bulk = useGlobalBulkActions({ tasks, origin, filters })
  const rowActions = useGlobalRowActions()

  const referenceRequests = React.useMemo(
    () =>
      visible.flatMap((task) =>
        taskReferences(task.run, task.project?.repoUrl)
          .filter((reference) => isOwnRepoReference(reference, task.project?.repoUrl))
          .map((reference) => ({
            projectId: task.run.projectId,
            kind: reference.kind,
            number: reference.number,
          })),
      ),
    [visible],
  )
  const truncated = truncatedProjectNames(index.data?.truncated ?? [], registry)

  const toggle = (facet: FacetId, value: string) =>
    setFilters((current) => ({ ...current, [facet]: toggleFacetValue(current[facet] ?? [], value) }))
  const clearFacet = (facet: FacetId) => setFilters((current) => ({ ...current, [facet]: [] }))

  const loadError = index.error ?? projects.error
  if (loadError) {
    return (
      <GlobalTasksLoadError
        groupBy={groupBy}
        filterDetailsOpen={filterDetailsOpen}
        message={loadError.message}
        onRetry={() => {
          void index.refetch()
          void projects.refetch()
        }}
      />
    )
  }

  const density = index.data === undefined ? 'full' : pageShellDensity(visible.length)
  const filtersToggle = (
    <Button
      variant="outline"
      data-slot="filters-toggle"
      data-active={filterDetailsOpen || narrowing > 0}
      className={cn(
        'max-md:min-h-11 md:h-9',
        (filterDetailsOpen || narrowing > 0) &&
          'border-accent-strong bg-accent-strong/10 text-accent-text hover:bg-accent-strong/15 hover:text-accent-text',
      )}
      aria-expanded={filterDetailsOpen}
      aria-controls="global-tasks-filters"
      onClick={() => setFilterDetailsOpen((open) => !open)}
    >
      <SlidersHorizontalIcon aria-hidden="true" />
      Filters
      {narrowing > 0 ? <Count variant="accent" data-slot="filters-count" aria-hidden="true" value={narrowing} /> : null}
    </Button>
  )

  return (
    <TablePage
      route="global-tasks"
      density={density}
      headerSpacing="compact"
      rootProps={{
        'data-presentation': groupBy === 'none' ? 'summary' : 'cards',
        'data-filter-details': String(filterDetailsOpen),
      }}
      bodyClassName="gap-3"
      header={globalTasksHeader({
        projectCount: registry.length,
        bootProject: projects.data?.bootProject,
        status: (
          <TaskViewTabs
            view={view}
            onSelect={setView}
            activeCount={tabCounts.active}
            archivedCount={tabCounts.archived}
            trailing={
              <span data-slot="global-tasks-count" className="self-center text-xs text-soft-foreground tabular-nums">
                {visible.length} of {tasks.length}
                {truncated.length > 0 ? ' loaded' : ''}
              </span>
            }
          />
        ),
        secondaryActions: (
          <TaskBulkActions
            view={view}
            unread={bulk.unread}
            finished={bulk.finished}
            archivePending={bulk.archivePending}
            markReadPending={bulk.markReadPending}
            onMarkAllRead={bulk.onMarkAllRead}
            onArchiveFinished={bulk.onArchiveFinished}
          />
        ),
      })}
      sparseFooter={globalTasksSparseFooter(
        index.data !== undefined,
        visible.length,
        hasActiveFilters(filters),
        projects.data?.bootProject,
      )}
    >
      <TaskListFocusBoundary
        layout={`${groupBy}:${desktop}`}
        revision={groups}
        visibilityRevision={JSON.stringify([
          BUCKET_ORDER.map(folds.isCollapsed),
          view,
          filterDetailsOpen,
          taskTableColumns.expandedColumns,
        ])}
        className="flex min-w-0 flex-1 flex-col gap-3"
      >
        <TaskControlStrip
          query={queryDraft}
          onQueryChange={setQueryDraft}
          searchPlaceholder="Search every project…"
          searchLabel="Search tasks across projects"
          origin={origin}
          originCounts={originTotals}
          automations={automations}
          onOriginChange={setOrigin}
          columns={unifiedColumns}
          expandedColumns={taskTableColumns.expandedColumns}
          columnsPending={taskTableColumns.isPending}
          onToggleColumn={taskTableColumns.toggleColumn}
          groupLabels={statusGroups.map((group) => group.label)}
          onSetAllFolds={folds.setAll}
          extraControls={filtersToggle}
        />

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <FilterBar
            filters={filters}
            onToggle={toggle}
            onClearFacet={clearFacet}
            onClearAll={() => {
              setQueryDraft('')
              commit((state) => ({ ...state, filters: NO_FILTERS, groupBy: 'none' }))
            }}
            groupBy={groupBy}
            onGroupByChange={setGroupBy}
            projects={registry}
            tasks={tasks}
            view={view}
            automationName={nameOf}
          />

          <TruncatedNotice projects={truncated} perProjectLimit={index.data?.perProjectLimit} />

          {index.data === undefined ? (
            <div role="status" className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
              Loading tasks…
            </div>
          ) : (
            <GlobalTaskResults
              view={view}
              filtered={hasActiveFilters(filters)}
              visibleCount={visible.length}
              referenceRequests={referenceRequests}
              lists={{
                desktop,
                groupBy,
                view,
                statusGroups,
                groups,
                folds,
                expandedColumns: taskTableColumns.expandedColumns,
                now,
                runners: runners.data,
                showTokens: metrics.tokens,
                showCost: metrics.cost,
                automationName: nameOf,
                onTogglePin: view === 'archived' ? undefined : rowActions.onTogglePin,
                onArchive: rowActions.onArchive,
                onSetRead: rowActions.onSetRead,
                busy: rowActions.busy,
              }}
            />
          )}
          <OtherProjects registry={registry} />
        </div>
      </TaskListFocusBoundary>
    </TablePage>
  )
}

function GlobalTaskResults({
  view,
  filtered,
  visibleCount,
  referenceRequests,
  lists,
}: {
  view: ListView
  filtered: boolean
  visibleCount: number
  referenceRequests: React.ComponentProps<typeof ReferenceStatusProvider>['requests']
  lists: React.ComponentProps<typeof GroupedTaskLists>
}) {
  if (visibleCount === 0) return <GlobalTasksEmptyState view={view} filtered={filtered} />
  return (
    <ReferenceStatusProvider requests={referenceRequests}>
      <GroupedTaskLists {...lists} />
    </ReferenceStatusProvider>
  )
}

function GroupedTaskLists({
  desktop,
  groupBy,
  view,
  statusGroups,
  groups,
  folds,
  expandedColumns,
  now,
  runners,
  showTokens,
  showCost,
  automationName,
  onTogglePin,
  onArchive,
  onSetRead,
  busy,
}: {
  desktop: boolean
  groupBy: GroupBy
  view: ListView
  statusGroups: TaskStatusGroup<GlobalTask>[]
  groups: readonly TaskGroup[]
  folds: ReturnType<typeof useTaskListFolds>
  expandedColumns: NormalizedExpandedColumns
  now: number
  runners: RunnersResponse | undefined
  showTokens: boolean
  showCost: boolean
  automationName: (task: GlobalTask) => string | undefined
  onTogglePin?: ((item: TaskRowModel, pinned: boolean) => void) | undefined
  onArchive: (item: TaskRowModel, archived: boolean) => void
  onSetRead: (item: TaskRowModel, read: boolean) => void
  busy: boolean
}) {
  const open = statusGroups.filter((group) => !folds.isCollapsed(group.label))
  const showReferences =
    groupBy === 'none'
      ? open.some((group) =>
          group.rows.flatMap(rowTasks).some((task) => taskReferences(task.run, task.project?.repoUrl).length > 0),
        )
      : groups.some((group) =>
          group.tasks.some((task) => taskReferences(task.run, task.project?.repoUrl).length > 0),
        )
  const density = desktop ? ('table' as const) : ('card' as const)

  const toModels = (tasks: readonly { task: GlobalTask; queuePosition: number | null }[]) =>
    tasks.map(({ task, queuePosition }) =>
      globalTaskToTaskModel({
        task,
        queuePosition,
        runners,
        automationName,
        now,
        showTokens,
        showCost,
      }),
    )

  const sharedTableProps = {
    density,
    now,
    showReferences,
    expandedColumns,
    showTokens,
    showCost,
    scopedLinks: false as const,
    liveUsageSource: 'snapshot' as const,
    onTogglePin,
    onArchive,
    onSetRead,
    busy,
    tableSlot: 'global-tasks-table',
    rowSlot: 'global-task-row',
    cardSlot: 'global-task-row',
  }

  return (
    <>
      {groupBy === 'none'
        ? statusGroups.map((group) => {
            const members = groupMembers(group)
            const rows = group.rows.flatMap((row) =>
              rowTasks(row).map((task) => ({
                task,
                queuePosition: task.run.status === 'queued' ? row.queuePosition : null,
              })),
            )
            return (
              <StatusGroupSection
                key={group.label}
                id={`global-group-${view}-${group.label.replaceAll(' ', '-')}`}
                label={group.label}
                count={members.length}
                tone={headingTone(
                  group.label,
                  members.map((task) => task.run),
                )}
                folded={folds.isFolded(group.label)}
                collapsed={folds.isCollapsed(group.label)}
                onToggle={() => folds.toggle(group.label)}
              >
                <TaskTable
                  {...sharedTableProps}
                  items={toModels(rows)}
                  showHeader={group === open[0]}
                  showProject
                />
              </StatusGroupSection>
            )
          })
        : groups.map((group, index) => {
            const orderedTasks =
              view === 'archived'
                ? group.tasks
                : [...group.tasks].sort((a, b) => Number(Boolean(b.run.pinned)) - Number(Boolean(a.run.pinned)))
            return (
              <section key={group.key} data-slot="task-group" data-group-key={group.key}>
                <h2 className="mb-1.5 flex items-center gap-2 text-[12px] font-semibold tracking-[0.04em] text-soft-foreground uppercase">
                  {groupBy === 'project' ? (
                    <Link
                      to={scopeTo(group.key, '/')}
                      data-slot="group-project-link"
                      className="hover:text-foreground hover:underline"
                    >
                      {group.label}
                    </Link>
                  ) : (
                    group.label
                  )}
                  <Count value={orderedTasks.length} className="font-mono text-xs font-medium" />
                </h2>
                <TaskTable
                  {...sharedTableProps}
                  items={toModels(orderedTasks.map((task) => ({ task, queuePosition: null })))}
                  showHeader={index === 0}
                  showProject={groupBy !== 'project'}
                />
              </section>
            )
          })}
    </>
  )
}

function useQueryDraft(query: string, send: (query: string) => void) {
  const [queryDraft, setQueryDraft] = React.useState(query)
  const sentQuery = React.useRef(query)
  React.useEffect(() => {
    if (query !== sentQuery.current) setQueryDraft(query)
    sentQuery.current = query
  }, [query])
  React.useEffect(() => {
    if (queryDraft === sentQuery.current) return
    const timer = setTimeout(() => {
      sentQuery.current = queryDraft
      send(queryDraft)
    }, QUERY_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryDraft])
  return [queryDraft, setQueryDraft] as const
}

function useStatusGroups({
  tasks,
  filters,
  view,
  groupBy,
  index,
  automationsOn,
}: {
  tasks: readonly GlobalTask[]
  filters: GlobalTaskFilters
  view: ListView
  groupBy: GroupBy
  index: readonly RunIndexEntry[]
  automationsOn: boolean
}) {
  const automationProjects = React.useMemo(
    () => [...new Set(tasks.filter((task) => task.run.automationId !== undefined).map((task) => task.run.projectId))],
    [tasks],
  )
  const automationNameIn = useAutomationNames(automationProjects, automationsOn && automationProjects.length > 0)
  const nameOf = React.useCallback(
    (task: GlobalTask) =>
      task.run.automationId === undefined ? undefined : automationNameIn(task.run.projectId, task.run.automationId),
    [automationNameIn],
  )
  const visible = React.useMemo(() => filterGlobalTasks(tasks, filters, view, nameOf), [tasks, filters, view, nameOf])
  const originTotals = originCounts(
    tasksExcludingFacet(tasks, filters, view, 'origin', nameOf).map((task) => task.run),
    view,
  )
  const statusGroups = groupBy === 'none' ? groupIndexedTasks(visible, view, index) : []
  const revealed = new Set<BucketLabel>(filters.query.trim() !== '' ? statusGroups.map((group) => group.label) : [])
  const folds = useTaskListFolds('global', view, revealed)
  return { nameOf, visible, originTotals, statusGroups, folds }
}

/** A project's tag chip, quiet muted pill used in FilterBar and metadata. */
export function TagChip({ tag, className }: { tag: string; className?: string | undefined }) {
  return (
    <span
      data-slot="project-tag"
      className={cn(
        'inline-flex max-w-full items-center truncate rounded-full bg-muted px-1.5 py-px text-xs font-medium text-muted-foreground',
        className,
      )}
    >
      {tag}
    </span>
  )
}
