import { FileCodeIcon, GitCommitHorizontalIcon, TriangleAlertIcon } from '@/components/design-icons'
import { useRef, useState } from 'react'
import { useParams } from 'react-router'
import { useQueries } from '@tanstack/react-query'

import { Link } from '@/lib/project-router'

import { ApiError } from '@/api/client'
import { getRunCommit } from '@/api/client-runs'
import { queryKeys, useRun, useRunCommit, useRunCommits } from '@/api/queries'
import type { ApiRun, ChangedFile, DiffStat, RunCommit } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Diff, type DiffHandle, type DiffMode } from '@/components/diff'
import { ChangeCounts } from '@/components/diff/change-counts'
import { DiffStatLabel } from '@/components/diff-stat'
import { CommitDiffPanel } from '@/components/diff/commit-diff-panel'
import { useIsDesktop } from '@/lib/use-desktop'

import { engineOwnsRun } from '@open-mercato/cezar-api-client/contract/run-predicates'
import { gitAge } from '../repo-git/git-sections'
import { RunHeader } from '../task-thread/run-header'
import { CommitList } from './commit-list'
import { DiffViewToggles } from './diff-controls'
import { GitTabLoadError, GitTabLoading } from './git-tab-loading'
import { loadWorktreeText } from './task-changes'

/**
 * `/tasks/:id/commits` — the run's own commits (`<base>..HEAD`), auto-selecting the newest
 * commit so its structured diff renders immediately beside the commit list, while each row
 * still deep-links to `/tasks/:id/commits/:sha`.
 */
export function TaskCommitsRoute() {
  const { id } = useParams<{ id: string }>()
  const run = useRun(id)

  if (run.isPending) return <GitTabLoading tab="changes" />
  if (run.isError) return <GitTabLoadError tab="changes" error={run.error} />
  return <CommitsView run={run.data} />
}

function CommitsView({ run }: { run: ApiRun }) {
  const { sha } = useParams<{ sha: string }>()
  const commits = useRunCommits(run.id, engineOwnsRun(run))
  const firstSha = commits.data?.commits[0]?.sha

  return (
    <div data-route="task-commits" className="flex min-h-full flex-col">
      <RunHeader run={run} tab="commits" />
      {sha ? (
        <CommitDiffView runId={run.id} sha={sha} />
      ) : commits.isPending ? (
        <p data-slot="commits-loading" className="px-4 py-6 text-center text-xs text-soft-foreground md:px-9">
          Loading commits…
        </p>
      ) : commits.isError ? (
        <CenteredState
          icon={<GitCommitHorizontalIcon size={16} />}
          tone={commits.error instanceof ApiError && commits.error.status === 409 ? 'neutral' : 'danger'}
          heading="h2"
          title={
            commits.error instanceof ApiError && commits.error.status === 409
              ? 'No commits to show'
              : 'Could not load the commits'
          }
          subtitle={commits.error.message}
        />
      ) : commits.data.commits.length === 0 ? (
        <CenteredState
          icon={<GitCommitHorizontalIcon size={16} />}
          tone="neutral"
          heading="h2"
          title="No commits yet"
          subtitle="This task hasn't committed anything on its branch. Autosave commits and any the agent makes appear here."
        />
      ) : (
        <CommitsWorkspace run={run} commits={commits.data.commits} selectedSha={firstSha} />
      )}
    </div>
  )
}

