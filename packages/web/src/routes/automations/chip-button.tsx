import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** A calm segmented-control button at touch-safe form size (44 px target): neutral surface when
 *  active inside a muted track, matching Skills and Agent Config. `aria-pressed` carries the state
 *  for assistive tech. */
export function ChipButton({ pressed, onClick, disabled, children }: { pressed: boolean; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex min-h-11 items-center justify-center rounded-md border px-3.5 text-[13px] font-medium transition-colors outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50',
        pressed
          ? 'border-border bg-card font-semibold text-foreground shadow-xs'
          : 'border-transparent bg-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}
