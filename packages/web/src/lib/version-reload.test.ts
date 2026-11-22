import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RELOADED_FOR_KEY,
  alreadyReloadedFor,
  hasUnsavedText,
  observeServerVersion,
  reloadForVersion,
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

describe('hasUnsavedText', () => {
  it('is false for empty, disabled and read-only fields', () => {
    document.body.innerHTML = '<textarea></textarea><input type="text" value="x" disabled><input value="y" readonly><input type="search" value="filter">'
    expect(hasUnsavedText()).toBe(false)
  })

  it('is true for a typed reply, an input or a content-editable field', () => {
    document.body.innerHTML = '<textarea></textarea>'
    document.querySelector('textarea')!.value = 'half a reply'
    expect(hasUnsavedText()).toBe(true)
    document.body.innerHTML = '<input value="name">'
    expect(hasUnsavedText()).toBe(true)
    document.body.innerHTML = '<div contenteditable="true">note</div>'
    expect(hasUnsavedText()).toBe(true)
  })

  it('ignores text a draft store keeps', () => {
    document.body.innerHTML = '<div data-persisted-draft><textarea></textarea></div>'
    document.querySelector('textarea')!.value = 'kept in localStorage'
    expect(hasUnsavedText()).toBe(false)
  })
})
