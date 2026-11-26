import type { ReactNode } from 'react'

/**
 * The quiet cue beside a Save button that is disabled because nothing changed. Without it a greyed
 * Save reads as "not allowed" rather than "already saved". Render it only for that reason: an
 * invalid value has its own red note, and a pending save has the button's own state.
 */
export function SaveCue({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <span data-slot="settings-save-cue" className="whitespace-nowrap text-xs leading-none text-muted-foreground">
      No unsaved changes
    </span>
  )
}

/**
 * A Save button and its cue as one unit. Every settings page wraps them in this row, so the button
 * and "No unsaved changes" share one vertical centre and one gap, whatever the field around them
 * aligns to.
 */
export function SaveRow({ show, children }: { show: boolean; children: ReactNode }) {
  return (
    <span data-slot="settings-save-row" className="inline-flex shrink-0 items-center gap-3">
      {children}
      <SaveCue show={show} />
    </span>
  )
}
