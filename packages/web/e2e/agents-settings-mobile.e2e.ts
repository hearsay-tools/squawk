import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'
import { waitForSettledSample } from './visual-ready'

/**
 * Runner setup at phone width (hearsay-tools/squawk#4094): global Settings → Agents, the project's
 * Settings → Agent defaults, and the composer's runner picker with a missing CLI, at 360×780 CSS
 * px — the narrowest common Android width. Each view must not scroll sideways, and each leaves a
 * screenshot in the e2e artifacts dir for review.
 *
 * The shared env runs under CEZ_DRY_RUN=1, where every provider reports `connected`. The picker
 * case serves a provider status with missing CLIs through Chrome's network layer, so the
 * "Install in Settings" links have something to show.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-agents-mobile-${process.pid}`
const PHONE = { width: 360, height: 780 }
const PROVIDER_STATUS_ROUTE = '*/api/v1/providers/status*'

let browser: AgentBrowser
let baseUrl: string
let project: string
let runnerIds: string[]

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  project = await bootProjectId(baseUrl)
  const runners = (await (await fetch(`${baseUrl}/api/v1/runners`)).json()) as { runners: Array<{ id: string }> }
  runnerIds = runners.runners.map((runner) => runner.id)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(PHONE.width, PHONE.height)
}, 120_000)

afterAll(() => {
  browser?.unroute(PROVIDER_STATUS_ROUTE)
  browser?.close()
})

/** No horizontal overflow once the view has settled, then a viewport screenshot. */
function fitsPhone(slug: string, ready: string): void {
  const [scrollWidth, innerWidth] = waitForSettledSample<[number, number]>(
    browser,
    `document.querySelector(${JSON.stringify(ready)}) ? [document.documentElement.scrollWidth, window.innerWidth] : null`,
  )
  expect(scrollWidth, `${slug} overflows a 360 px viewport`).toBeLessThanOrEqual(innerWidth)
  browser.screenshot(`${artifactsDir}/agents-mobile-${slug}.png`)
}

describe('runner setup at 360 px', () => {
  it('global Settings → Agents shows one card per runner and fits the phone', () => {
    browser.goto(`${baseUrl}/settings/global/agents`)
    const ids = browser.waitForValue<string[]>(
      `(() => { const ids = [...document.querySelectorAll('[data-slot="accounts-provider"]')].map(el => el.id); return ids.length ? ids : null })()`,
    )
    expect(ids).toEqual(runnerIds.map((id) => `agent-${id}`))
    fitsPhone('global-agents', '[data-slot="accounts-provider"]')
  })

  it('Settings → Agent defaults fits the phone', () => {
    browser.goto(`${baseUrl}/p/${project}/settings/agent-defaults`)
    browser.waitForFunction(`document.querySelector('[data-slot="agent-defaults-section"]') !== null`)
    fitsPhone('agent-defaults', '[data-slot="agent-defaults-section"]')
  })

  it('the runner picker lists a missing CLI as a link to its Settings card', () => {
    const [installed, ...missing] = runnerIds
    browser.routeJson(PROVIDER_STATUS_ROUTE, {
      providers: runnerIds.map((id) => ({ provider: id, status: id === installed ? 'connected' : 'not-installed', enabled: true })),
    })
    try {
      browser.goto(`${baseUrl}/p/${project}/new`)
      browser.waitForFunction(`(() => { const pill = document.querySelector('[data-slot="runner-pill"]'); return !!pill && !pill.disabled })()`)
      browser.click('[data-slot="runner-pill"]')
      const links = browser.waitForValue<string[]>(
        `(() => { const links = [...document.querySelectorAll('[data-slot="runner-install-link"]')].map(el => el.getAttribute('href')); return links.length ? links : null })()`,
      )
      expect(links).toEqual(missing.map((id) => `/settings/global/agents#agent-${id}`))
      fitsPhone('runner-picker', '[data-slot="runner-install-link"]')

      const target = missing[0]!
      browser.click(`[data-slot="runner-install-link"][data-runner="${target}"]`)
      browser.waitForFunction(
        `location.pathname === '/settings/global/agents' && document.activeElement?.id === ${JSON.stringify(`agent-${target}`)}`,
      )
      fitsPhone('runner-card', `#agent-${target}`)
    } finally {
      browser.unroute(PROVIDER_STATUS_ROUTE)
    }
  })
})
