import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'
import { waitForSettledSample } from './visual-ready'

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-page-shell-${process.pid}`

const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 360, height: 640 }

interface ShellSample {
  template: string | null
  density: string | null
  route: string | null
  titleLeft: number | null
  titleVisible: boolean
  headerButtons: Array<{ label: string; height: number; width: number; right: number; visible: boolean }>
  primaryAction: { label: string; height: number; right: number; visible: boolean } | null
  overflow: boolean
  light: boolean
}

const ROUTES = [
  { name: 'Project tasks', path: '/', scoped: true, template: 'Table' },
  { name: 'All tasks', path: '/tasks', scoped: false, template: 'Table' },
  { name: 'GitHub', path: '/github', phoneQuery: '?filter=all', scoped: true, template: 'Table' },
  { name: 'Skills', path: '/skills', scoped: true, template: 'Table' },
  { name: 'Automations', path: '/automations', scoped: true, template: 'Table' },
  { name: 'Not landed', path: '/git/not-landed', scoped: true, template: 'Table' },
  { name: 'Reports', path: '/reports', scoped: true, template: 'Split' },
  { name: 'Workflows', path: '/workflows', scoped: true, template: 'Split' },
  { name: 'Git main', path: '/git', phoneQuery: '?view=repo', scoped: true, template: 'Split' },
  { name: 'Agent config', path: '/settings/agent-config', scoped: true, template: 'Split' },
  { name: 'New task', path: '/new', scoped: true, template: 'Form' },
  { name: 'Settings defaults', path: '/settings/agent-defaults', scoped: true, template: 'Form' },
  { name: 'Activity', path: '/activity', scoped: true, template: 'Board' },
  { name: 'Not found', path: '/does-not-exist-shell-check', scoped: true, template: 'Reading' },
] as const

let browser: AgentBrowser
let baseUrl: string
let bootProject: string

function routeUrl(entry: (typeof ROUTES)[number], phone: boolean): string {
  const query = phone && 'phoneQuery' in entry ? entry.phoneQuery : ''
  const path = entry.scoped ? `/p/${bootProject}${entry.path}` : entry.path
  return `${baseUrl}${path}${query}`
}

function measureShell(theme: 'light' | 'dark'): ShellSample {
  browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'})`)
  return waitForSettledSample(
    browser,
    `(() => {
      const shell = document.querySelector('[data-slot="page-shell"]')
      const title = shell ? shell.querySelector('[data-slot="page-shell-header-title"], h1') : null
      const painted = (el) => {
        if (!el || !el.checkVisibility({ contentVisibilityAuto: true })) return false
        const r = el.getBoundingClientRect()
        const s = getComputedStyle(el)
        return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0
      }
      const actions = shell
        ? [...shell.querySelectorAll('[data-slot="page-shell-header-actions"] :is(button, a):is([data-slot="button"], [data-page-shell-action])')]
            .filter(painted)
            .map((el) => {
              const r = el.getBoundingClientRect()
              return {
                label: (el.textContent || el.getAttribute('aria-label') || '').trim(),
                height: Math.round(r.height),
                width: Math.round(r.width),
                right: Math.round(r.right),
                visible: true,
              }
            })
        : []
      const primaryEl = shell?.querySelector('[data-slot="page-header-primary"] :is(button, a)') ?? null
      const primaryRect = primaryEl && painted(primaryEl) ? primaryEl.getBoundingClientRect() : null
      const titleRect = title && painted(title) ? title.getBoundingClientRect() : null
      return {
        template: shell?.getAttribute('data-template') ?? null,
        density: shell?.getAttribute('data-density') ?? null,
        route: shell?.getAttribute('data-route') ?? null,
        titleLeft: titleRect ? Math.round(titleRect.left) : null,
        titleVisible: Boolean(titleRect),
        headerButtons: actions,
        primaryAction: primaryEl && primaryRect ? {
          label: (primaryEl.textContent || primaryEl.getAttribute('aria-label') || '').trim(),
          height: Math.round(primaryRect.height),
          right: Math.round(primaryRect.right),
          visible: true,
        } : null,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        light: document.documentElement.classList.contains('light'),
      }
    })()`,
  ) as ShellSample
}

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
})

afterAll(() => {
  browser?.close()
})

