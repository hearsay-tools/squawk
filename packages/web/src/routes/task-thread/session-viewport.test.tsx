import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { dockedHeaderHeight, useSessionViewport } from './session-viewport'

const BOXES: Record<string, { top: number; height: number }> = {
  'run-header': { top: 100, height: 132 },
  'run-tabs': { top: 188, height: 44 },
}

function Session() {
  const ref = useSessionViewport()
  return (
    <div ref={ref}>
      <header data-slot="run-header">
        <a data-slot="parent-task-link">Parent</a>
        <div data-slot="run-tabs" />
      </header>
      <div data-slot="thread-dock" />
    </div>
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('useSessionViewport', () => {
  it('measures the header lead above the facet tabs and counts only the docked part as header height', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const { top, height } = BOXES[this.dataset.slot ?? ''] ?? { top: 0, height: 0 }
      return { top, height, bottom: top + height } as DOMRect
    })
    // Phones apply the lead as a negative sticky offset (session-layout.css).
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) =>
      ({ insetBlockStart: (element as HTMLElement).dataset.slot === 'run-header' ? '-88px' : 'auto' }) as CSSStyleDeclaration)
    const main = document.createElement('main')
    main.dataset.slot = 'main'
    document.body.append(main)
    render(<Session />, { container: main })
    const header = main.querySelector<HTMLElement>('[data-slot="run-header"]')!
    expect(header.style.getPropertyValue('--run-header-lead')).toBe('88px')
    expect(main.style.getPropertyValue('--thread-header-height')).toBe('44px')
  })

  it('counts the whole header when it docks at the top edge', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ insetBlockStart: '0px' } as CSSStyleDeclaration)
    const header = document.createElement('header')
    header.getBoundingClientRect = () => ({ height: 132 }) as DOMRect
    expect(dockedHeaderHeight(header)).toBe(132)
  })
})
