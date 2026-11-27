import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { clickInView, waitForSettledSample } from './visual-ready'
import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'
import {
  applyContrastQaVariant,
  type ContrastSample,
  contrastQaVariants,
  contrastSampleExpression,
  restoreContrastQaDefaults,
} from './contrast'

/**
 * Settings → Session context (hearsay-tools/squawk#4308): the experience criteria only a real
 * browser can check. At 360×640 the page fits without sideways scroll and its controls are 44×44
 * targets; in both themes the problem text, a preview status and the save note read at AA.
 *
 * Read-only against the shared environment: the file read is served through Chrome's network
 * layer, so nothing writes a real `context.yaml`. The preview goes to the real server, which only
 * renders the draft.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-settings-session-context-${process.pid}`
// The API path only, in both spellings: the boot project reads `/api/v1/session-context`, another
// project `/api/v1/p/<id>/session-context`. A bare `*/session-context` would also match the page's own
// address, `/p/<id>/settings/session-context`, and serve this JSON as the HTML document.
const FILE_ROUTES = ['**/api/v1/session-context', '**/api/v1/p/*/session-context']
const AA_NORMAL_TEXT = 4.5
const DRAFT = 'version: 1\nrules:\n  - id: handoff\n    on: session_start\n    template: Mine\n  - id: brief\n    on: session_start\n    target: worker\n    template: You are {{run.id}}.\n'
const SHARED_DRAFT = 'version: 1\nrules:\n  - id: team-vision\n    on: session_start\n    template: Shared team vision.\n'

let browser: AgentBrowser
let baseUrl: string
let project: string

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  project = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
  const state = {
    local: { path: '.ai/squawk/context.local.yaml', exists: true, content: DRAFT, version: 'e2e', writable: true, readOnlyReason: null },
    shared: { path: '.ai/squawk/context.yaml', exists: true, content: SHARED_DRAFT, tracked: true, unreadableReason: null },
  }
  for (const route of FILE_ROUTES) browser.routeJson(route, state)
}, 120_000)

afterAll(() => {
  for (const route of FILE_ROUTES) browser?.unroute(route)
  browser?.close()
})

const open = () => {
  browser.goto(`${baseUrl}/p/${project}/settings/session-context`)
  browser.waitForFunction(`document.querySelector('[data-slot="session-context-problem"]') !== null`)
}

const rectOf = (selector: string) =>
  waitForSettledSample(browser,
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { width: r.width, height: r.height } })()`,
  ) as { width: number; height: number }

const contrastOf = (selector: string) => browser.evaluate(contrastSampleExpression(selector)) as ContrastSample

describe('settings → session context', () => {
  for (const variant of contrastQaVariants.filter((v) => v.density === 'comfortable')) {
    // Rule: docs/areas/web-ui.md § Touch and phone rules and § Accessibility rules (contrast).
    it(`${variant.id}: shows the server's problems, fits the viewport, 44×44 targets, AA text`, () => {
      open()
      applyContrastQaVariant(browser, variant)
      try {
        expect(browser.waitForValue<string>(`document.querySelector('[data-slot="session-context-problem"]')?.textContent || null`))
          .toBe('id "handoff" is reserved for the built-in handoff block')
        const phone = variant.viewport.width === 360
        const [scrollWidth, innerWidth] = waitForSettledSample<[number, number]>(
          browser, `[document.documentElement.scrollWidth, window.innerWidth]`,
        )
        expect(scrollWidth).toBeLessThanOrEqual(innerWidth)

        const targets = [
          '[data-slot="session-context-scope"][data-scope="local"]',
          '[data-slot="session-context-scope"][data-scope="shared"]',
          '[data-slot="session-context-add-rule"]',
          '[data-slot="session-context-save"]',
        ]
        if (phone) targets.push('[data-slot="session-context-pane"]', '[data-slot="session-context-line"]')
        for (const selector of targets) {
          const rect = rectOf(selector)
          expect(rect.height, selector).toBeGreaterThanOrEqual(44)
          expect(rect.width, selector).toBeGreaterThanOrEqual(44)
        }
        for (const selector of ['[data-slot="session-context-problem"]', '[data-slot="session-context-note"]']) {
          const sample = contrastOf(selector)
          expect(sample.ratio, `${selector} ${JSON.stringify(sample)}`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
        }
        // Switch to Shared tab to verify tracked status badge and read-only view, then back to Local.
        clickInView(browser, '[data-slot="session-context-scope"][data-scope="shared"]')
        expect(browser.waitForValue<string>(`document.querySelector('[data-slot="session-context-shared-status"]')?.textContent || null`)).toBe('Tracked in Git')
        const sharedNoteContrast = contrastOf('[data-slot="session-context-shared-note"]')
        expect(sharedNoteContrast.ratio, `shared note ${JSON.stringify(sharedNoteContrast)}`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
        clickInView(browser, '[data-slot="session-context-scope"][data-scope="local"]')
        if (phone) browser.screenshot(`${artifactsDir}/settings-session-context-edit-${variant.id}.png`, { viewport: true })

        // The preview: on a phone it is the second tab. Previewed as a worker, the worker rule applies.
        // The shell's New-task button floats over the bottom of a phone screen: click in view.
        if (phone) clickInView(browser, '[data-slot="session-context-pane"][data-pane="preview"]')
        clickInView(browser, '[data-slot="session-context-role"]:nth-child(2)')
        browser.waitForFunction(
          `[...document.querySelectorAll('[data-slot="session-context-block"]')].some((el) => el.textContent.includes('brief') && el.dataset.status === 'applied')`,
        )
        // On desktop the settings stylesheet gives panel buttons a 40px bar; 44 is the touch rule.
        const role = rectOf('[data-slot="session-context-role"]')
        expect(role.height).toBeGreaterThanOrEqual(phone ? 44 : 40)
        const status = contrastOf('[data-slot="session-context-block"][data-status="applied"] code')
        expect(status.ratio, `block id ${JSON.stringify(status)}`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
        if (phone) browser.screenshot(`${artifactsDir}/settings-session-context-preview-${variant.id}.png`, { viewport: true })
      } finally {
        restoreContrastQaDefaults(browser)
      }
    })
  }
})
