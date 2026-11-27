import { writeMockSkills, refreshMockSkills } from './runner-skills-fixture'
import { projectPaths } from '../../cezar/src/project-paths.ts'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clickInView, waitForSettledSample } from './visual-ready'
import { parse } from 'yaml'

import { AgentBrowser, readTestEnv, servedRoot } from './agent-browser'
import { contrastSampleExpression, focusWithKeyboard, type ContrastSample } from './contrast'

/**
 * The workflow builder (R6 Step 1.6) end-to-end against the shared dry-run environment.
 *
 * Reachability: fully reachable. The server discovers skills fresh on every GET, so the suite
 * supplies two skills through the mock runner list and
 * builds a small workflow from them: palette → canvas adds, the YAML preview, Save (a real
 * file lands in `.ai/cezar/workflows/`, read back and parsed here), keyboard reorder through
 * dnd-kit's defaults, Import through the server's `/api/v1/workflows/parse`, and the 8-step
 * limit. The saved file is removed in afterAll so a developer's repo stays clean.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-workflows-${process.pid}`

const DESKTOP = { width: 1440, height: 900 }

const repoRoot = servedRoot()
const ALPHA = 'e2e-wb-alpha'
const BETA = 'e2e-wb-beta'
const FLOW = 'e2e-wb-flow'
const savedFlowPath = resolve(projectPaths(repoRoot).write, `workflows/${FLOW}.yaml`)
const presentationArtifacts = resolve(artifactsDir, 'workflow-editor-presentation')

let browser: AgentBrowser
let baseUrl: string
let restoreSkills: (() => void) | undefined

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  // A crashed earlier run may have left the saved flow behind — Save would then 409.
  rmSync(savedFlowPath, { force: true })
  mkdirSync(presentationArtifacts, { recursive: true })
  restoreSkills = writeMockSkills(repoRoot, [
    { name: ALPHA, description: 'Fix the issue, verify the regression, and leave a concise review note for the next person.', scope: 'repo' },
    { name: BETA, description: 'Second e2e-seeded skill', scope: 'repo' },
  ])
  await refreshMockSkills(baseUrl)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(async () => {
  restoreSkills?.()
  await refreshMockSkills(baseUrl)
  rmSync(savedFlowPath, { force: true })
  browser?.close()
})

const palettePill = (name: string) => `[data-slot="wb-skill"][data-skill="${name}"]`
const addButton = (name: string) => `${palettePill(name)} [data-slot="wb-skill-add"]`
const stepIdsJs = `[...document.querySelectorAll('[data-slot="wb-step"]')].map((s) => s.dataset.id).join(',')`

function openEmptyWorkflow(): void {
  browser.goto(`${baseUrl}/workflows`)
  browser.waitForFunction(`document.querySelector('${palettePill(ALPHA)}') !== null`)
  browser.click('[data-slot="wb-new"]')
  browser.waitForFunction(`document.querySelectorAll('[data-slot="wb-step"]').length === 0`)
}

function prepareWorkflow(skills: string[], saved = false): void {
  // Remove the file before the page reads the catalog: a canvas that matches a listed file has
  // nothing to save, so Save stays off.
  if (saved) rmSync(savedFlowPath, { force: true })
  openEmptyWorkflow()
  for (const skill of skills) browser.click(addButton(skill))
  browser.waitForFunction(`${stepIdsJs} === '${skills.join(',')}'`)
  clickInView(browser, '[data-slot="wb-yaml-toggle"]')
  if (!saved) return
  browser.fill('[data-slot="wb-name"]', FLOW)
  browser.click('[data-slot="wb-save"]')
  browser.waitForFunction(`document.querySelector('[data-slot="wb-delete"]') !== null`)
}

function importWorkflow(): void {
  const pasted = [
    `name: ${FLOW}-imported`,
    'steps:',
    '  - id: fix',
    `    skill: ${ALPHA}`,
    "    prompt: '{{task}}'",
    '  - id: tests',
    '    command: npm test',
    '    onFail:',
    '      retry: fix',
    '      max: 2',
  ].join('\n')
  openEmptyWorkflow()
  clickInView(browser, '[data-slot="wb-yaml-toggle"]')
  browser.click('[data-slot="wb-import"]')
  browser.fill('[data-slot="wb-import-text"]', pasted)
  // The expanded import card can place its actions below the nested page viewport.
  browser.evaluate(`document.querySelector('[data-slot="wb-import-run"]').scrollIntoView({ block: 'center' })`)
  browser.click('[data-slot="wb-import-run"]')
  browser.waitForFunction(`${stepIdsJs} === 'fix,tests'`)
  browser.waitForFunction(`document.querySelector('[data-slot="dialog-overlay"]') === null`)
}

describe('workflow builder against the live dry-run server', () => {
  it('builds a small workflow from the palette and previews the portable YAML', () => {
    browser.goto(`${baseUrl}/workflows`)
    browser.waitForFunction(`document.querySelector('${palettePill(ALPHA)}') !== null`)

    // Start from a clean canvas: whatever the repo's first saved workflow is, "+ new" resets.
    browser.click('[data-slot="wb-new"]')
    browser.waitForFunction(`document.querySelectorAll('[data-slot="wb-step"]').length === 0`)

    browser.click(addButton(ALPHA))
    browser.click(addButton(BETA))
    browser.waitForFunction(`${stepIdsJs} === '${ALPHA},${BETA}'`)
    expect(browser.text('[data-slot="wb-count"]')).toBe('2 skills')

    clickInView(browser, '[data-slot="wb-yaml-toggle"]') // The portable source is disclosed on demand.

    // The preview speaks the portable compact form for a pure skill stack (spec 012).
    const yaml = browser.text('[data-slot="wb-yaml"]')
    expect(yaml).toContain('skills:')
    expect(yaml).toContain(`- ${ALPHA}`)
    expect(yaml).toContain(`- ${BETA}`)
    expect(yaml).not.toContain('steps:')
    browser.screenshot(`${artifactsDir}/workflows-builder.png`)
  })

  it('reorders steps with the keyboard (dnd-kit defaults: Space lifts, arrows move, Space drops)', () => {
    prepareWorkflow([ALPHA, BETA])
    // Each phase gets an explicit sync point — pressing before the previous phase settled is a
    // race the sensor loses silently (the lift needs focus; the move needs the lift's measuring
    // pass). dnd-kit marks the activator with aria-pressed="true" for the duration of the drag.
    const grip = `document.querySelector('[data-slot="wb-step"][data-id="${ALPHA}"] [data-slot="wb-step-grip"]')`
    browser.evaluate(`${grip}.focus()`)
    browser.waitForFunction(`document.activeElement === ${grip}`)
    browser.press('Space')
    // The keyboard sensor attaches after the lift; hold it as README §dnd-kit describes.
    browser.waitForStable(`${grip}.getAttribute('aria-pressed') === 'true'`, { holdMs: 150 })
    browser.press('ArrowDown')
    browser.waitForFunction(`[...document.querySelectorAll('[aria-live]')].some(n => n.textContent.includes('was moved over droppable area ${BETA}'))`)
    browser.press('Space')
    browser.waitForFunction(`${stepIdsJs} === '${BETA},${ALPHA}'`)
    // Order is execution order — the YAML preview follows the move.
    expect(browser.text('[data-slot="wb-yaml"]').indexOf(BETA)).toBeLessThan(
      browser.text('[data-slot="wb-yaml"]').indexOf(ALPHA),
    )
  })

  it('Save writes a real portable workflow file the server round-trips', () => {
    rmSync(savedFlowPath, { force: true })
    prepareWorkflow([BETA, ALPHA])
    browser.fill('[data-slot="wb-name"]', FLOW)
    browser.click('[data-slot="wb-save"]')
    browser.waitForFunction(
      `document.querySelector('[data-slot="toaster"]')?.textContent.includes('Saved — ${FLOW}.yaml')`,
    )

    // The exported artifact on disk IS the compact portable form.
    const doc = parse(readFileSync(savedFlowPath, 'utf8')) as Record<string, unknown>
    expect(doc).toEqual({ name: FLOW, skills: [BETA, ALPHA] })

    // The catalog refetched: the new chain is selectable, and Delete now exists for it.
    browser.waitForFunction(`document.querySelector('[data-slot="wb-load-option"][data-name="${FLOW}"]') !== null`)
    browser.waitForFunction(`document.querySelector('[data-slot="wb-delete"]') !== null`)
    // The canvas now matches the saved file: Save is off and says why.
    browser.waitForFunction(`document.querySelector('[data-slot="wb-save"]').disabled && document.querySelector('[data-slot="wb-save-cue"]')?.textContent === 'No unsaved changes'`)
    browser.screenshot(`${artifactsDir}/workflows-saved.png`)
  })

  it('keeps action hierarchy and readable summaries across viewport, theme, and density', () => {
    prepareWorkflow([BETA, ALPHA], true)
    // An unsaved edit turns Save back on, so its primary look and focus ring are measured live.
    browser.fill('[data-slot="wb-description"]', 'Measure the action hierarchy.')
    browser.waitForFunction(`!document.querySelector('[data-slot="wb-save"]').disabled && document.querySelector('[data-slot="wb-save-cue"]') === null`)
    for (const [width, height] of [[360, 640], [1440, 900]] as const) {
      for (const density of ['comfortable', 'compact', 'ultra']) {
        for (const theme of ['light', 'dark']) {
          browser.setViewport(width, height)
          browser.evaluate(`(() => {
            document.documentElement.dataset.density = ${JSON.stringify(density)};
            document.documentElement.classList.toggle('light', ${JSON.stringify(theme)} === 'light');
          })()`)

          // Measure the settled theme, rather than an intermediate button color transition.
          browser.waitForFunction(`document.querySelector('[data-slot="wb-actions"]').getAnimations({ subtree: true }).every(animation => animation.playState !== 'running')`)
          const presentation = waitForSettledSample(browser, `(() => {
            const save = document.querySelector('[data-slot="wb-save"]');
            const removeFile = document.querySelector('[data-slot="wb-delete"]');
            const step = document.querySelector('[data-slot="wb-step"][data-id="${ALPHA}"]');
            const heading = step.querySelector('[data-slot="wb-step-heading"]');
            const summary = step.querySelector('[data-slot="wb-step-summary"]');
            const sr = summary.getBoundingClientRect(), hr = heading.getBoundingClientRect(), cr = step.getBoundingClientRect();
            const style = getComputedStyle(summary), saveStyle = getComputedStyle(save), deleteStyle = getComputedStyle(removeFile);
            const controls = ['[data-slot="wb-step-grip"]', '[data-slot="wb-step-actions"]', '${addButton(ALPHA)}']
              .map(selector => {
                const element = document.querySelector(selector), rect = element.getBoundingClientRect();
                const hit = getComputedStyle(element, '::after');
                // Compact step icons retain authored44px hit regions, exercised at real edges in touch-targets.
                return { width: Math.max(rect.width, parseFloat(hit.width) || 0),
                  height: Math.max(rect.height, parseFloat(hit.height) || 0) };
              });
            return {
              saveBackground: saveStyle.backgroundColor,
              deleteBackground: deleteStyle.backgroundColor,
              summaryTop: sr.top,
              summaryBottom: sr.bottom,
              headingBottom: hr.bottom,
              cardRight: cr.right,
              summaryRight: sr.right,
              lineHeight: parseFloat(style.lineHeight),
              controls,
              pageFits: document.documentElement.scrollWidth <= innerWidth,
            };
          })()`) as {
            saveBackground: string
            deleteBackground: string
            summaryTop: number
            summaryBottom: number
            headingBottom: number
            cardRight: number
            summaryRight: number
            lineHeight: number
            controls: Array<{ width: number; height: number }>
            pageFits: boolean
          }

          expect(presentation.saveBackground).not.toBe(presentation.deleteBackground)
          const deleteContrast = browser.evaluate(
            contrastSampleExpression('[data-slot="wb-delete"]'),
          ) as ContrastSample
          expect(
            deleteContrast.ratio,
            `${width}/${density}/${theme}: ${deleteContrast.foreground} on ${deleteContrast.background}`,
          ).toBeGreaterThanOrEqual(4.5)
          expect(presentation.summaryTop).toBeGreaterThanOrEqual(presentation.headingBottom)
          expect(presentation.summaryRight).toBeLessThanOrEqual(presentation.cardRight)
          expect(presentation.pageFits).toBe(true)
          if (width === 360) {
            expect(presentation.summaryBottom - presentation.summaryTop).toBeGreaterThan(
              presentation.lineHeight,
            )
            for (const control of presentation.controls) {
              expect(control.width).toBeGreaterThanOrEqual(44)
              expect(control.height).toBeGreaterThanOrEqual(44)
            }
          } else {
            for (const selector of [
              '[data-slot="wb-delete"]',
              '[data-slot="wb-save"]',
              '[data-slot="wb-step-grip"]',
              '[data-slot="wb-step-actions"]',
              addButton(ALPHA),
            ]) {
              focusWithKeyboard(browser, selector)
              expect(browser.waitForValue(`(() => {
                const element = document.querySelector(${JSON.stringify(selector)});
                const style = getComputedStyle(element);
                return document.activeElement === element && element.matches(':focus-visible') &&
                  ((style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none');
              })()`, (ringed: boolean) => ringed === true), `${density}/${theme}: ${selector}`).toBe(true)
            }
          }

          browser.screenshot(
            `${presentationArtifacts}/${width}-${density}-${theme}.png`,
            { viewport: true },
          )
        }
      }
    }
  }, 60_000)

  it('Import parses pasted YAML through the server and renders richer flows as full steps', () => {
    importWorkflow()

    browser.waitForFunction(`${stepIdsJs} === 'fix,tests' || document.querySelector('[data-slot="wb-import-error"]') !== null`)
    expect(browser.evaluate(`document.querySelector('[data-slot="wb-import-error"]')?.textContent ?? ''`)).toBe('')
    expect(String(browser.evaluate(stepIdsJs))).toBe('fix,tests')
    expect(browser.text('[data-slot="wb-count"]')).toBe('2 steps')
    // The check step retains its kind and retry count; YAML stays complete.
    expect(browser.text('[data-slot="wb-step"][data-id="tests"] [data-slot="wb-step-kind"]')).toBe('Command step · Retry ×2')
    expect(browser.text('[data-slot="wb-yaml"]')).toContain('steps:')
    expect(browser.text('[data-slot="wb-yaml"]')).toContain('command: npm test')
    browser.screenshot(`${artifactsDir}/workflows-imported.png`)
  })

  it('refuses the 9th step with the legacy limit message', () => {
    importWorkflow()
    // 2 imported steps on the canvas — fill up to the server's cap of 8, then one more.
    for (let i = 0; i < 6; i++) browser.click(addButton(ALPHA))
    browser.waitForFunction(`document.querySelectorAll('[data-slot="wb-step"]').length === 8`)

    browser.click(addButton(ALPHA))
    browser.waitForFunction(
      `document.querySelector('[data-slot="toaster"]')?.textContent.includes('at most 8 steps')`,
    )
    expect(browser.count('[data-slot="wb-step"]')).toBe(8)
  })
})
