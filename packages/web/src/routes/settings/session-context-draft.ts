import { isMap, isScalar, isSeq, parseDocument } from 'yaml'

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
  const used = new Set<unknown>([...text.matchAll(RULE_ID)].map((match) => match[1]))
  // Quoted or otherwise written ids: read them from the parsed rules when the draft parses.
  try {
    const rules = (parseDocument(text).toJS() as { rules?: unknown } | null)?.rules
    if (Array.isArray(rules)) for (const rule of rules) used.add((rule as { id?: unknown } | null)?.id)
  } catch {
    // A draft that does not parse keeps the ids the pattern found.
  }
  if (!used.has('new-rule')) return 'new-rule'
  let n = 2
  while (used.has(`new-rule-${n}`)) n++
  return `new-rule-${n}`
}

const STARTER_TEXT = 'Text for every session.'

function blockRule(id: string, indent: string): string {
  return [`${indent}- id: ${id}`, `${indent}  on: session_start`, `${indent}  target: both`, `${indent}  template: |`, `${indent}    ${STARTER_TEXT}`].join('\n')
}

type Inserted = { text: string; select: [number, number] }
type Ranged = { range?: [number, number, number] | null }

/** `text` up to `lead`, the id, then the rest: the id is what the caller selects. */
function placed(lead: string, id: string, rest: string): Inserted {
  return { text: lead + id + rest, select: [lead.length, lead.length + id.length] }
}

/** The starter rule's lines after `- id: <id>`, at `indent`. */
function ruleTail(indent: string): string {
  return blockRule('x', indent).slice(indent.length + 'x'.length + '- id: '.length)
}

/** The starter rule as a one-item flow list, valid in block and flow mappings alike. */
function flowList(): [string, string] {
  return ['[{ id: ', `, on: session_start, target: both, template: "${STARTER_TEXT}" }]`]
}

/**
 * `rules: null`, `rules: ~` or an empty `rules:`. An explicit null becomes a flow list in its place,
 * so a comment after it and an enclosing flow mapping stay. An empty block key gets the rule on
 * the lines under it, after any comment on its line.
 */
function underNullKey(text: string, keyStart: number, value: Ranged | null, flowRoot: boolean, id: string): Inserted {
  const [open, close] = flowList()
  if (value?.range && value.range[1] > value.range[0]) {
    return placed(`${text.slice(0, value.range[0])}${open}`, id, close + text.slice(value.range[1]))
  }
  const colon = text.indexOf(':', keyStart) + 1
  if (flowRoot) return placed(`${text.slice(0, colon)} ${open}`, id, close + text.slice(colon))
  const lineStart = text.lastIndexOf('\n', keyStart - 1) + 1
  const lineEnd = text.indexOf('\n', keyStart)
  const indent = text.slice(lineStart, keyStart)
  const head = lineEnd === -1 ? `${text}\n` : text.slice(0, lineEnd + 1)
  return placed(`${head}${indent}  - id: `, id, ruleTail(`${indent}  `) + (lineEnd === -1 ? '\n' : text.slice(lineEnd)))
}

/** Right after the last item, or right after `[`: a trailing comma or a comment stays after it. */
function intoFlowList(text: string, start: number, last: Ranged | undefined, id: string): Inserted {
  const at = last?.range ? last.range[1] : text.indexOf('[', start) + 1
  const lead = `${text.slice(0, at)}${last ? ', ' : ''}{ id: `
  return placed(lead, id, `, on: session_start, target: both, template: "${STARTER_TEXT}" }${text.slice(at)}`)
}

/** After the last item of a block list, at the indentation of its first item. */
function intoBlockList(text: string, firstStart: number, valueEnd: number, id: string): Inserted {
  const lineStart = text.lastIndexOf('\n', firstStart - 1) + 1
  const indent = /^[ \t]*/.exec(text.slice(lineStart))![0]
  const end = text.slice(0, valueEnd).replace(/\s*$/, '').length
  return placed(`${text.slice(0, end)}\n${indent}- id: `, id, ruleTail(indent) + text.slice(end))
}

/** No `rules` list to insert into: add the key if it is missing, and the rule at the end. */
function atEnd(text: string, id: string): Inserted {
  let head = text.endsWith('\n') ? text : `${text}\n`
  if (!/^rules:/m.test(head)) head += 'rules:\n'
  return placed(`${head}  - id: `, id, `${ruleTail('  ')}\n`)
}

/**
 * Add a starter rule to the `rules` list, as a text insert where the list is. An empty draft gets
 * `version` and `rules` first. A draft that does not parse gets the rule at its end.
 */
export function addRule(text: string): Inserted {
  const id = freeRuleId(text)
  if (text.trim() === '') return atEnd('version: 1\n', id)
  const doc = parseDocument(text)
  const root = doc.errors.length === 0 && isMap(doc.contents) ? doc.contents : undefined
  const pair = root?.items.find((item) => isScalar(item.key) && item.key.value === 'rules')
  const rules = pair?.value
  const keyStart = isScalar(pair?.key) ? pair.key.range?.[0] : undefined
  if (keyStart !== undefined && (rules === null || (isScalar(rules) && rules.value === null))) {
    return underNullKey(text, keyStart, rules as Ranged | null, root?.flow === true, id)
  }
  if (isSeq(rules) && rules.range) {
    const last = rules.items.at(-1) as Ranged | undefined
    if (rules.flow) return intoFlowList(text, rules.range[0], last, id)
    const first = (rules.items[0] as Ranged | undefined)?.range?.[0]
    if (first !== undefined) return intoBlockList(text, first, rules.range[1], id)
  }
  return atEnd(text, id)
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
