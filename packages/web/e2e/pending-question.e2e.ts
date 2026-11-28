import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RUN_STATUS, STEP_STATUS, STEP_KIND } from '@open-mercato/cezar-api-client/contract/test-factories.testkit';
import { WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-api-client/contract/wait-factories.testkit';
import type { RunRecord } from '@open-mercato/cezar-api-client/contract/runs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seedRuns } from './seed-runs'
import { AgentBrowser, bootProjectId, squawkCli, fixtureServeEnv } from './agent-browser'
import { contrastSampleExpression, type ContrastSample } from './contrast'
import { captureFixtureServer, spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { seedTranscript } from './seed-transcript'
import { waitForSettledSample } from './visual-ready'
// fixture-server starts: 1

/**
 * The pinned pending question (hearsay-tools/cezarion#1495): a waiting task whose open
 * question sits far above the newest history page, behind an earlier answered question.
 */
const RUN_ID = 'abababab-1495-4222-8333-cdcdcdcdcdcd'
const OTHER_ID = 'abababab-1495-4222-8333-efefefefefef'
const now = '2026-10-23T10:00:00.000Z'
const LATER_MESSAGES = 260
const ASK_CONTEXT = Array.from({ length: 40 }, (_, index) => `Context paragraph ${index + 1}: keep the full proposal visible in the transcript.`).join('\n\n')

const lines: Array<Record<string, unknown>> = [
  { type: 'step-start', stepId: 'task', name: 'Do the task', kind: STEP_KIND.agent, iteration: 1 },
  { type: 'session.started', sessionId: 'a0000000-0000-4000-8000-000000001495', backend: 'claude', stepId: 'task' },
  { type: 'turn.started', turnId: 'turn_1', stepId: 'task' },
  { type: 'ask.requested', stepId: 'task', requestId: 'answered-question', context: 'The earlier proposal stays visible.', questions: [{ header: 'Earlier', question: 'Which branch is the base?', options: [{ label: 'main' }, { label: 'develop' }] }, { header: 'Notes', question: 'Which notes should I keep?', options: [{ label: 'Default notes' }, { label: 'No notes' }] }] },
]
const answeredSeq = lines.length
lines.push(
  { type: 'human-input-delivered', stepId: 'task', askSeq: answeredSeq },
  { type: 'user-message', stepId: 'task', text: 'Earlier: main\nNotes: Keep the filters.\nKeep every column.', imageCount: 0 },
  { type: 'turn.started', turnId: 'turn_2', stepId: 'task' },
  { type: 'ask.requested', stepId: 'task', requestId: 'pending-question', context: ASK_CONTEXT, questions: [{ header: 'Approach', question: 'Which approach should I take?', options: [{ label: 'Minimal', description: 'Small change' }, { label: 'Expanded', description: 'Wider change' }] }] },
)
const pendingSeq = lines.length
for (let index = 1; index <= LATER_MESSAGES; index += 1) {
  lines.push({ type: 'item.completed', stepId: 'task', item: { kind: 'message', id: `later_${index}`, role: 'assistant', text: `Worker update ${index}: still monitoring.` } })
}
const events = lines.map((line, index) => ({ ...line, seq: index + 1, ts: new Date(Date.parse(now) + index * 10).toISOString(), runId: RUN_ID }))

const record = (id: string, title: string, extra: Partial<RunRecord> = {}) => ({
  id, title, titleSummary: title, task: title, workflow: 'quick-task', runner: 'claude', status: RUN_STATUS.done, createdAt: now,
  tokensUsed: 0, archived: false, steps: [{ id: 'task', name: 'Do the task', kind: STEP_KIND.agent, status: STEP_STATUS.done, iterations: 1, tokensUsed: 0 }], ...extra,
} satisfies Partial<RunRecord>)
const RUNS = [
  record(RUN_ID, 'Answer a question far above the tail', {
    status: RUN_STATUS.waiting,
    steps: [{ id: 'task', name: 'Do the task', kind: STEP_KIND.agent, status: STEP_STATUS.running, iterations: 1, tokensUsed: 0, sessionId: 'a0000000-0000-4000-8000-000000001495' }],
    waits: [{ id: randomUUID(), kind: WAIT_KIND.human, source: WAIT_SOURCE.agent, via: WAIT_VIA["ask-line"], registeredAt: now, phase: WAIT_PHASE.open, turnId: 'turn_2', askSeq: pendingSeq }],
  }),
  record(OTHER_ID, 'Another finished task'),
]

const MAIN = `document.querySelector('[data-slot="thread-transcript"]')`
const PILL = '[data-slot="jump-to-latest"]'
const PINNED = '[data-slot="ask-card"][data-pinned="true"]'
const FIRST_CHIP = `${PINNED} [data-slot="ask-question"] button`
const cursorRequests = `performance.getEntriesByType('resource').filter((entry) => {
  const url = new URL(entry.name)
  return url.pathname.endsWith('/runs/${RUN_ID}/history') && url.searchParams.has('cursor')
}).length`

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let project: string
let diagnostics: ReturnType<typeof captureFixtureServer> | undefined

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-pending-question-'))
  mkdirSync(join(dataRoot, '.ai/cezar/runs'), { recursive: true })
  seedRuns(dataRoot, RUNS)
  seedTranscript(join(dataRoot, '.ai/cezar/runs', `${RUN_ID}.ndjson`), events.map(event => JSON.stringify(event)).join('\n') + '\n')
  server = spawnFixtureServer([squawkCli, 'serve', '--repo', dataRoot, '--port', '0', '--no-open'], {
    env: fixtureServeEnv(dataRoot, { CEZ_AUTONAME: '0' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  diagnostics = captureFixtureServer(server)
  try {
    baseUrl = await waitForFixtureServer(server)
  } catch (error) {
    throw new Error(`${String(error)}\nFixture startup: ${JSON.stringify(diagnostics())}`, { cause: error })
  }
  project = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(`e2e-pending-question-${process.pid}`)
}, 120_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

function openTask(width: number, height: number, query = ''): void {
  browser.setViewport(width, height)
  browser.goto(`${baseUrl}/p/${project}/tasks/${RUN_ID}${query}`)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(PINNED)}) !== null`)
  browser.waitForStable(`window.__cezIdle !== false`, { holdMs: 50 })
}

/** Leave the tail through the scroll owner, as a reader scrolling up would. */
function scrollAwayFromTail(): void {
  browser.evaluate(`(() => {
    ${MAIN}.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
    window.__cezThreadScrollTo(Math.max(0, Math.round((${MAIN}.scrollHeight - ${MAIN}.clientHeight) / 3)))
  })()`)
  browser.waitForValue(`document.querySelector(${JSON.stringify(PILL)})?.textContent ?? null`,
    (text): text is string => text === 'Jump to latest (1 question pending)',
    { failure: 'the pill did not name the pending question' })
}

function inViewport(selector: string): string {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) return false
    const box = element.getBoundingClientRect()
    return box.bottom > 0 && box.top < innerHeight
  })()`
}

// `?thread=virtual` forces virtua's rows: the newest page alone stays under its threshold.
describe.each([
  { name: 'desktop', width: 1440, height: 900, query: '' },
  { name: '360×640', width: 360, height: 640, query: '' },
  { name: 'desktop, virtualized rows', width: 1440, height: 900, query: '?thread=virtual' },
])('the pinned pending question at $name', ({ width, height, query }) => {
  it('pins the pending ask in the bottom decision zone while scrolling history, with unified reply mode and no Activity gap', () => {
    openTask(width, height, query)
    const before = waitForSettledSample<{ dockInView: boolean; activityInDock: boolean; inDock: boolean }>(browser, `(() => {
      const dock = document.querySelector('[data-slot="thread-dock"]')
      const ask = dock?.querySelector('${PINNED}')
      const box = dock?.getBoundingClientRect()
      return {
        dockInView: !!box && box.bottom <= innerHeight + 1 && box.top >= 0,
        activityInDock: dock?.querySelector('[data-slot="run-activity-dock"]') !== null,
        inDock: ask !== null,
      }
    })()`)
    expect(before).toEqual({ dockInView: true, activityInDock: false, inDock: true })

    // Scroll the transcript independently while the pinned ask stays fixed at the bottom.
    scrollAwayFromTail()
    const whileScrolled = waitForSettledSample<{ dockAtBottom: boolean; askVisible: boolean }>(browser, `(() => {
      const dock = document.querySelector('[data-slot="thread-dock"]').getBoundingClientRect()
      const ask = document.querySelector('${PINNED}').getBoundingClientRect()
      return { dockAtBottom: Math.abs(dock.bottom - innerHeight) <= 2, askVisible: ask.top >= 0 && ask.bottom <= innerHeight + 1 }
    })()`)
    expect(whileScrolled).toEqual({ dockAtBottom: true, askVisible: true })

    // Embedded free-text reply mode lives inside the same decision surface with one send path.
    browser.click('[data-slot="ask-mode-reply"]')
    browser.waitForFunction(`document.querySelector('[data-slot="thread-composer-slot"]:not([hidden]) textarea') !== null`)
    browser.fill('[data-slot="thread-composer-slot"]:not([hidden]) textarea', 'Keep this reply draft')
    browser.click('[data-slot="ask-mode-options"]')
    browser.waitForFunction(`document.querySelector('${FIRST_CHIP}') !== null`)
    browser.click('[data-slot="ask-mode-reply"]')
    expect(browser.waitForValue(`document.querySelector('[data-slot="thread-composer-slot"]:not([hidden]) textarea')?.value ?? null`, (v): v is string => v === 'Keep this reply draft')).toBe('Keep this reply draft')
    browser.click('[data-slot="ask-mode-options"]')
  })

  it('pins the pending question at the tail and never answers the earlier one', () => {
    openTask(width, height, query)
    expect(browser.evaluate(`document.querySelector('[data-slot="thread-rows"]')?.dataset.virtualized ?? null`)).toBe(query ? 'true' : 'false')
    expect(browser.count('[data-slot="ask-card"][data-resolved="false"]')).toBe(1)
    expect(browser.text(PINNED)).toContain('Which approach should I take?')
    // The origin is far above the newest page, so only the pinned copy is loaded.
    expect(browser.count('[data-slot="ask-origin"]')).toBe(0)
    expect(Number(browser.evaluate(cursorRequests))).toBe(0)
  })

  it('opens long active context in a non-destructive sheet and replays the earlier decision', () => {
    openTask(width, height, query)
    browser.click('[data-slot="ask-show-context"]')
    browser.waitForFunction(`document.querySelector('[data-slot="ask-context-sheet"] [data-slot="ask-context"]') !== null`)
    browser.waitForFunction(
      `Math.abs(document.querySelector('[data-slot="ask-context-sheet"]').getBoundingClientRect().right - window.innerWidth) < 2`,
    )
    const context = browser.evaluate(`(() => {
      const region = document.querySelector('[data-slot="ask-context-sheet"] [data-slot="ask-context"]')
      return { content: region.scrollHeight, text: region.textContent }
    })()`) as { content: number; text: string }
    expect(context.text).toContain('Context paragraph 1:')
    expect(context.text).toContain('Context paragraph 40:')
    expect(context.content).toBeGreaterThan(height)
    browser.click('[data-slot="ask-context-sheet"] [data-slot="ask-show-origin"]')
    browser.waitForFunction(`document.querySelector('[data-slot="ask-answers"]') !== null`)
    expect(browser.text('[data-slot="ask-answers"]')).toContain('Which branch is the base?')
    expect(browser.text('[data-slot="ask-answers"]')).toContain('develop')
    expect(browser.text('[data-slot="ask-answers"]')).toContain('Other')
    expect(browser.text('[data-slot="ask-answers"] blockquote')).toBe('Keep the filters.\nKeep every column.')
    expect(browser.evaluate(`document.querySelector('[data-slot="ask-answers"] [data-selected="true"]').textContent`)).toContain('main')
    expect(browser.evaluate(`document.querySelectorAll('[data-slot="ask-answers"]').length`)).toBe(1)
    expect(browser.evaluate(`document.querySelectorAll('[data-slot="user-bubble"]').length`)).toBeGreaterThan(0)
    browser.evaluate(`(() => {
      ${MAIN}.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
      window.__cezThreadScrollTo(0)
    })()`)
    browser.waitForFunction(`document.body.textContent.includes('The earlier proposal stays visible.')`)
  })

  it('keyboard activation of the pill focuses the first answer chip', () => {
    openTask(width, height, query)
    scrollAwayFromTail()
    browser.evaluate(`document.querySelector(${JSON.stringify(PILL)}).focus()`)
    browser.press('Enter')
    browser.waitForValue(`(() => {
      const chip = document.querySelector(${JSON.stringify(FIRST_CHIP)})
      return chip !== null && document.activeElement === chip && ${inViewport(FIRST_CHIP)}
    })()`, (value): value is true => value === true, { failure: 'the first chip of the pinned question did not take focus in view' })
    browser.waitForFunction(`document.querySelector(${JSON.stringify(PILL)}) === null`)
  })

  it('"Show where it was asked" loads older history and focuses the marker', () => {
    openTask(width, height, query)
    browser.click('[data-slot="ask-show-context"]')
    browser.waitForFunction(`document.querySelector('[data-slot="ask-context-sheet"]') !== null`)
    browser.evaluate(`(() => {
      const btn = [...document.querySelectorAll('[data-slot="ask-context-sheet"] button')].find(el => el.textContent?.includes('Show where it was asked'))
      btn.focus()
    })()`)
    browser.press('Enter')
    browser.waitForValue(`(() => {
      const marker = document.querySelector('[data-slot="ask-origin"]')
      return marker !== null && document.activeElement === marker && ${inViewport('[data-slot="ask-origin"]')}
    })()`, (value): value is true => value === true, { failure: 'the marker did not take focus in view', timeoutMs: 30_000 })
    expect(Number(browser.evaluate(cursorRequests))).toBeGreaterThan(0)
    // The answered question stays a summary and is never focused.
    expect(browser.evaluate(`document.activeElement?.closest('[data-resolved="true"]') === null`)).toBe(true)
    expect(browser.count('[data-slot="ask-card"][data-resolved="false"]')).toBe(1)

    const marker = '[data-slot="ask-go-to-question"]'
    const box = browser.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(marker)}).getBoundingClientRect(); return { w: r.width, h: r.height } })()`) as { w: number; h: number }
    expect(box.w).toBeGreaterThanOrEqual(44)
    expect(box.h).toBeGreaterThanOrEqual(44)
    for (const theme of ['dark', 'light'] as const) {
      browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'})`)
      const sample = waitForSettledSample<ContrastSample>(browser, contrastSampleExpression(marker), (value) => value !== null, marker)
      expect(sample.ratio, `marker link in ${theme}`).toBeGreaterThanOrEqual(4.5)
    }
    browser.evaluate(`document.documentElement.classList.remove('light')`)
    browser.evaluate(`document.querySelector(${JSON.stringify(marker)}).focus()`)
    browser.press('Enter')
    browser.waitForValue(`document.activeElement === document.querySelector(${JSON.stringify(FIRST_CHIP)})`,
      (value): value is true => value === true, { failure: 'Go to the question did not focus the first chip' })
    expect(browser.count('[data-slot="ask-card"][data-resolved="false"]')).toBe(1)
  })

  // Rule: docs/areas/web-ui.md § Touch and phone rules and § Accessibility rules (contrast).
  it('keeps 44×44 mobile targets and readable contrast in light and dark themes', () => {
    const measure = (selector: string, requireTouchSize: boolean) => {
      const box = browser.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { w: r.width, h: r.height } })()`) as { w: number; h: number }
      if (requireTouchSize) {
        expect(box.w, selector).toBeGreaterThanOrEqual(44)
        expect(box.h, selector).toBeGreaterThanOrEqual(44)
      }
      for (const theme of ['dark', 'light'] as const) {
        browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'})`)
        const sample = waitForSettledSample<ContrastSample>(browser, contrastSampleExpression(selector), (value) => value !== null, selector)
        expect(sample.ratio, `${selector} in ${theme}`).toBeGreaterThanOrEqual(4.5)
      }
      browser.evaluate(`document.documentElement.classList.remove('light')`)
    }
    openTask(width, height, query)
    measure('[data-slot="ask-show-context"]', width < 768)
    measure('[data-slot="ask-mode-options"]', width < 768)
    measure('[data-slot="ask-mode-reply"]', width < 768)
    scrollAwayFromTail()
    measure(PILL, true)
  })
})

