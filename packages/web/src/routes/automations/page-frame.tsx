import './automations.css'
import type { ReactNode } from 'react'

/** Shared Variant A page frame for automations screens: md:px-9 px-4 gutter, 28px semibold
 *  title + subtitle on the left, and the primary CTA right-aligned on the top title row. */
export function PageFrame({ title, subtitle, action, children }: { title: string; subtitle: string; action?: ReactNode; children: ReactNode }) {
  return (
    <main data-route="automations" className="w-full max-w-full min-w-0 px-4 pt-7 pb-9 md:px-9">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
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
