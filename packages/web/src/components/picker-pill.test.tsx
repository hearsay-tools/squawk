import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClientProvider } from '@tanstack/react-query'
import type { Runner } from '@open-mercato/cezar-api-client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { createQueryClient } from '@/api/query-client'
import { RUNNERS_WITH_UNFAMILIAR, seedRunners } from '@/test/runners.testkit'
import { PickerPill, PickerPillGroup, RunnerPill } from './picker-pill'

afterEach(cleanup)

describe('PickerPill fieldLabel (#522)', () => {
  let available = 200
  let fullWidth = 150
  let resize: () => void

  beforeEach(() => {
    available = 200
    fullWidth = 150
    // jsdom has no layout. Supply only the browser measurements; the component decides
    // which text to render, including when the same pill shrinks and grows again.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { width: this.classList.contains('invisible') ? fullWidth : available } as DOMRect
    })
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback }
      observe() {}
      disconnect() {}
    })
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  function pill(label = 'Fable', props = {}) {
    return <PickerPill fieldLabel slot="model-pill" ariaLabel="Model" label={label}
      value={label} onPick={() => {}} options={[{ value: label, label }]} {...props} />
  }
  const visibleLabel = () => document.querySelector('[data-slot="picker-label"]')?.textContent

  it('keeps the entire prefix when the full label fits, including an exact fit', () => {
    available = fullWidth
    render(pill())
    expect(visibleLabel()).toBe('Model · Fable')
  })

  it('keeps a fractional-width prefix within the half-pixel fit tolerance', () => {
    fullWidth = 98.5625
    available = 98.25
    render(pill('grok-4.6'))
    expect(visibleLabel()).toBe('Model · grok-4.6')
    available = 98
    act(() => resize())
    expect(visibleLabel()).toBe('grok-4.6')
  })

  it('drops the whole prefix before the value and restores it after growing', () => {
    render(pill())
    available = fullWidth - 1
    act(() => resize())
    expect(visibleLabel()).toBe('Fable')
    available = 200
    act(() => resize())
    expect(visibleLabel()).toBe('Model · Fable')
  })

  it('keeps the full title and accessible name when a long value overflows', () => {
    available = 60
    fullWidth = 350
    render(pill('opencode/muse-spark-1.3-contributor-free'))
    const button = screen.getByRole('button', { name: 'Model · opencode/muse-spark-1.3-contributor-free' })
    expect(button.title).toBe('Model · opencode/muse-spark-1.3-contributor-free')
    expect(visibleLabel()).toBe('opencode/muse-spark-1.3-contributor-free')
  })

  it('rechecks the fit when the selected label changes', () => {
    const view = render(pill())
    fullWidth = 350
    view.rerender(pill('opencode/muse-spark-1.3-contributor-free'))
    expect(visibleLabel()).toBe('opencode/muse-spark-1.3-contributor-free')
  })

  it('exposes the full read-only value as text outside the aria-hidden visual label', () => {
    available = 60
    render(pill('Fable', { readOnly: true }))
    expect(screen.getAllByText('Model · Fable').some(node => !node.closest('[aria-hidden="true"]'))).toBe(true)
  })

  it.each([{ disabled: true }, { readOnly: true }])('retains the full label and explanation for %o', props => {
    render(pill('Fable', { ...props, disabledHint: 'Managed by agent settings' }))
    const control = document.querySelector('[data-slot="model-pill"]')!
    expect(control.getAttribute('aria-label')).toBe('Model · Fable')
    expect(control.getAttribute('title')).toContain('Model · Fable')
    expect(control.getAttribute('title')).toContain('Managed by agent settings')
  })
})