function CommitsWorkspace({
  run,
  commits,
  selectedSha,
}: {
  run: ApiRun
  commits: RunCommit[]
  selectedSha: string | undefined
}) {
  const activeCommit = useRunCommit(run.id, selectedSha)
  const commitStats = useCommitStats(run.id, commits)
  const diffRef = useRef<DiffHandle | null>(null)
  const desktop = useIsDesktop()
  const [mode, setMode] = useState<DiffMode>('unified')
  const [wrap, setWrap] = useState(true)
  const effectiveMode: DiffMode = desktop ? mode : 'unified'

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 px-4 py-5 md:px-9 lg:flex-row lg:items-start">
      <div className="w-full shrink-0 lg:w-[380px] xl:w-[420px]">
        <CommitList
          slot="task-commits"
          selectedSha={selectedSha}
          heading={
            <h2 className="text-sm font-semibold text-foreground">
              {commits.length} {commits.length === 1 ? 'commit' : 'commits'} in this task
            </h2>
          }
          className="w-full"
          commits={commits.map((commit: RunCommit) => ({
            ...commit,
            href: `/tasks/${run.id}/commits/${commit.sha}`,
            stat: commitStats.get(commit.sha),
          }))}
        />
        {selectedSha && activeCommit.data && activeCommit.data.files.length > 0 ? (
          <CommitFiles
            runId={run.id}
            sha={selectedSha}
            files={activeCommit.data.files}
            onPick={(path) => diffRef.current?.scrollToPath(path)}
          />
        ) : null}
      </div>

      {selectedSha ? (
        <section
          data-slot="task-commit-preview"
          data-sha={selectedSha}
          className="min-w-0 flex-1 overflow-hidden rounded-xl border border-border bg-card"
        >
          {activeCommit.isPending ? (
            <p className="px-4 py-8 text-center text-xs text-muted-foreground">Loading commit diff…</p>
          ) : activeCommit.isError ? (
            <CenteredState
              icon={<TriangleAlertIcon size={16} />}
              tone="danger"
              heading="h2"
              title="Could not load commit diff"
              subtitle={activeCommit.error.message}
            />
          ) : (
            <>
              <div className="flex flex-wrap items-start gap-x-3 gap-y-2 border-b border-border px-4 py-3">
                <div className="min-w-0 flex-1">
                  <h3 className="break-words text-sm leading-snug font-semibold text-foreground">{activeCommit.data.subject}</h3>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                    <span>{activeCommit.data.author}</span>
                    <span aria-hidden="true">·</span>
                    <span title={activeCommit.data.when}>{gitAge(activeCommit.data.when)}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono select-all" title={activeCommit.data.sha ?? selectedSha}>{(activeCommit.data.sha ?? selectedSha).slice(0, 8)}</span>
                    {activeCommit.data.stat ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <DiffStatLabel stat={activeCommit.data.stat} />
                      </>
                    ) : null}
                  </p>
                </div>
                <span className="flex shrink-0 items-center gap-1.5">
                  <DiffViewToggles mode={mode} wrap={wrap} onModeChange={setMode} onWrapChange={setWrap} />
                </span>
              </div>
              {!activeCommit.data.files || activeCommit.data.files.length === 0 ? (
                <CenteredState
                  icon={<GitCommitHorizontalIcon size={16} />}
                  tone="neutral"
                  heading="h2"
                  title="No file changes"
                  subtitle="This commit carries no diff of its own — a merge commit's changes live on the commits it merged."
                />
              ) : (
                <div className="p-4 [--diff-sticky-top:0px] md:[--diff-sticky-top:1rem]">
                  <Diff
                    viewRef={diffRef}
                    files={activeCommit.data.files}
                    mode={effectiveMode}
                    wrap={wrap}
                    loadFileText={(path) => loadWorktreeText(run.id, path)}
                    totals={false}
                    className="min-w-0"
                  />
                </div>
              )}
            </>
          )}
        </section>
      ) : null}
    </div>
  )
}

function CommitDiffView({ runId, sha }: { runId: string; sha: string }) {
  const commit = useRunCommit(runId, sha)

  return (
    <CommitDiffPanel
      commit={commit}
      sha={sha}
      backTo={`/tasks/${runId}/commits`}
      backLabel="All commits"
      slot="task-commit"
      className="mx-auto flex min-h-0 w-full max-w-[var(--measure)] flex-1 flex-col"
      diffClassName="px-4 py-4 [--diff-sticky-top:0px] md:[--diff-sticky-top:1rem] md:px-9"
    />
  )
}

/** Up to this many commits, every list row fetches its commit to show its ± stat. A longer
 *  list shows the numbers only for commits already in the query cache (opened this session). */
const COMMIT_STAT_FETCH_MAX = 12

/** Each commit's ± stat for its list row, through the same query the commit view reads. */
function useCommitStats(runId: string, commits: RunCommit[]): Map<string, DiffStat> {
  const fetchAll = commits.length <= COMMIT_STAT_FETCH_MAX
  const results = useQueries({
    queries: commits.map((commit) => ({
      queryKey: queryKeys.runs.commit(runId, commit.sha),
      queryFn: ({ signal }: { signal: AbortSignal }) => getRunCommit(runId, commit.sha, { signal }),
      enabled: fetchAll,
      retry: false,
    })),
  })
  const stats = new Map<string, DiffStat>()
  results.forEach((result, index) => {
    const sha = commits[index]?.sha
    if (sha && result.data?.stat) stats.set(sha, result.data.stat)
  })
  return stats
}

/** The selected commit's own files with their ± counts. A row scrolls the diff beside it to that
 *  file; the heading's link leads to the whole task's Changes view. */
function CommitFiles({ runId, sha, files, onPick }: {
  runId: string
  sha: string
  files: ChangedFile[]
  onPick: (path: string) => void
}) {
  return (
    <section data-slot="task-commit-files" className="mt-4 rounded-xl border border-border bg-card p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold text-foreground">
          {files.length} {files.length === 1 ? 'file' : 'files'} in{' '}
          <span className="font-mono text-[13px] font-medium" title={sha}>{sha.slice(0, 8)}</span>
        </h2>
        <Link to={`/tasks/${runId}/changes`} className="text-xs text-muted-foreground hover:text-foreground">
          All task changes ›
        </Link>
      </div>
      <ul className="space-y-1">
        {files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              data-slot="task-commit-file"
              title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              onClick={() => onPick(file.path)}
              className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <FileCodeIcon size={16} aria-hidden="true" className="size-[15px] shrink-0" />
              <span className="min-w-0 flex-1 break-all">{file.path}</span>
              <ChangeCounts adds={file.adds} dels={file.dels} className="font-mono text-xs" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
