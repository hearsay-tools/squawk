import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { RELOADED_FOR_KEY } from '@/lib/version-reload'
import { VersionReloadNotice } from './version-reload-notice'

beforeEach(() => {
  // Health arrives through the cache in these tests; a stray fetch must never answer it.
  vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  sessionStorage.clear()
  document.body.innerHTML = ''
})

function setup(extra: React.ReactNode = null) {
  const client = createQueryClient()
  const reload = vi.fn()
  client.setQueryData(queryKeys.health, { version: '1.0.0' })
  render(
    <QueryClientProvider client={client}>
      <VersionReloadNotice reload={reload} />
      {extra}
    </QueryClientProvider>,
  )
  // React Query notifies observers on a zero-delay timeout, so let that timeout run inside act.
  const upgrade = (version: string) => act(async () => {
    client.setQueryData(queryKeys.health, { version })
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { reload, upgrade }
}

describe('VersionReloadNotice', () => {
  it('shows nothing and reloads nothing while the version stays the same', async () => {
    const { reload, upgrade } = setup()
    await upgrade('1.0.0')
    expect(document.querySelector('[data-slot="version-reload"]')).toBeNull()
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads once when the server version changes, and says so', async () => {
    // A field that only shows a saved value does not hold the reload back.
    const { reload, upgrade } = setup(<input aria-label="Folder" defaultValue="~/projects" />)
    await upgrade('1.1.0')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toContain('Squawk was updated to 1.1.0. Reloading…')
    expect(sessionStorage.getItem(RELOADED_FOR_KEY)).toBe('1.1.0')
  })

  it('does not reload again for a version this tab already reloaded for', async () => {
    sessionStorage.setItem(RELOADED_FOR_KEY, '1.1.0')
    const { reload, upgrade } = setup()
    await upgrade('1.1.0')
    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toContain('Reload to use the new version')
    fireEvent.click(screen.getByRole('button', { name: 'Reload now' }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('waits while a field holds unsent text, then reloads once it is cleared', async () => {
    // Only the retry interval is faked: React Query's notify timeout must still run.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { reload, upgrade } = setup(<textarea aria-label="Reply" />)
    fireEvent.input(screen.getByLabelText('Reply'), { target: { value: 'half a reply' } })
    await upgrade('1.1.0')
    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toContain('reloads once your unsent text is sent or cleared')

    fireEvent.input(screen.getByLabelText('Reply'), { target: { value: '' } })
    act(() => { vi.advanceTimersByTime(2000) })
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
