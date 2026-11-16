import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import { automationsAvailable, useAutomationsAvailability, useAutomationsAvailable } from '@/lib/capabilities'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('automationsAvailable', () => {
  it('is true only when the payload says automations: true', () => {
    expect(automationsAvailable({ capabilities: { automations: true } })).toBe(true)
    expect(automationsAvailable({ capabilities: { automations: false } })).toBe(false)
    expect(automationsAvailable({ capabilities: {} })).toBe(false)
    expect(automationsAvailable({})).toBe(false)
    expect(automationsAvailable(undefined)).toBe(false)
    expect(automationsAvailable(null)).toBe(false)
  })
})

describe('useAutomationsAvailability', () => {
  function mount(health?: unknown) {
    // Health that is not cached never answers: the query stays pending.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)))
    const client = createQueryClient()
    if (health !== undefined) client.setQueryData(queryKeys.health, health)
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    const hook = renderHook(() => ({ availability: useAutomationsAvailability(), available: useAutomationsAvailable() }), { wrapper })
    return { client, hook }
  }

  it('is unknown, and so unavailable, until health has answered', () => {
    const { hook } = mount()
    expect(hook.result.current).toEqual({ availability: 'unknown', available: false })
  })

  it('follows the payload once it has answered', async () => {
    const { client, hook } = mount({ capabilities: { automations: false } })
    expect(hook.result.current).toEqual({ availability: 'unavailable', available: false })
    act(() => { client.setQueryData(queryKeys.health, { capabilities: { automations: true } }) })
    await waitFor(() => expect(hook.result.current).toEqual({ availability: 'available', available: true }))
  })

  it('keeps the last known answer while the health payload is gone', () => {
    const { client, hook } = mount({ capabilities: { automations: true } })
    act(() => { client.removeQueries({ queryKey: queryKeys.health }) })
    hook.rerender()
    expect(client.getQueryData(queryKeys.health)).toBeUndefined()
    expect(hook.result.current).toEqual({ availability: 'available', available: true })
  })
})
