import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { ProjectScopeProvider } from '@/api/project-scope-context'
import { jsonResponse } from '@/test/fetch-routes'

import { ACTIVITY_WAIT_KIND, RUN_STATUS, iso, project, request, run, snapshot, worker } from './activity.testkit'
import { GlobalActivityRoute } from './global-activity-route'
import { ProjectActivityRoute } from './activity-route'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const A1 = run({ runId: 'a1', title: 'Porting upstream SSE' })
const A2 = run({ runId: 'a2', title: 'Fixing flaky shard', status: RUN_STATUS.waiting, rung: 'needs-you', wait: { kind: ACTIVITY_WAIT_KIND.human, since: iso(-60_000), detail: { reason: 'question', question: 'Retry the shard?' } } })
const G1 = run({ runId: 'g1', title: 'Adding verdict schema', workers: [worker({ runId: 'g1-w1' }), worker({ runId: 'g1-w2' }), worker({ runId: 'g1-w3', status: RUN_STATUS.done, rung: 'done' })] })
const ALPHA_PEER = request({ senderRunId: 'a1', recipientRunId: 'a2' })
// A request whose other end is not a pill of its panel: it has no arc anywhere.
const GAMMA_AWAY = request({ senderRunId: 'g1', recipientRunId: 'a1', recipientTitle: 'Porting upstream SSE' })

const SNAPSHOT = snapshot(
  project({ projectId: 'alpha', name: 'alpha', inReview: 1, tasks: [A1, A2], requests: [ALPHA_PEER] }),
  project({ projectId: 'beta', name: 'beta', loaded: false }),
  project({ projectId: 'gamma', name: 'gamma', tasks: [G1], requests: [GAMMA_AWAY] }),
  project({ projectId: 'delta', name: 'delta', inReview: 2 }),
  project({ projectId: 'eps', name: 'eps', unavailable: { status: 503, error: 'The run store is locked by another process.' } }),
  project({ projectId: 'zeta', name: 'zeta' }),
)

const registryEntry = (id: string) => ({ id, name: id, root: `/home/me/${id}`, addedAt: iso(-86_400_000), lastOpenedAt: iso(-60_000), source: 'local', status: 'ok' })

function serve({ body = SNAPSHOT, status = 200, order = ['gamma', 'alpha'] }: { body?: unknown; status?: number; order?: string[] } = {}) {
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://cockpit.test')
    const path = url.pathname
    if (path === '/api/v1/workspace/activity') {
      const id = url.searchParams.get('project')
      return jsonResponse(id ? snapshot(...SNAPSHOT.projects.filter((project) => project.projectId === id)) : body, status)
    }
    if (path === '/api/v1/projects') return jsonResponse({ projects: ['alpha', 'beta', 'gamma', 'delta', 'eps'].map(registryEntry), bootProject: 'alpha', projectsDir: '~/projects' })
    if (path === '/api/v1/workspace/ui-state') return jsonResponse({ sidebar: { projectOrder: order } })
    return jsonResponse({ error: 'not found' }, 404)
  })
}

function ScopedActivity() {
  const { projectId = '' } = useParams()
  return <ProjectScopeProvider projectId={projectId}><ProjectActivityRoute /></ProjectScopeProvider>
}

