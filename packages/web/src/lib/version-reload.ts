/**
 * Reload on server upgrade (hearsay-tools/squawk#4094).
 *
 * The cockpit code and the runner list (`staleTime: Infinity`) belong to the server that served
 * the page. When health reports another `version`, a tab or phone app left open across an
 * upgrade would keep showing the old setup, so the cockpit reloads itself.
 *
 * Three guards keep the reload safe:
 * - **Baseline.** The first version health reports to the app's query client is the one the page
 *   loaded with. It is kept per client (one per page load), not per component, so a remounted
 *   shell does not take a newer version as its baseline.
 * - **No loop.** Before it reloads, the page records the target version in `sessionStorage`. A
 *   page that sees a change to a version it already reloaded for does not reload again; it shows
 *   the notice with a manual Reload button instead.
 * - **No lost input.** While unsent input exists that no draft store keeps, the reload waits and
 *   the notice says why. Two sources answer:
 *   - A message composer reports its own state through `useUnsentDraft`: text, attachments and a
 *     dictation in progress. Dictation and attachments change React state with no input event,
 *     so the composer is the only place that knows. Text a host stores (the new-task draft writes
 *     localStorage on every change) does not count; attachments always do, no store keeps them.
 *   - Any other field counts when the user typed into it and it still holds text. A field that
 *     only shows a saved value was never typed into, so it does not block. Fields inside a
 *     composer answer through the composer, and fields inside `[data-persisted-draft]` are kept
 *     by their draft store, so neither counts here.
 */

import { useEffect } from 'react'

export const RELOADED_FOR_KEY = 'hsq:reloaded-for-version'

const loadedVersions = new WeakMap<object, string>()

/** Record health's version for one page (its query client). Returns the new version when it
 *  differs from that page's baseline. */
export function observeServerVersion(page: object, version: string | undefined): string | null {
  if (!version) return null
  const loaded = loadedVersions.get(page)
  if (loaded === undefined) {
    loadedVersions.set(page, version)
    return null
  }
  return version === loaded ? null : version
}

/** True when this tab already reloaded for `version`: another reload would loop. */
export function alreadyReloadedFor(version: string, storage: Pick<Storage, 'getItem'> | undefined = safeSessionStorage()): boolean {
  try {
    return storage?.getItem(RELOADED_FOR_KEY) === version
  } catch {
    return false
  }
}

/** Mark the reload target, then reload. */
export function reloadForVersion(version: string, reload: () => void = () => window.location.reload()): void {
  try {
    safeSessionStorage()?.setItem(RELOADED_FOR_KEY, version)
  } catch {
    // Storage refused (private mode, quota): the reload still happens; the loop guard is lost for
    // this tab only, and the next page's baseline is the new version anyway.
  }
  reload()
}

/** Inputs whose value is not something the user writes: toggles, buttons, files, pickers, and
 *  search boxes (a filter, never a draft). Every other input counts, password and number too. */
const NOT_WRITTEN = ['search', 'checkbox', 'radio', 'hidden', 'button', 'submit', 'reset', 'image', 'file', 'range', 'color']

const EDITABLE = [
  'textarea',
  `input${NOT_WRITTEN.map((type) => `:not([type="${type}"])`).join('')}`,
  '[contenteditable=""]',
  '[contenteditable="true"]',
].join(', ')

const typedInto = new WeakSet<EventTarget>()

/** One token per mounted composer that holds unsent input. */
const unsentDrafts = new Set<symbol>()

/** Report that this component holds input a reload would lose, for as long as `unsent` is true. */
export function useUnsentDraft(unsent: boolean): void {
  useEffect(() => {
    if (!unsent) return
    const token = Symbol('unsent-draft')
    unsentDrafts.add(token)
    return () => {
      unsentDrafts.delete(token)
    }
  }, [unsent])
}

/** Remember every field the user types into. Returns the cleanup. */
export function trackTyping(target: Document = document): () => void {
  const onInput = (event: Event) => {
    if (event.target) typedInto.add(event.target)
  }
  target.addEventListener('input', onInput, true)
  return () => target.removeEventListener('input', onInput, true)
}

/** True when a reload would lose input: a composer's unsent draft, or a typed field's text. */
export function hasUnsentInput(root: ParentNode = document): boolean {
  if (unsentDrafts.size > 0) return true
  for (const element of root.querySelectorAll<HTMLElement>(EDITABLE)) {
    if (!typedInto.has(element) || element.closest('[data-persisted-draft], [data-slot="composer"]')) continue
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      if (element.disabled || element.readOnly) continue
      if (element.value.trim() !== '') return true
    } else if ((element.textContent ?? '').trim() !== '') {
      return true
    }
  }
  return false
}

function safeSessionStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage
  } catch {
    return undefined
  }
}
