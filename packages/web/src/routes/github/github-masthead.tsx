import type { GithubData } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { ArrowLeftIcon, CircleDotIcon, GitPullRequestIcon, RefreshCwIcon } from '@/components/design-icons'
import { PageShellActionButton, type PageShellHeaderProps } from '@/components/page-shell'
import { shortAge } from '@/lib/format'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'
import type { GithubView } from './github'
import { ACTIVE_FILTER_LABEL, ISSUE_ROWS, PR_ROWS, type GithubFilter } from './github-sidebar-model'

type GithubPageActionsProps = { automationsAvailable: boolean; refreshing: boolean; onRefresh: () => void }

/** Build the PageShell header props for GitHub so its masthead uses the shared shell slots
 *  and unified header button size while preserving historic `data-slot` hooks. */
export function githubHeaderProps({ view, activeFilter, isDesktop, rawFilterParam, n, gh, actions }: {
  view: GithubView
  activeFilter: GithubFilter
  isDesktop: boolean
  rawFilterParam: string | null
  n: string | undefined
  gh: GithubData
  actions: GithubPageActionsProps
}): PageShellHeaderProps {
  return {
    headerSlot: 'gh-masthead',
    title: isDesktop ? (view === 'issues' ? 'Issues' : 'Pull requests') : 'GitHub',
    scope: isDesktop ? (
      <span data-slot="gh-title-qualifier">{ACTIVE_FILTER_LABEL[activeFilter]}</span>
    ) : undefined,
    subtitle: gh.repo ? (
      <span className="block min-w-0 truncate">
        <span data-slot="gh-repo">{gh.repo}</span>
        <span data-slot="gh-synced" title={gh.syncedAt ? new Date(gh.syncedAt).toLocaleString() : undefined}>
          {' '}· {gh.syncedAt ? `Synced ${shortAge(gh.syncedAt)}` : 'Not synced yet'}
        </span>
      </span>
    ) : undefined,
    secondaryActions: <GithubPageActions {...actions} />,
    headerExtra: rawFilterParam !== null && n === undefined ? (
      <div data-slot="gh-filter-context" className="mt-1 flex min-w-0 items-center gap-3 md:hidden">
        <Link to="/github" data-slot="gh-back-filters" className="inline-flex min-h-11 items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeftIcon size={16} aria-hidden="true" className="size-3.5" />
          Back to filters
        </Link>
        {activeFilter !== 'all' ? (
          <span data-slot="gh-active-filter" className="truncate text-xs text-muted-foreground">
            {[...ISSUE_ROWS, ...PR_ROWS].find((row) => row.id === activeFilter)?.label}
          </span>
        ) : null}
      </div>
    ) : undefined,
  }
}

/** Set up automations and Refresh: page-level actions on the shared header row. */
function GithubPageActions({ automationsAvailable, refreshing, onRefresh }: GithubPageActionsProps) {
  return (
    <div data-slot="gh-page-actions" className="flex shrink-0 flex-wrap items-center gap-2">
      {automationsAvailable ? (
        <PageShellActionButton variant="outline" asChild>
          <Link to="/automations/new">Set up automations</Link>
        </PageShellActionButton>
      ) : null}
      <PageShellActionButton
        type="button"
        variant="outline"
        data-slot="gh-refresh"
        title="Refresh from GitHub"
        disabled={refreshing}
        onClick={onRefresh}
      >
        <RefreshCwIcon size={16} aria-hidden="true" className={cn('size-3.5', refreshing && 'motion-safe:animate-spin')} />
        Refresh
      </PageShellActionButton>
    </div>
  )
}

/** No item to show: an empty list, or a number the tab cannot find. */
export function GithubNothingSelected({ view, number }: { view: GithubView; number: number | null }) {
  return (
    <CenteredState
      icon={view === 'issues' ? <CircleDotIcon size={16} /> : <GitPullRequestIcon size={16} />}
      tone="neutral"
      heading="h2"
      title={number === null ? 'Nothing selected' : 'Not found'}
      subtitle={
        number === null
          ? `No open ${view === 'issues' ? 'issues' : 'pull requests'} to show.`
          : // Since #730 a closed or merged item IS reachable — type its number into the
            // search box and the tab asks GitHub directly — so the honest advice is to
            // search, not the old "it may be closed" shrug.
            `#${number} is not among the open ${view === 'issues' ? 'issues' : 'pull requests'}. Search for ${number} above to look it up on GitHub, closed and merged included.`
      }
    />
  )
}
