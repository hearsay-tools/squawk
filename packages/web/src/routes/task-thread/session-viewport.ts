import { useLayoutEffect, useRef } from 'react'

import { keyboardOpen, type KeyboardWindow } from '@/lib/keyboard-inset'

/** Native focus and scrollIntoView must use the space between the sticky controls.
 * Measure their rendered sizes: activity expansion and drafts both change the footer.
 * Phones dock only the header's facet tabs (`--run-header-lead`, a negative sticky offset in
 * session-layout.css), so the header height counts only the part that stays on screen. */
export function useSessionViewport() {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    const main = root.closest<HTMLElement>('[data-slot="main"]')
    const header = root.querySelector<HTMLElement>('[data-slot="run-header"]')
    const footer = root.querySelector<HTMLElement>('[data-slot="thread-dock"]')
    if (!main || !header || !footer) return

    const update = () => {
      const tabs = header.querySelector<HTMLElement>('[data-slot="run-tabs"]')
      const box = header.getBoundingClientRect()
      const computedRoot = getComputedStyle(document.documentElement)
      const kbRaw =
        document.documentElement.style.getPropertyValue('--kb') ||
        (typeof computedRoot.getPropertyValue === 'function' ? computedRoot.getPropertyValue('--kb') : '')
      const kb = Number.parseFloat(kbRaw) || 0
      if (main.clientHeight > 0 && main.clientHeight < 420) root.dataset.compactViewport = 'true'
      else delete root.dataset.compactViewport
      if (kb > 0 || keyboardOpen(window as unknown as KeyboardWindow)) root.dataset.keyboardOpen = 'true'
      else delete root.dataset.keyboardOpen
      header.style.setProperty('--run-header-lead', `${tabs ? Math.max(0, tabs.getBoundingClientRect().top - box.top) : 0}px`)
      main.style.setProperty('--thread-viewport-height', `${main.clientHeight}px`)
      main.style.setProperty('--thread-header-height', `${dockedHeaderHeight(header)}px`)
      main.style.setProperty('--thread-footer-height', `${footer.getBoundingClientRect().height}px`)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(header)
    observer.observe(footer)
    observer.observe(main)
    return () => {
      observer.disconnect()
      delete root.dataset.compactViewport
      delete root.dataset.keyboardOpen
      header.style.removeProperty('--run-header-lead')
      main.style.removeProperty('--thread-header-height')
      main.style.removeProperty('--thread-footer-height')
      main.style.removeProperty('--thread-viewport-height')
    }
  }, [])
  return ref
}

/** The part of the run header that stays on screen when it docks: its height less a negative
 *  sticky offset (phones park the lead above the scrollport). */
export function dockedHeaderHeight(header: HTMLElement): number {
  const top = Number.parseFloat(getComputedStyle(header).insetBlockStart) || 0
  return Math.max(0, header.getBoundingClientRect().height + Math.min(0, top))
}