function renderRoute(pathname = '/activity', state?: unknown) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[{ pathname, state }]}>
        <Routes>
          <Route path="/activity" element={<GlobalActivityRoute />} />
          <Route path="/p/:projectId/activity" element={<ScopedActivity />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** The scope switch's link back to a project. */
const projectLink = (name: string) => within(screen.getByRole('navigation', { name: 'Activity scope' })).getByRole('link', { name })
const panelIds = () => Array.from(document.querySelectorAll('[data-slot="activity-panel"]')).map((panel) => panel.getAttribute('data-project'))
const panel = (id: string) => document.querySelector(`[data-slot="activity-panel"][data-project="${id}"]`) as HTMLElement
const row = (runId: string) => document.querySelector(`[data-activity-row="${runId}"]`) as HTMLElement
const chip = (label: string) => document.querySelector(`[data-chip="${label}"]`)?.textContent
const lineText = (el: HTMLElement) => Array.from(el.querySelectorAll('[data-slot="activity-line-text"] li')).map((li) => li.textContent)

describe('GlobalActivityRoute', () => {
  it.each(['gamma', 'delta'])('returns to %s after switching to All projects, rather than boot project alpha', async (projectId) => {
    serve()
    renderRoute(`/p/${projectId}/activity`)
    await screen.findByRole('heading', { level: 1, name: `Activity · ${projectId}` })

    fireEvent.click(screen.getByRole('link', { name: 'All projects' }))
    await screen.findByRole('heading', { level: 1, name: 'Activity · All projects' })
    // On the global view the project segment reads as the project's name.
    const back = await waitFor(() => projectLink(projectId))
    expect(back.getAttribute('href')).toBe(`/p/${projectId}/activity`)
    fireEvent.click(back)
    expect(await screen.findByRole('heading', { level: 1, name: `Activity · ${projectId}` })).toBeTruthy()
    expect(projectLink(projectId).getAttribute('aria-current')).toBe('page')
  })

  it('restores the originating project from the global history entry', async () => {
    serve()
    renderRoute('/activity', { activityProjectId: 'gamma' })
    await screen.findByRole('heading', { level: 3, name: 'Adding verdict schema' })
    expect(projectLink('gamma').getAttribute('href')).toBe('/p/gamma/activity')
  })

  it.each([null, 'gamma', { activityProjectId: 123 }, { activityProjectId: 'removed' }])('keeps the boot fallback for unusable history state %j', async (state) => {
    serve()
    renderRoute('/activity', state)
    await screen.findByRole('heading', { level: 3, name: 'Adding verdict schema' })
    expect(projectLink('alpha').getAttribute('href')).toBe('/p/alpha/activity')
  })

  it('shows unloaded and unavailable notice panels in rail order and groups active tasks when toggled', async () => {
    serve()
    renderRoute()
    await waitFor(() => expect(panelIds()).toEqual(['beta', 'eps']))
    // Flat priority order by default; clicking Group by project groups Working rows in project-rail order.
    const toggle = screen.getByRole('button', { name: 'Group by project' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    const workingGroups = Array.from(document.querySelectorAll('[data-slot="activity-working"] [data-slot="activity-project-group"]'))
      .map((el) => el.getAttribute('data-project'))
    expect(workingGroups).toEqual(['gamma', 'alpha'])
  })

  it('collapses loaded idle projects into one line, and never an unloaded or unavailable one', async () => {
    serve()
    renderRoute()
    const idle = await screen.findByText(/more projects have no active work/)
    expect(idle.textContent).toBe('2 more projects have no active work: delta, zeta')
    expect(within(idle).getByRole('link', { name: 'delta' }).getAttribute('href')).toBe('/p/delta/activity')
    expect(within(idle).queryByRole('link', { name: 'beta' })).toBeNull()
    expect(within(idle).queryByRole('link', { name: 'eps' })).toBeNull()
    expect(panel('beta').textContent).toContain('Not loaded in this cockpit')
    expect(within(panel('beta')).getByRole('link', { name: 'Open project →' }).getAttribute('href')).toBe('/p/beta/')
    expect(panel('eps').textContent).toContain('The run store is locked by another process.')
  })

  it('counts every project in the summary chips and offers the scope switch', async () => {
    serve()
    renderRoute()
    await screen.findByRole('heading', { level: 3, name: 'Porting upstream SSE' })
    expect(chip('needs you')).toBe('1 needs you')
    expect(chip('working')).toBe('2 working')
    expect(chip('active workers')).toBe('2 active workers')
    expect(chip('open requests')).toBe('2 open requests')
    expect(chip('in review')).toBe('3 in review')
    expect(screen.getByRole('link', { name: /3 in review/ }).getAttribute('href')).toBe('/tasks')
    const scope = screen.getByRole('navigation', { name: 'Activity scope' })
    expect(within(scope).getByRole('link', { name: 'All projects' }).getAttribute('aria-current')).toBe('page')
    expect(within(scope).getByRole('link', { name: 'alpha' }).getAttribute('href')).toBe('/p/alpha/activity')
    // The project segment reads as the project's name on every view, never as 'This project'.
    expect(within(scope).queryByRole('link', { name: 'This project' })).toBeNull()
  })

  it('leads with Attention decisions carrying project identity and compact Working rows with worker trees', async () => {
    serve()
    renderRoute()
    await screen.findByRole('heading', { level: 3, name: 'Adding verdict schema' })
    expect(row('a2').getAttribute('data-slot')).toBe('activity-decision')
    expect(row('a2').querySelector('[data-slot="activity-project-badge"]')?.textContent).toBe('alpha')
    expect(row('a2').querySelector('[data-slot="activity-main"]')?.textContent).toBe('Retry the shard?')
    expect(within(row('a2')).getByRole('button', { name: 'Answer' })).toBeTruthy()
    expect(row('a1').querySelector('[data-slot="activity-heartbeat"]')).not.toBeNull()
    expect(row('g1').querySelectorAll('[data-slot="activity-worker"]')).toHaveLength(2)
  })

  it('draws a margin arc only between two rows of the same project', async () => {
    serve()
    renderRoute()
    await screen.findByRole('heading', { level: 3, name: 'Adding verdict schema' })
    await waitFor(() => expect(document.querySelector(`path[data-request="${ALPHA_PEER.requestId}"]`)).not.toBeNull())
    expect(document.querySelector(`path[data-request="${GAMMA_AWAY.requestId}"]`)).toBeNull()
  })

  it('links each row to its task with the text form of its peer requests', async () => {
    serve()
    renderRoute()
    await screen.findByRole('heading', { level: 3, name: 'Porting upstream SSE' })
    expect(within(row('a1')).getByRole('link', { name: 'Porting upstream SSE' }).getAttribute('href')).toBe('/p/alpha/tasks/a1')
    expect(within(row('g1')).getByRole('link', { name: 'Adding verdict schema' }).getAttribute('href')).toBe('/p/gamma/tasks/g1')
    expect(lineText(row('a1'))).toEqual(['Waiting for a reply from Fixing flaky shard'])
    expect(lineText(row('a2'))).toEqual(['Porting upstream SSE waits for your reply'])
    expect(lineText(row('g1'))).toEqual(['Waiting for a reply from Porting upstream SSE'])
    // The narrow layout names the peer on the sender row instead of the arc.
    expect(within(row('a1')).getByRole('link', { name: '→ Fixing flaky shard' }).getAttribute('href')).toBe('/p/alpha/tasks/a2')
  })

  it('keeps the header and the scope switch while the snapshot loads', async () => {
    serve()
    // The snapshot never answers; the registry still does.
    const answer = fetchMock.getMockImplementation()
    fetchMock.mockImplementation(async (input, init) => (String(input).startsWith('/api/v1/workspace/activity') ? new Promise<Response>(() => {}) : answer!(input, init)))
    renderRoute()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Activity')
    expect(screen.getByRole('status').textContent).toBe('Loading activity…')
    expect((await waitFor(() => projectLink('alpha'))).getAttribute('href')).toBe('/p/alpha/activity')
  })

  it('says when there is no project to show', async () => {
    serve({ body: snapshot() })
    renderRoute()
    expect(await screen.findByText('No projects to show.')).toBeTruthy()
  })

  it('says so when the snapshot cannot be read, with a retry', async () => {
    serve({ status: 404, body: { error: 'project not found' } })
    renderRoute()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Could not load activity')
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeTruthy()
  })
})
