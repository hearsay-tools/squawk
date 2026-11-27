import { useTaskListExpansion } from '@/lib/use-task-list-expansion'
import { taskListRowIndexes } from '@/lib/task-list-render'
import { GlobalTasksEmptyState, GlobalTasksLoadError, OtherProjects, TruncatedNotice } from './global-tasks-states'
import { FilterBar, panelFacetCount } from './global-tasks-filter-bar'
import { TaskListItems, TaskListFocusBoundary } from '@/components/task-list-items'
import { runAddress } from '@/api/run-address'
import { useRunCacheWriter } from '@/api/use-run-cache-writer'
import './task-lists.css'
import { Dash, ViewTab, fullTime, headingTone, taskTitleClass } from './task-list-parts'
import {
  PageShellActionButton,
  PageShellSparseFooter,
  TablePage,
  pageShellDensity,
} from '@/components/page-shell'
import { useMutation } from '@tanstack/react-query'
import { ArchiveRestoreIcon, EyeIcon, EyeOffIcon } from 'lucide-react'
import { ArchiveIcon, PlusIcon, SearchIcon, SlidersHorizontalIcon } from '@/components/design-icons'
import * as React from 'react'
import { useIsDesktop } from '@/lib/use-desktop'
import { Link } from 'react-router'
import { archiveRun, setRunRead } from '@/api/client'
import {
  rememberReferenceStatuses,
  useAutomationNames,
  useHealth,
  useProjects,
  useRunsIndex,
} from '@/api/queries'
import type { RunIndexEntry } from '@open-mercato/cezar-api-client'
import { DiffStatLabel } from '@/components/diff-stat'
import { Pill } from '@/components/pill'
import { ReferenceList } from '@/components/reference-overflow'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { StatusDot } from '@/components/status-dot'
import { StatusGroupSection, TaskOriginRow, TaskOriginLine, TaskPreview } from '@/components/task-status-groups'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { deriveAttention } from '@/lib/attention'
import { runStatusPresentation } from '@/lib/status-semantics'
import { shortAge } from '@/lib/format'
import {
  formatCost,
  isOwnRepoReference,
  taskReferences,
  usageCells,
  type TaskReference,
} from '@/lib/tasks-table'
import {
  NO_FILTERS,
  filterGlobalTasks,
  urlStateFromSearchParams,
  urlStateToSearchParams,
  groupGlobalTasks,
  hasActiveFilters,
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
import { canBeUnread, isReadDoneItem, isUnread, unreadMarkerTone } from '@/lib/read-state'
import { BUCKET_ORDER, runTitle, type BucketLabel, type ListView } from '@/lib/task-groups'
import { groupIndexedTasks, groupMembers, originCounts, rowTasks, type TaskOrigin, type TaskStatusGroup } from '@/lib/task-origin'
import { useAutomationsAvailable } from '@/lib/capabilities'
import { useSearchParamsWriter } from '@/lib/use-search-params-writer'
import { useTaskListFolds } from '@/lib/use-task-list-folds'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'
/**
 * The global Tasks page at `/tasks` — every registered project's work in one table.
 *
 * It is deliberately NOT under `/p/:projectId`, for the same reason `/settings/global` is not:
 * "all projects" scoped to one project is a contradiction. That also decides its data. The page
 * reads the workspace-level cross-project index (`GET /api/v1/workspace/runs-index`) — one
 * request for the whole registry — rather than N per-project run lists, which would ship a full
 * `RunRecord` (`steps[]` and all) per run times the registry to paint a title and a dot.
 *
 * The trade that buys: the index is a slim row and a capped one, and it names any project the cap
 * bit rather than presenting a short list as a complete one. It is not stale, though: the one
 * `/workspace/events` stream carries every project's run news, and any of it invalidates this
 * index (`global-events.tsx`) — the interval below is the backstop for what a stream cannot
 * promise, not the mechanism.
 *
 * **Filters and grouping live in the URL** (`?q=&tag=&status=&workflow=&group=`), which makes a
 * filtered view survive a refresh, paste into a colleague's chat, and sit in a bookmark. The URL
 * is the state rather than a mirror of it — there is no second copy to drift — and every write is
 * a `replace`, so Back leaves the page instead of undoing one chip at a time.
 *
 * The Active/Archived split is in there too, as `archived=1` present-or-absent: Active is the
 * default and the common case, so a normal link carries no key for it. That flag is this
 * table's own: the sidebar quick-list keeps a separate in-memory filter and does not follow.
 *
 * Presentational logic lives in `lib/global-tasks.ts`; what is here is markup, the router and the
 * local filter state.
 */
/** How often the page re-reads the cross-project index ON TOP of the stream's invalidations —
 *  the cover for a dropped socket, a frozen tab, or a run that ended while the connection was
 *  down. Slow enough that a forty-project workspace is not re-scanned every few seconds. */
const RUNS_INDEX_POLL_MS = 15_000
/** How long the search box waits before writing the URL. Long enough that a typed word is one
 *  history write rather than eight, short enough that a paste-and-share feels immediate. */
const QUERY_DEBOUNCE_MS = 250
/** How many reference chips a row paints before the rest collapse into a `+N`.
 *
 *  ONE. Two fit on a line but cost ~90px of a column that Task wants more, and nothing is lost
 *  by folding the rest: the `+N` opens on HOVER and lists every reference as a real link, so the
 *  second one is a pointer-move away rather than a click. The strongest reference — the PR a task
 *  created, else the one it is about, else its issue — is the one worth the row's own space. */
const MAX_VISIBLE_REFERENCES = 1
/** What "finished" means for the archive affordance — outcomes, not gates. A `review` run still
 *  wants a human, so it is not swept away, exactly as the per-project broom decides it. */
const ARCHIVABLE_STATUSES: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled'])

/** Archive (or restore) one indexed run, in its own project. */
function useArchiveIndexedRun() {
  return useIndexedRunMutation({
    request: ({ task, archived }: { task: GlobalTask; archived: boolean }) =>
      archiveRun(runAddress(task.run.id, { projectId: task.run.projectId }), archived),
    patch: ({ archived }) => (run) => ({ ...run, archived }),
  })
}

/**
 * Mark one indexed run read or unread — the same cross-project shape as the archive above.
 *
 * The receipt matters more here than anywhere else: this page is where you notice that something
 * finished while you were not looking, and "I have dealt with that one" needs somewhere to go
 * that is not archiving it. Reading a thread already stamps it; this is the manual half, and its
 * inverse (#775) is what makes an accidental stamp recoverable.
 */
function useReadIndexedRun() {
  return useIndexedRunMutation({
    request: ({ task, read }: { task: GlobalTask; read: boolean }) =>
      setRunRead(runAddress(task.run.id, { projectId: task.run.projectId }), read),
    patch:
      ({ read }) =>
      (run) => {
        if (read) return { ...run, seenAt: new Date().toISOString() }
        // Cleared as a rest-destructure, not `seenAt: undefined`: the reader is `isUnread`, which
        // keys on the field being ABSENT, and the server never writes an explicit undefined.
        const { seenAt: _dropped, ...rest } = run
        return rest
      },
  })
}

/**
 * The shape both row actions share: act on a run in ITS OWN project, move the row optimistically
 * so the click lands immediately, reconcile afterwards, and roll back with the server's reason if
 * it refused.
 *
 * Two things are cross-project rather than scoped, and both follow from standing outside every
 * `/p/:projectId`: the request names the project explicitly (`queryScope()` would answer with the
 * BOOT project, so an action on another project's row would 404 or — with a colliding id — land
 * on the wrong task), and the cache patched is the workspace index rather than the project's own
 * run list, which may not even be loaded here.
 */
function useIndexedRunMutation<V extends { task: GlobalTask }>({
  request,
  patch,
}: {
  request: (variables: V) => Promise<unknown>
  patch: (variables: V) => (run: RunIndexEntry) => RunIndexEntry
}) {
  const writer = useRunCacheWriter()
  return useMutation({
    mutationFn: request,
    onMutate: (variables: V) => writer.patchIndex(
      runAddress(variables.task.run.id, { projectId: variables.task.run.projectId }), () => patch(variables),
    ),
    onError: (error: Error, _variables, context) => {
      context?.rollback()
      toast(error.message, { tone: 'danger' })
    },
    onSettled: (_data, _error, { task }, context) => {
      if (context) context.settle()
      else writer.invalidateAfter('indexed', runAddress(task.run.id, { projectId: task.run.projectId }))
    },
  })
}

function globalTasksHeader(groupBy: GroupBy, bootProject: string | undefined) {
  return {
    title: 'All tasks',
    subtitle: groupBy === 'none'
      ? 'Every project. One place to review what your agents have shipped.'
      : 'Filter across projects and act on each run without opening the session.',
    hideSubtitleOnMobile: true,
    primaryAction: (
      <PageShellActionButton asChild variant="primary" data-slot="new-task-inline">
        <Link to={scopeTo(bootProject ?? 'default', '/new')}><PlusIcon aria-hidden="true" />New task</Link>
      </PageShellActionButton>
    ),
  }
}

function globalTasksSparseFooter(ready: boolean, visibleCount: number, filtered: boolean, bootProject: string | undefined) {
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

export function GlobalTasksRoute() {
  const { expandedRuns, toggleExpandedRun } = useTaskListExpansion()
  const projects = useProjects()
  // The same host gate the per-project table honours: `CEZ_HIDE_COST` and friends turn these
  // columns off everywhere, and a cross-project view is not an exception.
  const health = useHealth()
  const metrics = usageMetricVisibility(health.data)
  // Always enabled here — unlike the ⌘K palette, which parks it in a one-project workspace:
  // this page IS the index, so there is nothing else for it to fall back to. The interval is this
  // page's alone (see `useRunsIndex`), and it is now a BACKSTOP rather than the mechanism: any
  // project's run event invalidates this index through the one workspace stream, so a task that
  // is renamed or finishes while you watch updates on its own.
  const index = useRunsIndex(true, RUNS_INDEX_POLL_MS)
  // The URL is the state, not a mirror of it: read here, written by the setters below. One
  // source of truth means a refresh, a pasted link and the Back button all land on the same
  // filtered view, with no effect syncing two copies that can disagree.
  const [searchParams, writeSearchParams] = useSearchParamsWriter()
  const automations = useAutomationsAvailable()
  const { filters, groupBy, view } = React.useMemo(() => urlStateFromSearchParams(searchParams, automations), [searchParams, automations])
  const now = useNow(30_000)

  /**
   * `replace`, always: filtering is one continuous gesture, and a history entry per click would
   * turn Back into "undo one chip" instead of "leave this page".
   *
   * The whole state is re-decoded from the params INSIDE the updater rather than read from this
   * render's closure, and `useSearchParamsWriter` hands the updater the params of every earlier
   * write, rendered or not, so two changes landing in one tick compose instead of the second
   * silently reverting the first. Every origin decodes here; the render applies availability.
   */
  const commit = (next: (current: GlobalTasksUrlState) => GlobalTasksUrlState) =>
    writeSearchParams((current) => {
      const params = urlStateToSearchParams(next(urlStateFromSearchParams(current, true)))
      const renderer = current.get('tasks')
      if (renderer === 'flat' || renderer === 'virtual') params.set('tasks', renderer)
      return params
    })
  const setFilters = (next: (current: GlobalTaskFilters) => GlobalTaskFilters) =>
    commit((state) => ({ ...state, filters: next(state.filters) }))
  const setGroupBy = (groupBy: GroupBy) => commit((state) => ({ ...state, groupBy }))
  const setView = (nextView: ListView) => commit((state) => ({ ...state, view: nextView }))

  // Facet picks hidden behind the toggle still narrow the list; the toggle's badge counts them.
  const narrowing = panelFacetCount(filters) + (groupBy === 'none' ? 0 : 1)
  const [filterDetailsOpen, setFilterDetailsOpen] = React.useState(narrowing > 0)
  const [queryDraft, setQueryDraft] = useQueryDraft(filters.query, (query) => setFilters((current) => ({ ...current, query })))

  // Statuses the server already had, riding along with the rows that carry the references — so
  // the chips are coloured in the SAME paint as the table rather than a round trip later. Cold
  // references are simply absent here; `ReferenceStatusProvider` below still asks for those.
  const indexedStatuses = index.data?.referenceStatuses
  React.useEffect(() => {
    if (indexedStatuses) rememberReferenceStatuses(indexedStatuses)
  }, [indexedStatuses])
  const registry = React.useMemo(() => projects.data?.projects ?? [], [projects.data])
  const indexRuns = React.useMemo(() => index.data?.runs ?? [], [index.data])
  const tasks = React.useMemo(() => toGlobalTasks(indexRuns, registry), [indexRuns, registry])
  const { nameOf, visible, originTotals, statusGroups, folds } = useStatusGroups({
    tasks, filters, view, groupBy, index: indexRuns, automationsOn: automations,
  })
  const groups = React.useMemo(() => groupGlobalTasks(visible, groupBy), [visible, groupBy])
  const origin = filters.origin ?? 'all'
  // The same count the project list's tabs show: every task of the origin, whatever the filters.
  const tabCounts = React.useMemo(() => {
    const runs = tasks.map((task) => task.run)
    return { active: originCounts(runs, 'active')[origin], archived: originCounts(runs, 'archived')[origin] }
  }, [tasks, origin])
  const setOrigin = (next: TaskOrigin) => setFilters((current) => withOrigin(current, next))
  /**
   * Every tracker reference on screen, asked about ONCE.
   *
   * Collected here rather than per row for the obvious reason — a row-level hook would be a
   * request per chip, and this page routinely paints hundreds — and for a less obvious one: the
   * batching is per PROJECT, and only this level can see that forty rows belong to six repos.
   * A row that arrives after the cap, or whose forge is unreachable, keeps the neutral chip it
   * had before statuses existed.
   */
  const referenceRequests = React.useMemo(
    () =>
      visible.flatMap((task) =>
        taskReferences(task.run, task.project?.repoUrl).filter(reference => isOwnRepoReference(reference, task.project?.repoUrl)).map((reference) => ({
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
  const archive = useArchiveIndexedRun()
  const setRead = useReadIndexedRun()
  const onArchive = React.useCallback((task: GlobalTask, archived: boolean) => archive.mutate({ task, archived }), [archive.mutate])
  const onSetRead = React.useCallback((task: GlobalTask, read: boolean) => setRead.mutate({ task, read }), [setRead.mutate])

  const loadError = index.error ?? projects.error
  if (loadError) return <GlobalTasksLoadError groupBy={groupBy} filterDetailsOpen={filterDetailsOpen} message={loadError.message} onRetry={() => { void index.refetch(); void projects.refetch() }} />

  const search = (
    <div className="relative w-full">
      <SearchIcon
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-soft-foreground"
        aria-hidden="true"
      />
      <input
        type="text"
        value={queryDraft}
        onChange={(event) => setQueryDraft(event.target.value)}
        placeholder="Search every project…"
        aria-label="Search tasks across projects"
        className="h-11 w-full rounded-md border border-input bg-card pr-3 pl-8 text-[13px] text-foreground outline-none placeholder:text-soft-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:h-9"
      />
    </div>
  )

  const density = index.data === undefined ? 'full' : pageShellDensity(visible.length)

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
      header={globalTasksHeader(groupBy, projects.data?.bootProject)}
      sparseFooter={globalTasksSparseFooter(index.data !== undefined, visible.length, hasActiveFilters(filters), projects.data?.bootProject)}
    >
      <TaskListFocusBoundary
        layout={groupBy}
        revision={groups}
        visibilityRevision={JSON.stringify([BUCKET_ORDER.map(folds.isCollapsed), [...expandedRuns].sort(), view, filterDetailsOpen])}
        className="flex min-w-0 flex-1 flex-col gap-3"
      >
      <div className="flex shrink-0 flex-col gap-2.5">
        <div className="flex items-center gap-6 border-b border-border">
          <ViewTab view="active" current={view} onSelect={setView} count={tabCounts.active}>
            Active
          </ViewTab>
          <ViewTab view="archived" current={view} onSelect={setView} count={tabCounts.archived}>
            Archived
          </ViewTab>
        <span data-slot="global-tasks-count" className="ml-auto text-[13px] text-soft-foreground tabular-nums">
          {visible.length} of {tasks.length}{truncated.length > 0 ? ' loaded' : ''}
        </span>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="min-w-0 basis-full md:flex-1 md:basis-auto">{search}</div>
          <Button
            variant="outline"
            data-slot="filters-toggle"
            data-active={filterDetailsOpen || narrowing > 0}
            className={cn('max-md:min-h-11 md:h-9', (filterDetailsOpen || narrowing > 0) && 'border-accent-strong bg-accent-strong/10 text-accent-text hover:bg-accent-strong/15 hover:text-accent-text')}
            aria-expanded={filterDetailsOpen}
            aria-controls="global-tasks-filters"
            onClick={() => setFilterDetailsOpen((open) => !open)}
          >
            <SlidersHorizontalIcon aria-hidden="true" />Filters
            {narrowing > 0 ? <span data-slot="filters-count" aria-hidden="true" className="rounded-full bg-accent-strong/20 px-1.5 text-xs leading-[18px] font-semibold tabular-nums">{narrowing}</span> : null}
          </Button>
        </div>
        <TaskOriginRow origin={origin} counts={originTotals} automations={automations} onChange={setOrigin} labels={statusGroups.map((group) => group.label)} onSetAll={folds.setAll} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <FilterBar
          filters={filters}
          onToggle={toggle}
          onClearFacet={clearFacet}
          onClearAll={() => {
            setQueryDraft('')
            // Filters AND grouping — "Clear" is the one way back to a plain list.
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
          <div role="status" className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">Loading tasks…</div>
        ) : (
          <GlobalTaskResults
            view={view}
            filtered={hasActiveFilters(filters)}
            visibleCount={visible.length}
            referenceRequests={referenceRequests}
            lists={{
              groupBy,
              view,
              statusGroups,
              groups,
              folds,
              row: {
                now,
                onArchive,
                expandedRuns, toggleExpandedRun,
                onSetRead,
                busy: archive.isPending || setRead.isPending,
                showCost: metrics.cost,
                automationName: nameOf,
              },
            }}
          />
        )}
        <OtherProjects registry={registry} />

      </div>
      </TaskListFocusBoundary>
    </TablePage>
  )
}

/** What the loaded index leaves on screen: the empty state, or the lists and their footnote. */
function GlobalTaskResults({ view, filtered, visibleCount, referenceRequests, lists }: {
  view: ListView
  filtered: boolean
  visibleCount: number
  referenceRequests: React.ComponentProps<typeof ReferenceStatusProvider>['requests']
  lists: React.ComponentProps<typeof GroupedTaskLists>
}) {
  if (visibleCount === 0) return <GlobalTasksEmptyState view={view} filtered={filtered} />
  return (
    <>
      {/* No `projectId` on the provider, uniquely on this page: every chip under it names its
          own, because the rows next to each other belong to different repositories. */}
      <ReferenceStatusProvider requests={referenceRequests}>
        <GroupedTaskLists {...lists} />
      </ReferenceStatusProvider>
      {lists.groupBy === 'none' ? <p data-slot="tasks-resource-note" className="pb-8 text-xs text-muted-foreground">Select a task’s status to show its tokens, cost, CPU and peak memory.</p> : null}
    </>
  )
}

/** The rows any grouped list passes through, unchanged, to every `TaskList`. */
type TaskListRowProps = Omit<React.ComponentProps<typeof TaskList>, 'tasks' | 'showProject' | 'showHead' | 'showReferences'>

/**
 * The list body: the sidebar's status groups when no alternative grouping is picked
 * (hearsay-tools/cezarion#1616), otherwise the picked grouping's plain sections.
 */
function GroupedTaskLists({ groupBy, view, statusGroups, groups, folds, row }: {
  groupBy: GroupBy
  view: ListView
  statusGroups: TaskStatusGroup<GlobalTask>[]
  groups: readonly TaskGroup[]
  folds: ReturnType<typeof useTaskListFolds>
  row: TaskListRowProps
}) {
  // One column header for the page, on the first open group; the columns are the same in all.
  const open = statusGroups.filter((group) => !folds.isCollapsed(group.label))
  const showReferences = open.some((group) => group.rows.flatMap(rowTasks).some((task) => taskReferences(task.run, task.project?.repoUrl).length > 0))
  return (
    <>
      {groupBy === 'none' ? statusGroups.map((group) => {
        const members = groupMembers(group)
        return (
          <StatusGroupSection
            key={group.label}
            id={`global-group-${view}-${group.label.replaceAll(' ', '-')}`}
            label={group.label}
            count={members.length}
            tone={headingTone(group.label, members.map((task) => task.run))}
            folded={folds.isFolded(group.label)}
            collapsed={folds.isCollapsed(group.label)}
            onToggle={() => folds.toggle(group.label)}
          >
            <TaskList summary showHead={group === open[0]} showReferences={showReferences} tasks={group.rows.flatMap(rowTasks)} showProject {...row} />
          </StatusGroupSection>
        )
      }) : groups.map((group) => (
        <section key={group.key} data-slot="task-group" data-group-key={group.key}>
          <h2 className="mb-1.5 flex items-center gap-2 text-[12px] font-semibold tracking-[0.04em] text-soft-foreground uppercase">
              {/* A project heading is a DOOR, not a label: that project's own Tasks page is
                  the better version of "just this project" (live SSE, the full column set,
                  the composer). */}
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
              <span className="font-mono text-xs font-medium tabular-nums">
                {group.tasks.length}
              </span>
            </h2>
          <TaskList tasks={group.tasks} showProject={groupBy !== 'project'} {...row} />
        </section>
      ))}
    </>
  )
}

/**
 * The search box types locally and reaches the URL on a delay.
 *
 * Every other control writes the URL on the click that changed it, which is exactly right for
 * a discrete gesture. A text field is not discrete: writing per keystroke means a
 * `history.replaceState` per keystroke, and browsers rate-limit that (Safari drops calls past
 * ~100 in 30s) — so a fast typist's URL would silently stop tracking the box.
 *
 * The guard is what keeps two copies of one string honest: the URL is adopted back into the
 * draft only when it changed for a reason that is NOT this input — Back, a pasted link, Clear
 * filters — never when it is simply catching up to what was typed. Without it, a flush landing
 * mid-word would overwrite the characters typed since.
 */
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
    // `send` is re-created every render — depending on it would restart the timer on every
    // render and never fire. A stale `send` is safe: it writes through `useSearchParamsWriter`,
    // which starts from the newest params, not the ones `send` saw.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryDraft])
  return [queryDraft, setQueryDraft] as const
}

/**
 * The list the filters leave, and its status groups (hearsay-tools/cezarion#1616).
 *
 * Automation names feed the origin line and the search. They are read only for projects that
 * show automation tasks, and only while the host has automations on; otherwise a row shows the
 * recorded automation id. With no alternative grouping picked, the page shows the sidebar's status
 * groups, with queue numbers from each project's full queue in the index.
 */
function useStatusGroups({ tasks, filters, view, groupBy, index, automationsOn }: {
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
  const nameOf = React.useCallback((task: GlobalTask) =>
    task.run.automationId === undefined ? undefined : automationNameIn(task.run.projectId, task.run.automationId), [automationNameIn])
  const visible = React.useMemo(() => filterGlobalTasks(tasks, filters, view, nameOf), [tasks, filters, view, nameOf])
  const originTotals = originCounts(tasksExcludingFacet(tasks, filters, view, 'origin', nameOf).map((task) => task.run), view)
  const statusGroups = groupBy === 'none' ? groupIndexedTasks(visible, view, index) : []
  // A search shows every group holding a match, folded or not, without saving that choice.
  const revealed = new Set<BucketLabel>(filters.query.trim() !== '' ? statusGroups.map((group) => group.label) : [])
  const folds = useTaskListFolds('global', view, revealed)
  return { nameOf, visible, originTotals, statusGroups, folds }
}

/** Each group owns a list of task cards, with the same scoped actions on desktop and mobile. */
function TaskList({
  summary = false,
  showHead = true,
  showReferences = true,
  expandedRuns, toggleExpandedRun,
  tasks, now, showProject,
  onArchive, onSetRead,
  busy, showCost, automationName,
}: {
  expandedRuns: ReadonlySet<string>
  toggleExpandedRun: (id: string) => void
  summary?: boolean
  /** False keeps the column names for assistive technology only: an earlier group shows them. */
  showHead?: boolean
  /** False when no open summary group has a pull request or an issue to show. */
  showReferences?: boolean
  tasks: readonly GlobalTask[]
  now: number
  showProject: boolean
  onArchive: (task: GlobalTask, archived: boolean) => void
  onSetRead: (task: GlobalTask, read: boolean) => void
  busy: boolean
  showCost: boolean
  automationName: (task: GlobalTask) => string | undefined
}) {
  const aria = taskListRowIndexes(tasks.map((task) => `${task.run.projectId}/${task.run.id}`), expandedRuns)
  const desktop = useIsDesktop()
  return (
    <div
      role={summary ? "table" : undefined} aria-rowcount={summary ? aria.rowCount : undefined} data-slot="global-tasks-table" data-head={showHead} data-reference-column={showReferences}
      className="overflow-x-auto rounded-lg border border-border bg-card p-5"
    >
      <div data-slot="global-summary-head" className={cn('text-xs tracking-[0.04em]', !showHead && 'sr-only')} role="row" aria-rowindex={1}>{['Task', 'Workflow', 'Changes', ...(showReferences ? ['Pull request'] : []), 'Started'].map((label) => <span role="columnheader" key={label}>{label}</span>)}</div>
      <TooltipProvider>
            <TaskListItems {...(summary ? { itemSize: desktop ? 63 : 150 } : {})} /* the desktop row; an estimate for the stacked card */ items={tasks} itemKey={(task) => `${task.run.projectId}/${task.run.id}`}>{(task, index) => (
              <TaskRow
                key={`${task.run.projectId}/${task.run.id}`}
                task={task}
                summary={summary}
                showReferences={showReferences}
                rowIndex={aria.indexes[index]!}
                resourcesOpen={expandedRuns.has(`${task.run.projectId}/${task.run.id}`)}
                toggleExpandedRun={toggleExpandedRun}
                now={now}
                showProject={showProject}
                onArchive={onArchive}
                onSetRead={onSetRead}
                busy={busy}
                showCost={showCost}
                automationName={automationName(task)}
              />
            )}</TaskListItems>
      </TooltipProvider>
    </div>
  )
}

/**
 * One cross-project run.
 *
 * The title is a real `<Link>` — a plain router one, explicitly scoped with `scopeTo`: this page
 * renders outside every `/p/:projectId`, so the scope-aware `Link` would have no project to
 * prefix with, and each row points at a DIFFERENT project anyway.
 */
export const TaskRow = React.memo(function TaskRow({
  rowIndex, resourcesOpen, toggleExpandedRun,
  summary,
  showReferences = true,
  task,
  now,
  showProject,
  onArchive,
  onSetRead,
  busy,
  showCost,
  automationName,
}: {
  rowIndex: number
  resourcesOpen: boolean
  toggleExpandedRun: (id: string) => void
  summary: boolean
  showReferences?: boolean
  task: GlobalTask
  now: number
  showProject: boolean
  onArchive: (task: GlobalTask, archived: boolean) => void
  onSetRead: (task: GlobalTask, read: boolean) => void
  busy: boolean
  showCost: boolean
  automationName: string | undefined
}) {
  const rowRole = summary ? "row" : undefined
  const cellRole = summary ? "cell" : undefined
  const { run } = task
  const attention = deriveAttention(run)
  const status = runStatusPresentation(run, attention)
  const to = scopeTo(run.projectId, `/tasks/${run.id}`)
  // Global usage comes from the index; run streams are project-scoped.
  const usage = usageCells(run, run.usage)

  return (
    <article role={summary ? "rowgroup" : undefined} data-status={run.status} data-expanded={resourcesOpen} data-slot="global-task-row" data-run-id={run.id} data-project={run.projectId} className="hover:bg-muted max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-3 max-md:gap-y-2 max-md:border-b max-md:border-border max-md:py-5 ">
      {/* The one column with no fixed width, so every pixel the others give up lands here — and
          dropping Branch gave up 140 of them. A cross-project list is read by TITLE. */}
      <div data-slot="global-task-cells" className="contents" role={rowRole} aria-rowindex={summary ? rowIndex : undefined}><GlobalTaskTitle summary={summary} task={task} showProject={showProject} automationName={automationName} resourcesOpen={resourcesOpen} toggleExpandedRun={toggleExpandedRun} />
      <TaskRowCells task={task} cellRole={cellRole} showReferences={showReferences} now={now} />
      </div>{!summary || resourcesOpen ? <div className="contents" role={rowRole} aria-rowindex={summary ? rowIndex + 1 : undefined}><div data-slot="global-task-detail-cell" role={cellRole} aria-colspan={summary ? (showReferences ? 5 : 4) : undefined} className={summary ? 'col-span-full flex flex-col gap-3' : 'contents'}>
      <div data-slot="global-task-actions">
        <span className="inline-flex items-center gap-0.5">
          <ReadToggle task={task} busy={busy} onSetRead={onSetRead} />
          <ArchiveToggle task={task} busy={busy} onArchive={onArchive} /><Button asChild variant="outline"><Link to={to}>Open task</Link></Button>
        </span>
      </div>
    {resourcesOpen ? <div data-slot="global-task-resources" className="col-span-full flex flex-col gap-3">
      <TaskPreview projectId={run.projectId} runId={run.id} status={status.label} error={run.error} open={<Button asChild variant="outline" className="min-h-11"><Link to={to}>Open task<span className="sr-only">: {runTitle(run)}</span></Link></Button>} />
      <dl className="grid grid-cols-2 gap-4 rounded-md bg-muted/50 p-4 text-xs md:grid-cols-3">
        {showCost ? <div><dt className="text-muted-foreground">Cost</dt><dd className="mt-1">{formatCost(run.costUsd) || '—'}</dd></div> : null}
        <div><dt className="text-muted-foreground">CPU</dt><dd data-usage="cpu" data-usage-kind={usage.cpu.kind} title={usage.cpu.title} className="mt-1">{usage.cpu.text || '—'}</dd></div>
        <div><dt className="text-muted-foreground">Memory</dt><dd data-usage="mem" data-usage-kind={usage.mem.kind} title={usage.mem.title} className="mt-1">{usage.mem.text || '—'}</dd></div>
      </dl>
    </div> : null}</div></div> : null}
    </article>
  )
}, (previous, next) => {
  // The projection wrapper is recreated when any index row changes. Stable summaries still skip work.
  const { task: a, ...before } = previous
  const { task: b, ...after } = next
  return a.run === b.run && a.project === b.project && a.projectName === b.projectName && a.tags.length === b.tags.length && a.tags.every((tag, index) => tag === b.tags[index])
    && (Object.keys(before) as (keyof typeof before)[]).every((key) => before[key] === after[key])
})

/** The cells after the title: workflow, changes, references (unless the page hides them) and age. */
function TaskRowCells({ task, cellRole, showReferences, now }: { task: GlobalTask; cellRole: 'cell' | undefined; showReferences: boolean; now: number }) {
  const { run } = task
  // Resolve references against this run's own project repository.
  const references = taskReferences(run, task.project?.repoUrl)
  return (
    <>
      <div role={cellRole} data-slot="global-task-workflow" className="text-[13px] text-muted-foreground">
        {run.workflow}
      </div>
      <div role={cellRole} data-slot="global-task-diff" className="text-xs text-muted-foreground">{run.diffStat ? <DiffStatLabel stat={run.diffStat} /> : <Dash />}</div>
      {showReferences ? <div role={cellRole} data-slot="global-task-references">
        {references.length > 0 ? (
          <ReferenceChips references={references} run={run} repoBase={task.project?.repoUrl} />
        ) : (
          <Dash />
        )}
      </div> : null}
      <div role={cellRole} data-slot="global-task-age" title={fullTime(run.startedAt ?? run.createdAt)} className="text-right text-xs text-soft-foreground tabular-nums">
        {shortAge(run.startedAt ?? run.createdAt, now)}
      </div>
    </>
  )
}

function GlobalTaskTitle({ summary, task, showProject, automationName, resourcesOpen, toggleExpandedRun }: Pick<React.ComponentProps<typeof TaskRow>, 'summary' | 'task' | 'showProject' | 'automationName' | 'resourcesOpen' | 'toggleExpandedRun'>) {
  const { run } = task
  const attention = deriveAttention(run)
  const status = runStatusPresentation(run, attention)
  const to = scopeTo(run.projectId, `/tasks/${run.id}`)
  const unread = isUnread(run)
  const readDone = isReadDoneItem(run)
  return (      <div role={summary ? "cell" : undefined} data-slot="global-task-title">
        <span className="flex min-w-0 items-center gap-1.5">
          {run.delegation?.role === 'worker' ? <span className="shrink-0 text-xs text-muted-foreground">Worker</span> : null}
          <Link
            to={to}
            title={runTitle(run)}
            data-task-control="title"
            className={taskTitleClass(unread, readDone)}
          >
            {runTitle(run)}
          </Link>
          {/* In the run's outcome colour, like every unread marker (#617). */}
          {unread ? (
            <StatusDot
              tone={unreadMarkerTone(run)}
              role="img"
              aria-label="unread"
              title="Unread — not opened since it finished"
              className="shrink-0"
            />
          ) : null}
        </span>
        {/* One meta line: status, then the project and where the task came from, then tags. */}
        <div data-slot="task-meta-line" className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <button type="button" data-task-control="resources" aria-expanded={resourcesOpen} aria-label={`${resourcesOpen ? 'Hide' : 'Show'} resources for ${runTitle(run)}`} onClick={() => toggleExpandedRun(`${run.projectId}/${run.id}`)} aria-describedby={`global-status-${run.projectId}-${run.id}`} title="Resources and actions" className="inline-flex min-h-[22px] shrink-0 items-center rounded-full p-0 hover:bg-muted"><Pill id={`global-status-${run.projectId}-${run.id}`} dot={status.tone} shape={status.shape} pulse={status.pulse} className="py-0.5">{status.label}</Pill></button>
          <span aria-hidden="true">·</span>
          <TaskOriginLine
            automationId={run.automationId}
            automationName={automationName}
            project={showProject ? (
              <Link to={scopeTo(run.projectId, '/')} data-slot="task-project" className="truncate hover:text-foreground">
                {task.projectName}
              </Link>
            ) : undefined}
          />
          {task.tags.map((tag) => <TagChip key={tag} tag={tag} />)}
        </div>
      </div>
)
}

/**
 * Mark one row read or unread — an open eye to stamp the receipt, a closed one to take it back.
 *
 * Offered only where a read state EXISTS: `canBeUnread` is the same decider behind the unread dot
 * itself, so the button appears on exactly the rows that can wear one — finished, not archived,
 * not a task merely waiting out a usage limit. A running task has nothing to have read yet, and a
 * button that did nothing would say otherwise.
 *
 * The icon shows the ACTION, not the state: unread rows offer the open eye ("mark read"), read
 * ones the closed eye ("mark unread"). The state is already visible a few columns left, as the
 * violet dot beside the title.
 */
function ReadToggle({
  task,
  busy,
  onSetRead,
}: {
  task: GlobalTask
  busy: boolean
  onSetRead: (task: GlobalTask, read: boolean) => void
}) {
  if (!canBeUnread(task.run)) return null
  const unread = isUnread(task.run)
  const title = runTitle(task.run)
  const label = unread ? `Mark ${title} read` : `Mark ${title} unread`
  const Icon = unread ? EyeIcon : EyeOffIcon
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-action={unread ? 'mark-read' : 'mark-unread'}
          aria-label={label}
          disabled={busy}
          onClick={() => onSetRead(task, unread)}
          className={cn(
            'inline-flex size-11 items-center justify-center md:size-8 rounded-md transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-wait disabled:opacity-50',
            unread ? 'text-accent-icon' : 'text-soft-foreground',
          )}
        >
          <Icon className="size-3.5" aria-hidden="true" /><span>{unread ? 'Mark read' : 'Mark unread'}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{unread ? 'Mark read' : 'Mark unread'}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Archive / restore one row, without leaving the page.
 *
 * Per-row rather than the per-project table's count-gated "Archive finished" broom: a sweep that
 * crossed project boundaries would be one click firing N writes into N repos, and "finished" is a
 * judgement each project's own page is better placed to make. One row, one deliberate click.
 *
 * The button only exists for a run that is actually FINISHED (or already archived). Archiving
 * something still running would be answered by the server anyway, but offering it invites the
 * question of whether it also cancels — which it does not.
 */
function ArchiveToggle({
  task,
  busy,
  onArchive,
}: {
  task: GlobalTask
  busy: boolean
  onArchive: (task: GlobalTask, archived: boolean) => void
}) {
  const archived = task.run.archived
  if (!archived && !ARCHIVABLE_STATUSES.has(task.run.status)) return null
  const label = archived
    ? `Restore ${runTitle(task.run)} to the active list`
    : `Archive ${runTitle(task.run)}`
  const Icon = archived ? ArchiveRestoreIcon : ArchiveIcon
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-action={archived ? 'unarchive-run' : 'archive-run'}
          aria-label={label}
          disabled={busy}
          onClick={() => onArchive(task, !archived)}
          className="inline-flex size-11 items-center justify-center md:size-8 rounded-md text-soft-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-wait disabled:opacity-50"
        >
          <Icon className="size-3.5" aria-hidden="true" /><span>{archived ? 'Unarchive' : 'Archive'}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{archived ? 'Restore' : 'Archive'}</TooltipContent>
    </Tooltip>
  )
}

/**
 * A task's tracker references — all of them.
 *
 * Bounded rather than unbounded: `taskReferences` reads only real fields (never the transcript
 * candidate lists, see #526) so three is already a lot, but a table cell must not be able to
 * grow without limit on one odd record. Past the cap the rest collapse into a `+N` that NAMES
 * them in its tooltip, so nothing becomes invisible — it only stops taking vertical space.
 */
function ReferenceChips({
  references,
  run,
  repoBase,
}: {
  references: readonly TaskReference[]
  run: RunIndexEntry
  /** The row's own project repository: an own-repo reference opens the task's item tab (#692). */
  repoBase: string | undefined
}) {
  return <ReferenceList references={references} maxVisible={MAX_VISIBLE_REFERENCES}
    taskTitle={runTitle(run)} projectId={run.projectId} runId={run.id} repoBase={repoBase} />
}

/**
 * A project's tag, in a table cell.
 *
 * Deliberately QUIET — muted, like the branch chip beside it. Tags repeat on every row of a
 * project, so painting them in the accent turned a whole column into the loudest thing on the
 * page while saying the least: they are context for the row, not its status. The violet is spent
 * where it earns attention instead — the status dot, the reference chips, and a tag chip in the
 * FILTER bar, where being selected is a state worth seeing.
 */
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
