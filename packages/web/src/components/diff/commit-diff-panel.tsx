import { SearchXIcon } from 'lucide-react'
import { ArrowLeftIcon, GitCommitHorizontalIcon, TriangleAlertIcon } from '@/components/design-icons'
import { useState } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import type { RepoCommitPayload } from '@open-mercato/cezar-api-client'

import { ApiError } from '@/api/client'
import { CenteredState } from '@/components/centered-state'
import { Diff, type DiffMode } from '@/components/diff'
import { DiffStat, Sha } from '@/components/data-primitives'
import { Button } from '@/components/ui/button'
import { Link } from '@/lib/project-router'
import { useIsDesktop } from '@/lib/use-desktop'
import { gitAge } from '@/routes/repo-git/git-sections'
import { DiffViewToggles } from '@/routes/task-git/diff-controls'

type CommitDiffPanelProps = {
  commit: UseQueryResult<RepoCommitPayload, Error>
  sha: string
  backTo: string
  backLabel: string
  slot: string
  className: string
  diffClassName: string
}

export function CommitDiffPanel({ commit, sha, backTo, backLabel, slot, className, diffClassName }: CommitDiffPanelProps) {
  const desktop = useIsDesktop()
  const [mode, setMode] = useState<DiffMode>('unified')
  // Wrap on by default, like the Changes views, so the toggle reads the same on every diff.
  const [wrap, setWrap] = useState(true)

  // 409 = the server's answer (unknown sha, not a hash) — a dead link, not an outage.
  const refused = commit.isError && commit.error instanceof ApiError && commit.error.status === 409

  const effectiveMode: DiffMode = desktop ? mode : 'unified'

  return (
    <section data-slot={slot} data-sha={sha} className={className}>
      {/* Both dividers sit inside the content gutter (a margin, not padding), so they line up
          with the diff cards below instead of running to the window edge. */}
      <div className="mx-4 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border py-2 md:mx-9">
        <Button asChild variant="ghost" size="sm" data-slot="commit-back">
          <Link to={backTo}>
            <ArrowLeftIcon size={16} aria-hidden="true" />
            {backLabel}
          </Link>
        </Button>
        <span className="ml-auto flex items-center gap-1">
          <DiffViewToggles mode={mode} wrap={wrap} onModeChange={setMode} onWrapChange={setWrap} />
        </span>
      </div>

      {commit.isPending ? (
        <p data-slot="commit-loading" className="px-4 py-6 text-center text-xs text-muted-foreground md:px-9">
          Loading commit…
        </p>
      ) : commit.isError ? (
        <CenteredState
          icon={refused ? <SearchXIcon /> : <TriangleAlertIcon size={16} />}
          tone={refused ? 'neutral' : 'danger'}
          heading="h2"
          title={refused ? 'Commit not found' : 'Could not load the commit'}
          subtitle={commit.error.message}
        />
      ) : (
        <>
          <div data-slot="commit-meta" className="mx-4 border-b border-border py-3 md:mx-9">
            <h2 className="text-sm font-semibold">{commit.data.subject}</h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              <span>{commit.data.author}</span>
              <span aria-hidden="true">·</span>
              <span title={commit.data.when}>{gitAge(commit.data.when)}</span>
              <span aria-hidden="true">·</span>
              <Sha sha={commit.data.sha} variant="inline" />
              {/* The stat belongs to the commit, so it ends the commit's own line (as in the task's
                  Commits tab), not the back link's. */}
              <span aria-hidden="true">·</span>
              <span data-slot="commit-stat"><DiffStat stat={commit.data.stat} /></span>
            </p>
          </div>
          {commit.data.files.length === 0 ? (
            <CenteredState
              icon={<GitCommitHorizontalIcon size={16} />}
              tone="neutral"
              heading="h2"
              title="No file changes"
              subtitle="This commit carries no diff of its own — a merge commit's changes live on the commits it merged."
            />
          ) : (
            <div className={diffClassName}>
              <Diff files={commit.data.files} mode={effectiveMode} wrap={wrap} totals={false} className="min-w-0" />
            </div>
          )}
        </>
      )}
    </section>
  )
}
