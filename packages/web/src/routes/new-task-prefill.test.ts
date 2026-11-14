// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { prefillToast, unknownSkillPrefillText } from './new-task-prefill'

describe('prefillToast', () => {
  it('an unknown skill is called out honestly', () => {
    expect(prefillToast('ghost')).toEqual({
      message: 'Unknown skill "ghost" — prefilled for quick-task; review and press Start',
      tone: 'danger',
    })
  })
  it('a plain prefill is a quiet nudge', () => {
    expect(prefillToast('')).toEqual({
      message: 'Prefilled from link — review and press Start',
      tone: 'default',
    })
  })
})

it('unknownSkillPrefillText embeds the skill and the ref', () => {
  expect(unknownSkillPrefillText('om-fix', 'https://x')).toBe('Use the "om-fix" skill on: https://x')
})
