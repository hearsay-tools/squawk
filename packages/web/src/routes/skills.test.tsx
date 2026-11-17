import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import { SkillsRoute } from './skills'

const skills = [
  { id: 'plugin:check', name: 'Check', description: 'Check changes', scope: 'repo', plugin: 'plugin', path: '.agents/skills/check/SKILL.md' },
  { id: 'plugin:check', name: 'Check', description: 'User copy', scope: 'user', path: '/home/u/skills/check/SKILL.md' },
]
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function mount(source = 'live', client = createQueryClient()) {
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input) => {
    const url = String(input)
    requests.push(url)
    const body = url.includes('/runner-skills')
      ? { runner: new URL(url, 'http://localhost').searchParams.get('runner'), skills, problems: [{ message: 'Invalid manifest', path: '/broken' }], source }
      : url.endsWith('/config') ? { defaultRunner: 'codex' }
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
  expect(rows[0]?.textContent).toContain('.agents/skills/check/SKILL.md')
  expect(rows[1]?.textContent).toContain('/home/u/skills/check/SKILL.md')
  expect(screen.getByText('Plugin: plugin')).toBeTruthy()
  expect(screen.queryByRole('switch')).toBeNull()
  expect(document.querySelector('[data-slot="skill-body"]')).toBeNull()
  expect(requests.every((url) => !url.includes('/skills/') && !url.endsWith('/skills'))).toBe(true)
})

it('reads the selected runner and account and re-reads with refresh=1', async () => {
  const requests = mount()
  await waitFor(() => expect((screen.getByLabelText('Runner') as HTMLSelectElement).value).toBe('codex'))
  await screen.findByRole('option', { name: 'Work' })
  fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'work' } })
  await waitFor(() => expect(requests).toContain('/api/v1/runner-skills?runner=codex&account=work'))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Re-read' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Re-read' }))
  await waitFor(() => expect(requests).toContain('/api/v1/runner-skills?runner=codex&account=work&refresh=1'))
  fireEvent.change(screen.getByLabelText('Runner'), { target: { value: 'pi' } })
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
