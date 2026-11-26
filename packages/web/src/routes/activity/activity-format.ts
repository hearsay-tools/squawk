/** Time words of the activity view. Every age and countdown is computed from the server's
 *  timestamps and a client `now`; the caller ticks `now` once a second. */

const pad = (n: number) => String(n).padStart(2, '0')

/** A ticking counter: `4:12`, or `1:04:12` past an hour. Negative spans read as `0:00`. */
export function counter(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const seconds = total % 60
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/** A coarse span for prose, in the cockpit's one compact format: `34s`, `42m`, `1h 8m` under six
 *  hours, then `7h`, and `5d` from a day on. No space before a unit, never raw minutes past 59. */
export function span(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)}d`
  const rest = minutes % 60
  return hours < 6 && rest > 0 ? `${hours}h ${rest}m` : `${hours}h`
}

/** Milliseconds from `iso` to `now`; 0 when `iso` is absent or not a date. */
export function since(iso: string | undefined, now: number): number {
  const at = iso === undefined ? Number.NaN : Date.parse(iso)
  return Number.isNaN(at) ? 0 : now - at
}

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** A wall-clock time in the user's time zone: `15:42`. An unparseable value reads as given. */
export function clockOf(iso: string): string {
  const at = Date.parse(iso)
  return Number.isNaN(at) ? iso : CLOCK.format(at)
}

const DAY = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const SECONDS = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })

/** The full date, time and time zone of an instant, for the `title` of a relative age. */
export function fullTimeOf(at: number | string): string {
  const ms = typeof at === 'number' ? at : Date.parse(at)
  return Number.isNaN(ms) ? String(at) : `${DAY.format(ms)}, ${SECONDS.format(ms)} ${timeZoneName()}`
}

/** A relative age for prose: `just now` under a minute, then `3m ago`, `2h ago`, `5d ago`. */
export function agoOf(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

/** The user's time zone name, for the full time of a tooltip. */
export function timeZoneName(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}
