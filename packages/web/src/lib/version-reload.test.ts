import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RELOADED_FOR_KEY,
  alreadyReloadedFor,
  hasUnsentInput,
  observeServerVersion,
  reloadForVersion,
  trackTyping,
  useUnsentDraft,
} from './version-reload'

afterEach(() => {
  sessionStorage.clear()
  document.body.innerHTML = ''
})

describe('observeServerVersion', () => {
  it('takes the first version as the baseline and reports only a different one', () => {
    const page = {}
    expect(observeServerVersion(page, undefined)).toBeNull()
    expect(observeServerVersion(page, '1.0.0')).toBeNull()
    expect(observeServerVersion(page, '1.0.0')).toBeNull()
    expect(observeServerVersion(page, '1.1.0')).toBe('1.1.0')
    // The baseline stays the version the page loaded with.
    expect(observeServerVersion(page, '1.0.0')).toBeNull()
    // Another page (query client) keeps its own baseline.
    expect(observeServerVersion({}, '1.1.0')).toBeNull()
  })
})

describe('the reload loop guard', () => {
  it('records the target version before it reloads', () => {
    const reload = vi.fn()
    reloadForVersion('2.0.0', reload)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(RELOADED_FOR_KEY)).toBe('2.0.0')
    expect(alreadyReloadedFor('2.0.0')).toBe(true)
    expect(alreadyReloadedFor('3.0.0')).toBe(false)
  })
})

describe('hasUnsentInput', () => {
  let stop: () => void
  beforeEach(() => { stop = trackTyping() })
  afterEach(() => stop())

  /** Type into a field the way a person does: set the value, then fire `input`. */
  const type = (element: HTMLElement, value: string) => {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) element.value = value
    else element.textContent = value
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }

  it('is false for a field that only shows a saved value', () => {
    document.body.innerHTML = '<input value="~/projects"><textarea>saved prompt</textarea>'
    expect(hasUnsentInput()).toBe(false)
  })

  it('is false for typed fields that are empty, disabled or read-only', () => {
    document.body.innerHTML = '<textarea></textarea><input type="text"><input type="search"><input type="checkbox">'
    const [textarea, text, search, checkbox] = document.body.children as unknown as [HTMLTextAreaElement, HTMLInputElement, HTMLInputElement, HTMLInputElement]
    type(textarea, '   ')
    type(text, 'x')
    text.disabled = true
    type(search, 'filter')
    type(checkbox, 'on')
    expect(hasUnsentInput()).toBe(false)
  })

  it('is true for a typed reply, an input (text, password, number) or a content-editable field', () => {
    document.body.innerHTML = '<textarea></textarea>'
    type(document.querySelector('textarea')!, 'half a reply')
    expect(hasUnsentInput()).toBe(true)
    document.body.innerHTML = '<input>'
    type(document.querySelector('input')!, 'name')
    expect(hasUnsentInput()).toBe(true)
    document.body.innerHTML = '<input type="password">'
    type(document.querySelector('input')!, 'webhook token')
    expect(hasUnsentInput()).toBe(true)
    document.body.innerHTML = '<input type="number">'
    type(document.querySelector('input')!, '14')
    expect(hasUnsentInput()).toBe(true)
    document.body.innerHTML = '<div contenteditable="true"></div>'
    type(document.querySelector<HTMLElement>('[contenteditable]')!, 'note')
    expect(hasUnsentInput()).toBe(true)
  })

  it('leaves a composer\'s field to the composer\'s own report', () => {
    document.body.innerHTML = '<div data-slot="composer"><textarea></textarea></div>'
    type(document.querySelector('textarea')!, 'reported through useUnsentDraft')
    expect(hasUnsentInput()).toBe(false)
  })

  it('is true while any component reports an unsent draft', () => {
    const first = renderHook(({ unsent }) => useUnsentDraft(unsent), { initialProps: { unsent: true } })
    const second = renderHook(() => useUnsentDraft(true))
    expect(hasUnsentInput()).toBe(true)
    first.rerender({ unsent: false })
    expect(hasUnsentInput()).toBe(true)
    second.unmount()
    expect(hasUnsentInput()).toBe(false)
    first.unmount()
  })

  it('counts a cleared saved value, and not a field typed back to what it showed', () => {
    document.body.innerHTML = '<textarea>saved prompt</textarea><input value="14">'
    const [prompt, days] = document.body.children as unknown as [HTMLTextAreaElement, HTMLInputElement]
    prompt.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    type(prompt, '')
    expect(hasUnsentInput()).toBe(true)
    type(prompt, 'saved prompt')
    expect(hasUnsentInput()).toBe(false)
    days.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    type(days, '30')
    expect(hasUnsentInput()).toBe(true)
  })

  it('ignores text a draft store keeps', () => {
    document.body.innerHTML = '<div data-persisted-draft><textarea></textarea></div>'
    type(document.querySelector('textarea')!, 'kept in localStorage')
    expect(hasUnsentInput()).toBe(false)
  })
})
