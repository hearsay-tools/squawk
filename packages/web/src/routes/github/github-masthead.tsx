import type { GithubData } from '@open-mercato/cezar-api-client'
import { ArrowLeftIcon, RefreshCwIcon } from '@/components/design-icons'
import { shortAge } from '@/lib/format'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'
import type { GithubView } from './github'
import { ACTIVE_FILTER_LABEL, ISSUE_ROWS, PR_ROWS, type GithubFilter } from './github-sidebar-model'

/** The title row: the list on screen with the page actions on its right (the Tasks and
 *  Automations header geometry), the phone's way back to its filters, and the repo line. */
export function GithubMasthead({ view, activeFilter, isDesktop, rawFilterParam, n, gh, actions }: {
  view: GithubView
  activeFilter: GithubFilter
  isDesktop: boolean
  rawFilterParam: string | null
  n: string | undefined
  gh: GithubData
  actions: GithubPageActionsProps
}) {
  return (
    <div data-slot="gh-masthead" className="flex min-w-0 shrink-0 flex-col">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <h1 className="min-w-0 text-[26px] leading-[1.2] font-semibold tracking-tight text-foreground md:text-[28px]">
          {/* The view qualifier is muted and regular weight, as in "Activity · acme-api". */}
          {isDesktop ? (
            <>
              {view === 'issues' ? 'Issues' : 'Pull requests'}{' '}
              <span data-slot="gh-title-qualifier" className="font-normal text-muted-foreground">{`· ${ACTIVE_FILTER_LABEL[activeFilter]}`}</span>
            </>
          ) : 'GitHub'}
        </h1>
        <GithubPageActions {...actions} />
      </div>
      {rawFilterParam !== null && n === undefined ? (
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
      ) : null}
      {gh.repo ? (
        <p className="mt-1 min-w-0 truncate text-[13px] text-muted-foreground">
          <span data-slot="gh-repo">{gh.repo}</span>
          <span data-slot="gh-synced" title={gh.syncedAt ? new Date(gh.syncedAt).toLocaleString() : undefined}> · {gh.syncedAt ? `Synced ${shortAge(gh.syncedAt)}` : 'Not synced yet'}</span>
        </p>
      ) : null}
    </div>
  )
}

type GithubPageActionsProps = { automationsAvailable: boolean; refreshing: boolean; onRefresh: () => void }

/** Set up automations and Refresh: page-level actions, so they sit on the title row, not the tabs. */
function GithubPageActions({ automationsAvailable, refreshing, onRefresh }: GithubPageActionsProps) {
  return (
    <div data-slot="gh-page-actions" className="flex shrink-0 flex-wrap items-center gap-2">
      {automationsAvailable ? (
        <Link to="/automations/new" className="gh-utility">
          Set up automations
        </Link>
      ) : null}
      <button type="button" data-slot="gh-refresh" title="Refresh from GitHub" disabled={refreshing} onClick={onRefresh} className="gh-utility">
        <RefreshCwIcon size={16} aria-hidden="true" className={cn('size-3.5', refreshing && 'motion-safe:animate-spin')} />
        Refresh
      </button>
    </div>
  )
}
