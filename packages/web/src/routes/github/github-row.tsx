import { useQueryClient } from '@tanstack/react-query'
import type { DragEvent } from 'react'
import { CircleDotIcon, GitPullRequestIcon } from '@/components/design-icons'
import { getGithubComments } from '@/api/client'
import { queryKeys } from '@/api/queries'
import type { GithubItem } from '@open-mercato/cezar-api-client'
import { ChecksGlyph, CommentCount, LabelChip } from '@/components/github-item-detail'
import { shortAge } from '@/lib/format'
import { githubTaskPrompt } from '@/lib/github-task'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'
import type { GithubView } from './github'
import { githubFilterPath, type GithubFilter } from './github-sidebar-model'

export function GithubRow({
  item,
  view,
  filter,
  colors,
  active,
  queued,
  checks,
  comments,
}: {
  item: GithubItem
  view: GithubView
  /** The list's `?filter=`, carried into the detail URL so Back returns to the same list. */
  filter: GithubFilter | null
  colors: Record<string, string>
  active: boolean
  queued: boolean
  /** Resolved checks glyph — the lazily-hydrated value overrides the list's `null` (#664). */
  checks?: GithubItem['checks']
  /** Resolved comment count; `undefined` while a deferred count has not landed (#1183). */
  comments: number | undefined
}) {
  const Icon = item.kind === 'issue' ? CircleDotIcon : GitPullRequestIcon
  const queryClient = useQueryClient()

  // Warm the thread on hover/focus (#664) so opening the row is usually instant — best-effort,
  // deduped by React Query, and it re-uses the mounted detail's exact query key/staleTime.
  const prefetchThread = () => {
    void queryClient.prefetchQuery({
      queryKey: queryKeys.githubComments(item.kind, item.number),
      queryFn: ({ signal }) => getGithubComments(item.kind, item.number, {}, { signal }),
      staleTime: 60_000,
    })
  }

  // Drag an issue/PR row into the composer — it prefills the same prompt "Run agent on this
  // issue" uses (legacy parity); a textarea accepts the text/plain payload natively.
  const onDragStart = (event: DragEvent) => {
    try {
      event.dataTransfer.setData('text/plain', githubTaskPrompt(item))
      event.dataTransfer.effectAllowed = 'copy'
    } catch {
      // older engines — the drag just won't carry the prompt
    }
  }

  return (
    <Link
      to={githubFilterPath(view, filter, item.number)}
      draggable
      onDragStart={onDragStart}
      onMouseEnter={prefetchThread}
      onFocus={prefetchThread}
      data-slot="gh-row"
      data-number={item.number}
      data-kind={item.kind}
      aria-current={active ? 'page' : undefined}
      title="Drag into the composer to prefill a task"
      className={cn(
        'flex flex-col gap-2 rounded-md px-3 py-4 transition-colors hover:bg-muted',
        active && 'bg-accent-strong/10 text-accent-text',
      )}
    >
      <span className="flex min-w-0 items-start gap-2 md:items-center">
        <Icon
          aria-hidden="true" data-slot="gh-row-icon"
          className={cn('mt-0.5 size-3.5 shrink-0 md:mt-0', item.kind === 'issue' ? 'text-success' : 'text-accent-icon')}
        />
        <span data-slot="gh-row-title" className={cn('line-clamp-2 min-w-0 text-[13px] font-medium md:block md:truncate', active && 'font-semibold')}>
          {item.title}
        </span>
      </span>
      {/* Middle dots between the facts, the same grammar as the detail header beside it. */}
      <span data-slot="gh-row-meta" className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pl-[22px] text-xs text-muted-foreground md:flex-nowrap md:gap-y-0">
        <span className="shrink-0 tabular-nums">#{item.number}</span>
        <MetaDot />
        <span data-slot="gh-row-author" className="max-w-full shrink-0 truncate md:min-w-0 md:shrink">{item.author}</span>
        <MetaDot />
        <time className="shrink-0" dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>{shortAge(item.createdAt)}</time>
        {comments ? (
          <>
            <MetaDot />
            <CommentCount count={comments} />
          </>
        ) : null}
        {checks ? (
          <>
            <MetaDot />
            <ChecksGlyph checks={checks} />
          </>
        ) : null}
        {queued ? (
          <>
            <MetaDot />
            <span data-slot="gh-queued-flag" className="shrink-0 font-sans font-medium text-accent-text">
              ↗ run queued
            </span>
          </>
        ) : null}
      </span>
      {item.labels.length > 0 ? (
        <span data-slot="gh-row-labels" className="flex flex-wrap gap-1 pl-[22px]">
          {item.labels.map((label) => (
            <LabelChip key={label} label={label} color={colors[label]} plain />
          ))}
        </span>
      ) : null}
    </Link>
  )
}

/** The separator between a list row's meta facts; decorative, so screen readers skip it. */
function MetaDot() {
  return (
    <span data-slot="gh-row-dot" aria-hidden="true" className="shrink-0">
      ·
    </span>
  )
}
