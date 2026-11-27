import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { addRule, insertToken, lineRange } from './session-context-draft'

describe('session context draft edits', () => {
  it('starts an empty draft with version, rules and one starter rule, its id selected', () => {
    const { text, select } = addRule('')
    expect(parse(text)).toEqual({
      version: 1,
      rules: [{ id: 'new-rule', on: 'session_start', target: 'both', template: 'Text for every session.\n' }],
    })
    expect(text.slice(...select)).toBe('new-rule')
  })

  it('appends to existing rules with a free id and keeps comments', () => {
    const first = addRule('').text
    const { text, select } = addRule(`# team brief\n${first.trimEnd()}`)
    expect(text.startsWith('# team brief\n')).toBe(true)
    expect((parse(text) as { rules: { id: string }[] }).rules.map((r) => r.id)).toEqual(['new-rule', 'new-rule-2'])
    expect(text.slice(...select)).toBe('new-rule-2')
  })

  it.each([
    { name: 'rules: null', before: 'version: 1\nrules: null\n' },
    { name: 'an empty rules key before another key', before: 'rules:\nversion: 1\n' },
    { name: 'rules: ~ with a comment', before: '  # team\nrules: ~ # later\nversion: 1\n' },
  ])('adds the first rule under $name', ({ before }) => {
    const { text, select } = addRule(before)
    expect(parse(text)).toMatchObject({ version: 1, rules: [{ id: 'new-rule' }] })
    expect(text.slice(...select)).toBe('new-rule')
  })

  it('keeps the comment after rules: null', () => {
    const { text } = addRule('version: 1\nrules: null # filled later\n')
    expect((parse(text) as { rules: { id: string }[] }).rules.map((r) => r.id)).toEqual(['new-rule'])
    expect(text).toContain('# filled later')
  })

  it('adds the first rule when the whole file is a flow mapping', () => {
    const { text, select } = addRule('{version: 1, rules: null}\n')
    expect(parse(text)).toMatchObject({ version: 1, rules: [{ id: 'new-rule' }] })
    expect(text.slice(...select)).toBe('new-rule')
  })

  it('keeps the blank lines a keep-chomped template ends with', () => {
    const before = 'version: 1\nrules:\n  - id: a\n    on: session_start\n    template: |+\n      old\n\n'
    const { text } = addRule(before)
    const rules = (parse(text) as { rules: { id: string; template: string }[] }).rules
    expect(rules.map((r) => r.id)).toEqual(['a', 'new-rule'])
    expect(rules[0]!.template).toBe((parse(before) as { rules: { template: string }[] }).rules[0]!.template)
  })

  it('adds the rules key inside a flow mapping that has none', () => {
    const { text, select } = addRule('{version: 1}\n')
    expect(parse(text)).toMatchObject({ version: 1, rules: [{ id: 'new-rule' }] })
    expect(text.slice(...select)).toBe('new-rule')
  })

  it('picks a free id when an existing id is quoted', () => {
    const { text } = addRule('version: 1\nrules:\n  - id: "new-rule"\n    on: session_start\n    template: x\n')
    expect((parse(text) as { rules: { id: string }[] }).rules.map((r) => r.id)).toEqual(['new-rule', 'new-rule-2'])
  })

  it('avoids colliding with rule ids already defined in the shared context.yaml layer', () => {
    const shared = 'version: 1\nrules:\n  - id: new-rule\n    on: session_start\n    template: Shared\n'
    const { text, select } = addRule('', shared)
    expect((parse(text) as { rules: { id: string }[] }).rules.map((r) => r.id)).toEqual(['new-rule-2'])
    expect(text.slice(...select)).toBe('new-rule-2')
  })

  it('adds the rules key when the draft has only a version', () => {
    expect((parse(addRule('version: 1').text) as { rules: unknown[] }).rules).toHaveLength(1)
  })

  it('turns an empty flow list of rules into a block list it can append to', () => {
    const { text } = addRule('version: 1\nrules: []  # none yet\n')
    expect((parse(text) as { rules: { id: string }[] }).rules.map((r) => r.id)).toEqual(['new-rule'])
    expect(text).toContain('# none yet')
  })

  it('adds to a non-empty flow list of rules inside the brackets', () => {
    const before = 'version: 1\nrules: [{ id: a, on: session_start, template: x }]  # inline\n'
    const { text, select } = addRule(before)
    expect((parse(text) as { rules: { id: string }[] }).rules.map((r) => r.id)).toEqual(['a', 'new-rule'])
    expect(text).toContain('# inline')
    expect(text.slice(...select)).toBe('new-rule')
  })

  it.each([
    { name: 'a trailing comma', before: 'version: 1\nrules: [{ id: a, on: session_start, template: x },]\n' },
    { name: 'a comment before the closing bracket', before: 'version: 1\nrules: [\n  { id: a, on: session_start, template: x }, # last\n]\n' },
    { name: 'a comment in an empty list', before: 'version: 1\nrules: [ # none yet\n]\n' },
  ])('adds to a flow list with $name', ({ before }) => {
    const { text, select } = addRule(before)
    expect((parse(text) as { rules: { id: string }[] }).rules.map((r) => r.id).at(-1)).toBe('new-rule')
    expect(text.slice(...select)).toBe('new-rule')
  })

  it('adds after the last rule when another key follows the list, at the list indentation', () => {
    const before = 'rules:\n    - id: a\n      on: session_start\n      template: x\nversion: 1\n'
    const { text, select } = addRule(before)
    expect(parse(text)).toMatchObject({ version: 1, rules: [{ id: 'a' }, { id: 'new-rule', target: 'both' }] })
    expect(text.endsWith('version: 1\n')).toBe(true)
    expect(text.slice(...select)).toBe('new-rule')
  })

  it('inserts a variable over the selection and puts the caret after it', () => {
    expect(insertToken('Hi X!', 3, 4, 'run.id')).toEqual({ text: 'Hi {{run.id}}!', select: [13, 13] })
  })

  it('inserts a file token with its path selected', () => {
    const { text, select } = insertToken('', 0, 0, 'file:docs/example.md')
    expect(text).toBe('{{file:docs/example.md}}')
    expect(text.slice(...select)).toBe('docs/example.md')
  })

  it('finds the range of a line', () => {
    expect(lineRange('a\nbb\nccc', 2)).toEqual([2, 4])
    expect(lineRange('a\nbb\nccc', 3)).toEqual([5, 8])
    expect(lineRange('a', 9)).toEqual([1, 1])
  })
})
