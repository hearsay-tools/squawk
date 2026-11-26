import { isMap, isSeq, parseDocument } from 'yaml'

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

const RULE_ID = /(?:^\s*-\s*|\{\s*)id:\s*([^\s,}]+)/gm

/** A rule id the draft does not use yet: `new-rule`, then `new-rule-2`, … */
function freeRuleId(text: string): string {
  const used = new Set([...text.matchAll(RULE_ID)].map((match) => match[1]))
  if (!used.has('new-rule')) return 'new-rule'
  let n = 2
  while (used.has(`new-rule-${n}`)) n++
  return `new-rule-${n}`
}

const STARTER_TEXT = 'Text for every session.'

function blockRule(id: string, indent: string): string {
  return [`${indent}- id: ${id}`, `${indent}  on: session_start`, `${indent}  target: both`, `${indent}  template: |`, `${indent}    ${STARTER_TEXT}`].join('\n')
}

/**
 * Add a starter rule to the `rules` list, as a text insert where the list is: inside the brackets
 * of a flow list, or after the last item of a block list at its indentation. An empty draft gets
 * `version` and `rules` first. A draft that does not parse gets the rule at its end.
 */
export function addRule(text: string): { text: string; select: [number, number] } {
  const id = freeRuleId(text)
  if (text.trim() === '') {
    const head = 'version: 1\nrules:\n'
    return { text: `${head}${blockRule(id, '  ')}\n`, select: [head.length + 8, head.length + 8 + id.length] }
  }
  const doc = parseDocument(text)
  const rules = doc.errors.length === 0 && isMap(doc.contents) ? doc.contents.get('rules', true) : undefined
  if (isSeq(rules) && rules.flow && rules.range) {
    // Right after the last item, or right after `[`: a trailing comma or a comment stays after it.
    const last = rules.items.at(-1) as { range?: [number, number, number] } | undefined
    const at = last?.range ? last.range[1] : text.indexOf('[', rules.range[0]) + 1
    const lead = `${text.slice(0, at)}${last ? ', ' : ''}{ id: `
    const item = `${lead}${id}, on: session_start, target: both, template: "${STARTER_TEXT}" }`
    return { text: item + text.slice(at), select: [lead.length, lead.length + id.length] }
  }
  if (isSeq(rules) && rules.items.length > 0 && rules.range) {
    const first = (rules.items[0] as { range?: [number, number, number] }).range?.[0] ?? rules.range[0]
    const lineStart = text.lastIndexOf('\n', first - 1) + 1
    const indent = /^[ \t]*/.exec(text.slice(lineStart))![0]
    const end = text.slice(0, rules.range[1]).replace(/\s*$/, '').length
    const lead = `${text.slice(0, end)}\n${indent}- id: `
    return { text: lead + blockRule(id, indent).slice(indent.length + 6) + text.slice(end), select: [lead.length, lead.length + id.length] }
  }
  let head = text.endsWith('\n') ? text : `${text}\n`
  if (!/^rules:/m.test(head)) head += 'rules:\n'
  const at = head.length + 8
  return { text: `${head}${blockRule(id, '  ')}\n`, select: [at, at + id.length] }
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
