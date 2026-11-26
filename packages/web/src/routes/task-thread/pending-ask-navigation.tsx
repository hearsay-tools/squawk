import { useEffect, useState, type RefObject } from 'react'

import { Button } from '@/components/ui/button'

/** The section holding the pending ask's answerable copy; its row key is `pending-ask:<askId>`. */
export const PENDING_ASK_SECTION_ID = 'pending-ask'

/**
 * Navigation between the pending question's two places (hearsay-tools/cezarion#1495): the
 * answerable card pinned after the newest entry, and the marker where the agent asked it.
 */

/** The first answer control of an ask card: a chip, Other, or an open question's textarea.
 *  A card with none (a question routed to the parent task) takes focus itself. */
export function firstAnswerControl(card: HTMLElement): HTMLElement {
  const control = card.querySelector<HTMLElement>(
    '[data-slot="ask-question"] :is(button, textarea):not(:disabled)',
  )
  if (control) return control
  card.tabIndex = -1
  return card
}

/** The pinned card's first answer control under `root`, or null while it is not mounted. */
export function pinnedAnswerControl(root: HTMLElement): HTMLElement | null {
  const card = root.querySelector<HTMLElement>('[data-slot="ask-card"][data-pinned="true"]')
  return card ? firstAnswerControl(card) : null
}

/**
 * The pill's focus target for one pending ask: its pinned card's first answer control. Null
 * while that card is not mounted; false once the ask is no longer pending, which gives up the
 * late focus, so a later question in the same task never takes focus from an old click.
 */
export function pinnedAskFocus(askId: string, stillPending: () => boolean) {
  const key = `${PENDING_ASK_SECTION_ID}:${askId}`
  return (root: HTMLElement): HTMLElement | null | false => {
    if (!stillPending()) return false
    const row = [...root.querySelectorAll<HTMLElement>('[data-row-key]')].find((el) => el.dataset.rowKey === key)
    return row ? pinnedAnswerControl(row) : null
  }
}

const PINNED_ASK_SELECTOR = '[data-slot="ask-card"][data-pinned="true"]'

/**
 * Whether the pinned ask card shows in the transcript's visible part, above the thread dock.
 * While it does, the jump pill would float over its options, and the card already is the
 * latest thing to act on, so the pill stays hidden. The card mounts and unmounts with the
 * virtualizer, so a mutation observer finds the current one. Without IntersectionObserver
 * (old browsers, jsdom) the answer is always false: the pill keeps its old behavior.
 */
export function usePinnedAskInView(active: boolean, scrollRef: RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(false)
  useEffect(() => {
    if (!active || typeof IntersectionObserver === 'undefined' || typeof MutationObserver === 'undefined') return
    const host = scrollRef.current ?? document.body
    let card: HTMLElement | null = null
    let intersection: IntersectionObserver | null = null
    const watch = () => {
      const next = host.querySelector<HTMLElement>(PINNED_ASK_SELECTOR)
      if (next === card) return
      intersection?.disconnect()
      card = next
      if (!card) {
        setInView(false)
        return
      }
      // The sticky dock covers the bottom of the viewport: a card behind it is not visible.
      const dock = document.querySelector<HTMLElement>('[data-slot="thread-dock"]')
      const covered = Math.round(dock?.getBoundingClientRect().height ?? 0)
      intersection = new IntersectionObserver(
        (entries) => setInView(entries.some((entry) => entry.isIntersecting)),
        { rootMargin: `0px 0px -${covered}px 0px` },
      )
      intersection.observe(card)
    }
    watch()
    const mutations = new MutationObserver(watch)
    mutations.observe(host, { childList: true, subtree: true })
    return () => {
      mutations.disconnect()
      intersection?.disconnect()
    }
  }, [active, scrollRef])
  return active && inView
}

/** The jump pill's label: with a question pending, it names how many questions wait. */
export function jumpLabel(pendingQuestions: number): string {
  if (pendingQuestions <= 0) return 'Jump to latest'
  return `Jump to latest (${pendingQuestions} ${pendingQuestions === 1 ? 'question' : 'questions'} pending)`
}

/** The pending question's original place: context stays here, the answer form is pinned below. */
export function AskOriginMarker({ onGoToQuestion }: { onGoToQuestion: () => void }) {
  return (
    <div
      data-slot="ask-origin"
      className="flex flex-wrap items-center gap-x-2 rounded-lg border border-dashed border-accent-strong/40 px-3.5 py-1 text-xs text-muted-foreground"
    >
      <span className="font-medium text-link-foreground">Question asked here</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-slot="ask-go-to-question"
        className="min-h-11 min-w-11 px-2 text-foreground underline underline-offset-4"
        onClick={onGoToQuestion}
      >
        Go to the question
      </Button>
    </div>
  )
}
