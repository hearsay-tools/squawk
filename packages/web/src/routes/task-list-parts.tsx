import * as React from 'react'
import type { ReactNode } from 'react'
import { useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { CheckCheckIcon, MoreHorizontalIcon } from 'lucide-react'

import type { ArchivedRunsResponse, RunSummary } from '@open-mercato/cezar-api-client'

import { queryKeys, useArchivedRuns } from '@/api/queries'
import { runnerDisplayName, useRunners } from '@/api/runners'
import { useRunCacheWriter } from '@/api/use-run-cache-writer'
import { Count, Path, formatFullTime } from '@/components/data-primitives'
import { ArchiveIcon, PlusIcon, SearchIcon } from '@/components/design-icons'
import { PageShellActionButton, PageShellSparseFooter, pageShellDensity } from '@/components/page-shell'
import { GroupFoldControls, OriginFilter } from '@/components/task-status-groups'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { AttentionTone } from '@/lib/attention'
import { Link } from '@/lib/project-router'
import {
  isColumnExpanded,
  type NormalizedExpandedColumns,
  type TaskColumnDefinition,
  type TaskColumnId,
} from '@/lib/task-columns'
import { ARCHIVED_WINDOW, listCounts, type BucketLabel, type ListView } from '@/lib/task-groups'
import { groupTone, type originCounts as originCountsFn, type TaskOrigin } from '@/lib/task-origin'
import { DESKTOP_MEDIA_QUERY } from '@/lib/use-desktop'
import { cn } from '@/lib/utils'
import type { ArchivedPages } from './tasks-overview'

/**
 * A status group heading's dot. Finished holds successful and failed tasks alike, so its heading
 * stays neutral; each row's own status dot reports the outcome. Every other group keeps its tone.
 */
export function headingTone(label: BucketLabel, members: readonly RunSummary[]): AttentionTone {
  return label === 'Finished' ? 'neutral' : groupTone(label, members)
}

/** A task title link's type in a list row: one size, line height and weight rule on both lists.
 *  One line ends in an ellipsis; two lines (the detailed table's tall rows) wrap, then clamp. */
export function taskTitleClass(unread: boolean, readDone: boolean, lines: 1 | 2 = 1): string {
  return cn(
    lines === 2
      ? 'line-clamp-2 min-w-0 whitespace-normal rounded-sm text-[13px] leading-[18px]'
      : 'min-w-0 truncate rounded-sm text-[13px] leading-[18px]',
    unread ? 'font-semibold text-foreground' : readDone ? 'font-normal text-foreground' : 'font-medium text-foreground',
  )
}

/** A timestamp's full local date and time, for the `title` of a relative age. */
export function fullTime(iso: string | undefined): string | undefined {
  return formatFullTime(iso)
}

/** A page-level view tab's classes: compact underline pill in Tier 1 on desktop, 44px touch target on mobile. */
const VIEW_TAB =
  'inline-flex min-h-11 md:min-h-0 md:h-8 items-center justify-center gap-1.5 border-b-2 border-transparent px-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
const VIEW_TAB_ACTIVE = 'border-accent-text font-medium text-foreground'

/** Active or Archived on a task list, with the number of tasks it holds. */
export function ViewTab({
  view,
  current,
  onSelect,
  count,
  children,
}: {
  view: ListView
  current: ListView
  onSelect: (view: ListView) => void
  /** A number, or `200+` while the list holds a full window and the total is unknown. */
  count: number | string
  children: ReactNode
}) {
  const isActive = view === current
  return (
    <button
      type="button"
      data-slot="overview-tab"
      data-view={view}
      // Same rationale as the sidebar's tabs: these filter one list in place, they do not switch
      // panels — `aria-pressed` is what that actually is.
      aria-pressed={isActive}
      onClick={() => onSelect(view)}
      className={cn(VIEW_TAB, isActive && VIEW_TAB_ACTIVE)}
    >
      {children}
      {count !== 0 ? <span className="tabular-nums">{' · '}<Count value={count} /></span> : null}
    </button>
  )
}

/** Shared Active / Archived tab strip mounted in Tier 1 of Project Tasks and Global Tasks. */
export function TaskViewTabs({
  view,
  onSelect,
  activeCount,
  archivedCount,
  trailing,
}: {
  view: ListView
  onSelect: (view: ListView) => void
  activeCount: number | string
  archivedCount: number | string
  trailing?: ReactNode
}) {
  return (
    <div data-slot="tasks-view-tabs" className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <ViewTab view="active" current={view} onSelect={onSelect} count={activeCount}>
        Active
      </ViewTab>
      <ViewTab view="archived" current={view} onSelect={onSelect} count={archivedCount}>
        Archived
      </ViewTab>
      {trailing}
    </div>
  )
}

/** The honest absent value of a list cell. */
export function Dash() {
  return <span className="text-xs text-soft-foreground">—</span>
}

export function resultCaption(count: number, incomplete: boolean, needle: string): string {
  return `${count} ${count === 1 ? 'task' : 'tasks'}${incomplete ? ' loaded' : ''}${needle ? ` matching “${needle}”` : ''}`
}

/** The list's count shown inline beside the tabs when informative. */
export function ResultCount({ count, incomplete, needle }: { count: number; incomplete: boolean; needle: string }) {
  return (
    <span
      data-slot="tasks-result-count"
      className={cn(
        'self-center truncate text-xs text-soft-foreground tabular-nums',
        needle === '' && !incomplete && 'max-md:hidden',
      )}
    >
      {resultCaption(count, incomplete, needle)}
    </span>
  )
}

/** A task's branch name as a muted mono chip, cut with an ellipsis; the full name is its tooltip. */
export function BranchChip({ branch }: { branch: string }) {
  return <Path value={branch} variant="chip" />
}

/** A runner's name as its definition in `GET /api/v1/runners` gives it; the id until the list answers. */
export function RunnerName({ runner }: { runner: string }) {
  return runnerDisplayName(useRunners().data, runner)
}

/**
 * Shared bulk actions (`Mark all read` and `Archive finished`) for Tier 1 of both Project Tasks
 * and Global Tasks. On mobile, both sweeps collapse into one `Task actions` overflow menu so the
 * header stays compact above the first row.
 */
export function TaskBulkActions({
  view,
  unread,
  finished,
  archivePending,
  markReadPending = false,
  onMarkAllRead,
  onArchiveFinished,
  focusReturnRef,
}: {
  view: ListView
  unread: number
  finished: number
  archivePending: boolean
  markReadPending?: boolean
  onMarkAllRead: () => void
  onArchiveFinished: () => void
  focusReturnRef?: React.RefObject<HTMLElement | null>
}) {
  const archiveSelected = React.useRef(false)
  const [actionsOpen, setActionsOpen] = React.useState(false)
  const sweepable = finished > 0 || archivePending

  // A CSS-hidden Radix menu would keep its modal focus trap after a desktop resize.
  React.useEffect(() => {
    const media = window.matchMedia?.(DESKTOP_MEDIA_QUERY)
    if (!media) return
    const closeOnDesktop = () => {
      if (media.matches) setActionsOpen(false)
    }
    closeOnDesktop()
    media.addEventListener('change', closeOnDesktop)
    return () => media.removeEventListener('change', closeOnDesktop)
  }, [])

  return (
    <>
      {unread > 0 ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-slot="mark-all-read"
          disabled={markReadPending}
          aria-busy={markReadPending}
          className="hidden h-8 md:inline-flex"
          onClick={onMarkAllRead}
        >
          <CheckCheckIcon className="size-3.5" aria-hidden="true" />
          Mark all read <Count value={unread} className="text-muted-foreground" />
        </Button>
      ) : null}
      {view === 'active' && finished > 0 ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-slot="archive-finished"
          className="hidden h-8 md:inline-flex"
          disabled={archivePending}
          aria-busy={archivePending}
          onClick={onArchiveFinished}
        >
          <ArchiveIcon className="size-3.5" aria-hidden="true" />
          Archive finished <Count value={finished} className="text-muted-foreground" />
        </Button>
      ) : null}
      {view === 'active' && (sweepable || unread > 0) ? (
        <DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="min-h-11 min-w-11 md:hidden"
              aria-label="Task actions"
              aria-busy={archivePending || markReadPending}
            >
              <MoreHorizontalIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="md:hidden"
            onCloseAutoFocus={(event) => {
              if (archiveSelected.current || window.matchMedia?.(DESKTOP_MEDIA_QUERY).matches) {
                event.preventDefault()
                archiveSelected.current = false
                const root = focusReturnRef?.current ?? document
                root.querySelector<HTMLButtonElement>('[data-slot="overview-tab"][data-view="active"]')?.focus()
              }
            }}
          >
            {sweepable ? (
              <DropdownMenuItem
                disabled={archivePending || finished === 0}
                onSelect={() => {
                  archiveSelected.current = true
                  onArchiveFinished()
                }}
              >
                <ArchiveIcon aria-hidden="true" />
                {archivePending ? 'Archiving…' : `Archive finished (${finished})`}
              </DropdownMenuItem>
            ) : null}
            {unread > 0 ? (
              <DropdownMenuItem disabled={markReadPending} onSelect={onMarkAllRead}>
                <CheckCheckIcon aria-hidden="true" />
                {`Mark all read (${unread})`}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </>
  )
}

function columnCheckboxLabel(column: TaskColumnDefinition): string {
  if (column.id === 'diff') return 'Diff'
  if (column.id === 'reference') return 'Reference'
  if (column.id === 'memory') return 'Memory'
  return column.summaryLabel ?? column.label
}

/** Shared column selector popover for Project Tasks and Global Tasks. */
export function TaskColumnsPopover({
  columns,
  expandedColumns,
  columnsPending,
  onToggleColumn,
  detailedTable,
  onToggleDetailed,
}: {
  columns: readonly TaskColumnDefinition[]
  expandedColumns: NormalizedExpandedColumns
  columnsPending: boolean
  onToggleColumn: (id: TaskColumnId) => void
  detailedTable?: boolean | undefined
  onToggleDetailed?: (() => void) | undefined
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button data-slot="task-columns-trigger" variant="outline" className="hidden h-9 md:inline-flex">
          Columns
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <h2 className="mb-2 text-base font-medium">Visible columns</h2>
        <p className="mb-4 text-xs text-muted-foreground">Task · Always visible</p>
        <div className="grid grid-cols-2 gap-3">
          {columns
            .filter((column) => column.canFold)
            .map((column) => (
              <label key={column.id} className="flex items-center gap-2 text-xs">
                <input
                  data-column-toggle={column.id}
                  type="checkbox"
                  checked={isColumnExpanded(column.id, expandedColumns)}
                  disabled={columnsPending}
                  onChange={() => onToggleColumn(column.id)}
                />
                {columnCheckboxLabel(column)}
              </label>
            ))}
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          Saved automatically across task lists.
        </p>
        {onToggleDetailed ? (
          <Button variant="outline" className="mt-4" onClick={onToggleDetailed}>
            {detailedTable ? 'Summary view' : 'Resource columns'}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

/**
 * Shared Tier 2 control strip for Project Tasks and Global Tasks: search input, compact origin
 * filter, optional route-specific controls (e.g. Global Tasks Filters button), Columns popover, and
 * compact group fold controls in one horizontal bar.
 */
export function TaskControlStrip({
  query,
  onQueryChange,
  searchPlaceholder,
  searchLabel,
  origin,
  originCounts,
  automations,
  onOriginChange,
  columns,
  expandedColumns,
  columnsPending,
  onToggleColumn,
  detailedTable,
  onToggleDetailed,
  groupLabels,
  onSetAllFolds,
  extraControls,
}: {
  query: string
  onQueryChange: (value: string) => void
  searchPlaceholder: string
  searchLabel: string
  origin: TaskOrigin
  originCounts: ReturnType<typeof originCountsFn>
  automations: boolean
  onOriginChange: (origin: TaskOrigin) => void
  columns: readonly TaskColumnDefinition[]
  expandedColumns: NormalizedExpandedColumns
  columnsPending: boolean
  onToggleColumn: (id: TaskColumnId) => void
  detailedTable?: boolean | undefined
  onToggleDetailed?: (() => void) | undefined
  groupLabels: readonly BucketLabel[]
  onSetAllFolds: (labels: readonly BucketLabel[], folded: boolean) => void
  extraControls?: ReactNode
}) {
  return (
    <div data-slot="tasks-toolbar" className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 basis-full md:min-w-48 md:flex-1 md:basis-auto">
        <SearchIcon
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-soft-foreground"
          aria-hidden="true"
        />
        <input
          type="text"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchLabel}
          className="h-11 w-full rounded-md border border-input bg-card pr-3 pl-8 text-[13px] text-foreground outline-none placeholder:text-soft-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:h-9"
        />
      </div>
      <OriginFilter
        origin={origin}
        counts={originCounts}
        automations={automations}
        onChange={onOriginChange}
        compact
      />
      {extraControls}
      <TaskColumnsPopover
        columns={columns}
        expandedColumns={expandedColumns}
        columnsPending={columnsPending}
        onToggleColumn={onToggleColumn}
        detailedTable={detailedTable}
        onToggleDetailed={onToggleDetailed}
      />
      {groupLabels.length > 0 ? (
        <GroupFoldControls
          onExpand={() => onSetAllFolds(groupLabels, false)}
          onCollapse={() => onSetAllFolds(groupLabels, true)}
          compact
        />
      ) : null}
    </div>
  )
}

export function tasksOverviewHeader({
  projectName,
  status,
  secondaryActions,
}: {
  projectName: string | undefined
  status: ReactNode
  secondaryActions: ReactNode
}) {
  return {
    title: 'Project tasks',
    status: (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {projectName ? (
          <span data-slot="tasks-project-scope" className="text-xs font-medium text-muted-foreground">
            {projectName}
          </span>
        ) : null}
        {status}
      </div>
    ),
    secondaryActions,
    primaryAction: (
      <PageShellActionButton asChild variant="primary" data-slot="new-task-inline">
        <Link to="/new">
          <PlusIcon aria-hidden="true" />
          New task
        </Link>
      </PageShellActionButton>
    ),
  }
}

export function tasksOverviewSparseFooter(ready: boolean, visibleCount: number, view: ListView, needle: string) {
  if (!ready || visibleCount <= 0 || needle !== '') return undefined
  return (
    <PageShellSparseFooter
      summary={`${visibleCount} ${view} ${visibleCount === 1 ? 'task' : 'tasks'} in this project.`}
      actions={
        <Button variant="outline" size="sm" asChild className="max-md:min-h-11">
          <Link to="/new">Start another task</Link>
        </Button>
      }
    />
  )
}

export function tasksOverviewDensity(runs: RunSummary[] | undefined, visibleCount: number) {
  return runs === undefined ? 'full' : pageShellDensity(visibleCount)
}

export function tasksOverviewRootProps(detailedTable: boolean) {
  return { 'data-presentation': detailedTable ? 'resources' : 'summary' }
}

/** How long the Archived tab waits after a keystroke before it asks the server to search. */
const ARCHIVED_SEARCH_DEBOUNCE_MS = 150

/**
 * The Archived tab's reach past the run list's window (#864). The list carries the newest
 * `ARCHIVED_WINDOW` archived tasks; when it holds that many there may be older ones, so the tab
 * reads the server's pages (the first one overlaps the window, which is what lets the next one
 * add rows rather than repeat them). A search on that tab asks the server too, debounced, since
 * the matches can be anywhere in the history.
 */
export function useArchivedPages(runs: readonly RunSummary[] | undefined, view: ListView): {
  pages: ArchivedPages | undefined
  total: number | undefined
  search: (needle: string) => void
} {
  useRunCacheWriter()
  const queryClient = useQueryClient()
  const [typed, setTyped] = React.useState('')
  const [needle, setNeedle] = React.useState('')
  React.useEffect(() => {
    const timer = setTimeout(() => setNeedle(typed), ARCHIVED_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [typed])
  const windowFull = runs !== undefined && listCounts(runs).archived >= ARCHIVED_WINDOW
  const { data, isError, isPlaceholderData, hasNextPage, isFetchingNextPage, fetchNextPage, refetch } =
    useArchivedRuns(needle, view === 'archived' && (needle !== '' || windowFull))
  const loaded = data?.pages
  const pages = React.useMemo<ArchivedPages | undefined>(
    () =>
      loaded || isError
        ? {
            runs: (loaded ?? []).flatMap((page) => page.runs),
            // `placeholderData` keeps the previous text's pages on screen while the next ones load.
            query: isPlaceholderData ? null : needle,
            hasMore: hasNextPage,
            loading: isFetchingNextPage,
            // A failed first page has nothing to continue from, so retrying it is a refetch.
            onLoadMore: () => void (loaded ? fetchNextPage() : refetch()),
            failed: isError,
          }
        : undefined,
    [loaded, isError, isPlaceholderData, needle, hasNextPage, isFetchingNextPage, fetchNextPage, refetch],
  )
  // Only the unfiltered total counts all archived tasks; a search total counts matches.
  const unfiltered =
    needle === ''
      ? loaded
      : queryClient.getQueryData<InfiniteData<ArchivedRunsResponse>>(queryKeys.runs.archived(''))?.pages
  const plainHasMore = unfiltered === undefined ? undefined : unfiltered.at(-1)?.nextCursor != null
  const enrichedPages = React.useMemo(() => pages && { ...pages, plainHasMore }, [pages, plainHasMore])
  return { pages: enrichedPages, total: unfiltered?.[0]?.total, search: setTyped }
}
