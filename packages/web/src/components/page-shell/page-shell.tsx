import './page-shell.css'
import type { ComponentProps, ReactNode, Ref } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * The five named cockpit page shell templates (hearsay-tools/squawk#4373).
 * Every main cockpit route renders through one of these templates so left origin,
 * gutter, maximum width, header slots, and empty/sparse/full states stay unified.
 */
export const PAGE_SHELL_TEMPLATES = ['Table', 'Split', 'Reading', 'Form', 'Board'] as const

export type PageShellTemplate = (typeof PAGE_SHELL_TEMPLATES)[number]

/** Declared content density state per template: 0 items, 1–3 items (or empty draft), or full. */
export type PageShellDensity = 'empty' | 'sparse' | 'full'

/** Derive declared density from an item count. */
export function pageShellDensity(count: number, sparseLimit = 3): PageShellDensity {
  if (count <= 0) return 'empty'
  if (count <= sparseLimit) return 'sparse'
  return 'full'
}

export interface PageShellHeaderProps {
  /** Primary page heading rendered in the single `<h1>`. */
  title: ReactNode
  /** Optional scope qualifier rendered inline after `·` inside `<h1>`. */
  scope?: ReactNode
  /** Optional muted subtitle rendered below `<h1>`. */
  subtitle?: ReactNode
  /** Optional inline status indicator (e.g. save cue, live badge) in the header action area. */
  status?: ReactNode
  /** At most one primary call-to-action button for the page. */
  primaryAction?: ReactNode
  /** Secondary page-level actions grouped beside the primary action. */
  secondaryActions?: ReactNode
  /** Optional custom slot name on the outer header wrapper for existing route-specific selectors. */
  headerSlot?: string
  /** Optional `data-slot` on the inline scope `<span>` (defaults to `page-header-scope`). */
  scopeSlot?: string
  /** Optional `data-slot` on the subtitle `<p>` (defaults to `page-header-subtitle`). */
  subtitleSlot?: string
  /** Hide subtitle on mobile (`< md`), matching compact task/composer mobile headers when needed. */
  hideSubtitleOnMobile?: boolean
  /** Optional extra row inside the header (e.g. mobile back-to-filters link). */
  headerExtra?: ReactNode
  /** Optional ref for header DOM measurements. */
  headerRef?: Ref<HTMLElement>
}

export interface PageShellProps {
  template: PageShellTemplate
  /** Stable route identifier placed on `data-route`. */
  route: string
  /** Declared empty / sparse / full layout state. */
  density: PageShellDensity
  /** Fixed header slots; omit only for routes whose own sticky chrome owns the header (e.g. task sessions). */
  header?: PageShellHeaderProps | undefined
  /** Spacing between header and body: default (20px), compact (10px for tabbed routes), or none. */
  headerSpacing?: 'default' | 'compact' | 'none'
  /** Fill available `<main>` height so internal panes can own scroll (GitHub, Reports). */
  fillHeight?: boolean
  /** Disable outer shell padding for full-bleed task layouts that manage their own inner reading padding. */
  flushPadding?: boolean
  /** Content rendered above the header inside the shell frame (e.g. mobile back link on Git). */
  beforeHeader?: ReactNode
  /** Declared empty-state surface rendered when `density === 'empty'` and provided. */
  emptyState?: ReactNode
  /** Declared sparse-state footer/guidance rendered below children when `density === 'sparse'`. */
  sparseFooter?: ReactNode
  /** Extra attributes spread onto the shell root (e.g. `data-git-section`, `data-presentation`). */
  rootProps?: Record<string, string | boolean | undefined>
  /** Optional ref to the shell root element. */
  rootRef?: Ref<HTMLDivElement>
  /** Optional extra className for layout-only modifiers (e.g. `@container`, bottom safe-area clearance). */
  className?: string | undefined
  /** Optional extra className on the body container. */
  bodyClassName?: string | undefined
  children?: ReactNode
}

/**
 * Canonical header button inside `PageShell`: inherits the shell's single header button size
 * (`36px` on desktop, `44px` on mobile/touch) without route-level height overrides.
 */
export function PageShellActionButton({
  variant = 'outline',
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, 'size'>) {
  return (
    <Button
      variant={variant}
      data-page-shell-action=""
      className={cn('shrink-0', className)}
      {...props}
    />
  )
}

function PageShellHeader({
  title,
  scope,
  subtitle,
  status,
  primaryAction,
  secondaryActions,
  headerSlot = 'page-header',
  scopeSlot = 'page-header-scope',
  subtitleSlot = 'page-header-subtitle',
  hideSubtitleOnMobile = false,
  headerExtra,
  headerRef,
}: PageShellHeaderProps) {
  const hasActions = Boolean(status || secondaryActions || primaryAction)
  return (
    <header
      ref={headerRef}
      data-slot="page-shell-header"
      data-header-slot={headerSlot}
    >
      {/* Keep a wrapper carrying the route's historic header `data-slot` so existing tests and
          page-heading specs locate the exact header landmark without duplicating `<header>`. */}
      <div data-slot={headerSlot} className="flex min-w-0 flex-col">
        <div data-slot="page-shell-header-row">
          <div data-slot="page-shell-header-title-block">
            <h1 data-slot="page-shell-header-title" className="min-w-0 break-words">
              {title}
              {scope ? (
                <>
                  {' '}
                  <span data-slot={scopeSlot} className="font-normal text-muted-foreground">
                    · {scope}
                  </span>
                </>
              ) : null}
            </h1>
            {subtitle ? (
              <p
                data-slot={subtitleSlot}
                className={cn(
                  'mt-1 text-[13px] text-muted-foreground',
                  hideSubtitleOnMobile && 'max-md:hidden',
                )}
              >
                {subtitle}
              </p>
            ) : null}
          </div>
          {hasActions ? (
            <div data-slot="page-shell-header-actions">
              {status ? (
                <div data-slot="page-header-status" className="flex shrink-0 items-center">
                  {status}
                </div>
              ) : null}
              {secondaryActions ? (
                <div data-slot="page-header-secondary" className="flex flex-wrap items-center gap-2">
                  {secondaryActions}
                </div>
              ) : null}
              {primaryAction ? (
                <div data-slot="page-header-primary" className="flex shrink-0 items-center">
                  {primaryAction}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        {headerExtra}
      </div>
    </header>
  )
}

/**
 * Shared cockpit page shell. Owns gutter, left origin, template max-width, fixed header slots,
 * and declared `empty` / `sparse` / `full` state framing.
 */
export function PageShell({
  template,
  route,
  density,
  header,
  headerSpacing = 'default',
  fillHeight = false,
  flushPadding = false,
  beforeHeader,
  emptyState,
  sparseFooter,
  rootProps,
  rootRef,
  className,
  bodyClassName,
  children,
}: PageShellProps) {
  const showEmpty = density === 'empty' && emptyState !== undefined
  return (
    <div
      ref={rootRef}
      data-slot="page-shell"
      data-route={route}
      data-template={template}
      data-density={density}
      data-header-spacing={headerSpacing}
      data-fill-height={fillHeight ? 'true' : undefined}
      data-flush-padding={flushPadding ? 'true' : undefined}
      className={className}
      {...rootProps}
    >
      <div data-slot="page-shell-frame">
        {beforeHeader}
        {header ? <PageShellHeader {...header} /> : null}
        <div data-slot="page-shell-body" className={bodyClassName}>
          {showEmpty ? (
            <div data-slot="page-shell-empty">{emptyState}</div>
          ) : (
            <>
              {children}
              {density === 'sparse' && sparseFooter ? sparseFooter : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

type NamedTemplateProps = Omit<PageShellProps, 'template'>

/** Named `Table` shell template (`max-w: 84rem`) for Tasks, All tasks, GitHub, Skills, Automations, Git lists. */
export function TablePage(props: NamedTemplateProps) {
  return <PageShell template="Table" {...props} />
}

/** Named `Split` shell template (`max-w: none`) for Reports, Workflows, Git diffs/commits, Settings Agent config. */
export function SplitPage(props: NamedTemplateProps) {
  return <PageShell template="Split" {...props} />
}

/** Named `Reading` shell template (`max-w: var(--measure)`) for Task sessions, Automation logs, Archived records, fallbacks. */
export function ReadingPage(props: NamedTemplateProps) {
  return <PageShell template="Reading" {...props} />
}

/** Named `Form` shell template (`max-w: 68rem`) for New task, Automation editor, Settings forms, Workspace tools. */
export function FormPage(props: NamedTemplateProps) {
  return <PageShell template="Form" {...props} />
}

/** Named `Board` shell template (`max-w: 96rem`) for Project Activity and Global Activity. */
export function BoardPage(props: NamedTemplateProps) {
  return <PageShell template="Board" {...props} />
}
