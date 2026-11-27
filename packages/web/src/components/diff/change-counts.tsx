import { cn } from '@/lib/utils'

/**
 * `+12 −3` in its smallest form: a zero side is no change, so it is left out (`+4`, `−5`), and
 * nothing renders when both are zero — the caller keeps its own absent state. For inline counts
 * that are not a whole `DiffStat` (a GitHub file row, a branch's meta line). The `−` is U+2212.
 */
export function ChangeCounts({ adds, dels, className }: { adds: number; dels: number; className?: string | undefined }) {
  if (adds <= 0 && dels <= 0) return null
  return (
    <span data-slot="change-counts" className={cn('shrink-0 whitespace-nowrap tabular-nums', className)}>
      {adds > 0 ? <span className="text-success">+{adds.toLocaleString('en-US')}</span> : null}
      {adds > 0 && dels > 0 ? ' ' : null}
      {dels > 0 ? <span className="text-danger">−{dels.toLocaleString('en-US')}</span> : null}
    </span>
  )
}
