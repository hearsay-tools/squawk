import type { ReactNode } from 'react'

/** The page header of the two task lists: title and subtitle at the left, the primary action at the right. */
export function TaskPageHeader({ title, subtitle, action }: { title: string; subtitle: ReactNode; action: ReactNode }) {
  return (
    <div data-slot="page-header" className="flex flex-wrap items-start justify-between gap-4 pt-7 pb-1">
      <div className="min-w-0">
        <h1 className="text-[26px] leading-[1.2] font-semibold tracking-tight text-foreground md:text-[28px]">{title}</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">{subtitle}</p>
      </div>
      {action}
    </div>
  )
}

/** The honest absent value of a list cell. */
export function Dash() {
  return <span className="text-xs text-soft-foreground">—</span>
}
