import type { ReactNode } from 'react'

import type { ListView } from '@/lib/task-groups'
import { cn } from '@/lib/utils'

/** The page header of the two task lists: title and subtitle at the left, the primary action at the right. */
export function TaskPageHeader({ title, subtitle, action }: { title: string; subtitle: ReactNode; action: ReactNode }) {
  return (
    <div data-slot="page-header" className="flex flex-wrap items-start justify-between gap-4 pt-7">
      <div className="min-w-0">
        <h1 className="text-[26px] leading-[1.2] font-semibold tracking-tight text-foreground md:text-[28px]">{title}</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">{subtitle}</p>
      </div>
      {action}
    </div>
  )
}

/** A timestamp's full local date and time, for the `title` of a relative age. */
export function fullTime(iso: string | undefined): string | undefined {
  if (!iso) return undefined
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? undefined : at.toLocaleString()
}

/** A page-level view tab's classes: an underline, never a filled pill. */
const VIEW_TAB = 'flex min-h-11 items-center justify-center gap-1.5 border-b-2 border-transparent text-[13px] text-muted-foreground'
const VIEW_TAB_ACTIVE = 'border-accent-text font-medium text-foreground'

/** Active or Archived on a task list, with the number of tasks it holds. */
export function ViewTab({
  view,
  current,
  onSelect,
  count,
  children,
}: {
  view: ListView
  current: ListView
  onSelect: (view: ListView) => void
  /** A number, or `200+` while the list holds a full window and the total is unknown. */
  count: number | string
  children: ReactNode
}) {
  const isActive = view === current
  return (
    <button
      type="button"
      data-slot="overview-tab"
      data-view={view}
      // Same rationale as the sidebar's tabs: these filter one list in place, they do not switch
      // panels — `aria-pressed` is what that actually is.
      aria-pressed={isActive}
      onClick={() => onSelect(view)}
      className={cn(VIEW_TAB, isActive && VIEW_TAB_ACTIVE)}
    >
      {children}
      {count !== 0 ? <span className="tabular-nums"> · {count}</span> : null}
    </button>
  )
}

/** The honest absent value of a list cell. */
export function Dash() {
  return <span className="text-xs text-soft-foreground">—</span>
}
