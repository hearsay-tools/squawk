/**
 * Pure text edits for Settings → Session context. Squawk never re-serializes `context.yaml`:
 * every change is a text insert, so comments and formatting stay as the user wrote them.
 */

/** The template variables a rule may name, in the order the docs list them. */
export const SESSION_CONTEXT_TOKENS = [
  'task', 'run.id', 'role', 'workflow.name', 'step.id', 'project.root', 'worktree.root', 'handoff.path', 'file:docs/example.md',
] as const

/** Shown for `file:` in the chip row; inserts `{{file:docs/example.md}}` with the path selected. */
export const FILE_TOKEN_LABEL = 'file:<path>'

const RULE_ID = /^\s*-\s*id:\s*(\S+)/gm

/** A rule id the draft does not use yet: `new-rule`, then `new-rule-2`, … */
function freeRuleId(text: string): string {
  const used = new Set([...text.matchAll(RULE_ID)].map((match) => match[1]))
  if (!used.has('new-rule')) return 'new-rule'
  let n = 2
  while (used.has(`new-rule-${n}`)) n++
  return `new-rule-${n}`
}

/** Append a starter rule. An empty draft gets the `version` and `rules` keys first. */
export function addRule(text: string): { text: string; select: [number, number] } {
  const id = freeRuleId(text)
  const rule = `  - id: ${id}\n    on: session_start\n    target: both\n    template: |\n      Text for every session.\n`
  let head = text
  if (head.trim() === '') head = 'version: 1\nrules:\n'
  else {
    if (!head.endsWith('\n')) head += '\n'
    if (!/^rules:/m.test(head)) head += 'rules:\n'
  }
  const at = head.length + rule.indexOf(id)
  return { text: head + rule, select: [at, at + id.length] }
}

/** Insert `{{token}}` over the selection. A `file:` token selects its path, ready to type over. */
export function insertToken(text: string, start: number, end: number, token: string): { text: string; select: [number, number] } {
  const inserted = `{{${token}}}`
  const next = text.slice(0, start) + inserted + text.slice(end)
  if (token.startsWith('file:')) {
    const from = start + '{{file:'.length
    return { text: next, select: [from, from + token.length - 'file:'.length] }
  }
  const caret = start + inserted.length
  return { text: next, select: [caret, caret] }
}

/** The character range of a 1-based line, without its newline. */
export function lineRange(text: string, line: number): [number, number] {
  let start = 0
  for (let n = 1; n < line; n++) {
    const next = text.indexOf('\n', start)
    if (next === -1) return [text.length, text.length]
    start = next + 1
  }
  const end = text.indexOf('\n', start)
  return [start, end === -1 ? text.length : end]
}
