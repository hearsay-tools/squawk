import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import { SkillsRoute } from './skills'
import { RUNNERS_PATH, RUNNERS_RESPONSE } from '@/test/runners.testkit'

const skills = [
  { id: 'plugin:check', name: 'Check', description: 'Check changes', scope: 'repo', plugin: 'plugin', path: '.agents/skills/check/SKILL.md' },
  { id: 'plugin:check', name: 'Check', description: 'User copy', scope: 'user', path: '/home/u/skills/check/SKILL.md' },
]
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function mount(source = 'live', client = createQueryClient(), { defaultRunner = 'codex', runnersFail = false } = {}) {
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input) => {
    const url = String(input)
    requests.push(url)
    if (runnersFail && url === RUNNERS_PATH) return new Response(JSON.stringify({ error: 'down' }), { status: 404 })
    const body = url.includes('/runner-skills')
      ? { runner: new URL(url, 'http://localhost').searchParams.get('runner'), skills, problems: [{ message: 'Invalid manifest', path: '/broken' }], source }
      : url === RUNNERS_PATH ? RUNNERS_RESPONSE
      : url.endsWith('/config') ? { defaultRunner }
      : url.endsWith('/agent-profiles') ? { profiles: [{ provider: 'codex', id: 'work', label: 'Work' }], selections: {} } : {}
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  }))
  render(<QueryClientProvider client={client}><MemoryRouter><SkillsRoute /></MemoryRouter></QueryClientProvider>)
  return requests
}

it('shows duplicate ids with runner metadata and problems, without edit controls or body reads', async () => {
  const requests = mount()
  await screen.findByText('Invalid manifest · /broken')
  await waitFor(() => expect(requests).toContain('/api/v1/runner-skills?runner=codex'))
  const rows = document.querySelectorAll('[data-slot="skill-row"]')
  expect(rows).toHaveLength(2)
  const paths = [...rows].map((row) => row.querySelector('[data-slot="skill-path"]')?.textContent)
  expect(paths.sort()).toEqual(['.agents/skills/check/SKILL.md', '/home/u/skills/check/SKILL.md'])
  expect(screen.getByText('Project · Plugin plugin')).toBeTruthy()
  expect(screen.getByRole('region', { name: 'plugin' }).textContent).toContain('Check')
  expect(screen.getByRole('region', { name: 'Your skills' }).textContent).toContain('User copy')
  expect(screen.queryByRole('switch')).toBeNull()
  expect(document.querySelector('[data-slot="skill-body"]')).toBeNull()
  // Every row says it opens in place: a trailing chevron, so a clamped description is no dead end.
  for (const row of rows) expect(row.querySelector('summary [data-slot="skill-row-cue"]')).not.toBeNull()
  expect(requests.every((url) => !url.includes('/skills/') && !url.endsWith('/skills'))).toBe(true)
})

it('reads the runner the server runs instead when the stored default is not registered', async () => {
  const requests = mount('live', createQueryClient(), { defaultRunner: 'ghost' })
  await waitFor(() => expect(requests).toContain('/api/v1/runner-skills?runner=claude'))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Claude Code' }).getAttribute('aria-pressed')).toBe('true'))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Re-read' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Re-read' }))
  await waitFor(() => expect(requests).toContain('/api/v1/runner-skills?runner=claude&refresh=1'))
  expect(requests.some((url) => url.includes('runner=ghost'))).toBe(false)
})

it('does not send an account picked for another runner with the resolved runner', async () => {
  const requests = mount()
  await screen.findByRole('option', { name: 'Work' })
  fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'work' } })
  await waitFor(() => expect(requests).toContain('/api/v1/runner-skills?runner=codex&account=work'))
  fireEvent.click(screen.getByRole('button', { name: 'Pi' }))
  await waitFor(() => expect(requests).toContain('/api/v1/runner-skills?runner=pi'))
  expect(requests.some((url) => url.includes('runner=pi&account='))).toBe(false)
})

it('still reads the stored default runner when the runners list fails', async () => {
  const requests = mount('live', createQueryClient(), { runnersFail: true })
  await waitFor(() => expect(requests).toContain('/api/v1/runner-skills?runner=codex'))
  await waitFor(() => expect(document.querySelectorAll('[data-slot="skill-row"]')).toHaveLength(2))
})

it('reads the selected runner and account and re-reads with refresh=1', async () => {
  const requests = mount()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Codex' }).getAttribute('aria-pressed')).toBe('true'))
  await screen.findByRole('option', { name: 'Work' })
  fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'work' } })
  await waitFor(() => expect(requests).toContain('/api/v1/runner-skills?runner=codex&account=work'))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Re-read' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Re-read' }))
  await waitFor(() => expect(requests).toContain('/api/v1/runner-skills?runner=codex&account=work&refresh=1'))
  fireEvent.click(screen.getByRole('button', { name: 'Pi' }))
  await waitFor(() => expect(requests).toContain('/api/v1/runner-skills?runner=pi'))
})

it('reports an unavailable list without hiding the inventory controls', async () => {
  mount('unavailable')
  await screen.findByText(/Skill list unavailable/)
  expect(screen.getByRole('button', { name: 'Re-read' })).toBeTruthy()
})

it('invalidates equivalent explicit-account lists after re-reading the project default', async () => {
  const client = createQueryClient()
  const explicit = queryKeys.runnerSkills('codex', 'default')
  const otherRunner = queryKeys.runnerSkills('pi', 'default')
  for (const key of [explicit, otherRunner]) client.setQueryData(key, { skills: [] })
  const requests = mount('live', client)
  await waitFor(() => expect(document.querySelectorAll('[data-slot="skill-row"]')).toHaveLength(2))
  fireEvent.click(screen.getByRole('button', { name: 'Re-read' }))
  await waitFor(() => expect(requests).toContain('/api/v1/runner-skills?runner=codex&refresh=1'))
  await waitFor(() => expect(client.getQueryState(explicit)?.isInvalidated).toBe(true))
  expect(client.getQueryState(otherRunner)?.isInvalidated).toBe(false)
})

it('starts a task with the open skill on the selected runner, and filters across groups', async () => {
  mount()
  await waitFor(() => expect(document.querySelectorAll('[data-slot="skill-row"]')).toHaveLength(2))
  const start = document.querySelector('[data-skill-path=".agents/skills/check/SKILL.md"] [data-action="start-task"]')
  expect(start?.textContent).toBe('Start task')
  expect(start?.getAttribute('href')).toBe('/new?skill=plugin%3Acheck&skillPath=.agents%2Fskills%2Fcheck%2FSKILL.md&runner=codex')
  fireEvent.change(screen.getByLabelText('Search skills'), { target: { value: 'user copy' } })
  await waitFor(() => expect(document.querySelectorAll('[data-slot="skill-row"]')).toHaveLength(1))
  fireEvent.change(screen.getByLabelText('Search skills'), { target: { value: 'zzzz' } })
  await screen.findByText('No skills match “zzzz”.')
})

it('folds a group and keeps the count', async () => {
  mount()
  await waitFor(() => expect(document.querySelectorAll('[data-slot="skill-row"]')).toHaveLength(2))
  fireEvent.click(screen.getByRole('button', { name: /Your skills/ }))
  await waitFor(() => expect(document.querySelectorAll('[data-slot="skill-row"]')).toHaveLength(1))
  expect(screen.getByRole('button', { name: /Your skills/ }).getAttribute('aria-expanded')).toBe('false')
})
