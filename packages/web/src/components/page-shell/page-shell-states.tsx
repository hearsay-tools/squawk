import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * Framed, labelled empty state for any PageShell template (hearsay-tools/squawk#4373).
 * Replaces bare unframed `<p>` lines and unlabelled placeholder boxes with a structured
 * card that names what is missing and offers a clear next action.
 */
export function PageShellEmptyState({
  icon,
  title,
  description,
  actions,
  slot = 'page-shell-empty-state',
  className,
}: {
  icon?: ReactNode
  title: string
  description?: ReactNode
  actions?: ReactNode
  slot?: string
  className?: string | undefined
}) {
  return (
    <section
      data-slot={slot}
      data-page-shell-empty=""
      aria-label={title}
      className={cn(
        'flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-6',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        {icon ? (
          <span
            aria-hidden="true"
            className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50 text-muted-foreground [&_svg]:size-4"
          >
            {icon}
          </span>
        ) : null}
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          {description ? (
            <div className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</div>
          ) : null}
        </div>
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">{actions}</div>
      ) : null}
    </section>
  )
}

/**
 * Compact framing footer rendered in declared `sparse` states (1–3 items or empty draft)
 * so low-count screens end with clear context and next actions instead of an empty void.
 */
export function PageShellSparseFooter({
  summary,
  actions,
  slot = 'page-shell-sparse-footer',
  className,
}: {
  summary: ReactNode
  actions?: ReactNode
  slot?: string
  className?: string | undefined
}) {
  return (
    <aside data-slot={slot} data-page-shell-sparse="" className={cn('min-w-0', className)}>
      <div className="min-w-0 text-muted-foreground">{summary}</div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </aside>
  )
}

/**
 * Minimum content width (px) required for SplitPage's side-by-side master-detail layout
 * (280px list + 20px gap + 360px detail pane). Keep aligned with `@container page-shell-split`
 * in `page-shell.css`.
 */
export const PAGE_SHELL_SPLIT_MIN_WIDTH = 660

/**
 * Responsive master-detail layout for `Split` template screens (e.g. Reports list + preview).
 */
export function PageShellSplitPane({
  list,
  detail,
  className,
}: {
  list: ReactNode
  detail: ReactNode
  className?: string | undefined
}) {
  return (
    <div data-slot="page-shell-split-host" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        data-slot="page-shell-split-pane"
        data-has-detail={detail ? 'true' : 'false'}
        className={className}
      >
        <div data-slot="page-shell-split-list" className="flex min-h-0 min-w-0 flex-col">
          {list}
        </div>
        {detail ? (
          <div data-slot="page-shell-split-detail" className="flex min-h-0 min-w-0 flex-col">
            {detail}
          </div>
        ) : null}
      </div>
    </div>
  )
}
