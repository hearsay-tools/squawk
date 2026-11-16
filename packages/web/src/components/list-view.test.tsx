import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import { ListViewProvider, useListView } from '@/components/list-view'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** Two sidebar consumers in two subtrees — project groups share one filter. */
function Consumer({ name }: { name: string }) {
  const [view, setView, automations] = useListView()
  return (
    <button type="button" data-automations={automations} onClick={() => setView(view === 'active' ? 'automations' : 'active')}>
      {name}:{view}
    </button>
  )
}

function withHealth(automations: boolean | undefined) {
  // Health that is not cached never answers: the query stays pending.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)))
  const client = createQueryClient()
  if (automations !== undefined) client.setQueryData(queryKeys.health, { capabilities: { automations } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return { client, wrapper }
}

describe('ListViewProvider', () => {
  it('starts on Active', () => {
    const { wrapper } = withHealth(true)
    render(
      <ListViewProvider>
        <Consumer name="a" />
      </ListViewProvider>,
      { wrapper },
    )
    expect((screen.getByRole('button'))?.textContent).toContain('a:active')
  })

  it('keeps every sidebar consumer on the same view', async () => {
    const { wrapper } = withHealth(true)
    render(
      <ListViewProvider>
        <div>
          <Consumer name="sidebar" />
        </div>
        <div>
          <Consumer name="table" />
        </div>
      </ListViewProvider>,
      { wrapper },
    )

    fireEvent.click(screen.getByRole('button', { name: 'sidebar:active' }))
    expect(screen.getByRole('button', { name: 'sidebar:automations' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'table:automations' })).not.toBeNull()

    // …and back, from the other one.
    fireEvent.click(screen.getByRole('button', { name: 'table:automations' }))
    expect(screen.getByRole('button', { name: 'sidebar:active' })).not.toBeNull()
  })

  it('falls back to Active while automations are off, and returns once they are on (hearsay-tools/squawk#1401)', async () => {
    const { client, wrapper } = withHealth(true)
    render(<ListViewProvider><Consumer name="sidebar" /></ListViewProvider>, { wrapper })
    fireEvent.click(screen.getByRole('button', { name: 'sidebar:active' }))
    expect(screen.getByRole('button', { name: 'sidebar:automations' }).dataset.automations).toBe('true')

    act(() => { client.setQueryData(queryKeys.health, { capabilities: { automations: false } }) })
    await waitFor(() => expect(screen.getByRole('button', { name: 'sidebar:active' }).dataset.automations).toBe('false'))

    act(() => { client.setQueryData(queryKeys.health, { capabilities: { automations: true } }) })
    await waitFor(() => expect(screen.getByRole('button', { name: 'sidebar:automations' })).not.toBeNull())
  })

  it('reads Active, with automations unavailable, until health has answered', () => {
    const { wrapper } = withHealth(undefined)
    render(<ListViewProvider><Consumer name="sidebar" /></ListViewProvider>, { wrapper })
    expect(screen.getByRole('button', { name: 'sidebar:active' }).dataset.automations).toBe('false')
  })

  it('throws outside a provider rather than handing out a private filter', () => {
    // React logs the thrown render error; the assertion is the throw itself.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => render(<Consumer name="orphan" />)).toThrow(/must be used inside a <ListViewProvider>/)
    } finally {
      error.mockRestore()
    }
  })
})
