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
 * - **No lost text.** While a field the user typed into still holds text that no draft store
 *   keeps, the reload waits and the notice says why. A field that only shows a saved value was
 *   never typed into, so it does not block. A field inside `[data-persisted-draft]` is kept by its
 *   draft store (the new-task composer writes localStorage on every change), so it does not block.
 */

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

const EDITABLE = [
  'textarea',
  'input:not([type])',
  'input[type="text"]',
  'input[type="url"]',
  'input[type="email"]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
].join(', ')

const typedInto = new WeakSet<EventTarget>()

/** Remember every field the user types into. Returns the cleanup. */
export function trackTyping(target: Document = document): () => void {
  const onInput = (event: Event) => {
    if (event.target) typedInto.add(event.target)
  }
  target.addEventListener('input', onInput, true)
  return () => target.removeEventListener('input', onInput, true)
}

/** True when a field the user typed into holds text that a reload would lose. */
export function hasUnsavedText(root: ParentNode = document): boolean {
  for (const element of root.querySelectorAll<HTMLElement>(EDITABLE)) {
    if (!typedInto.has(element) || element.closest('[data-persisted-draft]')) continue
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
