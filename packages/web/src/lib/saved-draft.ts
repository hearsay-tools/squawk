import { useCallback, useState, type SetStateAction } from 'react'

/**
 * A form's local copy of a saved value. While the user has not changed it, it follows the saved
 * value: a save from another tab or process replaces it, so an untouched field never reads as an
 * unsaved edit (hearsay-tools/squawk#4096). Once the user changes it, it keeps their text until it
 * equals the saved value again.
 */
export function useSavedDraft<T>(
  saved: T,
  equal: (a: T, b: T) => boolean = Object.is,
): [T, (next: SetStateAction<T>) => void] {
  const [state, setState] = useState({ value: saved, base: saved })
  let current = state
  if (!equal(state.base, saved)) {
    current = { value: equal(state.value, state.base) ? saved : state.value, base: saved }
    setState(current)
  }
  const setValue = useCallback(
    (next: SetStateAction<T>) =>
      setState((previous) => ({
        ...previous,
        value: typeof next === 'function' ? (next as (value: T) => T)(previous.value) : next,
      })),
    [],
  )
  return [current.value, setValue]
}

/** Structural equality for plain JSON values, such as a list of templates or a form draft. */
export const sameJson = <T,>(a: T, b: T): boolean => JSON.stringify(a) === JSON.stringify(b)
