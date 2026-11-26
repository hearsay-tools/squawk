// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { compactTokens, resumeLabel, shortAge, withAgo } from '@/lib/format'

describe('shortAge', () => {
  const now = Date.parse('2026-07-14T12:00:00.000Z')
  const ago = (ms: number) => new Date(now - ms).toISOString()

  it.each([
    [0, 'just now'],
    [9_999, 'just now'],
    [10_000, '10s'],
    [34_000, '34s'],
    [59_999, '59s'],
    [60_000, '1m'],
    [26 * 60_000, '26m'],
    [3_599_000, '59m'],
    [3_600_000, '1h'],
    [66 * 60_000, '1h 6m'],
    [76 * 60_000, '1h 16m'],
    [2 * 3_600_000, '2h'],
    [5 * 3_600_000 + 59 * 60_000, '5h 59m'],
    [6 * 3_600_000 + 30 * 60_000, '6h'],
    [86_399_000, '23h'],
    [86_400_000, '1d'],
    [3 * 86_400_000, '3d'],
    [400 * 86_400_000, '400d'],
  ])('%d ms ago → %s', (ms, expected) => {
    expect(shortAge(ago(ms), now)).toBe(expected)
  })

  it('clamps a future timestamp to just now rather than printing a negative age', () => {
    // The server stamps the time; the browser's clock may be behind it.
    expect(shortAge(new Date(now + 5_000).toISOString(), now)).toBe('just now')
  })

  it.each([
    ['6m', '6m ago'],
    ['just now', 'just now'],
    ['', ''],
  ])('withAgo(%j) → %j', (age, expected) => {
    expect(withAgo(age)).toBe(expected)
  })

  it.each([undefined, '', 'not a date'])('renders nothing for %s', (iso) => {
    expect(shortAge(iso, now)).toBe('')
  })
})

describe('compactTokens', () => {
  it.each([
    [0, '0'],
    [1, '1'],
    [812, '812'],
    [999, '999'],
    [1_000, '1.0k'],
    [96_249, '96.2k'],
    // Truncated, not rounded: this must not read `1000.0k`.
    [999_999, '999.9k'],
    [1_000_000, '1.0M'],
    [1_449_999, '1.4M'],
  ])('%d → %s', (tokens, expected) => {
    expect(compactTokens(tokens)).toBe(expected)
  })

  it.each([-5, Number.NaN, Number.POSITIVE_INFINITY])('renders %s as 0', (tokens) => {
    expect(compactTokens(tokens)).toBe('0')
  })
})

describe('resumeLabel (a scheduled run\'s meta word)', () => {
  const NOW = Date.parse('2026-07-14T12:00:00.000Z')
  const ago = (ms: number) => new Date(NOW - ms).toISOString()
  it('says how long, under an hour', () => {
    expect(resumeLabel(new Date(NOW + 12 * 60_000 + 5_000).toISOString(), NOW)).toBe('resumes in 12m')
    expect(resumeLabel(new Date(NOW + 20_000).toISOString(), NOW)).toBe('resumes in 1m')
  })
  it('says when, from an hour out', () => {
    const at = new Date(NOW + 2 * 3_600_000)
    const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(at)
    expect(resumeLabel(at.toISOString(), NOW)).toBe(`resumes ${clock}`)
  })
  it('falls back to scheduled when the time is missing, invalid or already past', () => {
    expect(resumeLabel(undefined, NOW)).toBe('scheduled')
    expect(resumeLabel('not a date', NOW)).toBe('scheduled')
    expect(resumeLabel(ago(60_000), NOW)).toBe('scheduled')
  })
})
