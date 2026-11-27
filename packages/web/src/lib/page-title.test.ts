// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { pageTitleContext } from '@/lib/page-title'

describe('pageTitleContext for automations', () => {
  it.each([
    ['/p/acme-api/automations', 'Automations'],
    ['/p/acme-api/automations/new', 'Automations / New automation'],
    ['/p/acme-api/automations/a1', 'Automations / Edit automation'],
    ['/p/acme-api/automations/a1/log', 'Automations'],
  ])('labels %s as %s', (pathname, pageLabel) => {
    expect(pageTitleContext(pathname)).toEqual({ pageLabel, taskId: null })
  })
})

describe('pageTitleContext for Git sections', () => {
  it.each([
    ['/p/acme-api/git', 'Git'],
    ['/p/acme-api/git/commits/abc123', 'Git'],
    ['/p/acme-api/git/not-landed', 'Git / Not landed'],
    ['/p/acme-api/git/branches', 'Git / All branches'],
    ['/p/acme-api/git/changes', 'Git / Uncommitted changes'],
    ['/p/acme-api/git/cleanup', 'Git / Cleanup'],
  ])('labels %s as %s', (pathname, pageLabel) => {
    expect(pageTitleContext(pathname)).toEqual({ pageLabel, taskId: null })
  })
})
