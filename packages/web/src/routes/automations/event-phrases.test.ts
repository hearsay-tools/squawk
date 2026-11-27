import { describe, expect, it } from 'vitest'

import { EVENT_CHIP_LABEL, eventsSentence } from './event-phrases'

describe('eventsSentence', () => {
  it('says each GitHub event in plain English', () => {
    expect(eventsSentence(['pull_request.opened'])).toBe('When a pull request opens')
    expect(eventsSentence(['issue.opened'])).toBe('When an issue opens')
    expect(eventsSentence(['issue.labeled'])).toBe('When an issue is labeled')
    expect(eventsSentence(['issue.unlabeled'])).toBe('When an issue is unlabeled')
  })

  it('joins several events with commas and a final "or"', () => {
    expect(eventsSentence(['issue.opened', 'pull_request.opened'])).toBe('When an issue opens or a pull request opens')
    expect(eventsSentence(['issue.opened', 'issue.labeled', 'issue.unlabeled'])).toBe('When an issue opens, an issue is labeled or an issue is unlabeled')
  })

  it('falls back to the trigger kind when no event is set', () => {
    expect(eventsSentence([])).toBe('When GitHub changes')
  })

  it('labels the editor chips without machine identifiers', () => {
    for (const label of Object.values(EVENT_CHIP_LABEL)) expect(label).not.toMatch(/[._]/)
  })
})
