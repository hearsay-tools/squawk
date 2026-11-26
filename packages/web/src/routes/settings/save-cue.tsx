/**
 * The quiet cue beside a Save button that is disabled because nothing changed. Without it a greyed
 * Save reads as "not allowed" rather than "already saved". Render it only for that reason: an
 * invalid value has its own red note, and a pending save has the button's own state.
 */
export function SaveCue({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <span data-slot="settings-save-cue" className="whitespace-nowrap text-xs text-muted-foreground">
      No unsaved changes
    </span>
  )
}
