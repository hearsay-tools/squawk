import './repo-git.css'
import { GitBranchIcon, TriangleAlertIcon } from '@/components/design-icons'

import { useSearchParams } from 'react-router'

import { useRepo, useRepoBranches } from '@/api/queries'
import type { RepoInfo, RepoResponse } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { PageShell, pageShellDensity, type PageShellTemplate } from '@/components/page-shell'
import { useIsDesktop } from '@/lib/use-desktop'

import { GitScreen } from './git-screen'
import { gitSectionLabel } from './git-section-list'
import { fetchedAgo, type GitSection } from './git-sections'
import { RepoBackLink } from './repo-back-link'
import { allBranchNames, RepoBranchesSection } from './repo-branches'
import { RepoChangesSection } from './repo-changes'
import { RepoCommitsSection } from './repo-commits'
import { CleanupBranchesCard } from './repo-cleanup-branches'
import { RepoGitLoading } from './repo-git-loading'
import { RepoNotLandedSection } from './repo-not-landed'
import { WorktreesPanel } from './worktrees-panel'

/**
 * `/git…` — the Git view (issue 06 §3, #622): is the base my agents start from right, and what
 * came back into it? The sections live in the sidebar (desktop) or the phone's Git screen; the
 * main area shows the open one under a header with a title and a meta line, and no tabs:
 *
 * - Recently on main (`/git`, and the old `/git/commits[/:sha]`): the log grouped by day; a
 *   commit opens inside it.
 * - Not landed (`/git/not-landed`, issue 08): finished tasks whose commits are not on the base.
 * - Cleanup (`/git/cleanup`): the worktrees on disk (moved here from Settings) and the branches
 *   safe to delete.
 * - All branches (`/git/branches`): the branch list with switch/create.
 * - Uncommitted changes (`/git/changes`): the main tree's diff, reached from the checkout block.
 *
 * Every section is a URL, so each deep-links and survives a refresh.
 */
function gitSectionTemplate(section: GitSection): PageShellTemplate {
  return section === 'main' || section === 'changes' ? 'Split' : 'Table'
}

export function RepoGitRoute({ section, index = false }: {
  section: GitSection
  /** The bare `/git` route: a phone shows the Git screen there unless `?view=repo`. */
  index?: boolean
}) {
  const repo = useRepo()
  const isDesktop = useIsDesktop()
  const [params] = useSearchParams()
  const template = gitSectionTemplate(section)

  // A phone's bare /git is the Git screen; Recently on main is `?view=repo`. Every other section
  // and deep link keeps its URL, and desktop never shows the screen.
  if (index && !isDesktop && params.get('view') !== 'repo') {
    return <GitScreen />
  }
  if (repo.isPending) return <RepoGitLoading />
  if (repo.isError) {
    return (
      <PageShell template={template} route="repo-git" density="empty" beforeHeader={<RepoBackLink />}>
        <CenteredState
          icon={<TriangleAlertIcon size={16} />}
          tone="danger"
          title="Could not load the repository"
          subtitle={repo.error.message}
        />
      </PageShell>
    )
  }
  const info = repo.data.info
  if (!info) {
    return (
      <PageShell template={template} route="repo-git" density="empty" beforeHeader={<RepoBackLink />}>
        <CenteredState
          icon={<GitBranchIcon size={16} />}
          tone="neutral"
          title="Not a git repository"
          subtitle={`Squawk is running outside a git repository — start it inside one to browse changes, commits and branches.`}
        />
      </PageShell>
    )
  }
  return <RepoView repo={repo.data} info={info} section={section} />
}

function RepoView({ repo, info, section }: { repo: RepoResponse; info: RepoInfo; section: GitSection }) {
  const template = gitSectionTemplate(section)
  const branches = useRepoBranches()
  const sectionCount = section === 'main'
    ? repo.log.length
    : section === 'changes'
      ? repo.status.length
      : section === 'branches'
        ? allBranchNames(repo, branches.data?.branches).length
        : section === 'not-landed'
          ? (branches.data?.branches.filter((b) => b.class === 'not-landed' || b.class === 'orphan').length ?? 0)
          : 4
  const density = section === 'not-landed' && branches.isPending ? 'full' : pageShellDensity(sectionCount)

  return (
    <PageShell
      template={template}
      route="repo-git"
      density={density}
      rootProps={{ 'data-git-section': section }}
      beforeHeader={<RepoBackLink />}
      header={{
        title: gitSectionLabel(section, info.branch),
        headerSlot: 'repo-header',
        subtitle: <SectionMeta repo={repo} info={info} section={section} />,
        subtitleSlot: 'repo-meta',
      }}
    >
      {section === 'main' ? (
        <RepoCommitsSection repo={repo} info={info} />
      ) : section === 'not-landed' ? (
        <RepoNotLandedSection />
      ) : section === 'cleanup' ? (
        <div data-slot="repo-cleanup" className="flex flex-col gap-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:pb-0">
          <WorktreesPanel />
          <CleanupBranchesCard base={repo.baseBranch ?? info.branch} />
        </div>
      ) : section === 'branches' ? (
        <RepoBranchesSection repo={repo} info={info} />
      ) : (
        <RepoChangesSection />
      )}
    </PageShell>
  )
}

/** The header's meta line: one fact about the open section, in the soft ink the board uses. */
function SectionMeta({ repo, info, section }: { repo: RepoResponse; info: RepoInfo; section: GitSection }) {
  const base = repo.baseBranch ?? info.branch
  switch (section) {
    case 'main': {
      const count = repo.log.length === 0 ? 'No commits yet' : `Latest ${repo.log.length} commit${repo.log.length === 1 ? '' : 's'} in the main checkout`
      return <>{count}{repo.tracking ? ` · ${fetchedAgo(repo.tracking)}` : ''}</>
    }
    case 'not-landed':
      return <>Finished tasks whose commits are not on {base}</>
    case 'branches':
      return <BranchesMeta repo={repo} info={info} />
    case 'changes':
      return <>{repo.status.length} uncommitted file{repo.status.length === 1 ? '' : 's'} in the main checkout</>
    case 'cleanup':
      // The section's invariant, stated where it applies; the server enforces it (issue 08 §C).
      return <>Nothing here can delete work that is not on {base}</>
  }
}

function BranchesMeta({ repo, info }: { repo: RepoResponse; info: RepoInfo }) {
  const count = allBranchNames(repo, useRepoBranches().data?.branches).length
  return <>{count} branch{count === 1 ? '' : 'es'} · on {info.branch}</>
}
