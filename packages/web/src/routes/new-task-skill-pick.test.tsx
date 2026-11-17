import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PROVIDERS_MULTI, pillReady, postedBody, renderNewTask, requests, serve, startTask, textarea } from './new-task.testkit'
import { readDraft, resetDraft, writeDraft } from './new-task-draft'

beforeEach(() => {
  resetDraft()
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); resetDraft(); vi.unstubAllGlobals() })

it('shows both copies of a recent plugin id, sends its chosen path and persists only the id in ui-state', async () => {
  serve({ skills: [
    { id: 'plugin:check', name: 'Check', description: 'Repo copy', path: '.agents/check/SKILL.md', scope: 'repo' },
    { id: 'plugin:check', name: 'Check', description: 'User copy', path: '/home/u/check/SKILL.md', scope: 'user' },
  ], uiState: { recentSources: [{ source: 'skill', ref: 'plugin:check' }], skillUsage: { 'plugin:check': 3 } } })
  renderNewTask()
  await pillReady()
  fireEvent.click(screen.getByRole('button', { name: 'Choose a skill or workflow' }))
  await screen.findByText('Repo copy')
  const choices = document.querySelectorAll('[data-source-kind="skill"][data-slot="source-option"]')
  expect(choices).toHaveLength(2)
  expect(choices[0]?.textContent).toContain('.agents/check/SKILL.md')
  expect(choices[1]?.textContent).toContain('/home/u/check/SKILL.md')
  fireEvent.click(choices[1]!)
  expect(readDraft().source).toEqual({ source: 'skill', ref: 'plugin:check', path: '/home/u/check/SKILL.md' })
  fireEvent.change(textarea(), { target: { value: 'Check this change' } })
  await startTask()
  expect(postedBody()).toMatchObject({ steps: [{ skill: 'plugin:check', skillPath: '/home/u/check/SKILL.md' }] })
  await waitFor(() => expect(requests.some((request) => request.method === 'PUT' && request.url === '/api/v1/ui-state')).toBe(true))
  const saved = requests.find((request) => request.method === 'PUT' && request.url === '/api/v1/ui-state')?.body
  expect(saved).toMatchObject({ lastTask: { source: 'skill', ref: 'plugin:check' }, recentSources: [{ source: 'skill', ref: 'plugin:check' }] })
  expect(JSON.stringify(saved)).not.toContain('SKILL.md')
})

it('waits for account discovery before checking a deep link against the drafted runner', async () => {
  serve({ providerStatus: PROVIDERS_MULTI })
  writeDraft({ ...readDraft(), runner: 'codex', agentProfile: 'work' })
  const fallback = globalThis.fetch
  let release!: (response: Response) => void
  const profiles = new Promise<Response>((resolve) => { release = resolve })
  const nativeRequests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/workspace/agent-profiles')) return profiles
    if (url.includes('/runner-skills?')) {
      nativeRequests.push(url)
      const skills = url.includes('account=work') ? [{ id: 'plugin:check', name: 'Check', description: 'Work checks' }] : []
      return new Response(JSON.stringify({ runner: 'codex', skills, problems: [], source: 'live' }), { headers: { 'content-type': 'application/json' } })
    }
    return fallback(input, init)
  }))
  renderNewTask('/new?skill=plugin%3Acheck&ref=Review')
  await waitFor(() => expect(nativeRequests).toContain('/api/v1/runner-skills?runner=codex'))
  expect(screen.queryByText(/Unknown skill/)).toBeNull()
  await act(async () => { release(new Response(JSON.stringify({ profiles: [{ provider: 'codex', id: 'work', label: 'Work' }], selections: {} }), { headers: { 'content-type': 'application/json' } })) })
  await waitFor(() => expect(nativeRequests).toContain('/api/v1/runner-skills?runner=codex&account=work'))
  await screen.findByRole('button', { name: /Check/ })
  expect(readDraft().source).toEqual({ source: 'skill', ref: 'plugin:check' })
})
