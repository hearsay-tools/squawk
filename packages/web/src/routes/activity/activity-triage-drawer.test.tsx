import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { jsonResponse } from '@/test/fetch-routes'
import { seedRunners } from '@/test/runners.testkit'

import { ACTIVITY_WAIT_KIND, NOW, RUN_STATUS, iso, project, run, worker } from './activity.testkit'
import { ActivitySupervisionView } from './activity-supervision-view'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const ASK_RUN_ID = 'run-ask-1'
const REVIEW_RUN_ID = 'run-rev-1'
const FAILED_RUN_ID = 'run-fail-1'

function mockApi() {
  const calls: string[] = []
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://cockpit.test')
    const path = url.pathname
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    if (path === '/api/v1/providers/status') {
      return jsonResponse({ claude: { installed: true, authenticated: true } })
    }
    if (path === '/api/v1/accounts') {
      return jsonResponse({ accounts: [] })
    }
    if (path === `/api/v1/p/acme/runs/${ASK_RUN_ID}`) {
      return jsonResponse({
        id: ASK_RUN_ID, title: 'Webhook idempotency', task: 'Webhook', workflow: 'quick-task',
        runner: 'claude', status: RUN_STATUS.waiting, createdAt: iso(-60_000), tokensUsed: 0, steps: [],
        sessionActive: true, finishBlocked: null,
      })
    }
    if (path === `/api/v1/p/acme/runs/${ASK_RUN_ID}/history-context`) {
      return jsonResponse({
        asOfSeq: 5,
        contextEvents: [{
          seq: 5, ts: iso(-30_000), type: 'ask.requested', requestId: 'ask-req-1',
          context: 'Stripe retries duplicate webhook events.',
          questions: [{ header: 'HTTP status', question: 'Return 200 or 409?', options: [{ label: '200 OK' }, { label: '409 Conflict' }] }],
        }],
      })
    }
    if (path === `/api/v1/p/acme/runs/${ASK_RUN_ID}/messages` && init?.method === 'POST') {
      return jsonResponse({ ok: true })
    }
    if (path === `/api/v1/p/acme/runs/${REVIEW_RUN_ID}`) {
      return jsonResponse({
        id: REVIEW_RUN_ID, title: 'Fix drawer padding', task: 'Fix drawer padding', workflow: 'quick-task',
        runner: 'claude', status: RUN_STATUS.review, createdAt: iso(-90_000), tokensUsed: 0, steps: [],
        sessionActive: false, finishBlocked: null,
      })
    }
    if (path === `/api/v1/p/acme/runs/${REVIEW_RUN_ID}/diff`) {
      return new Response('diff --git a/a.ts b/a.ts\n+const ok = true\n', { status: 200, headers: { 'content-type': 'text/plain' } })
    }
    if (path === `/api/v1/p/acme/runs/${REVIEW_RUN_ID}/finish` && init?.method === 'POST') {
      return jsonResponse({ ok: true })
    }
    if (path === `/api/v1/p/acme/runs/${FAILED_RUN_ID}`) {
      return jsonResponse({
        id: FAILED_RUN_ID, title: 'Sync OpenAPI docs', task: 'Sync docs', workflow: 'quick-task',
        runner: 'claude', status: RUN_STATUS.failed, error: 'Schema mismatch at /v1/activity',
        createdAt: iso(-120_000), tokensUsed: 0, steps: [], sessionActive: false, finishBlocked: null,
      })
    }
    if (path === `/api/v1/p/acme/runs/${FAILED_RUN_ID}/archive` && init?.method === 'POST') {
      return jsonResponse({ id: FAILED_RUN_ID, archived: true })
    }
    return jsonResponse({ error: `unexpected ${path}` }, 404)
  })
  return calls
}

