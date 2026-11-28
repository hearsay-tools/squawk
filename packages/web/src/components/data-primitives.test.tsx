import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Count, DiffStat, Path, RelativeTime, Sha, SHA_DISPLAY_LENGTH } from './data-primitives'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-27T11:05:00.000Z'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('data-primitives', () => {
  it('renders Sha with 8 characters and full hash tooltip', () => {
    const full = '259ec2f8cfde9ec8791fd9292a1c71260c6ae8b2'
    const { container } = render(<Sha sha={full} />)
    const el = container.querySelector('[data-slot="sha"]') as HTMLElement
    expect(el.textContent).toBe(full.slice(0, SHA_DISPLAY_LENGTH))
    expect(el.getAttribute('title')).toBe(full)
  })

  it('renders Sha inline variant with optional prefix', () => {
    const full = 'b31ba15a54321098765432109876543210987654'
    render(<Sha sha={full} variant="inline" prefix="head " />)
    expect(screen.getByTitle(full).textContent).toBe('head b31ba15a')
  })

  it('renders DiffStat using canonical diff formatting', () => {
    const { container } = render(<DiffStat stat={{ adds: 42, dels: 7, files: 3 }} />)
    const el = container.querySelector('[data-slot="diff-stat"]') as HTMLElement
    expect(el.textContent).toBe('+42 −7')
    expect(el.getAttribute('title')).toContain('3 files')
  })

  it('renders Count with tabular-nums and variants', () => {
    const { container } = render(
      <>
        <Count value={14} variant="badge" />
        <Count value="200+" variant="accent" />
      </>,
    )
    const nodes = [...container.querySelectorAll('[data-slot="count"]')]
    expect(nodes.map((node) => node.textContent)).toEqual(['14', '200+'])
    for (const node of nodes) expect(node.className).toContain('tabular-nums')
  })

  it('renders RelativeTime as a semantic <time> element with compact age and full title', () => {
    const iso = '2026-11-27T10:00:00.000Z'
    const now = Date.parse('2026-11-27T10:14:00.000Z')
    const { container } = render(<RelativeTime iso={iso} now={now} />)
    const el = container.querySelector('time[data-slot="relative-time"]') as HTMLTimeElement
    expect(el.getAttribute('datetime')).toBe(iso)
    expect(el.textContent).toBe('14m')
    expect(el.getAttribute('title')).toBeTruthy()
  })

  it('supports ago phrasing and omits empty timestamps without fallback', () => {
    const iso = '2026-11-27T10:00:00.000Z'
    const now = Date.parse('2026-11-27T11:05:00.000Z')
    const { container } = render(
      <>
        <RelativeTime iso={iso} now={now} ago prefix="Synced " />
        <RelativeTime iso={undefined} now={now} />
      </>,
    )
    const times = [...container.querySelectorAll('time[data-slot="relative-time"]')]
    expect(times).toHaveLength(1)
    expect(times[0]!.textContent).toBe('Synced 1h 5m ago')
  })

  it('renders Path in chip and inline variants with full tooltip', () => {
    const branch = 'feat/unify-task-lists-shared-primitives'
    const file = 'packages/web/src/components/task-table.tsx'
    const { container } = render(
      <>
        <Path value={branch} variant="chip" />
        <Path value={file} variant="inline" wrap />
      </>,
    )
    const paths = [...container.querySelectorAll('[data-slot="path"]')]
    expect(paths).toHaveLength(2)
    expect(paths[0]!.getAttribute('title')).toBe(branch)
    expect(paths[0]!.textContent).toBe(branch)
    expect(paths[1]!.getAttribute('title')).toBe(file)
    expect(paths[1]!.className).toContain('break-all')
  })
})