describe('PickerPillGroup (#541)', () => {
  // jsdom has no layout: `full` is each pill's prefixed label width (keyed by slot), `available`
  // the row's width. The group compares the sum of the first with the second.
  const full: Record<string, number> = {}
  let available = 500
  const observers: Array<() => void> = []

  beforeEach(() => {
    for (const key of Object.keys(full)) delete full[key]
    Object.assign(full, { 'runner-pill': 150, 'model-pill': 150, 'effort-pill': 150 })
    available = 500
    observers.length = 0
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const slot = this.closest('[data-slot$="pill"]')?.getAttribute('data-slot') ?? ''
      return { width: this.classList.contains('invisible') ? full[slot] : 0, top: 0 } as DOMRect
    })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => available)
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { observers.push(callback) }
      observe() {}
      unobserve() {}
      disconnect() {}
    })
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  const LONG = 'opencode/muse-spark-1.3-contributor-free'
  const pillFor = (slot: string, ariaLabel: string, label: string) => (
    <PickerPill fieldLabel slot={slot} ariaLabel={ariaLabel} label={label} value={label} onPick={() => {}} options={[{ value: label, label }]} />
  )
  const row = (model = 'Fable') => (
    <PickerPillGroup>
      {pillFor('runner-pill', 'Runner', 'opencode')}
      {pillFor('model-pill', 'Model', model)}
      {pillFor('effort-pill', 'Effort', 'medium')}
    </PickerPillGroup>
  )
  const labels = () => [...document.querySelectorAll('[data-slot="picker-label"]')].map((el) => el.textContent)
  const resize = () => act(() => observers.forEach((notify) => notify()))

  it('keeps every prefix while the row holds all of them, including an exact fit', () => {
    available = 450
    render(row())
    expect(labels()).toEqual(['Runner · opencode', 'Model · Fable', 'Effort · medium'])
  })

  it('drops every sibling prefix when one value would truncate, and restores them together', () => {
    full['model-pill'] = 350
    render(row(LONG))
    expect(labels()).toEqual(['opencode', LONG, 'medium'])
    available = 650
    resize()
    expect(labels()).toEqual(['Runner · opencode', `Model · ${LONG}`, 'Effort · medium'])
    available = 649
    resize()
    expect(labels()).toEqual(['opencode', LONG, 'medium'])
  })

  it('keeps full-value tooltips and accessible names after the prefixes drop', () => {
    full['model-pill'] = 350
    render(row(LONG))
    expect(document.querySelector('[data-slot="runner-pill"]')!.getAttribute('title')).toBe('Runner · opencode')
    expect(screen.getByRole('button', { name: `Model · ${LONG}` }).title).toBe(`Model · ${LONG}`)
  })

  it.each([true, false])('fits disabled pills against their shared row (all disabled: %s)', (allDisabled) => {
    const computedStyle = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      const style = computedStyle(element)
      // A grid item blockifies the disabled tooltip wrapper's inline-flex display.
      if (element.matches('span') && element.firstElementChild?.matches('button:disabled')) {
        style.display = 'flex'
      }
      return style
    })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.matches('span') ? available / 3 : available
    })
    full['model-pill'] = 350
    render(
      <PickerPillGroup>
        <div style={{ display: 'grid' }}>
          {(['Runner', 'Model', 'Effort'] as const).map((field) => {
            const label = field === 'Model' ? LONG : field === 'Runner' ? 'opencode' : 'medium'
            return <PickerPill key={field} fieldLabel slot={`${field.toLowerCase()}-pill`}
              ariaLabel={field} label={label} value={label} options={[{ value: label, label }]}
              disabled={allDisabled || field === 'Model'} onPick={() => {}} />
          })}
        </div>
      </PickerPillGroup>,
    )
    expect(labels()).toEqual(['opencode', LONG, 'medium'])
    available = 650
    resize()
    expect(labels()).toEqual(['Runner · opencode', `Model · ${LONG}`, 'Effort · medium'])
    available = 649
    resize()
    expect(labels()).toEqual(['opencode', LONG, 'medium'])
    expect(screen.getByRole('button', { name: `Model · ${LONG}` }).title).toBe(`Model · ${LONG}`)
  })

  it('rechecks the row when the selected value changes', () => {
    const view = render(row())
    expect(labels()).toEqual(['Runner · opencode', 'Model · Fable', 'Effort · medium'])
    full['model-pill'] = 350
    view.rerender(row(LONG))
    expect(labels()).toEqual(['opencode', LONG, 'medium'])
  })

  // The engine row's Model takes the flexible track. `Runner · Claude Code` (205px),
  // `Model · Default` (175px) and `Effort · auto` (138px) sum to 518px plus two 10px gaps, so
  // they fit a 563px row, yet Model would get only 563 - 205 - 138 - 20 = 200px, less than Runner.
  const engineRow = (fill?: string) => (
    <PickerPillGroup fill={fill}>
      <div style={{ display: 'grid', columnGap: '10px' }}>
        {pillFor('runner-pill', 'Runner', 'Claude Code')}
        {pillFor('model-pill', 'Model', 'Default')}
        {pillFor('effort-pill', 'Effort', 'auto')}
      </div>
    </PickerPillGroup>
  )

  it('keeps the flexible pill at least as wide as its widest sibling before showing prefixes', () => {
    Object.assign(full, { 'runner-pill': 205, 'model-pill': 175, 'effort-pill': 138 })
    available = 563
    const view = render(engineRow())
    expect(labels()).toEqual(['Runner · Claude Code', 'Model · Default', 'Effort · auto'])
    view.rerender(engineRow('model-pill'))
    expect(labels()).toEqual(['Claude Code', 'Default', 'auto'])
    // Three equal shares of the widest prefixed pill, plus the gaps: 3 × 205 + 20.
    available = 635
    resize()
    expect(labels()).toEqual(['Runner · Claude Code', 'Model · Default', 'Effort · auto'])
    available = 634
    resize()
    expect(labels()).toEqual(['Claude Code', 'Default', 'auto'])
  })

  it('fits a line without the flexible pill by the sum of its pills', () => {
    Object.assign(full, { 'runner-pill': 205, 'model-pill': 175, 'effort-pill': 138 })
    available = 353
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const slot = this.closest('[data-slot$="pill"]')?.getAttribute('data-slot') ?? ''
      // The compact row: Runner and Effort share the top line, Model sits alone below them.
      return { width: this.classList.contains('invisible') ? full[slot] : 0, top: slot === 'model-pill' ? 54 : 0 } as DOMRect
    })
    render(engineRow('model-pill'))
    expect(labels()).toEqual(['Runner · Claude Code', 'Model · Default', 'Effort · auto'])
    available = 352
    resize()
    expect(labels()).toEqual(['Claude Code', 'Default', 'auto'])
  })

  it('stops counting a pill once it unmounts', () => {
    full['model-pill'] = 350
    const view = render(row(LONG))
    expect(labels()).toEqual(['opencode', LONG, 'medium'])
    view.rerender(<PickerPillGroup>{pillFor('runner-pill', 'Runner', 'opencode')}</PickerPillGroup>)
    expect(labels()).toEqual(['Runner · opencode'])
  })
})

