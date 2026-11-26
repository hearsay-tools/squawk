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
