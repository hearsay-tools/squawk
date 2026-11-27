import './automations.css'
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** Shared Variant A page frame for automations screens: md:px-9 px-4 gutter, 28px semibold
 *  title + subtitle on the left, and the primary CTA right-aligned on the top title row.
 *  `tabbed` pages open on a tab row, which sits 10px under the header like the Tasks page's. */
export function PageFrame({ title, subtitle, action, tabbed = false, children }: {
  title: string
  subtitle: string
  action?: ReactNode
  tabbed?: boolean
  children: ReactNode
}) {
  return (
    <main data-route="automations" className="w-full max-w-full min-w-0 px-4 pt-7 pb-9 md:px-9">
      <header className={cn('flex flex-wrap items-start justify-between gap-4', tabbed ? 'mb-2.5' : 'mb-5')}>
        <div className="min-w-0">
          <h1 className="text-[26px] font-semibold tracking-tight leading-[1.2] text-foreground md:text-[28px]">{title}</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">{subtitle}</p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>
      {children}
    </main>
  )
}

export function PageState({ text }: { text: string }) {
  return <div role="status" className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">{text}</div>
}
