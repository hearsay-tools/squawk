/** An error's message with its cause chain, one line each — `run()` wraps the CLI's
 *  `Wait timed out after 25000ms` as a cause, and that line is the one worth keeping. */
export function describeError(error: unknown): string {
  if (Array.isArray(error)) return error.map(describeError).join('\n---\n')
  const lines: string[] = []
  for (let current: unknown = error, depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    lines.push(errorLine(current))
    current = typeof current === 'object' && 'cause' in current ? (current as { cause?: unknown }).cause : undefined
  }
  return lines.join('\n  caused by: ')
}

/** One line for an Error, or for the plain `{ name, message }` object vitest serializes a test's
 *  errors into by the time `onTestFailed` sees them — not an Error instance, and with no
 *  prototype `String()` could fall back on. */
function errorLine(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'message' in value) {
    const { name, message } = value as { name?: unknown | undefined; message?: unknown }
    return `${typeof name === 'string' ? name : 'Error'}: ${String(message)}`
  }
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? Object.prototype.toString.call(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}
