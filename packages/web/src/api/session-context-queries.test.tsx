import { QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setApiScope } from '@open-mercato/cezar-api-client/utils/project-scope'

import { createQueryClient } from './query-client'
import { usePutSessionContext } from './queries-project'

/** hearsay-tools/squawk#4308: a save writes its answer into the cache of the project it started in. */
describe('usePutSessionContext', () => {
  afterEach(() => {
    setApiScope(null)
    vi.unstubAllGlobals()
  })

  it('caches the saved file under the project the save started in, even after a project switch', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const saved = {
      local: { path: '.ai/squawk/context.local.yaml', exists: true, content: 'version: 1\n', version: 'v2', writable: true, readOnlyReason: null },
      shared: { path: '.ai/squawk/context.yaml', exists: false, content: '', tracked: false, unreadableReason: null },
    }
    vi.stubGlobal('fetch', vi.fn(async () => {
      await held
      return new Response(JSON.stringify(saved), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const client = createQueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    setApiScope('alpha')
    const { result, rerender } = renderHook(() => usePutSessionContext(), { wrapper })
    act(() => result.current.mutate({ content: 'version: 1\n', version: 'v1' }))
    setApiScope('beta')
    rerender()
    release()
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(client.getQueryData(['alpha', 'session-context'])).toEqual(saved)
    expect(client.getQueryData(['beta', 'session-context'])).toBeUndefined()
  })
})
