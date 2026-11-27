/**
 * Arrow-key movement for a single-select row (a radio group or a tab list): Right and Down go to
 * the next value, Left and Up to the previous one, Home and End to the ends, wrapping around.
 */
export function valueForKey<T>(values: readonly T[], current: T, key: string): T | undefined {
  const at = values.indexOf(current)
  const step: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }
  if (key === 'Home') return values[0]
  if (key === 'End') return values.at(-1)
  if (step[key] === undefined || at === -1) return undefined
  return values[(at + step[key]! + values.length) % values.length]
}
