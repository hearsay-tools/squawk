import { CheckIcon, CopyIcon } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { ChevronDownIcon } from '@/components/design-icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { productCommand } from '@/lib/product-name'
import { cliOf, shellQuote } from '@/lib/automation-cli'
import { useActiveProjectId } from '@/lib/project-router'

import { cliLines } from './cli-lines'
import type { AutomationDraft } from './editor-draft'

/**
 * "Copy as CLI" (#774, port of upstream #985): what the form holds, as the `hsq automation` line
 * that would create it — the flag form when every key has a flag, the JSON form otherwise. Built
 * from the body Save sends (`cliOf` → `toCreateBody`), so the two cannot disagree. The box shows
 * it one flag per line with backslash continuations; Copy takes the same lines. The box starts
 * folded behind "Show": Copy works either way, and the open box wraps every token
 * inside the card instead of clipping it at the right edge.
 */
export function CopyAsCliCard({ draft }: { draft: AutomationDraft }) {
  const projectId = useActiveProjectId()
  const origin = window.location.origin
  const line = useMemo(() => {
    const command = cliOf(draft)
    return projectId
      ? `HSQ_COCKPIT_URL=${shellQuote(origin)} HSQ_PROJECT_ID=${shellQuote(projectId)} ${command}`
      : command
  }, [draft, origin, projectId])
  const shown = useMemo(() => cliLines(line), [line])
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [open, setOpen] = useState(false)
  const boxId = useId()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  // A new line is not the one that was copied.
  useEffect(() => setState('idle'), [line])

  const copy = async () => {
    clearTimeout(timer.current)
    try {
      await navigator.clipboard.writeText(shown)
      setState('copied')
      timer.current = setTimeout(() => setState('idle'), 1600)
    } catch {
      setState('failed')
    }
  }

  return (
    <section aria-labelledby="copy-as-cli-heading" data-slot="copy-as-cli" className="min-w-0 max-w-full overflow-hidden rounded-xl border bg-card px-4 py-3.5">
      {/* One row at the 320px aside width: heading, the fold toggle, and Copy flush right inside
          the card's padding. The toggle shrinks (the button base sets shrink-0) and truncates
          before Copy would reach the card's edge. */}
      <div className="flex min-h-8 min-w-0 flex-nowrap items-center justify-between gap-x-2">
        <h2 id="copy-as-cli-heading" className="shrink-0 text-[13px] font-medium text-muted-foreground">Copy as CLI</h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-slot="copy-as-cli-toggle"
          aria-expanded={open}
          aria-controls={boxId}
          aria-label={open ? 'Hide command' : 'Show command'}
          className="min-w-0 shrink gap-1 px-1.5 text-[12px] font-medium max-md:h-11 no-hover:h-11"
          onClick={() => setOpen((value) => !value)}
        >
          <span className="truncate">{open ? 'Hide' : 'Show'}</span>
          <ChevronDownIcon aria-hidden="true" className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
        </Button>
        <Button type="button" variant="outline" size="sm" className="ms-auto gap-1.5 px-2 text-[12px] font-medium max-md:h-11 no-hover:h-11" onClick={() => void copy()}>
          {state === 'copied' ? <CheckIcon aria-hidden="true" className="size-3.5" /> : <CopyIcon aria-hidden="true" className="size-3.5" />}
          {state === 'copied' ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {/* One flag per line. A long value wraps at any character inside the box, so no token is
          ever cut off at the card's right edge. The frame carries the border and focus ring. */}
      <div
        id={boxId}
        hidden={!open}
        className="mbs-2 max-w-full rounded-lg border border-border bg-muted has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring"
      >
        <pre data-slot="copy-as-cli-line" tabIndex={0} aria-label="Command line" className="m-0 max-w-full px-3 pt-2.5 pb-3 font-mono text-xs leading-5 break-all whitespace-pre-wrap text-muted-foreground outline-none">{shown}</pre>
      </div>
      <p role="status" className="mbs-2 text-xs break-words text-muted-foreground">
        {state === 'failed'
          ? 'Could not copy — select the line and copy it by hand.'
          : <>The definition Save paused would create. <code className="rounded-sm bg-muted px-1 py-px font-mono text-[11px] whitespace-nowrap text-foreground [word-spacing:-0.2em]">{`${productCommand()} automation schema`}</code> prints its shape.</>}
      </p>
    </section>
  )
}
