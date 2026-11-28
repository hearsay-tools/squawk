import type { AgentBrowser } from './agent-browser'
import { waitForSettledSample } from './visual-ready'

/** The Session activity trigger in the task header (desktop pill button or mobile 44px strip, hearsay-tools/squawk#4374). */
export const SESSION_ACTIVITY_SUMMARY = '[data-slot="run-activity-trigger"], [data-slot="run-activity-trigger-mobile"]'

/**
 * Opens the Session activity panel — popover on mobile/standard desktop (`< 1600px`) or the
 * right-hand sidebar on ultra-wide (`>= 1600px`) — and returns once `[data-slot="run-activity-dock"]`
 * is mounted and the header trigger reports `aria-expanded="true"`.
 */
export function openSessionActivity(browser: AgentBrowser): void {
  browser.waitForFunction(`document.querySelector('${SESSION_ACTIVITY_SUMMARY}') !== null`)
  if (browser.evaluate(`document.querySelector('${SESSION_ACTIVITY_SUMMARY}').getAttribute('aria-expanded')`) === 'false') {
    browser.click(SESSION_ACTIVITY_SUMMARY)
  }
  browser.waitForFunction(`document.querySelector('${SESSION_ACTIVITY_SUMMARY}')?.getAttribute('aria-expanded') === 'true' && document.querySelector('[data-slot="run-activity-dock"]') !== null`)
}

/**
 * Opens the Session activity panel, then one of its rows, and returns once the row reports
 * `aria-expanded="true"`. Each toggle is a pointer click that runs only while its control still
 * reads collapsed, because disclosure memory may already hold it open.
 */
export function openSessionActivityRow(browser: AgentBrowser, row: 'status-row' | 'workflow' | 'usage' | 'workspace'): void {
  const section = `[data-slot="run-activity-${row}"]`
  const head = `${section} > button`
  openSessionActivity(browser)
  browser.waitForFunction(`document.querySelector('${head}') !== null`)
  browser.evaluate(`document.querySelector('${head}').scrollIntoView({ block: 'nearest' })`)
  const expanded = waitForSettledSample<string>(browser, `(() => {
    const target = document.querySelector('${head}')
    if (!target) return null
    const box = target.getBoundingClientRect()
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return hit && target.contains(hit) ? target.getAttribute('aria-expanded') : null
  })()`, () => true, head)
  if (expanded === 'false') {
    browser.click(head)
  }
  browser.waitForFunction(`document.querySelector('${head}')?.getAttribute('aria-expanded') === 'true'`)
  waitForSettledSample(browser, `document.querySelector('${head}')?.getAttribute('aria-expanded') === 'true'`, expanded => expanded === true, section)
  browser.hover(head)
  browser.waitForFunction(`document.querySelector('[data-slot="reference-status-card"]') === null`)
}
