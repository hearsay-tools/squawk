import type { AgentBrowser } from './agent-browser'

/** Make React observe the clear before agent-browser's separate clear and insert steps. */
export function clearField(browser: Pick<AgentBrowser, 'evaluate' | 'waitForValue'>, selector: string): void {
  // Snapshot refs belong to the provider; they are not CSS selectors.
  if (/^@e\d+$/.test(selector)) return
  // The provider clears through React's value tracker, hiding the input event from React.
  // Clear through the native setter so a render between clear and insert restores ''.
  browser.evaluate(`(() => {
    const field = document.querySelector(${JSON.stringify(selector)})
    const prototype = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, '')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  browser.waitForValue(`document.querySelector(${JSON.stringify(selector)})?.value`, value => value === '')
}

/** Empty a controlled field with trusted keys, so React state sees the clear.
 *  `press` goes to whatever holds focus. A click aimed at a field that a late mount moved can
 *  leave focus on <body>; Control+a then selects the page and the field keeps its value.
 *  So focus the field itself and wait for that focus before the first key. */
export function clearWithKeyboard(browser: Pick<AgentBrowser, 'evaluate' | 'waitForFunction' | 'press'>, selector: string): void {
  const field = `document.querySelector(${JSON.stringify(selector)})`
  browser.waitForFunction(`${field} !== null`)
  browser.evaluate(`${field}.focus()`)
  browser.waitForFunction(`document.activeElement === ${field}`)
  browser.press('Control+a')
  browser.press('Backspace')
  browser.waitForFunction(`${field}.value === ''`)
}
