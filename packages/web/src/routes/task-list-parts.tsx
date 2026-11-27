import * as React from 'react'
import type { ReactNode } from 'react'
import { useQueryClient, type InfiniteData } from '@tanstack/react-query'

import type { ArchivedRunsResponse, RunSummary } from '@open-mercato/cezar-api-client'

import { queryKeys, useArchivedRuns } from '@/api/queries'
import { useRunCacheWriter } from '@/api/use-run-cache-writer'
import { PlusIcon } from '@/components/design-icons'
import { PageShellActionButton, PageShellSparseFooter, pageShellDensity } from '@/components/page-shell'
import { Button } from '@/components/ui/button'
import type { AttentionTone } from '@/lib/attention'
import { Link } from '@/lib/project-router'
import { ARCHIVED_WINDOW, listCounts, type BucketLabel, type ListView } from '@/lib/task-groups'
import { runnerDisplayName, useRunners } from '@/api/runners'
import { groupTone } from '@/lib/task-origin'
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
    lines === 2 ? 'line-clamp-2 min-w-0 whitespace-normal rounded-sm text-[13px] leading-[18px]' : 'min-w-0 truncate rounded-sm text-[13px] leading-[18px]',
    unread ? 'font-semibold text-foreground' : readDone ? 'font-normal text-foreground' : 'font-medium text-foreground',
  )
}

/** A timestamp's full local date and time, for the `title` of a relative age. */
export function fullTime(iso: string | undefined): string | undefined {
  if (!iso) return undefined
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? undefined : at.toLocaleString()
}

/** A page-level view tab's classes: an underline, never a filled pill. */
const VIEW_TAB = 'flex min-h-11 items-center justify-center gap-1.5 border-b-2 border-transparent text-[13px] text-muted-foreground'
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
      {count !== 0 ? <span className="tabular-nums"> · {count}</span> : null}
    </button>
  )
}

/** The honest absent value of a list cell. */
export function Dash() {
  return <span className="text-xs text-soft-foreground">—</span>
}

export function resultCaption(count: number, incomplete: boolean, needle: string): string {
  return `${count} ${count === 1 ? 'task' : 'tasks'}${incomplete ? ' loaded' : ''}${needle ? ` matching “${needle}”` : ''}`
}
/** The list's count, where All tasks puts its own: at the end of the tab row. Below `md` a plain
 *  count repeats the group headings, so it shows only when it says more. */
export function ResultCount({ count, incomplete, needle }: { count: number; incomplete: boolean; needle: string }) {
  return (
    <span data-slot="tasks-result-count" className={cn('ml-auto self-center truncate text-[13px] text-soft-foreground tabular-nums', needle === '' && !incomplete && 'max-md:hidden')}>
      {resultCaption(count, incomplete, needle)}
    </span>
  )
}

/** A task's branch name as a muted mono chip, cut with an ellipsis; the full name is its tooltip. */
export function BranchChip({ branch }: { branch: string }) {
  return (
    <span
      title={branch}
      className="block truncate rounded-[6px] bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted-foreground"
    >
      {branch}
    </span>
  )
}

/** A runner's name as its definition in `GET /api/v1/runners` gives it; the id until the list answers. */
export function RunnerName({ runner }: { runner: string }) {
  return runnerDisplayName(useRunners().data, runner)
}

export function tasksOverviewHeader(projectName: string | undefined, detailedTable: boolean) {
  return {
    title: 'Project tasks',
    subtitle: (
      <>
        {projectName ? `${projectName} · ` : ''}
        {detailedTable
          ? 'Every resource column shown. Fold columns without losing the saved view.'
          : 'Review runs, pull requests and resource usage.'}
      </>
    ),
    hideSubtitleOnMobile: true,
    primaryAction: (
      <PageShellActionButton asChild variant="primary" data-slot="new-task-inline">
        <Link to="/new"><PlusIcon aria-hidden="true" />New task</Link>
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
  const { data, isError, isPlaceholderData, hasNextPage, isFetchingNextPage, fetchNextPage, refetch } = useArchivedRuns(needle, view === 'archived' && (needle !== '' || windowFull))
  const loaded = data?.pages
  const pages = React.useMemo<ArchivedPages | undefined>(() => (loaded || isError ? {
    runs: (loaded ?? []).flatMap((page) => page.runs),
    // `placeholderData` keeps the previous text's pages on screen while the next ones load.
    query: isPlaceholderData ? null : needle,
    hasMore: hasNextPage,
    loading: isFetchingNextPage,
    // A failed first page has nothing to continue from, so retrying it is a refetch.
    onLoadMore: () => void (loaded ? fetchNextPage() : refetch()),
    failed: isError,
  } : undefined), [loaded, isError, isPlaceholderData, needle, hasNextPage, isFetchingNextPage, fetchNextPage, refetch])
  // Only the unfiltered total counts all archived tasks; a search total counts matches.
  const unfiltered = needle === ''
    ? loaded
    : queryClient.getQueryData<InfiniteData<ArchivedRunsResponse>>(queryKeys.runs.archived(''))?.pages
  const plainHasMore = unfiltered === undefined ? undefined : unfiltered.at(-1)?.nextCursor != null
  const enrichedPages = React.useMemo(() => pages && { ...pages, plainHasMore }, [pages, plainHasMore])
  return { pages: enrichedPages, total: unfiltered?.[0]?.total, search: setTyped }
}
