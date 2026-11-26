import type { ReactNode } from 'react'

import type { RunSummary } from '@open-mercato/cezar-api-client'

import type { AttentionTone } from '@/lib/attention'
import type { BucketLabel, ListView } from '@/lib/task-groups'
import { groupTone } from '@/lib/task-origin'
import { cn } from '@/lib/utils'

/**
 * The page header of the two task lists: the title with the primary action on its row, and the
 * subtitle below. On a phone the action stays on the title row, so it costs no row of its own.
 */
export function TaskPageHeader({ title, subtitle, action }: { title: string; subtitle: ReactNode; action: ReactNode }) {
  return (
    <div data-slot="page-header" className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 pt-5 md:pt-7">
      <h1 className="col-start-1 row-start-1 min-w-0 truncate text-[24px] leading-[1.2] font-semibold tracking-tight text-foreground md:text-[28px]">{title}</h1>
      <div className="col-start-2 row-start-1 flex justify-end md:row-span-2 md:self-start">{action}</div>
      <p className="col-span-2 row-start-2 text-[13px] text-muted-foreground md:col-span-1">{subtitle}</p>
    </div>
  )
}

/**
 * A status group heading's dot. Finished holds successful and failed tasks alike, so its heading
 * stays neutral; each row's own status dot reports the outcome. Every other group keeps its tone.
 */
export function headingTone(label: BucketLabel, members: readonly RunSummary[]): AttentionTone {
  return label === 'Finished' ? 'neutral' : groupTone(label, members)
}

/** A task title link's type in a list row: one size, line height and weight rule on both lists. */
export function taskTitleClass(unread: boolean, readDone: boolean): string {
  return cn(
    'min-w-0 truncate rounded-sm text-[13px] leading-[18px]',
    unread ? 'font-semibold text-foreground' : readDone ? 'font-normal text-foreground' : 'font-medium text-foreground',
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

export function resultCaption(count: number, incomplete: boolean, needle: string): string {
  return `${count} ${count === 1 ? 'task' : 'tasks'}${incomplete ? ' loaded' : ''}${needle ? ` matching “${needle}”` : ''}`
}
/** The list's count, where All tasks puts its own: at the end of the tab row. Below `md` a plain
 *  count repeats the group headings, so it shows only when it says more. */
export function ResultCount({ count, incomplete, needle }: { count: number; incomplete: boolean; needle: string }) {
  return (
    <span data-slot="tasks-result-count" className={cn('ml-auto self-center truncate text-[13px] text-soft-foreground tabular-nums', needle === '' && !incomplete && 'max-md:hidden')}>
      {resultCaption(count, incomplete, needle)}
    </span>
  )
}

/** A task's branch name as a muted mono chip, cut with an ellipsis; the full name is its tooltip. */
export function BranchChip({ branch }: { branch: string }) {
  return (
    <span
      title={branch}
      className="block truncate rounded-[6px] bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted-foreground"
    >
      {branch}
    </span>
  )
}