describe('PageShell unified layout templates across themes and viewports', () => {
  for (const theme of ['dark', 'light'] as const) {
    it(`aligns desktop left origin, header button height (36px), and templates in ${theme} theme`, () => {
      browser.setViewport(DESKTOP.width, DESKTOP.height)
      const origins: Array<{ name: string; left: number }> = []

      for (const entry of ROUTES) {
        browser.goto(routeUrl(entry, false))
        browser.waitForFunction(
          `document.querySelector('[data-slot="page-shell"][data-template=${JSON.stringify(entry.template)}] [data-slot="page-shell-header-title"]') !== null`,
        )
        const sample = measureShell(theme)
        expect(sample.light, entry.name).toBe(theme === 'light')
        expect(sample.template, entry.name).toBe(entry.template)
        expect(['empty', 'sparse', 'full'], entry.name).toContain(sample.density)
        expect(sample.titleVisible, entry.name).toBe(true)
        expect(sample.overflow, `${entry.name} desktop overflow`).toBe(false)
        if (sample.titleLeft !== null) origins.push({ name: entry.name, left: sample.titleLeft })
        for (const button of sample.headerButtons) {
          expect(button.height, `${entry.name} header button "${button.label}" height`).toBe(36)
          expect(button.right, `${entry.name} header button "${button.label}" inside viewport`).toBeLessThanOrEqual(DESKTOP.width)
        }
      }

      const baselineLeft = origins[0]?.left
      expect(baselineLeft).toBeTypeOf('number')
      for (const origin of origins) {
        expect(
          Math.abs(origin.left - baselineLeft!),
          `${origin.name} left origin ${origin.left} vs ${origins[0]?.name} ${baselineLeft}`,
        ).toBeLessThanOrEqual(1)
      }

      browser.goto(routeUrl(ROUTES[0], false))
      browser.waitForFunction(`document.querySelector('[data-slot="page-shell"]') !== null`)
      measureShell(theme)
      browser.screenshot(`${artifactsDir}/page-shell-desktop-${theme}.png`, { viewport: true })
    })

    it(`keeps 360x640 mobile routes free of overflow with >=44px header targets and visible primary actions in ${theme} theme`, () => {
      browser.setViewport(PHONE.width, PHONE.height)
      const origins: Array<{ name: string; left: number }> = []

      for (const entry of ROUTES) {
        browser.goto(routeUrl(entry, true))
        browser.waitForFunction(
          `document.querySelector('[data-slot="page-shell"][data-template=${JSON.stringify(entry.template)}] [data-slot="page-shell-header-title"]') !== null`,
        )
        const sample = measureShell(theme)
        expect(sample.light, entry.name).toBe(theme === 'light')
        expect(sample.template, entry.name).toBe(entry.template)
        expect(['empty', 'sparse', 'full'], entry.name).toContain(sample.density)
        expect(sample.titleVisible, entry.name).toBe(true)
        expect(sample.overflow, `${entry.name} mobile overflow`).toBe(false)
        if (sample.titleLeft !== null) origins.push({ name: entry.name, left: sample.titleLeft })
        for (const button of sample.headerButtons) {
          expect(button.height, `${entry.name} mobile button "${button.label}" height`).toBeGreaterThanOrEqual(44)
          expect(button.right, `${entry.name} mobile button "${button.label}" right`).toBeLessThanOrEqual(PHONE.width + 1)
        }
        if (sample.primaryAction) {
          expect(sample.primaryAction.visible, `${entry.name} mobile primary action`).toBe(true)
          expect(sample.primaryAction.height, `${entry.name} mobile primary height`).toBeGreaterThanOrEqual(44)
          expect(sample.primaryAction.right, `${entry.name} mobile primary right`).toBeLessThanOrEqual(PHONE.width + 1)
        }
      }

      const baselineLeft = origins[0]?.left
      expect(baselineLeft).toBeTypeOf('number')
      for (const origin of origins) {
        expect(
          Math.abs(origin.left - baselineLeft!),
          `${origin.name} mobile left origin ${origin.left} vs ${origins[0]?.name} ${baselineLeft}`,
        ).toBeLessThanOrEqual(1)
      }

      browser.goto(routeUrl(ROUTES[0], true))
      browser.waitForFunction(`document.querySelector('[data-slot="page-shell"]') !== null`)
      measureShell(theme)
      browser.screenshot(`${artifactsDir}/page-shell-mobile-${theme}.png`, { viewport: true })
    })
  }

  it('preserves RunHeader inside ReadingPage during tablet (960x800) preview takeover', async () => {
    const response = await fetch(`${baseUrl}/api/v1/p/${encodeURIComponent(bootProject)}/runs`)
    const payload = (await response.json()) as { runs?: Array<{ id: string }> }
    const runId = payload.runs?.[0]?.id
    if (!runId) return

    browser.setViewport(960, 800)
    browser.goto(`${baseUrl}/p/${bootProject}/tasks/${encodeURIComponent(runId)}`)
    browser.waitForFunction(`document.querySelector('[data-route="task-thread"] [data-slot="run-header"]') !== null`)

    const state = waitForSettledSample(
      browser,
      `(() => {
        const main = document.querySelector('[data-slot="task-main"]')
        if (!main) return null
        main.setAttribute('data-collapsed', '')
        const header = document.querySelector('[data-route="task-thread"] [data-slot="run-header"]')
        const body = document.querySelector('[data-route="task-thread"] [data-slot="session-conversation"]')
        const headerRect = header ? header.getBoundingClientRect() : null
        const result = {
          headerDisplay: header ? getComputedStyle(header).display : null,
          headerHeight: headerRect ? Math.round(headerRect.height) : 0,
          bodyDisplay: body ? getComputedStyle(body).display : null,
        }
        main.removeAttribute('data-collapsed')
        return result
      })()`,
    ) as { headerDisplay: string | null; headerHeight: number; bodyDisplay: string | null }

    expect(state.headerDisplay).not.toBe('none')
    expect(state.headerHeight).toBeGreaterThan(20)
    expect(state.bodyDisplay).toBe('none')
  })
})
