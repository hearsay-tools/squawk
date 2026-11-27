/**
 * The Copy as CLI line laid out for reading: one shell word group per line, joined by
 * backslash continuations. Env assignments each take a line, the command words share one, and
 * every `--flag` starts a line with its value. Spaces and newlines inside single quotes stay put,
 * so the result runs in a POSIX shell exactly as the one-line form does.
 */
export function cliLines(line: string): string {
  const groups: string[] = []
  let commandStarted = false
  for (const word of shellWords(line)) {
    const last = groups.length - 1
    if (!commandStarted && /^[A-Z_][A-Z0-9_]*=/.test(word)) groups.push(word)
    else if (word.startsWith('--') || !commandStarted) {
      groups.push(word)
      commandStarted = true
    } else groups[last] = `${groups[last]} ${word}`
  }
  return groups.map((group, index) => (index === 0 ? group : `  ${group}`)).join(' \\\n')
}

/** The line's words, split at spaces outside single quotes; a `\'` outside quotes is one char. */
function shellWords(line: string): string[] {
  const words: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    if (!quoted && char === '\\' && index + 1 < line.length) {
      current += char + line[index + 1]
      index += 1
    } else if (char === "'") {
      quoted = !quoted
      current += char
    } else if (char === ' ' && !quoted) {
      if (current) words.push(current)
      current = ''
    } else current += char
  }
  if (current) words.push(current)
  return words
}
