/**
 * Compact age, the one relative-time format every surface shows (hearsay-tools/squawk pass 5
 * contract): `just now` under 10s, then `34s`, `26m`, `1h 6m` (minutes only under 6h), `23h`, `5d`.
 *
 * No space before a unit and no "ago": the unit *is* the information. Callers that write prose
 * around the age use `withAgo`, which leaves `just now` alone. Put the full date in a `title`.
 *
 * `now` is a parameter rather than a `Date.now()` call so the tests are not racing the clock.
 * Returns '' for a missing or unparseable timestamp — an empty slot is honest; `NaNm` is not.
 */
export function shortAge(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  // Clamp: a clock skew between the server's timestamp and the browser must not print `-3s`.
  return compactDuration(Math.max(0, (now - then) / 1000))
}

/** A span of seconds in the `shortAge` format. Floors every unit: never rounds up to the next. */
export function compactDuration(seconds: number): string {
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${Math.floor(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours < 6 && minutes > 0) return `${hours}h ${minutes}m`
  if (seconds < 86400) return `${hours}h`
  return `${Math.floor(seconds / 86400)}d`
}

/** A `shortAge` value inside prose: `6m ago`, but `just now` as it is. Empty stays empty. */
export function withAgo(age: string): string {
  if (!age || age === 'just now') return age
  return `${age} ago`
}

/**
 * Compact token count — `812` / `96.2k` / `1.4M`. Directional usage supplies the semantic
 * context around this deliberately unit-less number (`IN 96.2k · OUT 1.8k`).
 *
 * Truncates rather than rounds: `999_999` reads `999.9k`, never a `1000.0k` that is really 1M.
 */
export function compactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens >= 1_000_000) return `${(Math.floor(tokens / 100_000) / 10).toFixed(1)}M`
  if (tokens >= 1_000) return `${(Math.floor(tokens / 100) / 10).toFixed(1)}k`
  return String(Math.floor(tokens))
}

/** A check time as the status line and the sidebar show it: the time alone today, the date and
 *  the time on another day (hearsay-tools/cezarion#1333, #1236). */
export function checkTimeText(at: Date, now: Date = new Date()): string {
  const sameDay = at.toDateString() === now.toDateString()
  return new Intl.DateTimeFormat(undefined, sameDay ? { timeStyle: 'short' } : { dateStyle: 'medium', timeStyle: 'short' }).format(at)
}

/**
 * A scheduled run's meta word (#617 01b): when it resumes, short enough for a sidebar line —
 * `resumes in 12m` under an hour, `resumes 14:05` from an hour out (the date too beyond a day).
 * `scheduled` when the time is missing, unreadable or already due. The auto-resume hint's
 * medium date + long time is the thread's wording; it does not fit here.
 */
export function resumeLabel(autoResumeAt: string | undefined, now: number): string {
  const at = autoResumeAt ? Date.parse(autoResumeAt) : Number.NaN
  if (!Number.isFinite(at) || at <= now) return 'scheduled'
  // Floored like `shortAge`, but never "in 0m": a run a few seconds out still resumes in 1m.
  const minutes = Math.max(1, Math.floor((at - now) / 60_000))
  if (minutes < 60) return `resumes in ${minutes}m`
  const date = new Date(at)
  const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)
  if (at - now < 86_400_000) return `resumes ${clock}`
  return `resumes ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)} ${clock}`
}
