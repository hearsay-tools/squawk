import { SendIcon } from 'lucide-react'

import { ChevronRightIcon } from '@/components/design-icons'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

import type { ThreadFailureDetail, ThreadNote } from './thread-state'

const FAILURE_DETAIL_LABELS: Record<ThreadFailureDetail['source'], string> = {
  assistant: 'Agent message',
  error: 'Runner error',
  'session.error': 'Session error',
  'step-end': 'Step status',
  lifecycle: 'Run status',
}

/** A dim (lifecycle/note) or danger (error) transcript line. */
export function NoteLine({ note }: { note: ThreadNote }) {
  if (note.icon === 'handoff') {
    return (
      <div data-slot="note-line" data-tone={note.tone} data-icon="handoff" className="flex items-start gap-2 px-0.5 text-xs text-muted-foreground">
        <span aria-hidden="true" className="mt-[-1px] flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-success">
          <SendIcon className="size-3" />
        </span>
        <span className="min-w-0 break-words">{note.text}</span>
      </div>
    )
  }
  if (note.details && note.details.length > 0) {
    return (
      <Collapsible
        data-slot="note-line"
        data-tone={note.tone}
        className="group/failure min-w-0 px-0.5 text-xs"
      >
        <div className={cn('flex items-start gap-2', note.tone === 'danger' ? 'text-danger [.light_&]:text-red-700' : 'text-soft-foreground')}>
          <span className="min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere">
            {note.tone === 'danger' ? '✗ ' : null}
            {note.text}
          </span>
          <CollapsibleTrigger
            data-slot="note-details-toggle"
            className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring max-md:min-h-11 max-md:min-w-11 max-md:justify-center pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center"
          >
            <ChevronRightIcon
              aria-hidden="true"
              className="size-3 shrink-0 motion-safe:transition-transform group-data-[state=open]/failure:rotate-90"
            />
            Details
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <ul
            data-slot="note-details"
            className="mbs-1.5 flex flex-col gap-1 border-s border-border ps-3 font-mono text-[11px] text-muted-foreground"
          >
            {note.details.map((detail, index) => (
              <li key={`${detail.source}:${index}`} className="min-w-0 whitespace-pre-wrap wrap-anywhere">
                <span className="font-sans font-medium text-foreground/80">
                  {FAILURE_DETAIL_LABELS[detail.source]}:{' '}
                </span>
                {detail.text}
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    )
  }
  return (
    <div
      data-slot="note-line"
      data-tone={note.tone}
      className={cn('px-0.5 text-xs', note.tone === 'danger' ? 'text-danger [.light_&]:text-red-700' : 'text-soft-foreground')}
    >
      {note.tone === 'danger' ? '✗ ' : null}
      {note.text}
    </div>
  )
}
