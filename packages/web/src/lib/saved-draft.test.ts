import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useSavedDraft } from './saved-draft'

describe('useSavedDraft', () => {
  it('follows the saved value while the user has not changed it', () => {
    const { result, rerender } = renderHook(({ saved }) => useSavedDraft(saved), { initialProps: { saved: 'a' } })
    expect(result.current[0]).toBe('a')
    rerender({ saved: 'b' })
    expect(result.current[0]).toBe('b')
  })

  it('keeps a local edit when the saved value changes underneath it', () => {
    const { result, rerender } = renderHook(({ saved }) => useSavedDraft(saved), { initialProps: { saved: 'a' } })
    act(() => result.current[1]('mine'))
    rerender({ saved: 'b' })
    expect(result.current[0]).toBe('mine')
  })

  it('follows again once the edit was saved', () => {
    const { result, rerender } = renderHook(({ saved }) => useSavedDraft(saved), { initialProps: { saved: 'a' } })
    act(() => result.current[1]('mine'))
    rerender({ saved: 'mine' })
    rerender({ saved: 'theirs' })
    expect(result.current[0]).toBe('theirs')
  })
})
