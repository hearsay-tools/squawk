import type { DiffStat } from '@open-mercato/cezar-api-client'
import { DiffStatLabel } from '@/components/diff-stat'

/** `N files changed +A −D`, the line above the cards. Shared by the engine and the fallback, in
 *  its own module so the lazy engine chunk does not import the facade that loads it. `hidden`
 *  when a header of the consumer already shows the total: the line stays the diff's own count of
 *  the files it holds, but is not printed twice. */
export function DiffTotals({ stat, hidden = false }: { stat: DiffStat; hidden?: boolean }) {
  return (
    <p data-slot="diff-totals" hidden={hidden} className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>
        {stat.files} {stat.files === 1 ? 'file' : 'files'} changed
      </span>
      <DiffStatLabel stat={stat} />
    </p>
  )
}