describe('PickerPill catalog status', () => {
  it('keeps radio options selectable and renders a disabled status row', async () => {
    render(
      <PickerPill
        slot="model-pill"
        ariaLabel="Model"
        label="auto"
        value=""
        onPick={() => {}}
        options={[{ value: '', label: 'auto' }, { value: 'gpt-future', label: 'Future' }]}
        status="Using cached Codex model list"
      />,
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Model' }))
    expect(await screen.findAllByRole('menuitemradio')).toHaveLength(2)
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.getByText('Using cached Codex model list').closest('[data-disabled]')).not.toBeNull()
  })

  it('keeps typing focus when the pointer crosses options and lets keyboard users refine a query', async () => {
    render(<PickerPill slot="branch-pill" ariaLabel="Base branch" label="main" value="main"
      onPick={() => {}} options={[{ value: 'main', label: 'main' }, { value: 'feature/search', label: 'feature/search' }]}
      searchPlaceholder="Search branches…" />)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Base branch' }))
    const search = await screen.findByRole('searchbox')
    await waitFor(() => expect(document.activeElement).toBe(search))
    fireEvent.change(search, { target: { value: 'feature' } })
    const option = screen.getByRole('menuitemradio', { name: 'feature/search' })
    fireEvent.pointerMove(option, { pointerType: 'mouse' })
    expect(document.activeElement).toBe(search)
    fireEvent.pointerLeave(option, { pointerType: 'mouse' })
    expect(document.activeElement).toBe(search)
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(option)
    fireEvent.keyDown(option, { key: 'ArrowUp' })
    await waitFor(() => expect(document.activeElement).toBe(search))
    fireEvent.change(search, { target: { value: 'main' } })
    expect(screen.getAllByRole('menuitemradio').map(el => el.textContent)).toEqual(['main'])
  })

  it.each([['ArrowDown', 'feature/search'], ['ArrowUp', 'feature/second']])('uses %s to enter filtered options for keyboard selection', async (key, selected) => {
    const onPick = vi.fn()
    render(
      <PickerPill
        slot="branch-pill"
        ariaLabel="Base branch"
        label="main"
        value="main"
        onPick={onPick}
        options={[
          { value: 'main', label: 'main' },
          { value: 'feature/search', label: 'feature/search' },
          { value: 'feature/second', label: 'feature/second' },
        ]}
        searchPlaceholder="Search branches…"
      />,
    )

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Base branch' }))
    const search = await screen.findByRole('searchbox', { name: 'Search branches…' })
    await waitFor(() => expect(document.activeElement).toBe(search))
    fireEvent.change(search, { target: { value: 'missing' } })
    fireEvent.keyDown(search, { key })
    expect(document.activeElement).toBe(search)
    fireEvent.change(search, { target: { value: 'feature' } })
    fireEvent.keyDown(search, { key })

    const option = screen.getByRole('menuitemradio', { name: selected })
    expect(document.activeElement).toBe(option)
    fireEvent.keyDown(option, { key: 'Enter' })
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(selected))
  })
})