function renderView() {
  const client = createQueryClient()
  seedRunners(client)
  const proj = project({
    projectId: 'acme',
    name: 'acme',
    inReview: 1,
    tasks: [
      run({
        runId: ASK_RUN_ID, title: 'Webhook idempotency', status: RUN_STATUS.waiting, rung: 'needs-you',
        wait: { kind: ACTIVITY_WAIT_KIND.human, since: iso(-30_000), detail: { reason: 'question', question: 'Return 200 or 409?' } },
      }),
      run({ runId: REVIEW_RUN_ID, title: 'Fix drawer padding', status: RUN_STATUS.review, rung: 'needs-review', finishedAt: iso(-40_000) }),
      run({ runId: FAILED_RUN_ID, title: 'Sync OpenAPI docs', status: RUN_STATUS.failed, rung: 'failed', error: 'Schema mismatch', finishedAt: iso(-50_000) }),
      run({ runId: 'run-work-1', title: 'Migrate queries', status: RUN_STATUS.running, rung: 'running', currentStepId: 'implement' }),
    ],
  })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/activity']}>
        <ActivitySupervisionView
          projects={[proj]}
          now={NOW}
          global
          grouped={false}
          projectOrder={['acme']}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ActivityTriageDrawer inline resolution', () => {
  it('opens the live AskCard in the triage drawer and closes after answering without leaving Activity', async () => {
    const calls = mockApi()
    renderView()

    // Zero-item Open requests and Just now panels do not render when empty.
    expect(document.querySelector('[data-slot="activity-open-requests"]')).toBeNull()
    expect(document.querySelector('[data-slot="activity-just-now"]')).toBeNull()

    const answerBtn = screen.getByRole('button', { name: 'Answer' })
    fireEvent.click(answerBtn)

    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).getByText('Webhook idempotency')).toBeTruthy()
    expect(await within(drawer).findByText('Return 200 or 409?')).toBeTruthy()
    expect(within(drawer).getByRole('link', { name: /Open task/ }).getAttribute('href')).toBe(`/p/acme/tasks/${ASK_RUN_ID}`)

    // Single-select one-tap answer posts directly to the target project's run messages endpoint.
    fireEvent.click(within(drawer).getByRole('button', { name: '200 OK' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls).toContain(`POST /api/v1/p/acme/runs/${ASK_RUN_ID}/messages`)
  })

  it('opens the ReviewPanel in the triage drawer and accepts changes on the target project', async () => {
    const calls = mockApi()
    renderView()

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    const drawer = await screen.findByRole('dialog')
    expect(await within(drawer).findByText('Review the changes before anything lands.')).toBeTruthy()
    fireEvent.click(within(drawer).getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls).toContain(`POST /api/v1/p/acme/runs/${REVIEW_RUN_ID}/finish`)
  })

  it('opens failure details in the triage drawer and archives the failed task', async () => {
    const calls = mockApi()
    renderView()

    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }))
    const drawer = await screen.findByRole('dialog')
    expect(await within(drawer).findByText('Schema mismatch at /v1/activity')).toBeTruthy()
    fireEvent.click(within(drawer).getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls).toContain(`POST /api/v1/p/acme/runs/${FAILED_RUN_ID}/archive`)
  })

  it('preserves live worker rows on Attention roots, refetches Q2 after Q1, and marks externally resolved tasks', async () => {
    let questionRound = 1
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input), 'http://cockpit.test').pathname
      if (path === '/api/v1/providers/status') return jsonResponse({ claude: { installed: true, authenticated: true } })
      if (path === '/api/v1/accounts') return jsonResponse({ accounts: [] })
      if (path === `/api/v1/p/acme/runs/${ASK_RUN_ID}`) {
        return jsonResponse({ id: ASK_RUN_ID, title: 'Webhook idempotency', task: 'Webhook', workflow: 'quick-task', runner: 'claude', status: RUN_STATUS.waiting, createdAt: iso(-60_000), tokensUsed: 0, steps: [], sessionActive: true, finishBlocked: null })
      }
      if (path === `/api/v1/p/acme/runs/${ASK_RUN_ID}/history-context`) {
        const q = questionRound === 1
          ? { requestId: 'ask-1', header: 'Q1', question: 'First question?', options: [{ label: 'Opt A' }, { label: 'Opt A2' }] }
          : { requestId: 'ask-2', header: 'Q2', question: 'Second question?', options: [{ label: 'Opt B' }, { label: 'Opt B2' }] }
        return jsonResponse({ asOfSeq: questionRound, contextEvents: [{ seq: questionRound, ts: iso(-10_000), type: 'ask.requested', requestId: q.requestId, questions: [{ header: q.header, question: q.question, options: q.options }] }] })
      }
      if (path === `/api/v1/p/acme/runs/${ASK_RUN_ID}/messages` && init?.method === 'POST') {
        questionRound = 2
        return jsonResponse({ ok: true })
      }
      return jsonResponse({ error: `unexpected ${path}` }, 404)
    })
    const client = createQueryClient()
    seedRunners(client)
    const makeProj = (question: string | null) => project({
      projectId: 'acme', name: 'acme',
      tasks: [run({
        runId: ASK_RUN_ID, title: 'Webhook idempotency',
        status: question ? RUN_STATUS.waiting : RUN_STATUS.running,
        rung: question ? 'needs-you' : 'running',
        ...(question ? { wait: { kind: ACTIVITY_WAIT_KIND.human, since: iso(-30_000), detail: { reason: 'question', question } } } : {}),
        workers: [worker({ runId: 'w-live', title: 'Background parser', status: RUN_STATUS.running })],
      })],
    })
    const ui = (p: ReturnType<typeof makeProj>) => (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/activity']}>
          <ActivitySupervisionView projects={[p]} now={NOW} global grouped={false} projectOrder={['acme']} />
        </MemoryRouter>
      </QueryClientProvider>
    )
    const view = render(ui(makeProj('First question?')))
    expect(document.querySelector('[data-activity-card="run-ask-1"] [data-slot="activity-worker"][data-run="w-live"]')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    fireEvent.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: 'Opt A' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    view.rerender(ui(makeProj('Second question?')))
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    expect(await within(await screen.findByRole('dialog')).findByRole('button', { name: 'Opt B' })).toBeTruthy()

    // Leaving Attention externally replaces stale controls with a resolved notice.
    view.rerender(ui(makeProj(null)))
    expect(document.querySelector('[data-slot="activity-triage-resolved"]')).not.toBeNull()
  })
})
