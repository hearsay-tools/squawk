import { productCommand } from '@/lib/product-name'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cliLines } from './cli-lines'
import { CopyAsCliCard } from './copy-as-cli-card'
import { fromDefinition } from './editor-draft'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const draft = fromDefinition({
  name: 'Nightly',
  kind: 'schedule',
  schedule: { type: 'daily', hour: 4, minute: 0 },
  task: { prompt: "Bump what's stale", workflow: 'quick-task', worktree: true, autonomous: false },
})
/** Mounted where the editor lives: under a project, so the line names this cockpit and project. */
const renderInProject = (ui: ReactElement) => render(<MemoryRouter initialEntries={['/p/my-proj/automations/a1']}>{ui}</MemoryRouter>)
/** The command box's text, exactly as shown. */
const shownLine = () => screen.getByRole('region', { name: 'Copy as CLI' }).querySelector('pre')?.textContent
const address = `HSQ_COCKPIT_URL='${window.location.origin}' HSQ_PROJECT_ID='my-proj' `
const line = address + `${productCommand()} automation add --name 'Nightly' --cron '0 4 * * *' --workflow 'quick-task' --no-autonomous --prompt 'Bump what'\\''s stale'`

describe('CopyAsCliCard', () => {
  it('prints the line and copies it, saying so', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderInProject(<CopyAsCliCard draft={draft} />)
    expect(screen.getByText(cliLines(line), { normalizer: (text) => text })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(cliLines(line)))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).not.toBeNull())
  })

  // The command box starts folded: Copy works while it is closed, and the open box wraps every
  // token inside the card instead of clipping it at the right edge.
  it('folds the command behind Show command and wraps it when open', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderInProject(<CopyAsCliCard draft={draft} />)
    const toggle = screen.getByRole('button', { name: 'Show command' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    const box = document.getElementById(toggle.getAttribute('aria-controls')!)!
    expect(box.hidden).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(cliLines(line)))

    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Hide command' }).getAttribute('aria-expanded')).toBe('true')
    expect(box.hidden).toBe(false)
    const pre = box.querySelector('pre')!
    expect(pre.className).toContain('whitespace-pre-wrap')
    expect(pre.className).toContain('break-all')
    expect(pre.className).not.toContain('overflow-x-auto')
  })

  it('says so when the clipboard refuses', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
    renderInProject(<CopyAsCliCard draft={draft} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/could not copy/i))
  })

  // hearsay-tools/cezarion#1465.
  it('once emits --at --tz --latest-start', () => {
    const once = fromDefinition({ name: 'Check', kind: 'schedule', schedule: { type: 'once', at: '2030-01-15T09:00', timeZone: 'Europe/Warsaw', latestStartMinutes: 360 }, task: { prompt: 'Go', workflow: 'quick-task', worktree: true } })
    renderInProject(<CopyAsCliCard draft={once} />)
    expect(shownLine()).toBe(cliLines(`${address}${productCommand()} automation add --name 'Check' --at '2030-01-15T09:00' --tz 'Europe/Warsaw' --latest-start '6h' --workflow 'quick-task' --prompt 'Go'`))
  })

  it('emits --no-workers and --no-messaging when task access is off', () => {
    renderInProject(<CopyAsCliCard draft={{ ...draft, allowWorkers: false, allowMessaging: false }} />)
    expect(shownLine()).toBe(cliLines(`${address}${productCommand()} automation add --name 'Nightly' --cron '0 4 * * *' --workflow 'quick-task' --no-autonomous --no-workers --no-messaging --prompt 'Bump what'\\''s stale'`))
  })

  it('falls back to the JSON form for what flags cannot say', () => {
    renderInProject(<CopyAsCliCard draft={{ ...draft, description: 'Nightly bumps' }} />)
    expect(shownLine()).toContain(`${productCommand()} automation create \\\n  --json '`)
  })
})