describe('reopening and reduced motion', () => {
  it('reopening the task keeps the pinned question and its labelled pill', () => {
    openTask(1440, 900)
    browser.goto(`${baseUrl}/p/${project}/tasks/${OTHER_ID}`)
    browser.waitForFunction(`document.querySelector('[data-route="task-thread"][data-run-id="${OTHER_ID}"]') !== null`)
    openTask(1440, 900)
    expect(browser.count(PINNED)).toBe(1)
    scrollAwayFromTail()
  })

  it('jumps instantly under reduced motion', () => {
    browser.setReducedMotion()
    openTask(1440, 900)
    scrollAwayFromTail()
    browser.click(PILL)
    browser.waitForValue(`document.activeElement === document.querySelector(${JSON.stringify(FIRST_CHIP)}) && ${inViewport(FIRST_CHIP)}`,
      (value): value is true => value === true, { failure: 'the reduced-motion jump did not land on the first chip' })
  })

  it('keeps the Other answer textarea and Send button usable when a 280px mobile keyboard opens at 360×640', () => {
    openTask(360, 640)
    browser.evaluate(`document.documentElement.style.setProperty('--kb', '280px')`)
    try {
      browser.waitForFunction(`document.querySelector('[data-route="task-thread"]')?.dataset.compactViewport === 'true'`)
      const otherBtn = `[...document.querySelectorAll('${PINNED} [data-slot="ask-question"] button')].find((el) => el.textContent?.trim() === 'Other')`
      browser.evaluate(`(() => { const btn = ${otherBtn}; btn.scrollIntoView({ block: 'center', behavior: 'instant' }); btn.click(); })()`)
      browser.waitForFunction(`document.querySelector('${PINNED} textarea') !== null`)
      browser.evaluate(`document.querySelector('${PINNED} textarea')?.scrollIntoView({ block: 'nearest', behavior: 'instant' })`)
      browser.fill(`${PINNED} textarea`, 'Custom mobile answer')
      browser.waitForFunction(
        `[...document.querySelectorAll('${PINNED} [data-slot="ask-footer"] button')].some((el) => el.textContent?.includes('Send answer') && !el.disabled)`,
      )
      const state = waitForSettledSample<{
        textareaHeight: number
        textareaHit: boolean
        sendInView: boolean
        sendHit: boolean
        sendHeight: number
      }>(browser, `(() => {
        const textarea = document.querySelector('${PINNED} textarea')
        const send = [...document.querySelectorAll('${PINNED} [data-slot="ask-footer"] button')].find((el) => el.textContent?.includes('Send answer'))
        if (!textarea || !send) return null
        const tb = textarea.getBoundingClientRect()
        const sb = send.getBoundingClientRect()
        const tHit = document.elementFromPoint(tb.x + tb.width / 2, tb.y + tb.height / 2)
        const hit = document.elementFromPoint(sb.x + sb.width / 2, sb.y + sb.height / 2)
        return {
          textareaHeight: Math.round(tb.height),
          textareaHit: !!tHit && (tHit === textarea || textarea.contains(tHit)),
          sendInView: sb.top >= 0 && sb.bottom <= 640 - 280 + 1,
          sendHit: !!hit && (hit === send || send.contains(hit)),
          sendHeight: Math.round(sb.height),
        }
      })()`)
      expect(state.textareaHeight).toBeGreaterThanOrEqual(40)
      expect(state.textareaHit).toBe(true)
      expect(state.sendInView).toBe(true)
      expect(state.sendHit).toBe(true)
      expect(state.sendHeight).toBeGreaterThanOrEqual(44)
    } finally {
      browser.evaluate(`document.documentElement.style.setProperty('--kb', '0px')`)
    }
  })
})
