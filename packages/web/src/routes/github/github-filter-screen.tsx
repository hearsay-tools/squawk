import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'

import { RefreshCwIcon } from '@/components/design-icons'
import { PageShellActionButton, TablePage } from '@/components/page-shell'
import { cn } from '@/lib/utils'

import { GithubFilterList } from './github-filter-list'
import { useGithubFilterModel } from './use-github-filter-model'

/**
 * The phone's GitHub entry (#622): the filter list as its own screen. Choosing a row pushes the
 * list (`/github?filter=…`, `/github/prs?filter=…`), which carries a "Back to filters" link here.
 * Rendered by the routed view, so `queryScope()` is already the project on screen.
 */
export function GithubFilterScreen({ onRefresh, refreshing }: { onRefresh: () => void; refreshing: boolean }) {
  const model = useGithubFilterModel(queryScope())
  return (
    <TablePage
      route="github"
      density="full"
      headerSpacing="compact"
      header={{
        title: 'GitHub',
        secondaryActions: (
          <PageShellActionButton
            type="button"
            variant="ghost"
            data-slot="gh-screen-refresh"
            aria-label="Refresh from GitHub"
            title="Refresh from GitHub"
            disabled={refreshing}
            onClick={onRefresh}
          >
            <RefreshCwIcon size={17} aria-hidden="true" className={cn('size-[17px]', refreshing && 'motion-safe:animate-spin')} />
          </PageShellActionButton>
        ),
      }}
    >
      <div data-slot="github-filter-screen">
        <GithubFilterList model={model} variant="screen" />
      </div>
    </TablePage>
  )
}
