import type { ReactNode } from 'react'

/** The label over one control inside a settings form: the same small medium-weight foreground
 *  type on every Settings page, so Prompt templates, Resources and Projects read like Workflows. */
export const SETTINGS_LABEL_CLASS = 'text-xs font-medium text-foreground'

/**
 * One labelled settings row — title, one-line hint, control(s).
 *
 * Extracted when step 3.5 split Resources into a global pane (parallel + memory) and a project
 * pane (worktrees): both halves are the same rhythm, and two private copies of it would be two
 * things to keep in step. Settings reads as ONE surface across the project/global boundary
 * precisely because every section renders through the same chassis.
 */
export function SettingsField({
  title,
  hint,
  children,
}: {
  title: string
  hint: string
  children: ReactNode
}) {
  return (
    <section className="settings-field flex flex-col gap-2">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="text-[13px] text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  )
}
