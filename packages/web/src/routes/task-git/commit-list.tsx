import { GitCommitHorizontalIcon, SearchIcon } from '@/components/design-icons'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Virtualizer } from 'virtua'

import type { DiffStat } from '@open-mercato/cezar-api-client'
import { DiffStatLabel } from '@/components/diff-stat'
import { Input } from '@/components/ui/input'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { gitAge, gitAgeTitle } from '../repo-git/git-sections'

/**
 * The commit log list, shared by the task Commits tab and the repo Commits segment — one
 * `sha · subject · author·when` row per commit, deep-linking to that commit's structured diff.
 *
 * Same two-tier rule as the transcript and the diff (`components/diff/diff-scroll.ts` §"THE
 * PERFORMANCE RULE"): flat with `content-visibility: auto` up to
 * {@link COMMIT_VIRTUALIZE_THRESHOLD} rows, virtua past it. Rows have a fixed two-line layout, which
 * makes this the easy case — `ROW_HEIGHT_PX` is exact rather than an estimate, so the flat
 * tier's placeholders and virtua's initial guesses are right the first time.
 *
 * WHICH CONSUMER ACTUALLY NEEDS THE VIRTUAL TIER — they are not symmetric, and it would be easy
 * to assume they are:
 *  - The TASK Commits tab is why this exists. `collectRunCommits` (src/server/git-changes.ts)
 *    runs `git log <merge-base>..HEAD` with NO cap, and Squawk autosaves a commit per turn, so a
 *    long-running task genuinely reaches hundreds of rows.
 *  - The REPO Commits segment cannot reach the threshold today: `getLog` (src/server/git.ts)
 *    defaults to 20 and `server.ts` calls it without a count, so that list is 20 rows, full
 *    stop. It shares this component for one renderer rather than two, and for the flat tier's
 *    `content-visibility` — not because 20 rows need windowing. If that cap is ever lifted,
 *    this is already correct; until then, don't read the virtual branch as protecting it.
 */

/** Commit rows past which the list goes through virtua. */
export const COMMIT_VIRTUALIZE_THRESHOLD = 150

/** Desktop history-row estimate. Virtua measures expanded mobile rows after mounting. */
const ROW_HEIGHT_PX = 56

export interface CommitListItem {
  sha: string
  subject: string
  author: string
  when: string
  /** The committer date as ISO 8601 when the payload has it: the age and its tooltip read it first. */
  at?: string | undefined
  /** Where the row links to — the two consumers have different route prefixes. */
  href: string
  /** The sha as displayed; the task list abbreviates, the repo log is already short. */
  shaLabel: string
  /** Optional ± diff stat for the commit when already fetched. */
  stat?: DiffStat | undefined
}

export function CommitList({
  slot,
  commits,
  selectedSha,
  className,
  heading,
}: {
  slot: string
  commits: CommitListItem[]
  selectedSha?: string | undefined
  className?: string | undefined
  heading?: ReactNode
}) {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const filtered = normalizedQuery ? commits.filter(commit => commit.subject.toLowerCase().includes(normalizedQuery)) : commits
  const virtual = filtered.length > COMMIT_VIRTUALIZE_THRESHOLD
  const containerRef = useRef<HTMLDivElement | null>(null)
  const scrollElRef = useRef<HTMLElement | null>(null)

  // Same measured `startMargin` as the thread and the diff: the distance from the shell
  // scroller's content start down to this list (headers, toolbars). See diff-view.tsx.
  const [startMargin, setStartMargin] = useState(0)
  useLayoutEffect(() => {
    if (!virtual) return
    const measure = () => {
      const container = containerRef.current
      const scroller = scrollElRef.current
      if (!container || !scroller) return
      setStartMargin(
        Math.max(
          0,
          Math.round(
            container.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop,
          ),
        ),
      )
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [virtual])

  const rows = filtered.map((commit) => (
    <CommitRow key={commit.sha} commit={commit} selected={selectedSha !== undefined && commit.sha === selectedSha} />
  ))

  return (
    <>
      <label className="relative mb-3 block">
        <SearchIcon size={16} aria-hidden="true" className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground" />
        <Input aria-label="Search commit messages" placeholder="Search commit messages…" value={query} onChange={event => setQuery(event.target.value)} className="h-10 rounded-lg border-border bg-card pl-10" />
      </label>
      <div
        ref={(el) => {
          containerRef.current = el
          if (el) scrollElRef.current = el.closest<HTMLElement>('[data-slot="main"]')
        }}
        data-slot={slot}
        data-virtualized={virtual}
        className={cn('flex flex-col divide-y divide-border rounded-xl border border-border bg-card px-3 py-1 md:px-4', className)}
      >
        {heading ? <div className="flex min-h-11 flex-wrap items-center gap-2 py-2.5">{heading}</div> : null}
        {filtered.length === 0 ? <p role="status" className="py-5 text-sm text-muted-foreground">No loaded commits match your search.</p> : null}
        {virtual ? (
          // No `shift`: commit logs are newest-first and only ever grow at the start on a
          // refetch that REPLACES the list, so there is no prepend to anchor against.
          <Virtualizer scrollRef={scrollElRef} startMargin={startMargin} itemSize={ROW_HEIGHT_PX}>
            {rows}
          </Virtualizer>
        ) : (
          rows
        )}
      </div>
    </>
  )
}

function CommitRow({ commit, selected }: { commit: CommitListItem; selected: boolean }) {
  return (
    // Not a <ul>/<li>: virtua inserts its own positioned wrapper between the list and the
    // items, which would break that parent/child contract. A plain list of links reads the
    // same to a screen reader here — each row's accessible name is its own link text.
    <div className="[contain-intrinsic-block-size:auto_56px] [content-visibility:auto]">
      <Link
        data-slot="commit-row"
        data-sha={commit.sha}
        data-selected={selected ? 'true' : undefined}
        aria-current={selected ? 'true' : undefined}
        to={commit.href}
        className={cn(
          'flex min-h-11 min-w-0 items-start gap-2.5 rounded-md px-2 py-2.5 transition-colors hover:bg-muted',
          selected && 'bg-muted/70',
        )}
      >
        <GitCommitHorizontalIcon size={16} aria-hidden="true" className="mt-px size-4 shrink-0 text-accent-text" />
        <span className="min-w-0 flex-1">
          <span data-slot="commit-row-subject" title={commit.subject} className="line-clamp-2 text-[13px] leading-snug font-medium break-words text-foreground">{commit.subject}</span>
          {/* The sha rides in the meta line, not beside the subject: the subject keeps the row's
              full width and wraps less beside a wide diff pane. */}
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            {/* One chip on every row: a bordered card surface reads the same on a plain row and
                on the selected row's muted fill, where a muted chip would melt into it. */}
            <span data-slot="commit-sha" className="shrink-0 rounded-sm border border-border bg-card px-1.5 py-px font-mono text-xs text-muted-foreground" title={commit.sha}>{commit.shaLabel}</span>
            <span className="min-w-0 truncate">{commit.author} · <span title={gitAgeTitle(commit.when, commit.at)}>{gitAge(commit.when, commit.at)}</span></span>
            {commit.stat ? <DiffStatLabel stat={commit.stat} /> : null}
          </span>
        </span>
      </Link>
    </div>
  )
}
