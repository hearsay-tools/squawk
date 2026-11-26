import { describe, expect, it } from 'vitest'

import type { LogEntry } from '@open-mercato/cezar-api-client'

import { commitDayLabel, commitsToday, fetchedAgo, gitAge, groupCommitsByDay } from './git-sections'

const commit = (hash: string, at: string, when: string): LogEntry => ({ hash, subject: hash, author: 'Ada', when, at })

describe('Recently on main day grouping', () => {
  it('files a commit made just after midnight under Today, whatever git rounds its relative age to', () => {
    // 00:10 today, read at 01:40: git's %cr says "2 hours ago" (it rounds 90 minutes up), which an
    // estimate turns into 23:40 yesterday. The absolute `at` keeps the commit on its own day.
    const now = new Date('2026-09-30T01:40:00').getTime()
    const log = [commit('after', '2026-09-30T00:10:00', '2 hours ago'), commit('before', '2026-09-29T23:50:00', '2 hours ago')]
    expect(groupCommitsByDay(log, now)).toEqual([
      { label: 'Today', commits: [log[0]] },
      { label: 'Yesterday', commits: [log[1]] },
    ])
    expect(commitsToday(log, now)).toBe(1)
  })

  it('labels older days by date, with the year once it is not this one', () => {
    const now = new Date('2026-09-30T12:00:00').getTime()
    expect(commitDayLabel('2026-09-27T09:00:00', now)).toBe('Sun, Sep 27')
    expect(commitDayLabel('2025-12-31T09:00:00', now)).toBe('Dec 31, 2025')
    expect(commitDayLabel('not a date', now)).toBe('Earlier')
  })
})

describe('fetchedAgo', () => {
  it('says how long ago the last fetch was, or that there never was one', () => {
    const now = new Date('2026-09-30T12:00:00Z').getTime()
    expect(fetchedAgo({ ref: 'origin/main', ahead: 0, behind: 0, fetchedAt: '2026-09-30T11:54:00Z' }, now)).toBe('fetched 6m ago')
    expect(fetchedAgo({ ref: 'origin/main', ahead: 0, behind: 0, fetchedAt: null }, now)).toBe('never fetched')
  })
})

describe('gitAge', () => {
  // Every age here is measured from this explicit `now`, never from the system clock.
  const now = Date.UTC(2026, 8, 30, 12)

  it.each([
    ['5 seconds ago', 'just now'],
    ['34 seconds ago', '34s'],
    ['12 minutes ago', '12m'],
    ['66 minutes ago', '1h 6m'],
    ['76 minutes ago', '1h 16m'],
    ['23 hours ago', '23h'],
    ['5 days ago', '5d'],
    ['2 weeks ago', '14d'],
    ['1 year, 2 months ago', '425d'],
    ['in the future', 'in the future'],
  ])('reads git %j as %j', (when, expected) => {
    expect(gitAge(when, undefined, now)).toBe(expected)
  })

  it('prefers the ISO committer date when the payload has it', () => {
    expect(gitAge('2 hours ago', new Date(now - 64 * 60_000).toISOString(), now)).toBe('1h 4m')
  })
})