describe('RunnerPill: runners that are not installed (hearsay-tools/squawk#4094)', () => {
  function renderRunnerPill(onPick = vi.fn(), disabled = false, uninstalled: Runner[] = ['opencode']) {
    const client = seedRunners(createQueryClient())
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/p/boot/new']}>
          <RunnerPill runners={['claude', 'codex']} uninstalled={uninstalled} value="claude" onPick={onPick} disabled={disabled} />
          <Routes>
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    return onPick
  }
  function LocationProbe() {
    const location = useLocation()
    return <span data-testid="location">{`${location.pathname}${location.hash}`}</span>
  }

  it('lists a missing runner after the choices, as a link to its Settings card, not a choice', async () => {
    renderRunnerPill()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Runner' }))
    const choices = await screen.findAllByRole('menuitemradio')
    expect(choices.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Claude Code'),
      expect.stringContaining('Codex'),
    ])
    const link = screen.getByRole('menuitem', { name: /OpenCode/ })
    expect(link.textContent).toContain('Not installed')
    expect(link.textContent).toContain('Install in Settings')
    // Global settings live outside every project: no `/p/<id>` prefix.
    expect(link.getAttribute('href')).toBe('/settings/global/agents#agent-opencode')
  })

  it('navigates to the card and picks nothing when the missing runner is chosen', async () => {
    const onPick = renderRunnerPill()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Runner' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /OpenCode/ }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/settings/global/agents#agent-opencode'))
    expect(onPick).not.toHaveBeenCalled()
  })

  it('keeps the install links reachable while the pill is disabled, with the choices locked', async () => {
    const onPick = renderRunnerPill(vi.fn(), true)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Runner' }))
    const choices = await screen.findAllByRole('menuitemradio')
    expect(choices.every((item) => item.getAttribute('aria-disabled') === 'true')).toBe(true)
    fireEvent.click(choices[1]!)
    expect(onPick).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: /OpenCode/ }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/settings/global/agents#agent-opencode'))
  })

  it('stays closed when disabled with no missing runner to link to', () => {
    renderRunnerPill(vi.fn(), true, [])
    expect((screen.getByRole('button', { name: 'Runner' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('RunnerPill: a registered runner the cockpit has no built-in name for', () => {
  function renderPill(value: Runner, uninstalled: Runner[] = []) {
    render(
      <QueryClientProvider client={seedRunners(createQueryClient(), RUNNERS_WITH_UNFAMILIAR)}>
        <MemoryRouter>
          <RunnerPill runners={['claude', 'zed-agent']} uninstalled={uninstalled} value={value} onPick={vi.fn()} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('names the runner by the display name the runners list sends, not its id or picker label', async () => {
    renderPill('zed-agent')
    const pill = screen.getByRole('button', { name: 'Runner' })
    expect(pill.textContent).toContain('Zed Agent')
    fireEvent.pointerDown(pill)
    const choices = await screen.findAllByRole('menuitemradio')
    expect(choices.map((item) => item.textContent)).toEqual([expect.stringContaining('Claude Code'), expect.stringContaining('Zed Agent')])
    expect(choices[1]!.textContent).not.toMatch(/zed-agent|\bzed\b/)
  })

  it('names a missing unfamiliar runner by its display name in the install links', async () => {
    renderPill('claude', ['zed-agent'])
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Runner' }))
    const link = await screen.findByRole('menuitem', { name: /Zed Agent/ })
    expect(link.textContent).toContain('Not installed')
  })
})
