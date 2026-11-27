import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { blockedStateExpression, interactableExpression } from '../../e2e/interactable'

/** Run the seam's page expressions in jsdom: the predicate `click` and `fill` wait on. */
function mount(html: string): HTMLElement {
  document.body.innerHTML = html
  return document.querySelector<HTMLElement>('#target')!
}

function place(target: HTMLElement, box: { top: number; left: number; width: number; height: number }) {
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
    ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box,
  })
}

/** jsdom has no hit testing: by default the centre point hits the target itself. */
let hit: () => Element | null
beforeEach(() => {
  hit = () => document.querySelector('#target')
  document.elementFromPoint = () => hit()
})

afterEach(() => {
  document.body.innerHTML = ''
  Reflect.deleteProperty(document, 'elementFromPoint')
  vi.restoreAllMocks()
})

describe('interactableExpression (hearsay-tools/squawk#3820)', () => {
  it.each([
    ['a disabled button', '<button id="target" disabled>Send</button>', 'disabled'],
    ['an aria-disabled control', '<div id="target" role="button" aria-disabled="true">Send</div>', 'aria-disabled="true"'],
    ['a field in a disabled fieldset', '<fieldset disabled><input id="target"></fieldset>', 'disabled'],
  ])('holds while the target is %s, and names that state', (_, html, state) => {
    mount(html)
    expect(window.eval(interactableExpression('#target'))).toBe(false)
    expect(window.eval(blockedStateExpression('#target'))).toBe(state)
  })

  it('holds while the target is missing', () => {
    mount('<span></span>')
    expect(window.eval(interactableExpression('#target'))).toBe(false)
    expect(window.eval(blockedStateExpression('#target'))).toBe('detached')
  })

  it('passes an enabled target and an aria-disabled="false" one', () => {
    mount('<button id="target" aria-disabled="false">Send</button>')
    expect(window.eval(interactableExpression('#target'))).toBe(true)
  })

  it('allowDisabled passes a disabled target', () => {
    mount('<button id="target" disabled>Send</button>')
    expect(window.eval(interactableExpression('#target', { allowDisabled: true }))).toBe(true)
  })

  it('scrolls an off-viewport target to the centre before it passes', () => {
    const target = mount('<button id="target">Toggle</button>')
    place(target, { top: innerHeight + 400, left: 20, width: 80, height: 24 })
    const scroll = vi.fn()
    target.scrollIntoView = scroll
    expect(window.eval(interactableExpression('#target'))).toBe(true)
    expect(scroll).toHaveBeenCalledWith({ block: 'center', inline: 'center', behavior: 'instant' })
  })

  it('leaves a target that is fully in view where it is', () => {
    const target = mount('<button id="target">Toggle</button>')
    place(target, { top: 100, left: 20, width: 80, height: 24 })
    const scroll = vi.fn()
    target.scrollIntoView = scroll
    expect(window.eval(interactableExpression('#target'))).toBe(true)
    expect(scroll).not.toHaveBeenCalled()
  })

  it('scrolls a target covered at its centre point and holds until nothing covers it', () => {
    const target = mount('<div data-slot="run-tabs"></div><button id="target">Toggle</button>')
    place(target, { top: 100, left: 20, width: 80, height: 24 })
    hit = () => document.querySelector('[data-slot="run-tabs"]')
    const scroll = vi.fn()
    target.scrollIntoView = scroll
    expect(window.eval(interactableExpression('#target'))).toBe(false)
    expect(scroll).toHaveBeenCalledWith({ block: 'center', inline: 'center', behavior: 'instant' })
    expect(window.eval(blockedStateExpression('#target'))).toBe('covered by <div data-slot="run-tabs">')
    hit = () => target
    expect(window.eval(interactableExpression('#target'))).toBe(true)
  })

  it('passes a target whose centre hits its own label or an ancestor', () => {
    const target = mount('<label for="target"><span>Name</span></label><input id="target">')
    place(target, { top: 100, left: 20, width: 80, height: 24 })
    hit = () => document.querySelector('label')
    expect(window.eval(interactableExpression('#target'))).toBe(true)
    hit = () => document.body
    expect(window.eval(interactableExpression('#target'))).toBe(true)
  })

  it('leaves the hit test out for fill, which types without a pointer', () => {
    const target = mount('<div data-slot="cover"></div><input id="target">')
    place(target, { top: 100, left: 20, width: 80, height: 24 })
    hit = () => document.querySelector('[data-slot="cover"]')
    expect(window.eval(interactableExpression('#target', {}, false))).toBe(true)
  })

  it('does not scroll a disabled target it is still waiting on', () => {
    const target = mount('<button id="target" disabled>Toggle</button>')
    place(target, { top: innerHeight + 400, left: 20, width: 80, height: 24 })
    const scroll = vi.fn()
    target.scrollIntoView = scroll
    expect(window.eval(interactableExpression('#target'))).toBe(false)
    expect(scroll).not.toHaveBeenCalled()
  })
})
