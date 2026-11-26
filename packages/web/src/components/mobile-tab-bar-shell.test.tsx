import { cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppShell, type AppShellProps } from '@/components/app-shell'
import { ThemeProvider } from '@/components/theme-provider'
import type { MobileProjectNav } from '@/components/mobile-projects'

const insets = vi.hoisted(() => ({ bottom: 0 }))
vi.mock('@/lib/keyboard-inset', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/keyboard-inset')>()),
  useViewportInsets: () => ({ top: 0, bottom: insets.bottom }),
  useKeyboardOpen: () => insets.bottom > 80,
}))

beforeEach(() => {
  insets.bottom = 0
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {}; unobserve() {}; disconnect() {} })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

const projects: MobileProjectNav = {
  projects: [
    { id: 'cezarion', name: 'Cezarion', root: '/r/c', addedAt: '2026-07-01T00:00:00.000Z', lastOpenedAt: '2026-07-01T00:00:00.000Z', source: 'local', status: 'ok', branch: 'main' },
    { id: 'other', name: 'Other', root: '/r/o', addedAt: '2026-07-01T00:00:00.000Z', lastOpenedAt: '2026-07-01T00:00:00.000Z', source: 'local', status: 'ok', branch: 'main' },
  ],
  signals: new Map([
    ['cezarion', { needsYou: 2, failedUnread: 0, inMotion: 1, finishedUnread: 0 }],
    ['other', { needsYou: 7, failedUnread: 0, inMotion: 0, finishedUnread: 0 }],
  ]),
}

function renderShell(entry: string, props: Partial<AppShellProps> = {}) {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[entry]}>
        <AppShell mobileProjects={projects} {...props}><p>route</p></AppShell>
      </MemoryRouter>
    </ThemeProvider>,
  )
}

const tabBar = () => document.querySelector('[data-slot="mobile-tab-bar"]')
const floating = () => document.querySelector('[data-slot="mobile-new-task"]')

describe('AppShell mobile tab bar (#621)', () => {
  it('renders the tab bar in the composer row on list routes', () => {
    renderShell('/p/cezarion/')
    const row = document.querySelector('[data-slot="composer"]')!
    expect(row.contains(tabBar())).toBe(true)
  })

  it('badges Tasks with the CURRENT project, not the elsewhere total', () => {
    renderShell('/p/cezarion/')
    expect(tabBar()!.querySelector('[data-segment="amber"]')!.getAttribute('data-count')).toBe('2')
  })

  it('gates the GitHub tab on the forge', () => {
    renderShell('/p/cezarion/', { forgeAvailable: false })
    expect(tabBar()!.querySelector('[data-tab="/github"]')).toBeNull()
    expect(tabBar()!.querySelectorAll('[data-tab]')).toHaveLength(3)
  })

  it.each(['/p/cezarion/tasks/abc', '/p/cezarion/tasks/abc/changes', '/tasks/abc/files'])(
    'hides the tab bar on pushed route %s',
    (entry) => {
      renderShell(entry)
      expect(tabBar()).toBeNull()
    },
  )

  it.each(['/p/cezarion/git?view=repo', '/p/cezarion/git/not-landed', '/p/cezarion/git/cleanup', '/git/branches'])(
    'hides the tab bar on the pushed Git section screen %s (issue 08)',
    (entry) => {
      renderShell(entry)
      expect(tabBar()).toBeNull()
    },
  )

  it('keeps the tab bar on the Git screen itself, which is a list', () => {
    renderShell('/p/cezarion/git')
    expect(tabBar()).not.toBeNull()
  })

  it('keeps them on the tasks overview, which is a list', () => {
    renderShell('/p/cezarion/tasks')
    expect(tabBar()).not.toBeNull()
  })

  it('hides the tab bar while the on-screen keyboard is open', () => {
    insets.bottom = 300
    renderShell('/p/cezarion/')
    expect(tabBar()).toBeNull()
    // The row itself stays: it is what lifts the composer by --kb.
    expect(document.querySelector('[data-slot="composer"]')).not.toBeNull()
  })

  // New task is in each task list's own header: nothing floats over the rows at any scroll position.
  it.each(['/p/cezarion/', '/tasks', '/p/cezarion/new', '/p/cezarion/activity', '/p/cezarion/git', '/p/cezarion/settings', '/activity', '/tools'])(
    'keeps the tab bar and floats no New task button over %s',
    (entry) => {
      renderShell(entry)
      expect(tabBar()).not.toBeNull()
      expect(floating()).toBeNull()
      expect(document.querySelector('[data-slot="composer"] a[href$="/new"]')).toBeNull()
      expect(document.querySelector('[data-slot="main"]')?.className).not.toContain('max-md:pb-24')
    },
  )
})
