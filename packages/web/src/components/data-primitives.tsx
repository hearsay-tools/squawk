import * as React from 'react'
import type { DiffStat as DiffStatValue } from '@open-mercato/cezar-api-client'

import { DiffStatLabel } from '@/components/diff-stat'
import { shortAge, withAgo } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Canonical short-SHA length shared by commit chips, headers, and git metadata. */
export const SHA_DISPLAY_LENGTH = 8

/** Canonical 8-character short SHA for plain-text strings (toasts, status labels). */
export function shortSha(sha: string): string {
  return sha.slice(0, SHA_DISPLAY_LENGTH)
}

/** Full local date and time for a relative-time tooltip. */
export function formatFullTime(iso: string | undefined): string | undefined {
  if (!iso) return undefined
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? undefined : at.toLocaleString()
}

/**
 * Canonical commit / object SHA renderer (hearsay-tools/squawk#4377).
 * Always renders 8 monospace characters with the full SHA in `title`.
 */
export function Sha({
  sha,
  variant = 'chip',
  prefix,
  className,
  ...props
}: {
  sha: string
  variant?: 'chip' | 'inline'
  prefix?: string | undefined
  className?: string | undefined
} & Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'>) {
  const short = sha.slice(0, SHA_DISPLAY_LENGTH)
  return (
    <span
      data-slot="sha"
      title={sha}
      className={cn(
        'font-mono tabular-nums',
        variant === 'chip'
          ? 'shrink-0 rounded-sm border border-border bg-card px-1.5 py-px text-xs text-muted-foreground'
          : 'select-all',
        className,
      )}
      {...props}
    >
      {prefix ? `${prefix}${short}` : short}
    </span>
  )
}

/**
 * Canonical `+A −D` diff statistics renderer (hearsay-tools/squawk#4377).
 * Wraps `DiffStatLabel` so every surface shares one implementation and accessibility contract.
 */
export function DiffStat({
  stat,
  compact = false,
  className,
}: {
  stat: DiffStatValue
  compact?: boolean
  className?: string | undefined
}) {
  return <DiffStatLabel stat={stat} compact={compact} className={className} />
}

/**
 * Canonical tabular numeral counter for tabs, group headings, filters, and bulk buttons
 * (hearsay-tools/squawk#4377).
 */
export function Count({
  value,
  variant = 'plain',
  className,
  ...props
}: {
  value: number | string
  variant?: 'plain' | 'badge' | 'accent'
  className?: string | undefined
} & Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'>) {
  return (
    <span
      data-slot="count"
      className={cn(
        'tabular-nums',
        variant === 'badge' && 'rounded-full bg-muted px-1.5 text-[11px] leading-[18px] font-medium text-muted-foreground',
        variant === 'accent' && 'rounded-full bg-accent-strong/20 px-1.5 text-[11px] leading-[18px] font-semibold',
        className,
      )}
      {...props}
    >
      {value}
    </span>
  )
}

/**
 * Canonical relative timestamp renderer (hearsay-tools/squawk#4377).
 * Emits a semantic `<time dateTime>` with `shortAge` formatting, `tabular-nums`, and the full
 * local timestamp in `title`.
 */
export function RelativeTime({
  iso,
  now,
  ago = false,
  prefix,
  fallback = '',
  title,
  className,
  ...props
}: {
  iso: string | undefined
  now?: number | undefined
  ago?: boolean
  prefix?: string | undefined
  fallback?: string
  title?: string | undefined
  className?: string | undefined
} & Omit<React.TimeHTMLAttributes<HTMLTimeElement>, 'dateTime' | 'children'>) {
  const raw = shortAge(iso, now)
  const formatted = raw ? (ago ? withAgo(raw) : raw) : fallback
  if (!formatted) return null
  const resolvedTitle = title ?? formatFullTime(iso)
  return (
    <time
      data-slot="relative-time"
      dateTime={iso}
      title={resolvedTitle}
      className={cn('tabular-nums', className)}
      {...props}
    >
      {prefix ? `${prefix}${formatted}` : formatted}
    </time>
  )
}

/**
 * Canonical monospace path or branch renderer with truncation and full-value tooltip
 * (hearsay-tools/squawk#4377).
 */
export function Path({
  value,
  variant = 'inline',
  wrap = false,
  className,
  ...props
}: {
  value: string
  variant?: 'chip' | 'inline'
  wrap?: boolean
  className?: string | undefined
} & Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'>) {
  return (
    <span
      data-slot="path"
      title={value}
      className={cn(
        'font-mono',
        variant === 'chip'
          ? 'block max-w-full truncate rounded-[6px] bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground'
          : wrap
            ? 'break-all'
            : 'block min-w-0 truncate',
        className,
      )}
      {...props}
    >
      {value}
    </span>
  )
}
