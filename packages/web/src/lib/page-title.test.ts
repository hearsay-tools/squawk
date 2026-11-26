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
