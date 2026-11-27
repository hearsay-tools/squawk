import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'

import { queryKeys, useRepo } from '@/api/queries'
import { RefreshCwIcon } from '@/components/design-icons'
import { PageShellActionButton, TablePage } from '@/components/page-shell'
import { cn } from '@/lib/utils'

import { GitCheckoutBlock } from './git-checkout-block'
import { GitSectionList } from './git-section-list'
import { useGitSectionCounts } from './use-git-section-counts'

/**
 * The phone's Git entry (issue 06 §3, #622): the checkout block and the sections as their own
 * screen, 48px rows with chevrons — the GitHub filter screen's pattern. A section pushes its
 * screen (`/git?view=repo`, `/git/cleanup`, `/git/branches`), each with a "Back to Git" link here.
 * Rendered by the routed view, so `queryScope()` is already the project on screen.
 */
export function GitScreen() {
  const scope = queryScope()
  const repo = useRepo()
  const queryClient = useQueryClient()
  const refreshing = useIsFetching({ queryKey: queryKeys.repo }) > 0
  const data = repo.data?.info ? repo.data : null
  const counts = useGitSectionCounts(scope, data, 'screen')
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.repo })
    void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees })
  }
  return (
    <TablePage
      route="repo-git"
      density={data?.info ? 'full' : 'empty'}
      headerSpacing="compact"
      header={{
        title: 'Git',
        secondaryActions: (
          <PageShellActionButton
            type="button"
            variant="ghost"
            data-slot="git-screen-refresh"
            aria-label="Refresh the repository"
            title="Refresh the repository"
            disabled={refreshing}
            onClick={refresh}
          >
            <RefreshCwIcon size={17} aria-hidden="true" className={cn('size-[17px]', refreshing && 'motion-safe:animate-spin')} />
          </PageShellActionButton>
        ),
      }}
    >
      <div data-slot="git-screen">
        {data?.info ? (
          <div className="mb-[16px]">
            <GitCheckoutBlock key={scope} scope={scope} repo={data} info={data.info} variant="screen" />
          </div>
        ) : repo.isPending ? (
          <p data-slot="git-screen-loading" role="status" className="mb-[16px] px-[10px] text-[13px] text-soft-foreground">Loading the checkout…</p>
        ) : repo.isError ? (
          <p data-slot="git-screen-error" role="alert" className="mb-[16px] px-[10px] text-[13px] text-danger">Could not load the repository: {repo.error.message}</p>
        ) : (
          <p data-slot="git-screen-not-git" className="mb-[16px] px-[10px] text-[13px] text-soft-foreground">Not a git repository.</p>
        )}
        {/* Same rule as the sidebar: the sections wait for the checkout so they never shift under a tap. */}
        {repo.isPending ? null : <GitSectionList branch={data?.info?.branch ?? null} counts={counts} variant="screen" />}
      </div>
    </TablePage>
  )
}
