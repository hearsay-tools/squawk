import { EyeIcon, Rows2Icon, WrapTextIcon } from 'lucide-react'
import { GitBranchIcon, Columns2Icon } from '@/components/design-icons'

import type { DiffMode } from '@/components/diff'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * The diff view's local controls, extracted from the Changes toolbar (R5 1.7) so the repo
 * view renders the SAME unified/split + wrap toggles and branch chip rather than a fork.
 * Layout preferences, not git actions — no policy involvement. Below `md` the unified/split
 * group hides itself (phones force unified: a 390px screen has no room for two columns), but
 * the wrap switch stays, so a phone reader can still trade wrapped rows for a side scroll.
 */
export function DiffViewToggles({
  mode,
  wrap,
  onModeChange,
  onWrapChange,
}: {
  mode: DiffMode
  wrap: boolean
  onModeChange: (mode: DiffMode) => void
  onWrapChange: (wrap: boolean) => void
}) {
  return (
    <>
      <span
        data-slot="diff-mode-toggle"
        role="group"
        aria-label="Diff layout"
        className="inline-flex items-center rounded-lg border border-border bg-card p-0.5 max-md:hidden"
      >
        <ModeButton current={mode} value="unified" onModeChange={onModeChange} />
        <ModeButton current={mode} value="split" onModeChange={onModeChange} />
      </span>
      <WrapToggle wrap={wrap} onWrapChange={onWrapChange} />
    </>
  )
}

/** The wrap switch on its own: the diff toolbars and the Files viewer header share one button.
 *  `className` sizes it; the default is the toolbar's 44px square. */
export function WrapToggle({ wrap, onWrapChange, className = 'size-11 rounded-lg' }: {
  wrap: boolean
  onWrapChange: (wrap: boolean) => void
  className?: string
}) {
  return (
    <Button
      variant="outline"
      size="icon-sm"
      data-slot="wrap-toggle"
      aria-pressed={wrap}
      aria-label="Wrap long lines"
      title="Wrap long lines"
      className={cn(
        className,
        wrap ? 'border-accent-text/40 bg-muted text-accent-text' : 'text-muted-foreground hover:text-foreground',
      )}
      onClick={() => onWrapChange(!wrap)}
    >
      <WrapTextIcon aria-hidden="true" />
    </Button>
  )
}

/**
 * The Markdown preview switch (hearsay-tools/cezarion#1012): every previewable Markdown file in
 * the diff at once, and pressing it clears the per-file choices made in the cards. Like the
 * wrap switch it shows at every width: a rendered document reads better on a phone than
 * anywhere. Callers render it only when the diff holds a file `canPreviewMarkdown`
 * accepts, so the button never sits there doing nothing.
 */
export function MarkdownPreviewToggle({
  preview,
  onPreviewChange,
}: {
  preview: boolean
  onPreviewChange: (preview: boolean) => void
}) {
  const label = preview ? 'Show Markdown as a diff' : 'Preview Markdown'
  return (
    <Button
      variant="outline"
      size="icon-sm"
      data-slot="markdown-preview-toggle"
      aria-pressed={preview}
      aria-label="Preview Markdown"
      title={label}
      className={cn(
        'size-11 rounded-lg',
        preview ? 'border-accent-text/40 bg-muted text-accent-text' : 'text-muted-foreground hover:text-foreground',
      )}
      onClick={() => onPreviewChange(!preview)}
    >
      <EyeIcon aria-hidden="true" />
    </Button>
  )
}

function ModeButton({
  current,
  value,
  onModeChange,
}: {
  current: DiffMode
  value: DiffMode
  onModeChange: (mode: DiffMode) => void
}) {
  const active = current === value
  return (
    <button
      type="button"
      data-mode={value}
      aria-pressed={active}
      onClick={() => onModeChange(value)}
      className={cn(
        'inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 text-xs font-medium capitalize transition-colors outline-hidden focus-visible:ring-2 focus-visible:ring-ring/50',
        active
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground pointer-hover:text-foreground',
      )}
    >
      {value === 'unified' ? (
        <Rows2Icon aria-hidden="true" className="size-4" />
      ) : (
        <Columns2Icon size={16} aria-hidden="true" className="size-4" />
      )}
      {value}
    </button>
  )
}

/** The mono branch chip both git toolbars lead with. */
export function BranchChip({ branch }: { branch: string }) {
  return (
    <span
      data-slot="branch-chip"
      className="flex min-w-0 items-center gap-1 rounded-sm border border-border bg-card px-1.5 py-px font-mono text-[11px] font-medium"
    >
      <GitBranchIcon size={16} aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{branch}</span>
    </span>
  )
}
