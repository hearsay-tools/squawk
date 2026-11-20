// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { newTaskPrefillHref, parseNewTaskParams, type NewTaskParams } from './new-task-params'
import { RUNNERS_RESPONSE } from '@/test/runners.testkit'

const empty: NewTaskParams = { skill: '', ref: '' }

describe('parseNewTaskParams', () => {
  const cases: Array<[name: string, search: string, expected: NewTaskParams]> = [
    ['no query at all', '', empty],
    [
      'skill and ref',
      '?skill=om-code-review&ref=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F1',
      { skill: 'om-code-review', ref: 'https://github.com/o/r/pull/1' },
    ],
    ['skill only', '?skill=om-fix', { ...empty, skill: 'om-fix' }],
    ['native skill identity', '?skill=plugin%3Acheck&skillPath=repo%2FSKILL.md&runner=codex&account=work',
      { ...empty, skill: 'plugin:check', skillPath: 'repo/SKILL.md', runner: 'codex', account: 'work' }],
    ['invalid runner is ignored', '?runner=unknown', empty],
    ['empty path is absent', '?skill=check&skillPath=', { ...empty, skill: 'check' }],
    ['nonempty paths are preserved without trimming', '?skill=check&skillPath=%20repo%2FSKILL.md%20',
      { ...empty, skill: 'check', skillPath: ' repo/SKILL.md ' }],
    // `task` is the older spelling of `ref`; app.js still accepts it, so must we.
    ['legacy `task` alias for `ref`', '?task=issue-12', { ...empty, ref: 'issue-12' }],
    ['`ref` wins over `task` when both are present', '?ref=a&task=b', { ...empty, ref: 'a' }],
    ['whitespace around skill/ref is trimmed', '?skill=%20om-fix%20&ref=%20x%20', { ...empty, skill: 'om-fix', ref: 'x' }],
    ['unknown params are ignored', '?skill=om-fix&nope=1', { ...empty, skill: 'om-fix' }],
  ]

  for (const [name, search, expected] of cases) {
    it(name, () => {
      expect(parseNewTaskParams(search, RUNNERS_RESPONSE)).toEqual(expected)
    })
  }

  it('leaves the runner out until the runners list answers', () => {
    expect(parseNewTaskParams('?runner=codex', undefined)).toEqual(empty)
  })

  it('takes a URLSearchParams too (what useSearchParams hands the route)', () => {
    expect(parseNewTaskParams(new URLSearchParams('skill=om-fix'), RUNNERS_RESPONSE)).toEqual({ ...empty, skill: 'om-fix' })
  })
})

/** The in-app half of the contract (#374). */
describe('newTaskPrefillHref', () => {
  it('emits only the params it was given', () => {
    expect(newTaskPrefillHref({ skill: 'om-fix', ref: 'fix it' })).toBe(
      '/new?skill=om-fix&ref=fix+it',
    )
    expect(newTaskPrefillHref({ ref: 'fix it' })).toBe('/new?ref=fix+it')
    expect(newTaskPrefillHref({})).toBe('/new')
  })

  it('round-trips through the parser (in-app links use the same shape /new reads)', () => {
    const href = newTaskPrefillHref({ skill: 'om-fix', ref: 'fix it\nnow' })
    expect(parseNewTaskParams(href.split('?')[1] ?? '', RUNNERS_RESPONSE)).toEqual({
      ...empty,
      skill: 'om-fix',
      ref: 'fix it\nnow',
    })
  })

  it('round-trips a runner skill pick including its account and path', () => {
    const pick = { skill: 'plugin:check', skillPath: 'repo/SKILL.md', runner: 'codex' as const, account: 'work' }
    expect(parseNewTaskParams(newTaskPrefillHref(pick).split('?')[1] ?? '', RUNNERS_RESPONSE)).toEqual({ ...empty, ...pick })
  })
})
