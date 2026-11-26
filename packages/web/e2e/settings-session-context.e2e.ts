import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { waitForSettledSample } from './visual-ready'
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
const FILE_ROUTE = '*/session-context'
const AA_NORMAL_TEXT = 4.5
const DRAFT = 'version: 1\nrules:\n  - id: handoff\n    on: session_start\n    template: Mine\n  - id: brief\n    on: session_start\n    target: worker\n    template: You are {{run.id}}.\n'

let browser: AgentBrowser
let baseUrl: string
let project: string

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  project = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
  browser.routeJson(FILE_ROUTE, {
    path: '.ai/squawk/context.yaml', exists: true, content: DRAFT, version: 'e2e', writable: true, readOnlyReason: null,
  })
}, 120_000)

afterAll(() => {
  browser?.unroute(FILE_ROUTE)
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

        const targets = ['[data-slot="session-context-add-rule"]', '[data-slot="session-context-save"]']
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
        if (phone) browser.screenshot(`${artifactsDir}/settings-session-context-edit-${variant.id}.png`, { viewport: true })

        // The preview: on a phone it is the second tab. Previewed as a worker, the worker rule applies.
        if (phone) browser.click('[data-slot="session-context-pane"][data-pane="preview"]')
        browser.click('[data-slot="session-context-role"]:nth-child(2)')
        browser.waitForFunction(
          `[...document.querySelectorAll('[data-slot="session-context-block"]')].some((el) => el.textContent.includes('brief') && el.dataset.status === 'applied')`,
        )
        const role = rectOf('[data-slot="session-context-role"]')
        expect(role.height).toBeGreaterThanOrEqual(44)
        const status = contrastOf('[data-slot="session-context-block"][data-status="applied"] code')
        expect(status.ratio, `block id ${JSON.stringify(status)}`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
        if (phone) browser.screenshot(`${artifactsDir}/settings-session-context-preview-${variant.id}.png`, { viewport: true })
      } finally {
        restoreContrastQaDefaults(browser)
      }
    })
  }
})
